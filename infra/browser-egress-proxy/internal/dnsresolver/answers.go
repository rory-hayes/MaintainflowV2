package dnsresolver

import (
	"errors"
	"net/netip"
)

type Status string

const (
	StatusSuccess  Status = "success"
	StatusNoData   Status = "nodata"
	StatusNXDomain Status = "nxdomain"
)

var (
	ErrInvalidName          = errors.New("DNS name must be normalized and absolute")
	ErrInvalidResponse      = errors.New("invalid DNS response")
	ErrTruncatedResponse    = errors.New("truncated DNS response")
	ErrNXDomain             = errors.New("DNS name does not exist")
	ErrNoData               = errors.New("DNS name has no address data")
	ErrInconsistentResponse = errors.New("inconsistent DNS resolver response")
	ErrCNAMELoop            = errors.New("CNAME loop")
	ErrCNAMEDepth           = errors.New("CNAME depth exceeded")
	ErrBlockedName          = errors.New("DNS name is blocked by domain policy")
)

type Resolution struct {
	Status    Status
	Names     []string
	Addresses []netip.Addr
}
