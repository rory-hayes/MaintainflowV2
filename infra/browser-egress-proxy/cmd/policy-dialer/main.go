package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"maintainflow/browser-egress-proxy/internal/audit"
	"maintainflow/browser-egress-proxy/internal/config"
	"maintainflow/browser-egress-proxy/internal/dnsresolver"
	"maintainflow/browser-egress-proxy/internal/health"
	"maintainflow/browser-egress-proxy/internal/limits"
	"maintainflow/browser-egress-proxy/internal/proxy"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "policy dialer stopped because a required startup or runtime gate failed")
		os.Exit(1)
	}
}

func run() error {
	runtimeConfig, err := config.LoadRuntimeFromEnv()
	if err != nil {
		return errors.New("invalid runtime configuration")
	}
	if err := runtimeConfig.ValidateFiles(); err != nil {
		return errors.New("invalid runtime files")
	}
	domainPolicy, err := config.LoadVerifiedDomainPolicy(runtimeConfig.DomainDenylistFile)
	if err != nil {
		return errors.New("invalid immutable domain policy")
	}
	tlsConfig, err := config.ServerTLSConfig(
		runtimeConfig.TLSCertificateFile,
		runtimeConfig.TLSPrivateKeyFile,
		runtimeConfig.ClientCAFile,
		runtimeConfig.AllowedClientURI,
	)
	if err != nil {
		return errors.New("invalid mTLS identity")
	}
	limiter, err := limits.New(runtimeConfig.Limiter)
	if err != nil {
		return errors.New("invalid limiter profile")
	}
	auditLogger, err := audit.NewLogger(os.Stdout)
	if err != nil || auditLogger.Preflight() != nil {
		return errors.New("audit encoder is unavailable")
	}
	resolver, err := dnsresolver.New(runtimeConfig.ResolverEndpoints, dnsresolver.TLSQueryClient{}, domainPolicy)
	if err != nil {
		return errors.New("DNS-over-TLS resolver configuration is invalid")
	}
	dialer, err := proxy.NewServer(proxy.ServerConfig{
		TLSConfig:            tlsConfig,
		AllowedClientURI:     runtimeConfig.AllowedClientURI,
		Resolver:             resolver,
		DomainPolicy:         domainPolicy,
		Connector:            proxy.NewExactConnector(),
		Limiter:              limiter,
		Audit:                auditLogger,
		AuditPepper:          runtimeConfig.AuditPepper,
		PolicyVersion:        runtimeConfig.PolicyVersion,
		ImageDigest:          runtimeConfig.ImageDigest,
		DNSConnectBudget:     runtimeConfig.DNSConnectBudget,
		HandshakeTimeout:     proxy.DefaultHandshakeTimeout,
		ConnectHeaderBytes:   runtimeConfig.ConnectHeaderBytes,
		ConnectHeaderTimeout: runtimeConfig.ConnectHeaderTimeout,
		MaxPendingHandshakes: proxy.DefaultMaxHandshakes,
		Relay:                runtimeConfig.Relay,
	})
	if err != nil {
		return errors.New("dialer server validation failed")
	}
	healthServer, err := health.New(dialer.Ready)
	if err != nil {
		return errors.New("health server validation failed")
	}

	// Listener binding happens only after every secret, policy, resolver,
	// limiter, audit, and TLS gate above has passed.
	dialerListener, err := net.Listen("tcp", runtimeConfig.ListenAddress.String())
	if err != nil {
		return errors.New("private dialer listener failed")
	}
	healthListener, err := net.Listen("tcp", runtimeConfig.HealthAddress.String())
	if err != nil {
		_ = dialerListener.Close()
		return errors.New("loopback health listener failed")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 2)
	go func() { errCh <- dialer.Serve(ctx, dialerListener) }()
	go func() { errCh <- healthServer.Serve(ctx, healthListener) }()

	first := <-errCh
	failedClosed := dialer.FailedClosed()
	stop()
	_ = dialerListener.Close()
	_ = healthListener.Close()
	second := <-errCh
	if first != nil || second != nil || failedClosed {
		return errors.New("dialer runtime failed closed")
	}
	return nil
}
