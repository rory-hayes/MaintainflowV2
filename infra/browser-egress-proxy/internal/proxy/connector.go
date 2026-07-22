package proxy

import (
	"context"
	"errors"
	"net"
	"net/netip"

	"maintainflow/browser-egress-proxy/internal/policy"
)

type Connector interface {
	Connect(context.Context, netip.AddrPort) (net.Conn, error)
}

type dialContextFunc func(context.Context, string, string) (net.Conn, error)

// ExactConnector accepts a previously selected numeric address and passes that
// exact address to one kernel dial. It has no hostname, resolver, fallback,
// retry, or Happy Eyeballs path.
type ExactConnector struct {
	dial dialContextFunc
}

func NewExactConnector() *ExactConnector {
	dialer := &net.Dialer{KeepAlive: -1}
	return &ExactConnector{dial: dialer.DialContext}
}

func newExactConnector(dial dialContextFunc) (*ExactConnector, error) {
	if dial == nil {
		return nil, errors.New("exact dial function is required")
	}
	return &ExactConnector{dial: dial}, nil
}

func (c *ExactConnector) Connect(ctx context.Context, address netip.AddrPort) (net.Conn, error) {
	if c == nil || c.dial == nil || !address.IsValid() || address.Port() != 443 || address.Addr().Zone() != "" {
		return nil, errors.New("invalid exact target address")
	}
	if decision := policy.ClassifyAddress(address.Addr()); !decision.Allowed {
		return nil, errors.New("exact target address is not public")
	}
	connection, err := c.dial(ctx, "tcp", address.String())
	if err != nil {
		return nil, errors.New("exact target connect failed")
	}
	return connection, nil
}
