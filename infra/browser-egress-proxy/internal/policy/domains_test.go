package policy

import (
	"strings"
	"testing"
)

func TestDomainPolicyBoundaries(t *testing.T) {
	t.Parallel()
	policy, err := NewDomainPolicy([]string{"blocked.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		host    string
		allowed bool
		reason  ReasonCode
	}{
		{host: "public.example.com", allowed: true, reason: ReasonAllowed},
		{host: "blocked.example.com", reason: ReasonBlockedDomain},
		{host: "sub.blocked.example.com", reason: ReasonBlockedDomain},
		{host: "notblocked.example.com", allowed: true, reason: ReasonAllowed},
		{host: "metadata.google.internal", reason: ReasonBlockedDomain},
		{host: "a.metadata.google.internal", reason: ReasonBlockedDomain},
		{host: "host.docker.internal", reason: ReasonBlockedDomain},
		{host: "service.flycast", reason: ReasonBlockedDomain},
		{host: "service.internal", reason: ReasonBlockedDomain},
		{host: "127.0.0.1", reason: ReasonInvalidDomain},
	}
	for _, test := range tests {
		decision := policy.Evaluate(test.host)
		if decision.Allowed != test.allowed || decision.Reason != test.reason {
			t.Errorf("Evaluate(%q) = %+v, want allowed=%v reason=%s", test.host, decision, test.allowed, test.reason)
		}
	}
}

func TestZeroValueDomainPolicyFailsClosed(t *testing.T) {
	t.Parallel()
	if decision := (DomainPolicy{}).Evaluate("public.example.com"); decision.Allowed || decision.Reason != ReasonInvalidDomain {
		t.Fatalf("zero-value policy did not fail closed: %+v", decision)
	}
}

func TestLoadDomainDenylist(t *testing.T) {
	t.Parallel()
	contents := "# reviewed\nversion: 1\ndomains:\n  - blocked.example\n  - other.example\n"
	domains, err := LoadDomainDenylist(strings.NewReader(contents))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(domains, ",") != "blocked.example,other.example" {
		t.Fatalf("domains = %v", domains)
	}
	for _, malformed := range []string{
		"version: 1\n- blocked.example\n",
		"version: 1\ndomains:\nblocked.example\n",
		"version: 1\ndomains:\n- \"blocked.example\"\n",
		"version: 1\nother:\n- blocked.example\n",
	} {
		if _, err := LoadDomainDenylist(strings.NewReader(malformed)); err == nil {
			t.Fatalf("malformed denylist unexpectedly accepted: %q", malformed)
		}
	}
}
