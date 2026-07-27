package policy

import "net/netip"

type ReasonCode string

const (
	ReasonAllowed              ReasonCode = "allowed"
	ReasonInvalidAddress       ReasonCode = "invalid_address"
	ReasonMappedAddress        ReasonCode = "mapped_address"
	ReasonMetadataAddress      ReasonCode = "metadata_address"
	ReasonFlyPrivateAddress    ReasonCode = "fly_private_address"
	ReasonPrivateAddress       ReasonCode = "private_address"
	ReasonLoopbackAddress      ReasonCode = "loopback_address"
	ReasonLinkLocalAddress     ReasonCode = "link_local_address"
	ReasonMulticastAddress     ReasonCode = "multicast_address"
	ReasonUnspecifiedAddress   ReasonCode = "unspecified_address"
	ReasonDocumentationAddress ReasonCode = "documentation_address"
	ReasonBenchmarkAddress     ReasonCode = "benchmarking_address"
	ReasonCarrierGradeNAT      ReasonCode = "carrier_grade_nat_address"
	ReasonTranslatedAddress    ReasonCode = "translated_address"
	ReasonReservedAddress      ReasonCode = "reserved_address"
	ReasonSpecialAddress       ReasonCode = "special_purpose_address"
	ReasonBlockedDomain        ReasonCode = "blocked_domain"
	ReasonInvalidDomain        ReasonCode = "invalid_domain"
	ReasonEmptyDNSAnswer       ReasonCode = "empty_dns_answer"
	ReasonMixedDNSAnswer       ReasonCode = "mixed_dns_answer"
)

type AddressClass string

const (
	ClassUnknown           AddressClass = "unknown"
	ClassPublicIPv4        AddressClass = "public_v4"
	ClassPublicIPv6        AddressClass = "public_v6"
	ClassPublicDualStack   AddressClass = "public_dual_stack"
	ClassBlockedInvalid    AddressClass = "blocked_invalid"
	ClassBlockedMapped     AddressClass = "blocked_mapped"
	ClassBlockedMetadata   AddressClass = "blocked_metadata"
	ClassBlockedFlyPrivate AddressClass = "blocked_fly_private"
	ClassBlockedPrivate    AddressClass = "blocked_private"
	ClassBlockedLoopback   AddressClass = "blocked_loopback"
	ClassBlockedLinkLocal  AddressClass = "blocked_link_local"
	ClassBlockedMulticast  AddressClass = "blocked_multicast"
	ClassBlockedSpecial    AddressClass = "blocked_special"
	ClassBlockedMixed      AddressClass = "blocked_mixed"
)

type AddressDecision struct {
	Allowed bool
	Class   AddressClass
	Reason  ReasonCode
}

type DestinationDecision struct {
	Allowed  bool
	Class    AddressClass
	Reason   ReasonCode
	Selected netip.Addr
}
