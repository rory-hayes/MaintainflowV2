package policy

import (
	"net/netip"
	"testing"
	"testing/quick"
)

func TestEveryReviewedIANAPrefixIsBlocked(t *testing.T) {
	t.Parallel()
	prefixes := RegistryPrefixes()
	if len(prefixes) != 51 {
		t.Fatalf("reviewed registry contains %d prefixes, want 51", len(prefixes))
	}
	for _, prefix := range prefixes {
		prefix := prefix
		t.Run(prefix.String(), func(t *testing.T) {
			t.Parallel()
			decision := ClassifyAddress(prefix.Addr())
			if decision.Allowed {
				t.Fatalf("IANA prefix representative %s was allowed", prefix)
			}
		})
	}
}

func TestAddressClasses(t *testing.T) {
	t.Parallel()
	tests := []struct {
		address string
		class   AddressClass
		reason  ReasonCode
		allowed bool
	}{
		{address: "8.8.8.8", class: ClassPublicIPv4, reason: ReasonAllowed, allowed: true},
		{address: "2606:4700:4700::1111", class: ClassPublicIPv6, reason: ReasonAllowed, allowed: true},
		{address: "10.0.0.1", class: ClassBlockedPrivate, reason: ReasonPrivateAddress},
		{address: "127.0.0.1", class: ClassBlockedLoopback, reason: ReasonLoopbackAddress},
		{address: "169.254.169.254", class: ClassBlockedMetadata, reason: ReasonMetadataAddress},
		{address: "100.100.100.200", class: ClassBlockedMetadata, reason: ReasonMetadataAddress},
		{address: "fd00:ec2::254", class: ClassBlockedMetadata, reason: ReasonMetadataAddress},
		{address: "fdaa::1", class: ClassBlockedFlyPrivate, reason: ReasonFlyPrivateAddress},
		{address: "224.0.0.1", class: ClassBlockedMulticast, reason: ReasonMulticastAddress},
		{address: "ff02::1", class: ClassBlockedMulticast, reason: ReasonMulticastAddress},
		{address: "::ffff:8.8.8.8", class: ClassBlockedMapped, reason: ReasonMappedAddress},
		{address: "::8.8.8.8", class: ClassBlockedSpecial, reason: ReasonTranslatedAddress},
		{address: "64:ff9b::808:808", class: ClassBlockedSpecial, reason: ReasonTranslatedAddress},
		{address: "2002:0808:0808::", class: ClassBlockedSpecial, reason: ReasonTranslatedAddress},
		{address: "fec0::1", class: ClassBlockedSpecial, reason: ReasonSpecialAddress},
		{address: "198.18.0.1", class: ClassBlockedSpecial, reason: ReasonBenchmarkAddress},
		{address: "100.64.0.1", class: ClassBlockedSpecial, reason: ReasonCarrierGradeNAT},
	}
	for _, test := range tests {
		decision := ClassifyAddress(netip.MustParseAddr(test.address))
		if decision.Allowed != test.allowed || decision.Class != test.class || decision.Reason != test.reason {
			t.Errorf("ClassifyAddress(%s) = %+v, want allowed=%v class=%s reason=%s", test.address, decision, test.allowed, test.class, test.reason)
		}
	}
}

func TestPublicBoundaryAddressesRemainAllowed(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		"9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0",
		"126.255.255.255", "128.0.0.0", "172.15.255.255", "172.32.0.0",
		"192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0",
		"223.255.255.255", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"2003::", "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
	} {
		if decision := ClassifyAddress(netip.MustParseAddr(raw)); !decision.Allowed {
			t.Errorf("adjacent public boundary %s blocked as %+v", raw, decision)
		}
	}
}

func TestEvaluateDestinationRejectsMixedAnswersAndPinsOneAddress(t *testing.T) {
	t.Parallel()
	domains, err := NewDomainPolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	mixed := EvaluateDestination(domains, []string{"example.com"}, []netip.Addr{
		netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("10.0.0.1"),
	})
	if mixed.Allowed || mixed.Reason != ReasonMixedDNSAnswer || mixed.Selected.IsValid() {
		t.Fatalf("mixed answer decision = %+v", mixed)
	}

	allowed := EvaluateDestination(domains, []string{"example.com"}, []netip.Addr{
		netip.MustParseAddr("2606:2800:220:1:248:1893:25c8:1946"),
		netip.MustParseAddr("93.184.216.35"), netip.MustParseAddr("93.184.216.34"),
		netip.MustParseAddr("93.184.216.34"),
	})
	if !allowed.Allowed || allowed.Class != ClassPublicDualStack ||
		allowed.Selected != netip.MustParseAddr("93.184.216.34") {
		t.Fatalf("allowed decision = %+v", allowed)
	}
	second := EvaluateDestination(domains, []string{"example.com"}, []netip.Addr{
		netip.MustParseAddr("93.184.216.35"), netip.MustParseAddr("93.184.216.34"),
	})
	if second.Selected != allowed.Selected {
		t.Fatalf("selection is not deterministic: %s vs %s", allowed.Selected, second.Selected)
	}
}

func TestEvaluateDestinationRejectsBlockedCNAME(t *testing.T) {
	t.Parallel()
	domains, _ := NewDomainPolicy(nil)
	decision := EvaluateDestination(domains, []string{"example.com", "metadata.google.internal"}, []netip.Addr{
		netip.MustParseAddr("93.184.216.34"),
	})
	if decision.Allowed || decision.Reason != ReasonBlockedDomain || decision.Selected.IsValid() {
		t.Fatalf("blocked CNAME decision = %+v", decision)
	}
}

func TestEvaluateDestinationRejectsMissingOrUninitializedDomainPolicy(t *testing.T) {
	t.Parallel()
	address := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	domains, _ := NewDomainPolicy(nil)
	if decision := EvaluateDestination(domains, nil, address); decision.Allowed || decision.Reason != ReasonInvalidDomain {
		t.Fatalf("missing names decision = %+v", decision)
	}
	if decision := EvaluateDestination(DomainPolicy{}, []string{"example.com"}, address); decision.Allowed || decision.Reason != ReasonInvalidDomain {
		t.Fatalf("zero-value policy decision = %+v", decision)
	}
}

func TestPrivateIPv4Property(t *testing.T) {
	t.Parallel()
	property := func(suffix uint32) bool {
		address := netip.AddrFrom4([4]byte{10, byte(suffix >> 16), byte(suffix >> 8), byte(suffix)})
		return !ClassifyAddress(address).Allowed
	}
	if err := quick.Check(property, &quick.Config{MaxCount: 10_000}); err != nil {
		t.Fatal(err)
	}
}

func FuzzClassifyAddress(f *testing.F) {
	for _, seed := range [][]byte{
		{8, 8, 8, 8}, {127, 0, 0, 1}, make([]byte, 16),
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		address, ok := netip.AddrFromSlice(raw)
		if !ok {
			return
		}
		decision := ClassifyAddress(address)
		if decision.Allowed && decision.Reason != ReasonAllowed {
			t.Fatalf("allowed address has blocked reason: %+v", decision)
		}
	})
}
