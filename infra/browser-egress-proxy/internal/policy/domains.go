package policy

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"maintainflow/browser-egress-proxy/internal/authority"
)

type DomainDecision struct {
	Allowed bool
	Reason  ReasonCode
}

type DomainPolicy struct {
	denied      []string
	initialized bool
}

var builtInDeniedSuffixes = []string{
	"localhost",
	"local",
	"localdomain",
	"internal",
	"home.arpa",
	"lan",
	"corp",
	"test",
	"invalid",
	"example",
	"onion",
	"alt",
	"arpa",
	"svc",
	"metadata.google.internal",
	"metadata.google",
	"instance-data.ec2.internal",
	"metadata.azure.internal",
	"host.docker.internal",
	"gateway.docker.internal",
	"docker.internal",
	"kubernetes.default.svc",
	"flycast",
	"fly-local-6pn.internal",
}

func NewDomainPolicy(configured []string) (DomainPolicy, error) {
	policy := DomainPolicy{denied: append([]string(nil), builtInDeniedSuffixes...), initialized: true}
	for _, raw := range configured {
		raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "."))
		if raw == "" {
			continue
		}
		normalized, err := authority.NormalizeHostname(raw)
		if err != nil {
			return DomainPolicy{}, fmt.Errorf("invalid denylist domain")
		}
		policy.denied = append(policy.denied, normalized)
	}
	return policy, nil
}

func (p DomainPolicy) Evaluate(raw string) DomainDecision {
	if !p.initialized {
		return DomainDecision{Reason: ReasonInvalidDomain}
	}
	normalized, err := authority.NormalizeHostname(raw)
	if err != nil {
		return DomainDecision{Reason: ReasonInvalidDomain}
	}
	for _, suffix := range p.denied {
		if normalized == suffix || strings.HasSuffix(normalized, "."+suffix) {
			return DomainDecision{Reason: ReasonBlockedDomain}
		}
	}
	return DomainDecision{Allowed: true, Reason: ReasonAllowed}
}

func (p DomainPolicy) Ready() bool {
	return p.initialized
}

// LoadDomainDenylist parses the intentionally tiny checked-in YAML shape. It
// supports only a top-level `domains:` list and rejects unknown content so the
// policy does not gain a general YAML parser or ambiguous features.
func LoadDomainDenylist(reader io.Reader) ([]string, error) {
	scanner := bufio.NewScanner(reader)
	seenHeader := false
	domains := make([]string, 0)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "version:") {
			continue
		}
		if line == "domains:" {
			seenHeader = true
			continue
		}
		if !seenHeader || !strings.HasPrefix(line, "- ") {
			return nil, fmt.Errorf("unsupported denylist syntax")
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, "- "))
		if value == "" || strings.ContainsAny(value, "\"'{}[]#") {
			return nil, fmt.Errorf("invalid denylist value")
		}
		domains = append(domains, value)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read denylist: %w", err)
	}
	if !seenHeader {
		return nil, fmt.Errorf("denylist domains section is required")
	}
	return domains, nil
}
