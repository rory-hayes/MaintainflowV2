package audit

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"time"

	"maintainflow/browser-egress-proxy/internal/authority"
	"maintainflow/browser-egress-proxy/internal/policy"
)

const (
	MaxAuditLatency       = 5 * time.Minute
	MaxAuditRequestBytes  = 2 << 20
	MaxAuditResponseBytes = 20 << 20
)

type MethodClass string

const (
	MethodConnect     MethodClass = "connect"
	MethodRead        MethodClass = "read"
	MethodSideEffect  MethodClass = "side_effect"
	MethodUnsupported MethodClass = "unsupported"
)

type Result string

const (
	ResultAllowed Result = "allowed"
	ResultBlocked Result = "blocked"
)

type ReasonCode string

const (
	ReasonAllowed          ReasonCode = "allowed"
	ReasonInvalidAuthority ReasonCode = "invalid_authority"
	ReasonInvalidDomain    ReasonCode = "invalid_domain"
	ReasonBlockedDomain    ReasonCode = "blocked_domain"
	ReasonDNSFailure       ReasonCode = "dns_failure"
	ReasonDNSTimeout       ReasonCode = "dns_timeout"
	ReasonDNSInconsistent  ReasonCode = "dns_inconsistent"
	ReasonEmptyDNSAnswer   ReasonCode = "empty_dns_answer"
	ReasonMixedDNSAnswer   ReasonCode = "mixed_dns_answer"
	ReasonBlockedAddress   ReasonCode = "blocked_address"
	ReasonCapacity         ReasonCode = "capacity"
	ReasonRateLimit        ReasonCode = "rate_limit"
	ReasonClientIdentity   ReasonCode = "client_identity"
	ReasonUnsupported      ReasonCode = "unsupported_protocol"
	ReasonBodyNotAllowed   ReasonCode = "body_not_allowed"
	ReasonHeaderLimit      ReasonCode = "header_limit"
	ReasonHeaderTimeout    ReasonCode = "header_timeout"
	ReasonConnectFailure   ReasonCode = "connect_failure"
	ReasonConnectTimeout   ReasonCode = "connect_timeout"
	ReasonIdleTimeout      ReasonCode = "idle_timeout"
	ReasonRequestLimit     ReasonCode = "request_limit"
	ReasonResponseLimit    ReasonCode = "response_limit"
	ReasonRelayFailure     ReasonCode = "relay_failure"
	ReasonCancelled        ReasonCode = "cancelled"
	ReasonShutdown         ReasonCode = "shutdown"
	ReasonAuditFailure     ReasonCode = "audit_failure"
)

var (
	imageDigestPattern   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	policyVersionPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,96}$`)
	allowedReasons       = map[ReasonCode]struct{}{
		ReasonAllowed: {}, ReasonInvalidAuthority: {}, ReasonInvalidDomain: {},
		ReasonBlockedDomain: {}, ReasonDNSFailure: {}, ReasonDNSTimeout: {},
		ReasonDNSInconsistent: {}, ReasonEmptyDNSAnswer: {}, ReasonMixedDNSAnswer: {},
		ReasonBlockedAddress: {}, ReasonCapacity: {}, ReasonRateLimit: {},
		ReasonClientIdentity: {}, ReasonUnsupported: {}, ReasonBodyNotAllowed: {},
		ReasonHeaderLimit: {}, ReasonHeaderTimeout: {}, ReasonConnectFailure: {},
		ReasonConnectTimeout: {}, ReasonIdleTimeout: {}, ReasonRequestLimit: {},
		ReasonResponseLimit: {}, ReasonRelayFailure: {}, ReasonCancelled: {},
		ReasonShutdown:     {},
		ReasonAuditFailure: {},
	}
	allowedAddressClasses = map[policy.AddressClass]struct{}{
		policy.ClassUnknown: {}, policy.ClassPublicIPv4: {}, policy.ClassPublicIPv6: {},
		policy.ClassPublicDualStack: {}, policy.ClassBlockedInvalid: {},
		policy.ClassBlockedMapped: {}, policy.ClassBlockedMetadata: {},
		policy.ClassBlockedFlyPrivate: {}, policy.ClassBlockedPrivate: {},
		policy.ClassBlockedLoopback: {}, policy.ClassBlockedLinkLocal: {},
		policy.ClassBlockedMulticast: {}, policy.ClassBlockedSpecial: {},
		policy.ClassBlockedMixed: {},
	}
)

// Event deliberately contains only the reviewed audit schema. It has no field
// capable of carrying a URL, raw hostname, IP, header, body, credential,
// certificate, exception, session ID, or run ID.
type Event struct {
	Timestamp     string              `json:"timestamp"`
	EventID       string              `json:"event_id"`
	PolicyVersion string              `json:"policy_version"`
	ImageDigest   string              `json:"image_digest"`
	HostHMAC      string              `json:"host_hmac_sha256"`
	AddressClass  policy.AddressClass `json:"address_class"`
	MethodClass   MethodClass         `json:"method_class"`
	Result        Result              `json:"result"`
	ReasonCode    ReasonCode          `json:"reason_code"`
	LatencyMS     int64               `json:"latency_ms"`
	RequestBytes  int64               `json:"request_bytes"`
	ResponseBytes int64               `json:"response_bytes"`
}

type EventInput struct {
	Timestamp          time.Time
	PolicyVersion      string
	ImageDigest        string
	NormalizedHostname string
	AuditPepper        []byte
	AddressClass       policy.AddressClass
	MethodClass        MethodClass
	Result             Result
	ReasonCode         ReasonCode
	Latency            time.Duration
	RequestBytes       int64
	ResponseBytes      int64
}

func NewEvent(input EventInput) (Event, error) {
	if input.Timestamp.IsZero() || len(input.AuditPepper) < 32 {
		return Event{}, errors.New("audit timestamp and 32-byte pepper are required")
	}
	hostHMAC := ""
	if input.NormalizedHostname != "" {
		normalized, err := authority.NormalizeHostname(input.NormalizedHostname)
		if err != nil || normalized != input.NormalizedHostname {
			return Event{}, errors.New("audit hostname must already be normalized")
		}
		digest := hmac.New(sha256.New, input.AuditPepper)
		_, _ = digest.Write([]byte(input.NormalizedHostname))
		hostHMAC = hex.EncodeToString(digest.Sum(nil))
	}
	eventID := make([]byte, 16)
	if _, err := rand.Read(eventID); err != nil {
		return Event{}, errors.New("generate audit event ID")
	}
	event := Event{
		Timestamp:     input.Timestamp.UTC().Format(time.RFC3339Nano),
		EventID:       hex.EncodeToString(eventID),
		PolicyVersion: input.PolicyVersion,
		ImageDigest:   input.ImageDigest,
		HostHMAC:      hostHMAC,
		AddressClass:  input.AddressClass,
		MethodClass:   input.MethodClass,
		Result:        input.Result,
		ReasonCode:    input.ReasonCode,
		LatencyMS:     clampDurationMilliseconds(input.Latency, MaxAuditLatency),
		RequestBytes:  clampBytes(input.RequestBytes, MaxAuditRequestBytes),
		ResponseBytes: clampBytes(input.ResponseBytes, MaxAuditResponseBytes),
	}
	if err := event.Validate(); err != nil {
		return Event{}, err
	}
	return event, nil
}

func (e Event) Validate() error {
	if _, err := time.Parse(time.RFC3339Nano, e.Timestamp); err != nil {
		return errors.New("invalid audit timestamp")
	}
	if len(e.EventID) != 32 || (len(e.HostHMAC) != 0 && len(e.HostHMAC) != 64) ||
		!isLowerHex(e.EventID) || (e.HostHMAC != "" && !isLowerHex(e.HostHMAC)) {
		return errors.New("invalid audit identifier")
	}
	if !policyVersionPattern.MatchString(e.PolicyVersion) || !imageDigestPattern.MatchString(e.ImageDigest) {
		return errors.New("invalid audit release identity")
	}
	if _, ok := allowedAddressClasses[e.AddressClass]; !ok {
		return errors.New("invalid audit address class")
	}
	if e.MethodClass != MethodConnect && e.MethodClass != MethodRead &&
		e.MethodClass != MethodSideEffect && e.MethodClass != MethodUnsupported {
		return errors.New("invalid audit method class")
	}
	if e.Result != ResultAllowed && e.Result != ResultBlocked {
		return errors.New("invalid audit result")
	}
	if _, ok := allowedReasons[e.ReasonCode]; !ok {
		return errors.New("invalid audit reason")
	}
	if (e.Result == ResultAllowed) != (e.ReasonCode == ReasonAllowed) {
		return errors.New("audit result and reason disagree")
	}
	if e.LatencyMS < 0 || e.LatencyMS > MaxAuditLatency.Milliseconds() ||
		e.RequestBytes < 0 || e.RequestBytes > MaxAuditRequestBytes ||
		e.ResponseBytes < 0 || e.ResponseBytes > MaxAuditResponseBytes {
		return errors.New("audit counters are out of bounds")
	}
	return nil
}

func clampDurationMilliseconds(value, maximum time.Duration) int64 {
	if value < 0 {
		return 0
	}
	if value > maximum {
		value = maximum
	}
	return value.Milliseconds()
}

func clampBytes(value, maximum int64) int64 {
	if value < 0 {
		return 0
	}
	if value > maximum {
		return maximum
	}
	return value
}

func isLowerHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
