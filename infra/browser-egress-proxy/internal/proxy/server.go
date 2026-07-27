package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/netip"
	"reflect"
	"sync"
	"sync/atomic"
	"time"

	"maintainflow/browser-egress-proxy/internal/audit"
	"maintainflow/browser-egress-proxy/internal/dnsresolver"
	"maintainflow/browser-egress-proxy/internal/limits"
	"maintainflow/browser-egress-proxy/internal/policy"
)

const (
	DefaultHandshakeTimeout = 5 * time.Second
	DefaultMaxHandshakes    = 64
	privateDialerPort       = 9443
)

type Resolver interface {
	Resolve(context.Context, string) (dnsresolver.Resolution, error)
}

type AuditSink interface {
	Preflight() error
	Write(audit.Event) error
}

type ServerConfig struct {
	TLSConfig            *tls.Config
	AllowedClientURI     string
	Resolver             Resolver
	DomainPolicy         policy.DomainPolicy
	Connector            Connector
	Limiter              *limits.Limiter
	Audit                AuditSink
	AuditPepper          []byte
	PolicyVersion        string
	ImageDigest          string
	DNSConnectBudget     time.Duration
	HandshakeTimeout     time.Duration
	ConnectHeaderBytes   int
	ConnectHeaderTimeout time.Duration
	MaxPendingHandshakes int
	Relay                RelayConfig
}

type Server struct {
	config      ServerConfig
	ready       atomic.Bool
	unhealthy   atomic.Bool
	mu          sync.Mutex
	listener    net.Listener
	connections map[net.Conn]struct{}
	wait        sync.WaitGroup
	handshakes  chan struct{}
}

func NewServer(configuration ServerConfig) (*Server, error) {
	if err := validateServerConfig(configuration); err != nil {
		return nil, err
	}
	return &Server{
		config:      configuration,
		connections: make(map[net.Conn]struct{}),
		handshakes:  make(chan struct{}, configuration.MaxPendingHandshakes),
	}, nil
}

func validateServerConfig(configuration ServerConfig) error {
	tlsConfig := configuration.TLSConfig
	if tlsConfig == nil || len(tlsConfig.Certificates) == 0 || tlsConfig.ClientCAs == nil ||
		tlsConfig.ClientAuth != tls.RequireAndVerifyClientCert || tlsConfig.MinVersion < tls.VersionTLS12 ||
		len(tlsConfig.NextProtos) != 1 || tlsConfig.NextProtos[0] != "http/1.1" ||
		!tlsConfig.SessionTicketsDisabled || tlsConfig.VerifyConnection == nil {
		return errors.New("reviewed mTLS HTTP/1.1 server configuration is required")
	}
	if configuration.AllowedClientURI == "" || interfaceIsNil(configuration.Resolver) ||
		!configuration.DomainPolicy.Ready() || interfaceIsNil(configuration.Connector) ||
		configuration.Limiter == nil || interfaceIsNil(configuration.Audit) || len(configuration.AuditPepper) < 32 ||
		configuration.PolicyVersion == "" || configuration.ImageDigest == "" {
		return errors.New("dialer dependencies and release identity are required")
	}
	if configuration.DNSConnectBudget <= 0 || configuration.DNSConnectBudget > 5*time.Second ||
		configuration.HandshakeTimeout <= 0 || configuration.HandshakeTimeout > DefaultHandshakeTimeout ||
		configuration.ConnectHeaderBytes <= 0 || configuration.ConnectHeaderBytes > DefaultMaxConnectHeaderBytes ||
		configuration.ConnectHeaderTimeout <= 0 || configuration.ConnectHeaderTimeout > DefaultConnectHeaderTimeout ||
		configuration.MaxPendingHandshakes <= 0 || configuration.MaxPendingHandshakes > DefaultMaxHandshakes ||
		configuration.Relay.Validate() != nil {
		return errors.New("dialer time, header, handshake, or relay limits are invalid")
	}
	return nil
}

func interfaceIsNil(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

func (s *Server) Ready() bool {
	return s != nil && s.ready.Load() && !s.unhealthy.Load()
}

// FailedClosed distinguishes an intentional fatal safety shutdown from a
// normal context cancellation. The process supervisor must see the former as
// a failure so it cannot leave a permanently unavailable machine stopped with
// a successful exit status.
func (s *Server) FailedClosed() bool {
	return s != nil && s.unhealthy.Load()
}

func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	if listener == nil || !isPrivateDialerAddress(listener.Addr()) {
		return errors.New("dialer listener must be Fly-private TCP port 9443")
	}
	s.mu.Lock()
	if s.listener != nil {
		s.mu.Unlock()
		return errors.New("dialer listener is already serving")
	}
	s.listener = listener
	s.mu.Unlock()
	s.ready.Store(true)

	stop := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			s.stopAccepting()
		case <-stop:
		}
	}()

	var serveErr error
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() == nil && !s.unhealthy.Load() {
				serveErr = errors.New("dialer listener failed")
			}
			break
		}
		select {
		case s.handshakes <- struct{}{}:
		default:
			_ = connection.Close()
			continue
		}
		s.track(connection, true)
		s.wait.Add(1)
		go func() {
			defer s.wait.Done()
			defer s.track(connection, false)
			handshakeReleased := false
			releaseHandshake := func() {
				if !handshakeReleased {
					<-s.handshakes
					handshakeReleased = true
				}
			}
			defer releaseHandshake()
			s.handleConnection(ctx, connection, time.Now(), releaseHandshake)
		}()
	}
	close(stop)
	s.ready.Store(false)
	s.stopConnections()
	s.wait.Wait()
	return serveErr
}

func (s *Server) handleConnection(ctx context.Context, raw net.Conn, started time.Time, releaseHandshake func()) {
	defer raw.Close()
	handshakeContext, cancel := context.WithTimeout(ctx, s.config.HandshakeTimeout)
	tlsConnection := tls.Server(raw, s.config.TLSConfig.Clone())
	if err := tlsConnection.HandshakeContext(handshakeContext); err != nil {
		cancel()
		return
	}
	cancel()
	state := tlsConnection.ConnectionState()
	identity, err := verifiedClientIdentity(state, s.config.AllowedClientURI)
	if err != nil {
		return
	}
	if err := s.config.Audit.Preflight(); err != nil {
		s.failClosed()
		return
	}

	request, err := ReadConnectRequest(tlsConnection, s.config.ConnectHeaderBytes, s.config.ConnectHeaderTimeout)
	if err != nil {
		reason, status := auditReasonForRequest(err)
		s.block(tlsConnection, started, "", policy.ClassUnknown, audit.MethodUnsupported, reason, status, 0, 0)
		return
	}
	// Keep the bounded admission slot through the CONNECT header. Releasing it
	// immediately after TLS would allow one authenticated peer to accumulate an
	// unbounded number of post-handshake sockets that each wait for a header.
	releaseHandshake()
	lease, limitReason := s.config.Limiter.Acquire(time.Now(), identity, request.Hostname)
	if limitReason != limits.ReasonAllowed {
		reason := audit.ReasonCapacity
		if limitReason == limits.ReasonCredentialRate || limitReason == limits.ReasonDestinationRate {
			reason = audit.ReasonRateLimit
		}
		s.block(tlsConnection, started, request.Hostname, policy.ClassUnknown, audit.MethodConnect, reason, 429, 0, 0)
		return
	}
	defer lease.Release()

	operationContext, operationCancel := context.WithTimeout(ctx, s.config.DNSConnectBudget)
	resolution, resolveErr := s.config.Resolver.Resolve(operationContext, request.Hostname+".")
	if resolveErr != nil {
		reason, status := auditReasonForResolution(ctx, operationContext, resolveErr)
		operationCancel()
		s.block(tlsConnection, started, request.Hostname, policy.ClassUnknown, audit.MethodConnect, reason, status, 0, 0)
		return
	}
	destination := policy.EvaluateDestination(s.config.DomainPolicy, resolution.Names, resolution.Addresses)
	if !destination.Allowed {
		operationCancel()
		s.block(tlsConnection, started, request.Hostname, destination.Class, audit.MethodConnect, auditReasonForPolicy(destination.Reason), 403, 0, 0)
		return
	}
	upstream, connectErr := s.config.Connector.Connect(operationContext, netip.AddrPortFrom(destination.Selected, 443))
	if connectErr != nil {
		reason, status := audit.ReasonConnectFailure, 502
		if ctx.Err() != nil {
			reason, status = audit.ReasonShutdown, 503
		} else if operationContext.Err() != nil {
			reason, status = audit.ReasonConnectTimeout, 504
		}
		operationCancel()
		s.block(tlsConnection, started, request.Hostname, destination.Class, audit.MethodConnect, reason, status, 0, 0)
		return
	}
	operationCancel()
	defer upstream.Close()
	if err := writeBoundedResponse(tlsConnection, []byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		s.emit(started, request.Hostname, destination.Class, audit.MethodConnect, audit.ResultBlocked, audit.ReasonRelayFailure, 0, 0)
		return
	}
	result := Relay(ctx, tlsConnection, upstream, s.config.Relay)
	auditReason := audit.ReasonAllowed
	auditResult := audit.ResultAllowed
	if result.Reason != RelayAllowed {
		auditResult = audit.ResultBlocked
		auditReason = auditReasonForRelay(ctx, result.Reason)
	}
	s.emit(started, request.Hostname, destination.Class, audit.MethodConnect, auditResult, auditReason, result.RequestBytes, result.ResponseBytes)
}

func verifiedClientIdentity(state tls.ConnectionState, expected string) (string, error) {
	if !state.HandshakeComplete || state.NegotiatedProtocol != "http/1.1" || len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 {
		return "", errors.New("verified client identity is required")
	}
	leaf := state.PeerCertificates[0]
	if len(leaf.URIs) != 1 || leaf.URIs[0].String() != expected {
		return "", errors.New("client identity is not allowlisted")
	}
	return expected, nil
}

func (s *Server) block(connection net.Conn, started time.Time, hostname string, class policy.AddressClass, method audit.MethodClass, reason audit.ReasonCode, status int, requestBytes, responseBytes int64) {
	if !s.emit(started, hostname, class, method, audit.ResultBlocked, reason, requestBytes, responseBytes) {
		return
	}
	_ = writeHTTPError(connection, status)
}

func (s *Server) emit(started time.Time, hostname string, class policy.AddressClass, method audit.MethodClass, result audit.Result, reason audit.ReasonCode, requestBytes, responseBytes int64) bool {
	event, err := audit.NewEvent(audit.EventInput{
		Timestamp:          time.Now(),
		PolicyVersion:      s.config.PolicyVersion,
		ImageDigest:        s.config.ImageDigest,
		NormalizedHostname: hostname,
		AuditPepper:        s.config.AuditPepper,
		AddressClass:       class,
		MethodClass:        method,
		Result:             result,
		ReasonCode:         reason,
		Latency:            time.Since(started),
		RequestBytes:       requestBytes,
		ResponseBytes:      responseBytes,
	})
	if err != nil || s.config.Audit.Write(event) != nil {
		s.failClosed()
		return false
	}
	return true
}

func auditReasonForRequest(err error) (audit.ReasonCode, int) {
	var requestError *RequestError
	if !errors.As(err, &requestError) {
		return audit.ReasonUnsupported, 400
	}
	switch requestError.Reason {
	case RequestInvalidAuthority:
		return audit.ReasonInvalidAuthority, 400
	case RequestBodyNotAllowed:
		return audit.ReasonBodyNotAllowed, 400
	case RequestHeaderLimit:
		return audit.ReasonHeaderLimit, 400
	case RequestHeaderTimeout:
		return audit.ReasonHeaderTimeout, 408
	default:
		return audit.ReasonUnsupported, 400
	}
}

func auditReasonForResolution(serverContext, operationContext context.Context, err error) (audit.ReasonCode, int) {
	if serverContext.Err() != nil {
		return audit.ReasonShutdown, 503
	}
	if operationContext.Err() != nil {
		return audit.ReasonDNSTimeout, 504
	}
	switch {
	case errors.Is(err, dnsresolver.ErrBlockedName):
		return audit.ReasonBlockedDomain, 403
	case errors.Is(err, dnsresolver.ErrNXDomain), errors.Is(err, dnsresolver.ErrNoData):
		return audit.ReasonEmptyDNSAnswer, 403
	case errors.Is(err, dnsresolver.ErrInconsistentResponse):
		return audit.ReasonDNSInconsistent, 403
	default:
		return audit.ReasonDNSFailure, 502
	}
}

func auditReasonForPolicy(reason policy.ReasonCode) audit.ReasonCode {
	switch reason {
	case policy.ReasonBlockedDomain:
		return audit.ReasonBlockedDomain
	case policy.ReasonInvalidDomain:
		return audit.ReasonInvalidDomain
	case policy.ReasonEmptyDNSAnswer:
		return audit.ReasonEmptyDNSAnswer
	case policy.ReasonMixedDNSAnswer:
		return audit.ReasonMixedDNSAnswer
	default:
		return audit.ReasonBlockedAddress
	}
}

func auditReasonForRelay(ctx context.Context, reason RelayReason) audit.ReasonCode {
	switch reason {
	case RelayUploadLimit:
		return audit.ReasonRequestLimit
	case RelayResponseLimit:
		return audit.ReasonResponseLimit
	case RelayIdleTimeout:
		return audit.ReasonIdleTimeout
	case RelayCancelled:
		if ctx.Err() != nil {
			return audit.ReasonShutdown
		}
		return audit.ReasonCancelled
	default:
		return audit.ReasonRelayFailure
	}
}

func writeHTTPError(connection net.Conn, status int) error {
	statusText := "Bad Request"
	switch status {
	case 403:
		statusText = "Forbidden"
	case 408:
		statusText = "Request Timeout"
	case 429:
		statusText = "Too Many Requests"
	case 502:
		statusText = "Bad Gateway"
	case 503:
		statusText = "Service Unavailable"
	case 504:
		statusText = "Gateway Timeout"
	default:
		status = 400
	}
	return writeBoundedResponse(connection, []byte("HTTP/1.1 "+itoaStatus(status)+" "+statusText+"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"))
}

func writeBoundedResponse(connection net.Conn, response []byte) error {
	if err := connection.SetWriteDeadline(time.Now().Add(DefaultConnectHeaderTimeout)); err != nil {
		return err
	}
	defer connection.SetWriteDeadline(time.Time{}) //nolint:errcheck -- the connection closes on any later failure.
	for len(response) > 0 {
		written, err := connection.Write(response)
		if err != nil {
			return err
		}
		if written <= 0 {
			return errors.New("write proxy response")
		}
		response = response[written:]
	}
	return nil
}

func itoaStatus(status int) string {
	switch status {
	case 403:
		return "403"
	case 408:
		return "408"
	case 429:
		return "429"
	case 502:
		return "502"
	case 503:
		return "503"
	case 504:
		return "504"
	default:
		return "400"
	}
}

func isPrivateDialerAddress(address net.Addr) bool {
	tcpAddress, ok := address.(*net.TCPAddr)
	if !ok || tcpAddress.Port != privateDialerPort {
		return false
	}
	ip, ok := netip.AddrFromSlice(tcpAddress.IP)
	if !ok {
		return false
	}
	return policy.ClassifyAddress(ip.Unmap()).Class == policy.ClassBlockedFlyPrivate
}

func (s *Server) track(connection net.Conn, add bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if add {
		s.connections[connection] = struct{}{}
	} else {
		delete(s.connections, connection)
	}
}

func (s *Server) stopAccepting() {
	s.ready.Store(false)
	s.mu.Lock()
	listener := s.listener
	s.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
}

func (s *Server) stopConnections() {
	s.mu.Lock()
	connections := make([]net.Conn, 0, len(s.connections))
	for connection := range s.connections {
		connections = append(connections, connection)
	}
	s.mu.Unlock()
	for _, connection := range connections {
		_ = connection.Close()
	}
}

func (s *Server) failClosed() {
	s.unhealthy.Store(true)
	s.ready.Store(false)
	s.stopAccepting()
	s.stopConnections()
}
