package policy

import (
	"net/netip"
	"sort"
)

type classifiedPrefix struct {
	prefix netip.Prefix
	class  AddressClass
	reason ReasonCode
}

func mustPrefix(raw string) netip.Prefix {
	prefix, err := netip.ParsePrefix(raw)
	if err != nil {
		panic("invalid reviewed address prefix: " + raw)
	}
	return prefix
}

func prefixRule(raw string, class AddressClass, reason ReasonCode) classifiedPrefix {
	return classifiedPrefix{prefix: mustPrefix(raw), class: class, reason: reason}
}

var highSignalAddressRules = []classifiedPrefix{
	// Provider metadata and Fly private space precede the registry snapshot so
	// the bounded reason code remains operationally useful.
	prefixRule("169.254.169.254/32", ClassBlockedMetadata, ReasonMetadataAddress),
	prefixRule("100.100.100.200/32", ClassBlockedMetadata, ReasonMetadataAddress),
	prefixRule("fd00:ec2::254/128", ClassBlockedMetadata, ReasonMetadataAddress),
	prefixRule("fdaa::/16", ClassBlockedFlyPrivate, ReasonFlyPrivateAddress),

	prefixRule("10.0.0.0/8", ClassBlockedPrivate, ReasonPrivateAddress),
	prefixRule("172.16.0.0/12", ClassBlockedPrivate, ReasonPrivateAddress),
	prefixRule("192.168.0.0/16", ClassBlockedPrivate, ReasonPrivateAddress),
	prefixRule("100.64.0.0/10", ClassBlockedSpecial, ReasonCarrierGradeNAT),
	prefixRule("127.0.0.0/8", ClassBlockedLoopback, ReasonLoopbackAddress),
	prefixRule("169.254.0.0/16", ClassBlockedLinkLocal, ReasonLinkLocalAddress),
	prefixRule("192.0.2.0/24", ClassBlockedSpecial, ReasonDocumentationAddress),
	prefixRule("198.51.100.0/24", ClassBlockedSpecial, ReasonDocumentationAddress),
	prefixRule("203.0.113.0/24", ClassBlockedSpecial, ReasonDocumentationAddress),
	prefixRule("198.18.0.0/15", ClassBlockedSpecial, ReasonBenchmarkAddress),
	prefixRule("224.0.0.0/4", ClassBlockedMulticast, ReasonMulticastAddress),
	prefixRule("240.0.0.0/4", ClassBlockedSpecial, ReasonReservedAddress),

	prefixRule("::/128", ClassBlockedSpecial, ReasonUnspecifiedAddress),
	prefixRule("::1/128", ClassBlockedLoopback, ReasonLoopbackAddress),
	prefixRule("::/96", ClassBlockedSpecial, ReasonTranslatedAddress),
	prefixRule("::ffff:0:0/96", ClassBlockedMapped, ReasonMappedAddress),
	prefixRule("64:ff9b::/96", ClassBlockedSpecial, ReasonTranslatedAddress),
	prefixRule("64:ff9b:1::/48", ClassBlockedSpecial, ReasonTranslatedAddress),
	prefixRule("2001:db8::/32", ClassBlockedSpecial, ReasonDocumentationAddress),
	prefixRule("2002::/16", ClassBlockedSpecial, ReasonTranslatedAddress),
	prefixRule("fc00::/7", ClassBlockedPrivate, ReasonPrivateAddress),
	prefixRule("fe80::/10", ClassBlockedLinkLocal, ReasonLinkLocalAddress),
	// Deprecated site-local space is absent from the current IANA special
	// registry but must never be treated as an Internet destination.
	prefixRule("fec0::/10", ClassBlockedSpecial, ReasonSpecialAddress),
	prefixRule("ff00::/8", ClassBlockedMulticast, ReasonMulticastAddress),
}

var ianaRegistryPrefixes = parseRegistryPrefixes()

func parseRegistryPrefixes() []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(ianaRegistryPrefixStrings))
	for _, raw := range ianaRegistryPrefixStrings {
		prefixes = append(prefixes, mustPrefix(raw))
	}
	return prefixes
}

// RegistryPrefixes returns a copy of the reviewed IANA snapshot used by the
// binary. It exists so tests and release tooling can prove every entry is
// covered without exposing mutable package state.
func RegistryPrefixes() []netip.Prefix {
	return append([]netip.Prefix(nil), ianaRegistryPrefixes...)
}

func ClassifyAddress(address netip.Addr) AddressDecision {
	if !address.IsValid() || address.Zone() != "" {
		return AddressDecision{Class: ClassBlockedInvalid, Reason: ReasonInvalidAddress}
	}
	// netip.ParseAddr canonicalizes IPv4-mapped values. Check before Unmap so a
	// mapped public IPv4 value is still rejected as an IANA special form.
	if address.Is4In6() {
		return AddressDecision{Class: ClassBlockedMapped, Reason: ReasonMappedAddress}
	}
	for _, candidate := range highSignalAddressRules {
		if candidate.prefix.Contains(address) {
			return AddressDecision{Class: candidate.class, Reason: candidate.reason}
		}
	}
	for _, prefix := range ianaRegistryPrefixes {
		if prefix.Contains(address) {
			return AddressDecision{Class: ClassBlockedSpecial, Reason: ReasonSpecialAddress}
		}
	}
	// Backstops protect against a stale generated table. Snapshot freshness is a
	// separate release gate; these checks never turn a special value public.
	if address.IsUnspecified() {
		return AddressDecision{Class: ClassBlockedSpecial, Reason: ReasonUnspecifiedAddress}
	}
	if address.IsLoopback() {
		return AddressDecision{Class: ClassBlockedLoopback, Reason: ReasonLoopbackAddress}
	}
	if address.IsPrivate() {
		return AddressDecision{Class: ClassBlockedPrivate, Reason: ReasonPrivateAddress}
	}
	if address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() {
		return AddressDecision{Class: ClassBlockedLinkLocal, Reason: ReasonLinkLocalAddress}
	}
	if address.IsMulticast() {
		return AddressDecision{Class: ClassBlockedMulticast, Reason: ReasonMulticastAddress}
	}
	if !address.IsGlobalUnicast() {
		return AddressDecision{Class: ClassBlockedSpecial, Reason: ReasonSpecialAddress}
	}
	if address.Is4() {
		return AddressDecision{Allowed: true, Class: ClassPublicIPv4, Reason: ReasonAllowed}
	}
	return AddressDecision{Allowed: true, Class: ClassPublicIPv6, Reason: ReasonAllowed}
}

func EvaluateDestination(domainPolicy DomainPolicy, names []string, addresses []netip.Addr) DestinationDecision {
	if len(names) == 0 {
		return DestinationDecision{Class: ClassUnknown, Reason: ReasonInvalidDomain}
	}
	for _, name := range names {
		decision := domainPolicy.Evaluate(name)
		if !decision.Allowed {
			return DestinationDecision{Class: ClassUnknown, Reason: decision.Reason}
		}
	}
	if len(addresses) == 0 {
		return DestinationDecision{Class: ClassUnknown, Reason: ReasonEmptyDNSAnswer}
	}

	unique := make(map[netip.Addr]struct{}, len(addresses))
	public := make([]netip.Addr, 0, len(addresses))
	var firstBlocked AddressDecision
	for _, address := range addresses {
		if _, seen := unique[address]; seen {
			continue
		}
		unique[address] = struct{}{}
		decision := ClassifyAddress(address)
		if decision.Allowed {
			public = append(public, address)
		} else if firstBlocked.Reason == "" {
			firstBlocked = decision
		}
	}
	if firstBlocked.Reason != "" {
		if len(public) > 0 {
			return DestinationDecision{Class: ClassBlockedMixed, Reason: ReasonMixedDNSAnswer}
		}
		return DestinationDecision{Class: firstBlocked.Class, Reason: firstBlocked.Reason}
	}
	if len(public) == 0 {
		return DestinationDecision{Class: ClassUnknown, Reason: ReasonEmptyDNSAnswer}
	}

	sort.Slice(public, func(i, j int) bool { return public[i].Compare(public[j]) < 0 })
	hasIPv4, hasIPv6 := false, false
	for _, address := range public {
		hasIPv4 = hasIPv4 || address.Is4()
		hasIPv6 = hasIPv6 || address.Is6()
	}
	class := ClassPublicIPv4
	if hasIPv4 && hasIPv6 {
		class = ClassPublicDualStack
	} else if hasIPv6 {
		class = ClassPublicIPv6
	}
	return DestinationDecision{
		Allowed: true, Class: class, Reason: ReasonAllowed, Selected: public[0],
	}
}
