package proxy_test

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"maintainflow/browser-egress-proxy/internal/audit"
	"maintainflow/browser-egress-proxy/internal/config"
	"maintainflow/browser-egress-proxy/internal/dnsresolver"
	"maintainflow/browser-egress-proxy/internal/limits"
	"maintainflow/browser-egress-proxy/internal/policy"
	"maintainflow/browser-egress-proxy/internal/proxy"
)

const (
	allowedClientURI = "spiffe://maintainflow/interceptor"
	targetHostname   = "public.example.net"
)

func TestDialerAllowedTargetReceiptPinsOneExactAddress(t *testing.T) {
	t.Parallel()
	targetListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetListener.Close()
	receipt := make(chan string, 1)
	go func() {
		connection, acceptErr := targetListener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		payload := make([]byte, 4)
		_, readErr := io.ReadFull(connection, payload)
		if readErr == nil {
			receipt <- string(payload)
			_, _ = connection.Write([]byte("pong"))
		}
		if tcp, ok := connection.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		_, _ = io.Copy(io.Discard, connection)
	}()

	selected := netip.MustParseAddr("93.184.216.34")
	resolver := &sequenceResolver{results: []dnsresolver.Resolution{{
		Status: dnsresolver.StatusSuccess, Names: []string{targetHostname}, Addresses: []netip.Addr{selected},
	}}}
	connector := &recordingConnector{connect: func(context.Context, netip.AddrPort) (net.Conn, error) {
		return net.Dial("tcp", targetListener.Addr().String())
	}}
	auditSink := newCaptureAudit()
	fixture := newServerFixture(t, resolver, connector, auditSink)
	defer fixture.close(t)

	client := fixture.connect(t, fixture.identities.valid, "http/1.1")
	reader := sendConnect(t, client, targetHostname)
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if err := client.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(reader)
	if err != nil || string(response) != "pong" {
		t.Fatalf("target response = %q, %v", response, err)
	}
	_ = client.Close()
	select {
	case got := <-receipt:
		if got != "ping" {
			t.Fatalf("target receipt = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("target received no payload")
	}
	event := auditSink.next(t)
	if event.Result != audit.ResultAllowed || event.ReasonCode != audit.ReasonAllowed ||
		event.RequestBytes != 4 || event.ResponseBytes != 4 {
		t.Fatalf("allowed event = %+v", event)
	}
	calls := connector.addresses()
	if len(calls) != 1 || calls[0] != netip.AddrPortFrom(selected, 443) {
		t.Fatalf("exact dial receipt = %v", calls)
	}
}

func TestDialerBlockedDNSAnswersNeverReachConnector(t *testing.T) {
	t.Parallel()
	public := netip.MustParseAddr("93.184.216.34")
	private := netip.MustParseAddr("127.0.0.1")
	siteLocal := netip.MustParseAddr("fec0::1")
	resolver := &sequenceResolver{results: []dnsresolver.Resolution{
		{Status: dnsresolver.StatusSuccess, Names: []string{targetHostname}, Addresses: []netip.Addr{public, private}},
		{Status: dnsresolver.StatusSuccess, Names: []string{targetHostname}, Addresses: []netip.Addr{private}},
		{Status: dnsresolver.StatusSuccess, Names: []string{targetHostname}, Addresses: []netip.Addr{siteLocal}},
	}}
	connector := &recordingConnector{connect: func(context.Context, netip.AddrPort) (net.Conn, error) {
		return nil, errors.New("must not connect")
	}}
	auditSink := newCaptureAudit()
	fixture := newServerFixture(t, resolver, connector, auditSink)
	defer fixture.close(t)

	for _, expectedClass := range []policy.AddressClass{
		policy.ClassBlockedMixed,
		policy.ClassBlockedLoopback,
		policy.ClassBlockedSpecial,
	} {
		client := fixture.connect(t, fixture.identities.valid, "http/1.1")
		status := sendConnectExpectError(t, client, targetHostname)
		_ = client.Close()
		if !strings.Contains(status, "403 Forbidden") {
			t.Fatalf("status = %q", status)
		}
		event := auditSink.next(t)
		if event.Result != audit.ResultBlocked || event.AddressClass != expectedClass {
			t.Fatalf("blocked event = %+v", event)
		}
	}
	if len(connector.addresses()) != 0 {
		t.Fatalf("blocked resolution reached target: %v", connector.addresses())
	}
}

func TestDialerMTLSAndALPNFailBeforeResolver(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name      string
		identity  tls.Certificate
		protocol  string
		plaintext bool
	}{
		{name: "no certificate", protocol: "http/1.1"},
		{name: "same CA wrong URI", identity: tls.Certificate{}, protocol: "http/1.1"},
		{name: "wrong CA", identity: tls.Certificate{}, protocol: "http/1.1"},
		{name: "expired", identity: tls.Certificate{}, protocol: "http/1.1"},
		{name: "HTTP2 ALPN", protocol: "h2"},
		{name: "plaintext", plaintext: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &sequenceResolver{}
			connector := &recordingConnector{}
			fixture := newServerFixture(t, resolver, connector, newCaptureAudit())
			defer fixture.close(t)
			switch test.name {
			case "same CA wrong URI":
				test.identity = fixture.identities.wrongURI
			case "wrong CA":
				test.identity = fixture.identities.wrongCA
			case "expired":
				test.identity = fixture.identities.expired
			case "HTTP2 ALPN":
				test.identity = fixture.identities.valid
			}
			serverSide, clientSide := net.Pipe()
			fixture.listener.offer(serverSide)
			if test.plaintext {
				_, _ = clientSide.Write([]byte("CONNECT " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\n\r\n"))
				_ = clientSide.Close()
			} else {
				clientConfig := fixture.clientTLS(test.identity, test.protocol)
				connection := tls.Client(clientSide, clientConfig)
				_ = connection.Handshake()
				_, _ = connection.Write([]byte("CONNECT " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\n\r\n"))
				buffer := make([]byte, 1)
				_ = connection.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
				_, _ = connection.Read(buffer)
				_ = connection.Close()
			}
			time.Sleep(20 * time.Millisecond)
			if resolver.callCount() != 0 || len(connector.addresses()) != 0 {
				t.Fatalf("untrusted transport crossed policy boundary: resolver=%d connector=%v", resolver.callCount(), connector.addresses())
			}
		})
	}
}

func TestDialerProtocolDenialsHaveTargetNonArrivalReceipts(t *testing.T) {
	t.Parallel()
	resolver := &sequenceResolver{}
	connector := &recordingConnector{}
	auditSink := newCaptureAudit()
	fixture := newServerFixture(t, resolver, connector, auditSink)
	defer fixture.close(t)
	requests := []string{
		"GET " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\n\r\n",
		"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
		"CONNECT " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\nContent-Length: 0\r\n\r\n",
		"CONNECT " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
		"CONNECT " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\nHost: " + targetHostname + ":443\r\n\r\n",
		"CONNECT " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\n\r\ntarget-preface",
	}
	for _, request := range requests {
		client := fixture.connect(t, fixture.identities.valid, "http/1.1")
		if _, err := client.Write([]byte(request)); err != nil {
			t.Fatal(err)
		}
		status, _ := bufio.NewReader(client).ReadString('\n')
		_ = client.Close()
		if !strings.Contains(status, "400 Bad Request") {
			t.Fatalf("unsafe protocol status = %q", status)
		}
		if event := auditSink.next(t); event.Result != audit.ResultBlocked {
			t.Fatalf("unsafe protocol event = %+v", event)
		}
	}
	if resolver.callCount() != 0 || len(connector.addresses()) != 0 {
		t.Fatalf("protocol denial reached target: resolver=%d connector=%v", resolver.callCount(), connector.addresses())
	}
}

func TestDialerSharesOneDNSAndConnectBudgetAndNeverRetries(t *testing.T) {
	t.Parallel()
	resolver := &sequenceResolver{
		delay: 50 * time.Millisecond,
		results: []dnsresolver.Resolution{{
			Status:    dnsresolver.StatusSuccess,
			Names:     []string{targetHostname},
			Addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("93.184.216.35")},
		}},
	}
	var remaining time.Duration
	connector := &recordingConnector{connect: func(ctx context.Context, _ netip.AddrPort) (net.Conn, error) {
		if deadline, ok := ctx.Deadline(); ok {
			remaining = time.Until(deadline)
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	auditSink := newCaptureAudit()
	fixture := newServerFixtureWithBudget(t, resolver, connector, auditSink, 80*time.Millisecond)
	defer fixture.close(t)
	client := fixture.connect(t, fixture.identities.valid, "http/1.1")
	started := time.Now()
	status := sendConnectExpectError(t, client, targetHostname)
	elapsed := time.Since(started)
	_ = client.Close()
	if !strings.Contains(status, "504 Gateway Timeout") || elapsed > 160*time.Millisecond {
		t.Fatalf("shared budget status=%q elapsed=%s", status, elapsed)
	}
	if remaining <= 0 || remaining >= 60*time.Millisecond {
		t.Fatalf("connector received a fresh budget: remaining=%s", remaining)
	}
	if len(connector.addresses()) != 1 {
		t.Fatalf("connect attempts = %v", connector.addresses())
	}
	if event := auditSink.next(t); event.ReasonCode != audit.ReasonConnectTimeout {
		t.Fatalf("timeout event = %+v", event)
	}
}

func TestDialerAuditPreflightFailureClosesBeforeResolution(t *testing.T) {
	t.Parallel()
	resolver := &sequenceResolver{}
	connector := &recordingConnector{}
	auditSink := newCaptureAudit()
	auditSink.preflightErr = errors.New("sink unavailable")
	fixture := newServerFixture(t, resolver, connector, auditSink)
	defer fixture.close(t)
	client := fixture.connect(t, fixture.identities.valid, "http/1.1")
	_, _ = client.Write([]byte("CONNECT " + targetHostname + ":443 HTTP/1.1\r\nHost: " + targetHostname + ":443\r\n\r\n"))
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	_, _ = io.ReadAll(client)
	_ = client.Close()
	deadline := time.Now().Add(time.Second)
	for fixture.server.Ready() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if fixture.server.Ready() || !fixture.server.FailedClosed() || resolver.callCount() != 0 || len(connector.addresses()) != 0 {
		t.Fatalf("audit failure did not fail closed")
	}
}

func TestDialerAuditWriteFailureMakesReadinessFailClosed(t *testing.T) {
	t.Parallel()
	resolver := &sequenceResolver{}
	connector := &recordingConnector{}
	auditSink := newCaptureAudit()
	auditSink.writeErr = errors.New("sink unavailable")
	fixture := newServerFixture(t, resolver, connector, auditSink)
	defer fixture.close(t)
	client := fixture.connect(t, fixture.identities.valid, "http/1.1")
	_, _ = client.Write([]byte("GET / HTTP/1.1\r\nHost: " + targetHostname + "\r\n\r\n"))
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	_, _ = io.ReadAll(client)
	_ = client.Close()
	deadline := time.Now().Add(time.Second)
	for fixture.server.Ready() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if fixture.server.Ready() || !fixture.server.FailedClosed() || resolver.callCount() != 0 || len(connector.addresses()) != 0 {
		t.Fatal("audit write failure did not close listener before policy work")
	}
}

type sequenceResolver struct {
	mu      sync.Mutex
	results []dnsresolver.Resolution
	errors  []error
	delay   time.Duration
	calls   int
}

func (r *sequenceResolver) Resolve(ctx context.Context, absolute string) (dnsresolver.Resolution, error) {
	if absolute != targetHostname+"." {
		return dnsresolver.Resolution{}, errors.New("unexpected absolute name")
	}
	if r.delay > 0 {
		select {
		case <-time.After(r.delay):
		case <-ctx.Done():
			return dnsresolver.Resolution{}, ctx.Err()
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	index := r.calls
	r.calls++
	if index < len(r.errors) && r.errors[index] != nil {
		return dnsresolver.Resolution{}, r.errors[index]
	}
	if index >= len(r.results) {
		return dnsresolver.Resolution{}, errors.New("no fixture resolution")
	}
	return r.results[index], nil
}

func (r *sequenceResolver) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

type recordingConnector struct {
	mu      sync.Mutex
	calls   []netip.AddrPort
	connect func(context.Context, netip.AddrPort) (net.Conn, error)
}

func (c *recordingConnector) Connect(ctx context.Context, address netip.AddrPort) (net.Conn, error) {
	c.mu.Lock()
	c.calls = append(c.calls, address)
	c.mu.Unlock()
	if c.connect == nil {
		return nil, errors.New("no target")
	}
	return c.connect(ctx, address)
}

func (c *recordingConnector) addresses() []netip.AddrPort {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]netip.AddrPort(nil), c.calls...)
}

type captureAudit struct {
	mu           sync.Mutex
	events       chan audit.Event
	preflightErr error
	writeErr     error
}

func newCaptureAudit() *captureAudit {
	return &captureAudit{events: make(chan audit.Event, 16)}
}

func (a *captureAudit) Preflight() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.preflightErr
}

func (a *captureAudit) Write(event audit.Event) error {
	a.mu.Lock()
	err := a.writeErr
	a.mu.Unlock()
	if err == nil {
		a.events <- event
	}
	return err
}

func (a *captureAudit) next(t *testing.T) audit.Event {
	t.Helper()
	select {
	case event := <-a.events:
		return event
	case <-time.After(time.Second):
		t.Fatal("audit event not emitted")
		return audit.Event{}
	}
}

type privateListener struct {
	connections chan net.Conn
	closed      chan struct{}
	once        sync.Once
}

func newPrivateListener() *privateListener {
	return &privateListener{connections: make(chan net.Conn, 16), closed: make(chan struct{})}
}

func (l *privateListener) Accept() (net.Conn, error) {
	select {
	case connection := <-l.connections:
		return connection, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *privateListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *privateListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("fdaa::1234"), Port: 9443}
}

func (l *privateListener) offer(connection net.Conn) {
	l.connections <- connection
}

type testIdentities struct {
	valid    tls.Certificate
	wrongURI tls.Certificate
	wrongCA  tls.Certificate
	expired  tls.Certificate
	rootCAs  *x509.CertPool
}

type serverFixture struct {
	server     *proxy.Server
	listener   *privateListener
	identities testIdentities
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan error
}

func newServerFixture(t *testing.T, resolver proxy.Resolver, connector proxy.Connector, auditSink proxy.AuditSink) *serverFixture {
	t.Helper()
	return newServerFixtureWithBudget(t, resolver, connector, auditSink, 500*time.Millisecond)
}

func newServerFixtureWithBudget(t *testing.T, resolver proxy.Resolver, connector proxy.Connector, auditSink proxy.AuditSink, budget time.Duration) *serverFixture {
	t.Helper()
	serverTLS, identities := makeTestPKI(t)
	domainPolicy, err := policy.NewDomainPolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := limits.New(limits.DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	server, err := proxy.NewServer(proxy.ServerConfig{
		TLSConfig:            serverTLS,
		AllowedClientURI:     allowedClientURI,
		Resolver:             resolver,
		DomainPolicy:         domainPolicy,
		Connector:            connector,
		Limiter:              limiter,
		Audit:                auditSink,
		AuditPepper:          []byte(strings.Repeat("p", 32)),
		PolicyVersion:        policy.PolicyFingerprint,
		ImageDigest:          "sha256:" + strings.Repeat("a", 64),
		DNSConnectBudget:     budget,
		HandshakeTimeout:     time.Second,
		ConnectHeaderBytes:   proxy.DefaultMaxConnectHeaderBytes,
		ConnectHeaderTimeout: time.Second,
		MaxPendingHandshakes: proxy.DefaultMaxHandshakes,
		Relay: proxy.RelayConfig{
			IdleTimeout: 500 * time.Millisecond, MaxRequestBytes: 64, MaxResponseBytes: 64,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	listener := newPrivateListener()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	deadline := time.Now().Add(time.Second)
	for !server.Ready() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !server.Ready() {
		t.Fatal("server did not become ready")
	}
	return &serverFixture{server: server, listener: listener, identities: identities, ctx: ctx, cancel: cancel, done: done}
}

func (f *serverFixture) clientTLS(identity tls.Certificate, protocol string) *tls.Config {
	configuration := &tls.Config{
		RootCAs: f.identities.rootCAs, ServerName: "dialer.test", MinVersion: tls.VersionTLS12,
		NextProtos: []string{protocol},
	}
	if len(identity.Certificate) > 0 {
		configuration.Certificates = []tls.Certificate{identity}
	}
	return configuration
}

func (f *serverFixture) connect(t *testing.T, identity tls.Certificate, protocol string) *tls.Conn {
	t.Helper()
	serverSide, clientSide := net.Pipe()
	f.listener.offer(serverSide)
	connection := tls.Client(clientSide, f.clientTLS(identity, protocol))
	if err := connection.Handshake(); err != nil {
		t.Fatal(err)
	}
	return connection
}

func (f *serverFixture) close(t *testing.T) {
	t.Helper()
	f.cancel()
	_ = f.listener.Close()
	select {
	case err := <-f.done:
		if err != nil {
			t.Errorf("server shutdown: %v", err)
		}
	case <-time.After(time.Second):
		t.Error("server did not stop")
	}
}

func sendConnect(t *testing.T, connection *tls.Conn, hostname string) *bufio.Reader {
	t.Helper()
	request := "CONNECT " + hostname + ":443 HTTP/1.1\r\nHost: " + hostname + ":443\r\n\r\n"
	if _, err := connection.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	status, err := reader.ReadString('\n')
	if err != nil || status != "HTTP/1.1 200 Connection Established\r\n" {
		t.Fatalf("CONNECT status = %q, %v", status, err)
	}
	blank, err := reader.ReadString('\n')
	if err != nil || blank != "\r\n" {
		t.Fatalf("CONNECT terminator = %q, %v", blank, err)
	}
	return reader
}

func sendConnectExpectError(t *testing.T, connection *tls.Conn, hostname string) string {
	t.Helper()
	request := "CONNECT " + hostname + ":443 HTTP/1.1\r\nHost: " + hostname + ":443\r\n\r\n"
	if _, err := connection.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	status, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func makeTestPKI(t *testing.T) (*tls.Config, testIdentities) {
	t.Helper()
	root := t.TempDir()
	caCertificate, caKey, caPEM := issueCA(t, "test client CA")
	serverCertificate, serverKey := issueLeaf(t, caCertificate, caKey, leafOptions{
		commonName: "dialer.test", dnsNames: []string{"dialer.test"}, usages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	validCertificate, validKey := issueLeaf(t, caCertificate, caKey, leafOptions{
		commonName: "interceptor", uri: allowedClientURI, usages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	})
	wrongCertificate, wrongKey := issueLeaf(t, caCertificate, caKey, leafOptions{
		commonName: "wrong", uri: "spiffe://maintainflow/wrong", usages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	})
	expiredCertificate, expiredKey := issueLeaf(t, caCertificate, caKey, leafOptions{
		commonName: "expired", uri: allowedClientURI, usages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, expired: true,
	})
	otherCA, otherKey, _ := issueCA(t, "untrusted CA")
	otherCertificate, otherLeafKey := issueLeaf(t, otherCA, otherKey, leafOptions{
		commonName: "untrusted", uri: allowedClientURI, usages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	})

	serverCertificatePath := filepath.Join(root, "server.crt")
	serverKeyPath := filepath.Join(root, "server.key")
	clientCAPath := filepath.Join(root, "client-ca.crt")
	writePEM(t, serverCertificatePath, "CERTIFICATE", serverCertificate)
	writeECKey(t, serverKeyPath, serverKey)
	if err := os.WriteFile(clientCAPath, caPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	serverTLS, err := config.ServerTLSConfig(serverCertificatePath, serverKeyPath, clientCAPath, allowedClientURI)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(caPEM)
	return serverTLS, testIdentities{
		valid:    tlsKeyPair(t, validCertificate, validKey),
		wrongURI: tlsKeyPair(t, wrongCertificate, wrongKey),
		wrongCA:  tlsKeyPair(t, otherCertificate, otherLeafKey),
		expired:  tlsKeyPair(t, expiredCertificate, expiredKey),
		rootCAs:  roots,
	}
}

type leafOptions struct {
	commonName string
	uri        string
	dnsNames   []string
	usages     []x509.ExtKeyUsage
	expired    bool
}

func issueCA(t *testing.T, commonName string) (*x509.Certificate, *ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: commonName},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return certificate, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func issueLeaf(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, options leafOptions) ([]byte, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	notBefore, notAfter := time.Now().Add(-time.Hour), time.Now().Add(12*time.Hour)
	if options.expired {
		notBefore, notAfter = time.Now().Add(-2*time.Hour), time.Now().Add(-time.Hour)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: options.commonName},
		NotBefore: notBefore, NotAfter: notAfter, DNSNames: options.dnsNames,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: options.usages,
	}
	if options.uri != "" {
		parsed, parseErr := url.Parse(options.uri)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		template.URIs = []*url.URL{parsed}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return der, key
}

func tlsKeyPair(t *testing.T, certificate []byte, key *ecdsa.PrivateKey) tls.Certificate {
	t.Helper()
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	return pair
}

func writePEM(t *testing.T, path, blockType string, contents []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: contents}), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeECKey(t *testing.T, path string, key *ecdsa.PrivateKey) {
	t.Helper()
	contents, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	writePEM(t, path, "EC PRIVATE KEY", contents)
}
