package dnsresolver

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/netip"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"maintainflow/browser-egress-proxy/internal/authority"
	"maintainflow/browser-egress-proxy/internal/policy"
)

const (
	DNSOverTLSPort = 853
	MaxCNAMEDepth  = 8
	queryTimeout   = 5 * time.Second
)

type Endpoint struct {
	Address    netip.AddrPort
	ServerName string
}

func (e Endpoint) Validate() error {
	if !e.Address.IsValid() || e.Address.Port() != DNSOverTLSPort || e.Address.Addr().Zone() != "" {
		return errors.New("resolver endpoint must be a fixed IP on port 853")
	}
	if decision := policy.ClassifyAddress(e.Address.Addr()); !decision.Allowed {
		return errors.New("resolver endpoint must use a public IP")
	}
	normalized, err := authority.NormalizeHostname(e.ServerName)
	if err != nil || normalized != e.ServerName {
		return errors.New("resolver TLS server name must be normalized")
	}
	return nil
}

type QueryClient interface {
	Query(ctx context.Context, endpoint Endpoint, absoluteName string, queryType uint16) (*dns.Msg, error)
}

// TLSQueryClient sends one DNS query over a new certificate-verified TLS
// connection to the endpoint's numeric bootstrap address. It never invokes the
// operating-system resolver and does not retry.
type TLSQueryClient struct {
	RootCAs  *x509.CertPool
	exchange func(context.Context, *dns.Client, *dns.Msg, string) (*dns.Msg, time.Duration, error)
}

func (c TLSQueryClient) Query(
	ctx context.Context,
	endpoint Endpoint,
	absoluteName string,
	queryType uint16,
) (*dns.Msg, error) {
	if err := endpoint.Validate(); err != nil {
		return nil, err
	}
	if queryType != dns.TypeA && queryType != dns.TypeAAAA {
		return nil, errors.New("unsupported DNS query type")
	}
	if _, err := normalizeAbsoluteName(absoluteName); err != nil {
		return nil, err
	}

	request := new(dns.Msg)
	request.SetQuestion(absoluteName, queryType)
	request.RecursionDesired = true
	client := &dns.Client{
		Net:     "tcp-tls",
		Timeout: queryTimeout,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: endpoint.ServerName,
			RootCAs:    c.RootCAs,
		},
	}
	exchange := c.exchange
	if exchange == nil {
		exchange = func(ctx context.Context, client *dns.Client, request *dns.Msg, address string) (*dns.Msg, time.Duration, error) {
			return client.ExchangeContext(ctx, request, address)
		}
	}
	response, _, err := exchange(ctx, client, request, endpoint.Address.String())
	if err != nil {
		return nil, fmt.Errorf("DNS-over-TLS query failed: %w", err)
	}
	if response == nil || response.Id != request.Id || !response.Response {
		return nil, ErrInvalidResponse
	}
	return response, nil
}

type Resolver struct {
	endpoints [2]Endpoint
	client    QueryClient
	names     NamePolicy
}

type NamePolicy interface {
	Evaluate(raw string) policy.DomainDecision
}

type readyNamePolicy interface {
	Ready() bool
}

func New(endpoints []Endpoint, client QueryClient, names NamePolicy) (*Resolver, error) {
	if len(endpoints) != 2 {
		return nil, errors.New("exactly two DNS-over-TLS resolvers are required")
	}
	if client == nil {
		return nil, errors.New("DNS query client is required")
	}
	if namePolicyIsNil(names) {
		return nil, errors.New("domain policy is required")
	}
	if ready, ok := names.(readyNamePolicy); ok && !ready.Ready() {
		return nil, errors.New("domain policy is not initialized")
	}
	for _, endpoint := range endpoints {
		if err := endpoint.Validate(); err != nil {
			return nil, err
		}
	}
	if endpoints[0].Address == endpoints[1].Address || endpoints[0].ServerName == endpoints[1].ServerName {
		return nil, errors.New("DNS-over-TLS resolvers must be independent")
	}
	return &Resolver{endpoints: [2]Endpoint{endpoints[0], endpoints[1]}, client: client, names: names}, nil
}

func namePolicyIsNil(names NamePolicy) bool {
	if names == nil {
		return true
	}
	value := reflect.ValueOf(names)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

// Resolve queries both configured fixed-IP DNS-over-TLS resolvers. Each
// resolver must return a valid result; no resolver is a fallback for the other.
// Public answer differences are combined for later all-answer policy review.
func (r *Resolver) Resolve(ctx context.Context, absoluteName string) (Resolution, error) {
	normalized, err := normalizeAbsoluteName(absoluteName)
	if err != nil {
		return Resolution{}, err
	}
	if decision := r.names.Evaluate(normalized); !decision.Allowed {
		return Resolution{}, ErrBlockedName
	}

	type indexedResult struct {
		index      int
		resolution Resolution
		err        error
	}
	results := make(chan indexedResult, 2)
	for index, endpoint := range r.endpoints {
		go func(index int, endpoint Endpoint) {
			resolution, resolveErr := r.resolveEndpoint(ctx, endpoint, normalized)
			results <- indexedResult{index: index, resolution: resolution, err: resolveErr}
		}(index, endpoint)
	}

	resolved := make([]Resolution, 2)
	errorsByEndpoint := make([]error, 2)
	for range 2 {
		result := <-results
		resolved[result.index] = result.resolution
		errorsByEndpoint[result.index] = result.err
	}
	for _, resolveErr := range errorsByEndpoint {
		if resolveErr != nil {
			return Resolution{}, resolveErr
		}
	}
	if resolved[0].Status != resolved[1].Status {
		return Resolution{}, ErrInconsistentResponse
	}
	if resolved[0].Status == StatusNXDomain {
		return Resolution{Status: StatusNXDomain, Names: []string{normalized}}, ErrNXDomain
	}
	if resolved[0].Status == StatusNoData {
		return Resolution{Status: StatusNoData, Names: []string{normalized}}, ErrNoData
	}

	return combineResolutions(resolved), nil
}

func (r *Resolver) resolveEndpoint(ctx context.Context, endpoint Endpoint, root string) (Resolution, error) {
	queue := []string{root}
	visited := make(map[string]struct{}, MaxCNAMEDepth+1)
	names := make(map[string]struct{}, MaxCNAMEDepth+1)
	addresses := make(map[netip.Addr]struct{})
	cnameLinks := 0

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if _, seen := visited[current]; seen {
			return Resolution{}, ErrCNAMELoop
		}
		visited[current] = struct{}{}
		names[current] = struct{}{}

		responses, err := r.queryBothFamilies(ctx, endpoint, current+".")
		if err != nil {
			return Resolution{}, err
		}
		if responses[0].Rcode == dns.RcodeNameError || responses[1].Rcode == dns.RcodeNameError {
			if responses[0].Rcode != responses[1].Rcode || current != root || len(visited) != 1 {
				return Resolution{}, ErrInconsistentResponse
			}
			return Resolution{Status: StatusNXDomain, Names: []string{root}}, nil
		}

		targets := make(map[string]struct{})
		var familyTargets [2][]string
		for index, response := range responses {
			queryType := uint16(dns.TypeA)
			if index == 1 {
				queryType = dns.TypeAAAA
			}
			parsed, parseErr := parseResponse(response, current, queryType)
			if parseErr != nil {
				return Resolution{}, parseErr
			}
			familyTargets[index] = parsed.targets
			for _, name := range parsed.names {
				if decision := r.names.Evaluate(name); !decision.Allowed {
					return Resolution{}, ErrBlockedName
				}
			}
			for _, address := range parsed.addresses {
				addresses[address] = struct{}{}
			}
			for _, name := range parsed.names {
				names[name] = struct{}{}
			}
			for _, target := range parsed.targets {
				targets[target] = struct{}{}
			}
		}
		if !equalStrings(familyTargets[0], familyTargets[1]) {
			return Resolution{}, ErrInconsistentResponse
		}

		orderedTargets := mapKeysSorted(targets)
		for _, target := range orderedTargets {
			if target == current {
				return Resolution{}, ErrCNAMELoop
			}
			if _, seen := visited[target]; seen {
				return Resolution{}, ErrCNAMELoop
			}
			alreadyQueued := false
			for _, queued := range queue {
				alreadyQueued = alreadyQueued || queued == target
			}
			if alreadyQueued {
				continue
			}
			cnameLinks++
			if cnameLinks > MaxCNAMEDepth {
				return Resolution{}, ErrCNAMEDepth
			}
			queue = append(queue, target)
		}
	}

	resolution := Resolution{Status: StatusSuccess, Names: mapKeysSorted(names)}
	for address := range addresses {
		resolution.Addresses = append(resolution.Addresses, address)
	}
	sort.Slice(resolution.Addresses, func(i, j int) bool {
		return resolution.Addresses[i].Compare(resolution.Addresses[j]) < 0
	})
	if len(resolution.Addresses) == 0 {
		resolution.Status = StatusNoData
	}
	return resolution, nil
}

func (r *Resolver) queryBothFamilies(ctx context.Context, endpoint Endpoint, absoluteName string) ([2]*dns.Msg, error) {
	var responses [2]*dns.Msg
	var errorsByFamily [2]error
	var wait sync.WaitGroup
	for index, queryType := range []uint16{dns.TypeA, dns.TypeAAAA} {
		wait.Add(1)
		go func(index int, queryType uint16) {
			defer wait.Done()
			responses[index], errorsByFamily[index] = r.client.Query(ctx, endpoint, absoluteName, queryType)
		}(index, queryType)
	}
	wait.Wait()
	for _, err := range errorsByFamily {
		if err != nil {
			return [2]*dns.Msg{}, err
		}
	}
	return responses, nil
}

type parsedResponse struct {
	names     []string
	targets   []string
	addresses []netip.Addr
}

func parseResponse(message *dns.Msg, queriedName string, queryType uint16) (parsedResponse, error) {
	if message == nil || !message.Response || message.Truncated || message.Opcode != dns.OpcodeQuery {
		if message != nil && message.Truncated {
			return parsedResponse{}, ErrTruncatedResponse
		}
		return parsedResponse{}, ErrInvalidResponse
	}
	if message.Rcode != dns.RcodeSuccess && message.Rcode != dns.RcodeNameError {
		return parsedResponse{}, ErrInvalidResponse
	}
	if len(message.Question) != 1 || message.Question[0].Qtype != queryType ||
		message.Question[0].Qclass != dns.ClassINET {
		return parsedResponse{}, ErrInvalidResponse
	}
	questionName, err := normalizeAbsoluteName(message.Question[0].Name)
	if err != nil || questionName != queriedName {
		return parsedResponse{}, ErrInvalidResponse
	}
	if message.Rcode == dns.RcodeNameError {
		if len(message.Answer) != 0 {
			return parsedResponse{}, ErrInvalidResponse
		}
		return parsedResponse{}, nil
	}

	cnameByOwner := make(map[string]string)
	addressesByOwner := make(map[string][]netip.Addr)
	for _, record := range message.Answer {
		owner, ownerErr := normalizeAbsoluteName(record.Header().Name)
		if ownerErr != nil {
			return parsedResponse{}, ErrInvalidResponse
		}
		switch value := record.(type) {
		case *dns.CNAME:
			target, targetErr := normalizeAbsoluteName(value.Target)
			if targetErr != nil {
				return parsedResponse{}, ErrInvalidResponse
			}
			if prior, exists := cnameByOwner[owner]; exists && prior != target {
				return parsedResponse{}, ErrInconsistentResponse
			}
			cnameByOwner[owner] = target
		case *dns.A:
			if queryType != dns.TypeA {
				return parsedResponse{}, ErrInvalidResponse
			}
			address, ok := netip.AddrFromSlice(value.A)
			if !ok || !address.Is4() {
				return parsedResponse{}, ErrInvalidResponse
			}
			addressesByOwner[owner] = append(addressesByOwner[owner], address.Unmap())
		case *dns.AAAA:
			if queryType != dns.TypeAAAA {
				return parsedResponse{}, ErrInvalidResponse
			}
			address, ok := netip.AddrFromSlice(value.AAAA)
			if !ok || !address.Is6() {
				return parsedResponse{}, ErrInvalidResponse
			}
			// Preserve IPv4-mapped representation for the policy classifier.
			addressesByOwner[owner] = append(addressesByOwner[owner], address)
		default:
			return parsedResponse{}, ErrInvalidResponse
		}
	}

	reachable := map[string]struct{}{queriedName: {}}
	current := queriedName
	result := parsedResponse{names: []string{queriedName}}
	for depth := 0; ; depth++ {
		target, exists := cnameByOwner[current]
		if !exists {
			break
		}
		if depth >= MaxCNAMEDepth {
			return parsedResponse{}, ErrCNAMEDepth
		}
		if _, seen := reachable[target]; seen {
			return parsedResponse{}, ErrCNAMELoop
		}
		reachable[target] = struct{}{}
		result.names = append(result.names, target)
		result.targets = append(result.targets, target)
		current = target
	}
	for owner := range cnameByOwner {
		if _, ok := reachable[owner]; !ok {
			return parsedResponse{}, ErrInvalidResponse
		}
		if len(addressesByOwner[owner]) > 0 {
			return parsedResponse{}, ErrInconsistentResponse
		}
	}
	for owner, ownerAddresses := range addressesByOwner {
		if _, ok := reachable[owner]; !ok {
			return parsedResponse{}, ErrInvalidResponse
		}
		result.addresses = append(result.addresses, ownerAddresses...)
	}
	return result, nil
}

func normalizeAbsoluteName(raw string) (string, error) {
	if !strings.HasSuffix(raw, ".") || strings.HasSuffix(raw, "..") {
		return "", ErrInvalidName
	}
	normalized, err := authority.NormalizeHostname(strings.TrimSuffix(raw, "."))
	if err != nil || raw != normalized+"." {
		return "", ErrInvalidName
	}
	return normalized, nil
}

func combineResolutions(resolutions []Resolution) Resolution {
	names := make(map[string]struct{})
	addresses := make(map[netip.Addr]struct{})
	for _, resolution := range resolutions {
		for _, name := range resolution.Names {
			names[name] = struct{}{}
		}
		for _, address := range resolution.Addresses {
			addresses[address] = struct{}{}
		}
	}
	combined := Resolution{Status: StatusSuccess, Names: mapKeysSorted(names)}
	for address := range addresses {
		combined.Addresses = append(combined.Addresses, address)
	}
	sort.Slice(combined.Addresses, func(i, j int) bool {
		return combined.Addresses[i].Compare(combined.Addresses[j]) < 0
	})
	return combined
}

func mapKeysSorted(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for value := range values {
		keys = append(keys, value)
	}
	sort.Strings(keys)
	return keys
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
