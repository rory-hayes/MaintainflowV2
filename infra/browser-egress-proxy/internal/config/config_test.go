package config

import (
	"bytes"
	"net/netip"
	"testing"
	"time"

	"maintainflow/browser-egress-proxy/internal/dnsresolver"
)

func validConfig() Config {
	return Config{
		ResolverEndpoints: []dnsresolver.Endpoint{
			{Address: netip.MustParseAddrPort("1.1.1.1:853"), ServerName: "one.example"},
			{Address: netip.MustParseAddrPort("9.9.9.9:853"), ServerName: "two.example"},
		},
		AuditPepper:      bytes.Repeat([]byte{'p'}, 32),
		PolicyVersion:    "policy-2026-07-19.1",
		ResolutionBudget: 5 * time.Second,
	}
}

func TestConfigValidate(t *testing.T) {
	t.Parallel()
	if err := validConfig().Validate(); err != nil {
		t.Fatalf("valid config failed: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "one resolver", mutate: func(c *Config) { c.ResolverEndpoints = c.ResolverEndpoints[:1] }},
		{name: "duplicate resolver", mutate: func(c *Config) { c.ResolverEndpoints[1] = c.ResolverEndpoints[0] }},
		{name: "resolver hostname", mutate: func(c *Config) { c.ResolverEndpoints[0].Address = netip.MustParseAddrPort("1.1.1.1:443") }},
		{name: "private resolver", mutate: func(c *Config) { c.ResolverEndpoints[0].Address = netip.MustParseAddrPort("10.0.0.1:853") }},
		{name: "short pepper", mutate: func(c *Config) { c.AuditPepper = []byte("short") }},
		{name: "empty version", mutate: func(c *Config) { c.PolicyVersion = "" }},
		{name: "unsafe version", mutate: func(c *Config) { c.PolicyVersion = "policy with spaces" }},
		{name: "long timeout", mutate: func(c *Config) { c.ResolutionBudget = 5*time.Second + time.Nanosecond }},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			config := validConfig()
			test.mutate(&config)
			if err := config.Validate(); err == nil {
				t.Fatal("invalid config unexpectedly passed")
			}
		})
	}
}
