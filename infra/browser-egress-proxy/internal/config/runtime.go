package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"maintainflow/browser-egress-proxy/internal/dnsresolver"
	"maintainflow/browser-egress-proxy/internal/limits"
	"maintainflow/browser-egress-proxy/internal/policy"
	"maintainflow/browser-egress-proxy/internal/proxy"
)

const (
	DialerPort                  = 9443
	DefaultHealthAddress        = "127.0.0.1:8081"
	DefaultDNSConnectBudget     = 5 * time.Second
	MaximumRuntimePolicyBytes   = 1 << 20
	requiredResolverDescription = "IP:853|tls-name,IP:853|tls-name"
)

var imageDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type RuntimeConfig struct {
	ListenAddress        netip.AddrPort
	HealthAddress        netip.AddrPort
	TLSCertificateFile   string
	TLSPrivateKeyFile    string
	ClientCAFile         string
	AllowedClientURI     string
	ResolverEndpoints    []dnsresolver.Endpoint
	AuditPepper          []byte
	ImageDigest          string
	PolicyVersion        string
	DomainDenylistFile   string
	DNSConnectBudget     time.Duration
	ConnectHeaderBytes   int
	ConnectHeaderTimeout time.Duration
	Limiter              limits.Config
	Relay                proxy.RelayConfig
}

func LoadRuntimeFromEnv() (RuntimeConfig, error) {
	return LoadRuntime(os.Getenv)
}

func LoadRuntime(getenv func(string) string) (RuntimeConfig, error) {
	if getenv == nil {
		return RuntimeConfig{}, errors.New("runtime environment reader is required")
	}
	listen, err := netip.ParseAddrPort(strings.TrimSpace(getenv("MF_DIALER_LISTEN_ADDR")))
	if err != nil {
		return RuntimeConfig{}, errors.New("MF_DIALER_LISTEN_ADDR must be a numeric private address on port 9443")
	}
	healthRaw := strings.TrimSpace(getenv("MF_DIALER_HEALTH_ADDR"))
	if healthRaw == "" {
		healthRaw = DefaultHealthAddress
	}
	health, err := netip.ParseAddrPort(healthRaw)
	if err != nil {
		return RuntimeConfig{}, errors.New("MF_DIALER_HEALTH_ADDR must be a numeric loopback address")
	}
	resolvers, err := parseResolverEndpoints(getenv("MF_DIALER_DOT_RESOLVERS"))
	if err != nil {
		return RuntimeConfig{}, err
	}
	configuration := RuntimeConfig{
		ListenAddress:        listen,
		HealthAddress:        health,
		TLSCertificateFile:   strings.TrimSpace(getenv("MF_DIALER_TLS_CERT_FILE")),
		TLSPrivateKeyFile:    strings.TrimSpace(getenv("MF_DIALER_TLS_KEY_FILE")),
		ClientCAFile:         strings.TrimSpace(getenv("MF_DIALER_CLIENT_CA_FILE")),
		AllowedClientURI:     strings.TrimSpace(getenv("MF_DIALER_ALLOWED_CLIENT_SPIFFE_ID")),
		ResolverEndpoints:    resolvers,
		AuditPepper:          []byte(getenv("MF_DIALER_AUDIT_PEPPER")),
		ImageDigest:          strings.TrimSpace(getenv("MF_DIALER_IMAGE_DIGEST")),
		PolicyVersion:        policy.PolicyFingerprint,
		DomainDenylistFile:   strings.TrimSpace(getenv("MF_DIALER_DOMAIN_DENYLIST_FILE")),
		DNSConnectBudget:     DefaultDNSConnectBudget,
		ConnectHeaderBytes:   proxy.DefaultMaxConnectHeaderBytes,
		ConnectHeaderTimeout: proxy.DefaultConnectHeaderTimeout,
		Limiter:              limits.DefaultConfig(),
		Relay:                proxy.DefaultRelayConfig(),
	}
	if err := configuration.Validate(); err != nil {
		return RuntimeConfig{}, err
	}
	return configuration, nil
}

func (c RuntimeConfig) Validate() error {
	if !c.ListenAddress.IsValid() || c.ListenAddress.Port() != DialerPort ||
		policy.ClassifyAddress(c.ListenAddress.Addr()).Class != policy.ClassBlockedFlyPrivate {
		return errors.New("dialer listener must be an exact Fly-private numeric address on port 9443")
	}
	if !c.HealthAddress.IsValid() || c.HealthAddress.Port() == 0 || !c.HealthAddress.Addr().IsLoopback() {
		return errors.New("health listener must be an exact numeric loopback address")
	}
	for _, path := range []string{c.TLSCertificateFile, c.TLSPrivateKeyFile, c.ClientCAFile, c.DomainDenylistFile} {
		if path == "" || !filepath.IsAbs(path) {
			return errors.New("runtime certificate, key, CA, and policy paths must be absolute")
		}
	}
	parsedURI, err := url.Parse(c.AllowedClientURI)
	if err != nil || parsedURI.Scheme != "spiffe" || parsedURI.Host == "" || parsedURI.User != nil ||
		parsedURI.RawQuery != "" || parsedURI.Fragment != "" || parsedURI.String() != c.AllowedClientURI {
		return errors.New("one exact SPIFFE client URI is required")
	}
	base := Config{
		ResolverEndpoints: c.ResolverEndpoints,
		AuditPepper:       c.AuditPepper,
		PolicyVersion:     c.PolicyVersion,
		ResolutionBudget:  c.DNSConnectBudget,
	}
	if err := base.Validate(); err != nil {
		return err
	}
	if c.PolicyVersion != policy.PolicyFingerprint || !imageDigestPattern.MatchString(c.ImageDigest) {
		return errors.New("immutable policy fingerprint and image digest are required")
	}
	if c.DNSConnectBudget != DefaultDNSConnectBudget ||
		c.ConnectHeaderBytes != proxy.DefaultMaxConnectHeaderBytes ||
		c.ConnectHeaderTimeout != proxy.DefaultConnectHeaderTimeout ||
		c.Limiter != limits.DefaultConfig() || c.Relay != proxy.DefaultRelayConfig() {
		return errors.New("runtime safety limits do not match the reviewed profile")
	}
	return nil
}

func (c RuntimeConfig) ValidateFiles() error {
	for _, path := range []string{c.TLSCertificateFile, c.TLSPrivateKeyFile, c.ClientCAFile, c.DomainDenylistFile} {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > MaximumRuntimePolicyBytes {
			return errors.New("a required runtime file is missing, empty, oversized, or not regular")
		}
	}
	return nil
}

func LoadVerifiedDomainPolicy(path string) (policy.DomainPolicy, error) {
	file, err := os.Open(path)
	if err != nil {
		return policy.DomainPolicy{}, errors.New("read immutable domain denylist")
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, MaximumRuntimePolicyBytes+1))
	if err != nil || len(contents) == 0 || len(contents) > MaximumRuntimePolicyBytes {
		return policy.DomainPolicy{}, errors.New("read immutable domain denylist")
	}
	digest := sha256.Sum256(contents)
	if hex.EncodeToString(digest[:]) != policy.DomainDenylistSHA256 {
		return policy.DomainPolicy{}, errors.New("domain denylist fingerprint mismatch")
	}
	domains, err := policy.LoadDomainDenylist(strings.NewReader(string(contents)))
	if err != nil {
		return policy.DomainPolicy{}, errors.New("parse immutable domain denylist")
	}
	return policy.NewDomainPolicy(domains)
}

func parseResolverEndpoints(raw string) ([]dnsresolver.Endpoint, error) {
	values := strings.Split(strings.TrimSpace(raw), ",")
	if len(values) != 2 {
		return nil, errors.New("MF_DIALER_DOT_RESOLVERS must use " + requiredResolverDescription)
	}
	result := make([]dnsresolver.Endpoint, 0, 2)
	for _, value := range values {
		addressRaw, serverName, ok := strings.Cut(strings.TrimSpace(value), "|")
		address, parseErr := netip.ParseAddrPort(addressRaw)
		endpoint := dnsresolver.Endpoint{Address: address, ServerName: serverName}
		if !ok || parseErr != nil || endpoint.Validate() != nil {
			return nil, errors.New("MF_DIALER_DOT_RESOLVERS must use " + requiredResolverDescription)
		}
		result = append(result, endpoint)
	}
	return result, nil
}
