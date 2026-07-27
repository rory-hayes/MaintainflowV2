package dnsresolver

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/miekg/dns"
	"maintainflow/browser-egress-proxy/internal/policy"
)

type queryKey struct {
	endpoint string
	name     string
	typeCode uint16
}

type fakeQueryClient struct {
	mu        sync.Mutex
	responses map[queryKey]*dns.Msg
	errors    map[queryKey]error
	blocking  map[queryKey]bool
	calls     []queryKey
}

func newFakeQueryClient() *fakeQueryClient {
	return &fakeQueryClient{
		responses: make(map[queryKey]*dns.Msg),
		errors:    make(map[queryKey]error),
		blocking:  make(map[queryKey]bool),
	}
}

func (f *fakeQueryClient) Query(ctx context.Context, endpoint Endpoint, name string, typeCode uint16) (*dns.Msg, error) {
	key := queryKey{endpoint: endpoint.Address.String(), name: name, typeCode: typeCode}
	f.mu.Lock()
	f.calls = append(f.calls, key)
	response, ok := f.responses[key]
	err := f.errors[key]
	blocking := f.blocking[key]
	f.mu.Unlock()
	if blocking {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	if !ok {
		return responseMessage(name, typeCode, dns.RcodeSuccess), nil
	}
	return response.Copy(), nil
}

func (f *fakeQueryClient) set(endpoint Endpoint, name string, typeCode uint16, response *dns.Msg) {
	f.responses[queryKey{endpoint: endpoint.Address.String(), name: name, typeCode: typeCode}] = response
}

func (f *fakeQueryClient) countCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func testEndpoints() []Endpoint {
	return []Endpoint{
		{Address: netip.MustParseAddrPort("1.1.1.1:853"), ServerName: "one.resolver.example"},
		{Address: netip.MustParseAddrPort("9.9.9.9:853"), ServerName: "two.resolver.example"},
	}
}

func newTestResolver(t *testing.T, client QueryClient) *Resolver {
	t.Helper()
	resolver, err := New(testEndpoints(), client, allowAllNamePolicy{})
	if err != nil {
		t.Fatal(err)
	}
	return resolver
}

type allowAllNamePolicy struct{}

func (allowAllNamePolicy) Evaluate(string) policy.DomainDecision {
	return policy.DomainDecision{Allowed: true, Reason: policy.ReasonAllowed}
}

func (allowAllNamePolicy) Ready() bool { return true }

func responseMessage(name string, typeCode uint16, rcode int, answers ...dns.RR) *dns.Msg {
	return &dns.Msg{
		MsgHdr:   dns.MsgHdr{Response: true, Opcode: dns.OpcodeQuery, Rcode: rcode},
		Question: []dns.Question{{Name: name, Qtype: typeCode, Qclass: dns.ClassINET}},
		Answer:   answers,
	}
}

func TestTLSQueryClientUsesOneFixedIPCertificateVerifiedDoTExchange(t *testing.T) {
	t.Parallel()
	endpoint := testEndpoints()[0]
	calls := 0
	client := TLSQueryClient{exchange: func(
		_ context.Context,
		dnsClient *dns.Client,
		request *dns.Msg,
		address string,
	) (*dns.Msg, time.Duration, error) {
		calls++
		if address != "1.1.1.1:853" || dnsClient.Net != "tcp-tls" ||
			dnsClient.TLSConfig == nil || dnsClient.TLSConfig.ServerName != endpoint.ServerName ||
			dnsClient.TLSConfig.MinVersion != tls.VersionTLS12 {
			t.Fatalf("unsafe DoT exchange configuration: address=%q client=%+v", address, dnsClient)
		}
		if len(request.Question) != 1 || request.Question[0].Name != "example.com." ||
			request.Question[0].Qtype != dns.TypeA {
			t.Fatalf("unexpected DNS request: %+v", request.Question)
		}
		response := responseMessage("example.com.", dns.TypeA, dns.RcodeSuccess,
			aRecord("example.com.", "93.184.216.34"))
		response.Id = request.Id
		return response, time.Millisecond, nil
	}}
	response, err := client.Query(context.Background(), endpoint, "example.com.", dns.TypeA)
	if err != nil || response == nil || calls != 1 {
		t.Fatalf("response=%v error=%v calls=%d", response, err, calls)
	}

	client.exchange = func(context.Context, *dns.Client, *dns.Msg, string) (*dns.Msg, time.Duration, error) {
		calls++
		return nil, 0, errors.New("connection failed")
	}
	if _, err := client.Query(context.Background(), endpoint, "example.com.", dns.TypeA); err == nil {
		t.Fatal("exchange error unexpectedly succeeded")
	}
	if calls != 2 {
		t.Fatalf("failed exchange was retried; total calls=%d", calls)
	}
}

func aRecord(owner, raw string) dns.RR {
	return &dns.A{Hdr: dns.RR_Header{Name: owner, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.ParseIP(raw).To4()}
}

func aaaaRecord(owner, raw string) dns.RR {
	return &dns.AAAA{Hdr: dns.RR_Header{Name: owner, Rrtype: dns.TypeAAAA, Class: dns.ClassINET, Ttl: 60}, AAAA: net.ParseIP(raw)}
}

func cnameRecord(owner, target string) dns.RR {
	return &dns.CNAME{Hdr: dns.RR_Header{Name: owner, Rrtype: dns.TypeCNAME, Class: dns.ClassINET, Ttl: 60}, Target: target}
}

func TestResolveCombinesAAndAAAAFromBothResolvers(t *testing.T) {
	t.Parallel()
	client := newFakeQueryClient()
	endpoints := testEndpoints()
	client.set(endpoints[0], "example.com.", dns.TypeA, responseMessage("example.com.", dns.TypeA, dns.RcodeSuccess, aRecord("example.com.", "93.184.216.34")))
	client.set(endpoints[0], "example.com.", dns.TypeAAAA, responseMessage("example.com.", dns.TypeAAAA, dns.RcodeSuccess, aaaaRecord("example.com.", "2606:2800:220:1:248:1893:25c8:1946")))
	client.set(endpoints[1], "example.com.", dns.TypeA, responseMessage("example.com.", dns.TypeA, dns.RcodeSuccess, aRecord("example.com.", "93.184.216.35")))
	client.set(endpoints[1], "example.com.", dns.TypeAAAA, responseMessage("example.com.", dns.TypeAAAA, dns.RcodeSuccess))

	resolution, err := newTestResolver(t, client).Resolve(context.Background(), "example.com.")
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Status != StatusSuccess || strings.Join(resolution.Names, ",") != "example.com" {
		t.Fatalf("resolution metadata = %+v", resolution)
	}
	want := []netip.Addr{
		netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("93.184.216.35"),
		netip.MustParseAddr("2606:2800:220:1:248:1893:25c8:1946"),
	}
	if len(resolution.Addresses) != len(want) {
		t.Fatalf("addresses = %v, want %v", resolution.Addresses, want)
	}
	for index := range want {
		if resolution.Addresses[index] != want[index] {
			t.Fatalf("addresses = %v, want %v", resolution.Addresses, want)
		}
	}
	if client.countCalls() != 4 {
		t.Fatalf("query calls = %d, want exactly four with no retries", client.countCalls())
	}
}

func TestResolveAOnlyAndAAAAOnly(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name     string
		typeCode uint16
		record   dns.RR
	}{
		{name: "A only", typeCode: dns.TypeA, record: aRecord("a.example.", "93.184.216.34")},
		{name: "AAAA only", typeCode: dns.TypeAAAA, record: aaaaRecord("a.example.", "2606:4700:4700::1111")},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			client := newFakeQueryClient()
			for _, endpoint := range testEndpoints() {
				client.set(endpoint, "a.example.", test.typeCode, responseMessage("a.example.", test.typeCode, dns.RcodeSuccess, test.record))
			}
			resolution, err := newTestResolver(t, client).Resolve(context.Background(), "a.example.")
			if err != nil || resolution.Status != StatusSuccess || len(resolution.Addresses) != 1 {
				t.Fatalf("resolution = %+v, error = %v", resolution, err)
			}
		})
	}
}

func TestResolveFollowsBoundedCNAMEChain(t *testing.T) {
	t.Parallel()
	client := newFakeQueryClient()
	for _, endpoint := range testEndpoints() {
		for _, typeCode := range []uint16{dns.TypeA, dns.TypeAAAA} {
			client.set(endpoint, "start.example.", typeCode, responseMessage("start.example.", typeCode, dns.RcodeSuccess,
				cnameRecord("start.example.", "alias.example.")))
		}
		client.set(endpoint, "alias.example.", dns.TypeA, responseMessage("alias.example.", dns.TypeA, dns.RcodeSuccess,
			aRecord("alias.example.", "93.184.216.34")))
	}
	resolution, err := newTestResolver(t, client).Resolve(context.Background(), "start.example.")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(resolution.Names, ",") != "alias.example,start.example" || len(resolution.Addresses) != 1 {
		t.Fatalf("CNAME resolution = %+v", resolution)
	}
}

func TestResolveRejectsCNAMELoopAndDepth(t *testing.T) {
	t.Parallel()
	t.Run("loop", func(t *testing.T) {
		client := newFakeQueryClient()
		for _, endpoint := range testEndpoints() {
			for _, typeCode := range []uint16{dns.TypeA, dns.TypeAAAA} {
				client.set(endpoint, "loop.example.", typeCode, responseMessage("loop.example.", typeCode, dns.RcodeSuccess,
					cnameRecord("loop.example.", "alias.example.")))
				client.set(endpoint, "alias.example.", typeCode, responseMessage("alias.example.", typeCode, dns.RcodeSuccess,
					cnameRecord("alias.example.", "loop.example.")))
			}
		}
		_, err := newTestResolver(t, client).Resolve(context.Background(), "loop.example.")
		if !errors.Is(err, ErrCNAMELoop) {
			t.Fatalf("error = %v, want CNAME loop", err)
		}
	})

	t.Run("depth", func(t *testing.T) {
		client := newFakeQueryClient()
		for _, endpoint := range testEndpoints() {
			for depth := 0; depth <= MaxCNAMEDepth; depth++ {
				owner := "depth.example."
				if depth > 0 {
					owner = "alias" + string(rune('a'+depth-1)) + ".depth.example."
				}
				target := "alias" + string(rune('a'+depth)) + ".depth.example."
				for _, typeCode := range []uint16{dns.TypeA, dns.TypeAAAA} {
					client.set(endpoint, owner, typeCode, responseMessage(owner, typeCode, dns.RcodeSuccess,
						cnameRecord(owner, target)))
				}
			}
		}
		_, err := newTestResolver(t, client).Resolve(context.Background(), "depth.example.")
		if !errors.Is(err, ErrCNAMEDepth) {
			t.Fatalf("error = %v, want CNAME depth", err)
		}
	})
}

func TestResolveNoDataAndNXDomain(t *testing.T) {
	t.Parallel()
	t.Run("NODATA", func(t *testing.T) {
		resolution, err := newTestResolver(t, newFakeQueryClient()).Resolve(context.Background(), "empty.example.")
		if !errors.Is(err, ErrNoData) || resolution.Status != StatusNoData {
			t.Fatalf("resolution = %+v, error = %v", resolution, err)
		}
	})
	t.Run("NXDOMAIN", func(t *testing.T) {
		client := newFakeQueryClient()
		for _, endpoint := range testEndpoints() {
			for _, typeCode := range []uint16{dns.TypeA, dns.TypeAAAA} {
				client.set(endpoint, "missing.example.", typeCode, responseMessage("missing.example.", typeCode, dns.RcodeNameError))
			}
		}
		resolution, err := newTestResolver(t, client).Resolve(context.Background(), "missing.example.")
		if !errors.Is(err, ErrNXDomain) || resolution.Status != StatusNXDomain {
			t.Fatalf("resolution = %+v, error = %v", resolution, err)
		}
	})
}

func TestResolveFailsClosedOnEitherResolverOrFamily(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		setup func(*fakeQueryClient, []Endpoint)
		want  error
	}{
		{
			name: "one resolver error",
			setup: func(client *fakeQueryClient, endpoints []Endpoint) {
				client.errors[queryKey{endpoint: endpoints[0].Address.String(), name: "fail.example.", typeCode: dns.TypeA}] = errors.New("query failed")
			},
		},
		{
			name: "truncated",
			setup: func(client *fakeQueryClient, endpoints []Endpoint) {
				message := responseMessage("fail.example.", dns.TypeA, dns.RcodeSuccess)
				message.Truncated = true
				client.set(endpoints[0], "fail.example.", dns.TypeA, message)
			},
			want: ErrTruncatedResponse,
		},
		{
			name: "SERVFAIL",
			setup: func(client *fakeQueryClient, endpoints []Endpoint) {
				client.set(endpoints[0], "fail.example.", dns.TypeA, responseMessage("fail.example.", dns.TypeA, dns.RcodeServerFailure))
			},
			want: ErrInvalidResponse,
		},
		{
			name: "inconsistent resolver status",
			setup: func(client *fakeQueryClient, endpoints []Endpoint) {
				client.set(endpoints[0], "fail.example.", dns.TypeA, responseMessage("fail.example.", dns.TypeA, dns.RcodeSuccess,
					aRecord("fail.example.", "93.184.216.34")))
			},
			want: ErrInconsistentResponse,
		},
		{
			name: "unrelated answer owner",
			setup: func(client *fakeQueryClient, endpoints []Endpoint) {
				client.set(endpoints[0], "fail.example.", dns.TypeA, responseMessage("fail.example.", dns.TypeA, dns.RcodeSuccess,
					aRecord("attacker.example.", "93.184.216.34")))
			},
			want: ErrInvalidResponse,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			client := newFakeQueryClient()
			test.setup(client, testEndpoints())
			_, err := newTestResolver(t, client).Resolve(context.Background(), "fail.example.")
			if err == nil {
				t.Fatal("failure case unexpectedly resolved")
			}
			if test.want != nil && !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestResolveRejectsInconsistentCNAMEFamiliesAndCNAMEDataCoexistence(t *testing.T) {
	t.Parallel()
	t.Run("A and AAAA CNAME disagreement", func(t *testing.T) {
		client := newFakeQueryClient()
		for _, endpoint := range testEndpoints() {
			client.set(endpoint, "split.example.", dns.TypeA, responseMessage("split.example.", dns.TypeA, dns.RcodeSuccess,
				cnameRecord("split.example.", "alias.example.")))
			client.set(endpoint, "split.example.", dns.TypeAAAA, responseMessage("split.example.", dns.TypeAAAA, dns.RcodeSuccess))
		}
		_, err := newTestResolver(t, client).Resolve(context.Background(), "split.example.")
		if !errors.Is(err, ErrInconsistentResponse) {
			t.Fatalf("error = %v, want inconsistent response", err)
		}
	})

	t.Run("CNAME and address at same owner", func(t *testing.T) {
		message := responseMessage("split.example.", dns.TypeA, dns.RcodeSuccess,
			cnameRecord("split.example.", "alias.example."), aRecord("split.example.", "93.184.216.34"))
		if _, err := parseResponse(message, "split.example", dns.TypeA); !errors.Is(err, ErrInconsistentResponse) {
			t.Fatalf("error = %v, want inconsistent response", err)
		}
	})
}

func TestResolveHonorsContextWithoutFallbackOrRetry(t *testing.T) {
	t.Parallel()
	client := newFakeQueryClient()
	endpoint := testEndpoints()[0]
	key := queryKey{endpoint: endpoint.Address.String(), name: "slow.example.", typeCode: dns.TypeA}
	client.blocking[key] = true
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := newTestResolver(t, client).Resolve(ctx, "slow.example.")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline", err)
	}
	if client.countCalls() != 4 {
		t.Fatalf("query calls = %d, want one A and AAAA per resolver", client.countCalls())
	}
}

func TestResolutionFeedsAllAnswerAndCNAMEPolicy(t *testing.T) {
	t.Parallel()
	client := newFakeQueryClient()
	for _, endpoint := range testEndpoints() {
		client.set(endpoint, "public.example.com.", dns.TypeA, responseMessage("public.example.com.", dns.TypeA, dns.RcodeSuccess,
			aRecord("public.example.com.", "93.184.216.34"), aRecord("public.example.com.", "10.0.0.1")))
	}
	resolution, err := newTestResolver(t, client).Resolve(context.Background(), "public.example.com.")
	if err != nil {
		t.Fatal(err)
	}
	domains, _ := policy.NewDomainPolicy(nil)
	decision := policy.EvaluateDestination(domains, resolution.Names, resolution.Addresses)
	if decision.Allowed || decision.Reason != policy.ReasonMixedDNSAnswer {
		t.Fatalf("mixed resolver answers were not rejected: %+v", decision)
	}
}

func TestMappedAAAARepresentationIsPreservedForPolicy(t *testing.T) {
	t.Parallel()
	message := responseMessage("mapped.example.", dns.TypeAAAA, dns.RcodeSuccess,
		aaaaRecord("mapped.example.", "::ffff:8.8.8.8"))
	parsed, err := parseResponse(message, "mapped.example", dns.TypeAAAA)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.addresses) != 1 || !parsed.addresses[0].Is4In6() {
		t.Fatalf("mapped address was not preserved: %v", parsed.addresses)
	}
	if decision := policy.ClassifyAddress(parsed.addresses[0]); decision.Allowed || decision.Reason != policy.ReasonMappedAddress {
		t.Fatalf("mapped address policy = %+v", decision)
	}
}

func TestResolverRequiresNormalizedAbsoluteNameAndIndependentFixedEndpoints(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"example.com", "Example.com.", "example.com..", "127.0.0.1."} {
		if _, err := newTestResolver(t, newFakeQueryClient()).Resolve(context.Background(), raw); !errors.Is(err, ErrInvalidName) {
			t.Fatalf("Resolve(%q) error = %v, want invalid name", raw, err)
		}
	}
	endpoints := testEndpoints()
	for _, mutate := range []func([]Endpoint){
		func(values []Endpoint) { values[1] = values[0] },
		func(values []Endpoint) { values[0].Address = netip.MustParseAddrPort("127.0.0.1:853") },
		func(values []Endpoint) { values[0].Address = netip.MustParseAddrPort("1.1.1.1:53") },
		func(values []Endpoint) { values[0].ServerName = "UPPER.example" },
	} {
		copyEndpoints := append([]Endpoint(nil), endpoints...)
		mutate(copyEndpoints)
		if _, err := New(copyEndpoints, newFakeQueryClient(), allowAllNamePolicy{}); err == nil {
			t.Fatal("invalid resolver endpoints unexpectedly accepted")
		}
	}
	if _, err := New(endpoints, newFakeQueryClient(), nil); err == nil {
		t.Fatal("nil domain policy unexpectedly accepted")
	}
	if _, err := New(endpoints, newFakeQueryClient(), policy.DomainPolicy{}); err == nil {
		t.Fatal("zero-value domain policy unexpectedly accepted")
	}
}

func TestResolverRejectsBlockedRootAndCNAMEBeforeTargetQuery(t *testing.T) {
	t.Parallel()
	domains, err := policy.NewDomainPolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := newFakeQueryClient()
	resolver, err := New(testEndpoints(), client, domains)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.Resolve(context.Background(), "metadata.google.internal."); !errors.Is(err, ErrBlockedName) {
		t.Fatalf("blocked root error = %v", err)
	}
	if client.countCalls() != 0 {
		t.Fatalf("blocked root caused %d DNS queries", client.countCalls())
	}

	for _, endpoint := range testEndpoints() {
		for _, typeCode := range []uint16{dns.TypeA, dns.TypeAAAA} {
			client.set(endpoint, "public.example.com.", typeCode, responseMessage("public.example.com.", typeCode, dns.RcodeSuccess,
				cnameRecord("public.example.com.", "metadata.google.internal.")))
		}
	}
	if _, err := resolver.Resolve(context.Background(), "public.example.com."); !errors.Is(err, ErrBlockedName) {
		t.Fatalf("blocked CNAME error = %v", err)
	}
	if client.countCalls() != 4 {
		t.Fatalf("blocked CNAME should stop before target lookup; calls = %d", client.countCalls())
	}
}

func FuzzDNSPacketParsing(f *testing.F) {
	seed := responseMessage("fuzz.example.", dns.TypeA, dns.RcodeSuccess, aRecord("fuzz.example.", "93.184.216.34"))
	packed, err := seed.Pack()
	if err != nil {
		f.Fatal(err)
	}
	f.Add(packed)
	f.Add([]byte{0, 1, 2, 3})
	f.Fuzz(func(t *testing.T, raw []byte) {
		var message dns.Msg
		if err := message.Unpack(raw); err != nil {
			return
		}
		_, _ = parseResponse(&message, "fuzz.example", dns.TypeA)
	})
}

func FuzzCNAMEWalking(f *testing.F) {
	f.Add("alias.example.")
	f.Add("loop.example.")
	f.Add("bad target")
	f.Fuzz(func(t *testing.T, target string) {
		message := responseMessage("fuzz.example.", dns.TypeA, dns.RcodeSuccess,
			cnameRecord("fuzz.example.", target))
		_, _ = parseResponse(message, "fuzz.example", dns.TypeA)
	})
}

func TestCombinedResolutionOrderingIsStable(t *testing.T) {
	t.Parallel()
	combined := combineResolutions([]Resolution{
		{Names: []string{"z.example", "a.example"}, Addresses: []netip.Addr{netip.MustParseAddr("93.184.216.35")}},
		{Names: []string{"a.example"}, Addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34")}},
	})
	if !sort.StringsAreSorted(combined.Names) || combined.Addresses[0].String() != "93.184.216.34" {
		t.Fatalf("combined resolution is unstable: %+v", combined)
	}
}
