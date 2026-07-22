package config

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"maintainflow/browser-egress-proxy/internal/dnsresolver"
)

const MinimumAuditPepperBytes = 32

var policyVersionPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,96}$`)

type Config struct {
	ResolverEndpoints []dnsresolver.Endpoint
	AuditPepper       []byte
	PolicyVersion     string
	ResolutionBudget  time.Duration
}

func (c Config) Validate() error {
	if len(c.ResolverEndpoints) != 2 {
		return errors.New("exactly two DNS-over-TLS resolver endpoints are required")
	}
	for _, endpoint := range c.ResolverEndpoints {
		if err := endpoint.Validate(); err != nil {
			return err
		}
	}
	if c.ResolverEndpoints[0].Address == c.ResolverEndpoints[1].Address ||
		c.ResolverEndpoints[0].ServerName == c.ResolverEndpoints[1].ServerName {
		return errors.New("DNS-over-TLS resolver endpoints must be independent")
	}
	if len(c.AuditPepper) < MinimumAuditPepperBytes {
		return errors.New("audit pepper must contain at least 32 bytes")
	}
	if strings.TrimSpace(c.PolicyVersion) == "" || !policyVersionPattern.MatchString(c.PolicyVersion) {
		return errors.New("bounded policy version is required")
	}
	if c.ResolutionBudget <= 0 || c.ResolutionBudget > 5*time.Second {
		return errors.New("DNS and connect budget must be positive and no more than five seconds")
	}
	return nil
}
