package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"maintainflow/browser-egress-proxy/internal/policy"
)

const testImageDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func validInput() EventInput {
	return EventInput{
		Timestamp:          time.Date(2026, 7, 19, 12, 0, 0, 0, time.FixedZone("test", 3600)),
		PolicyVersion:      "policy-2026-07-19.1",
		ImageDigest:        testImageDigest,
		NormalizedHostname: "sentinel-target.example",
		AuditPepper:        bytes.Repeat([]byte{0x5a}, 32),
		AddressClass:       policy.ClassPublicIPv4,
		MethodClass:        MethodConnect,
		Result:             ResultAllowed,
		ReasonCode:         ReasonAllowed,
		Latency:            1250 * time.Millisecond,
		RequestBytes:       512,
		ResponseBytes:      1024,
	}
}

func TestEventSchemaContainsOnlyApprovedFields(t *testing.T) {
	t.Parallel()
	input := validInput()
	event, err := NewEvent(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), input.NormalizedHostname) ||
		strings.Contains(string(encoded), string(input.AuditPepper)) {
		t.Fatalf("audit output leaked a raw input: %s", encoded)
	}

	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"timestamp", "event_id", "policy_version", "image_digest", "host_hmac_sha256",
		"address_class", "method_class", "result", "reason_code", "latency_ms",
		"request_bytes", "response_bytes",
	}
	if len(fields) != len(want) {
		t.Fatalf("audit fields = %v", fields)
	}
	for _, key := range want {
		if _, ok := fields[key]; !ok {
			t.Fatalf("audit field %q missing from %v", key, fields)
		}
	}
	if event.Timestamp != "2026-07-19T11:00:00Z" || event.LatencyMS != 1250 {
		t.Fatalf("event normalization failed: %+v", event)
	}
}

func TestEventHMACStableAndEventIDRandom(t *testing.T) {
	t.Parallel()
	first, err := NewEvent(validInput())
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewEvent(validInput())
	if err != nil {
		t.Fatal(err)
	}
	if first.HostHMAC != second.HostHMAC {
		t.Fatal("same host and pepper produced different HMACs")
	}
	if first.EventID == second.EventID {
		t.Fatal("event IDs must be independently random")
	}
}

func TestEventClampsCounters(t *testing.T) {
	t.Parallel()
	input := validInput()
	input.Latency = 24 * time.Hour
	input.RequestBytes = MaxAuditRequestBytes + 1
	input.ResponseBytes = MaxAuditResponseBytes + 1
	event, err := NewEvent(input)
	if err != nil {
		t.Fatal(err)
	}
	if event.LatencyMS != MaxAuditLatency.Milliseconds() ||
		event.RequestBytes != MaxAuditRequestBytes || event.ResponseBytes != MaxAuditResponseBytes {
		t.Fatalf("event counters were not bounded: %+v", event)
	}
}

func TestEventRejectsArbitraryFieldsAndContradictoryResult(t *testing.T) {
	t.Parallel()
	input := validInput()
	input.ReasonCode = ReasonCode("raw exception: secret-sentinel")
	if _, err := NewEvent(input); err == nil {
		t.Fatal("arbitrary audit reason was accepted")
	}
	input = validInput()
	input.Result = ResultBlocked
	if _, err := NewEvent(input); err == nil {
		t.Fatal("blocked result with allowed reason was accepted")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("sentinel writer error") }

type failingPreflightWriter struct{ failingWriter }

func (failingPreflightWriter) Preflight() error { return errors.New("sentinel preflight error") }

func TestLoggerFailsClosedWithoutReturningWriterDetails(t *testing.T) {
	t.Parallel()
	logger, err := NewLogger(failingWriter{})
	if err != nil {
		t.Fatal(err)
	}
	event, err := NewEvent(validInput())
	if err != nil {
		t.Fatal(err)
	}
	err = logger.Write(event)
	if err == nil || strings.Contains(err.Error(), "sentinel") {
		t.Fatalf("logger error was missing or leaked writer detail: %v", err)
	}
}

func TestLoggerPreflightFailsClosedAndStaysUnhealthy(t *testing.T) {
	t.Parallel()
	logger, err := NewLogger(failingPreflightWriter{})
	if err != nil {
		t.Fatal(err)
	}
	if err := logger.Preflight(); err == nil || strings.Contains(err.Error(), "sentinel") {
		t.Fatalf("preflight error = %v", err)
	}
	if err := logger.Preflight(); err == nil {
		t.Fatal("failed audit logger became healthy")
	}
}

func FuzzAuditEventRedaction(f *testing.F) {
	f.Add("target.example", "secret-value")
	f.Fuzz(func(t *testing.T, host, pepperText string) {
		if len(host) == 0 || len(host) > 512 {
			return
		}
		pepper := []byte(pepperText)
		if len(pepper) < 32 {
			pepper = append(pepper, bytes.Repeat([]byte{'x'}, 32-len(pepper))...)
		}
		digest := sha256.Sum256([]byte(host))
		rawSentinel := "raw-host-sentinel-" + hex.EncodeToString(digest[:]) + ".example.com"
		input := validInput()
		input.NormalizedHostname = rawSentinel
		input.AuditPepper = pepper
		event, err := NewEvent(input)
		if err != nil {
			return
		}
		encoded, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), rawSentinel) {
			t.Fatalf("audit event leaked hostname sentinel")
		}
	})
}

func TestEventRejectsNonNormalizedHostname(t *testing.T) {
	t.Parallel()
	for _, hostname := range []string{"EXAMPLE.com", "https://example.com", "127.0.0.1", "single-label"} {
		input := validInput()
		input.NormalizedHostname = hostname
		if _, err := NewEvent(input); err == nil {
			t.Fatalf("non-normalized audit hostname %q was accepted", hostname)
		}
	}
}

func TestEventAllowsUnavailableHostOnlyAsEmptyHMAC(t *testing.T) {
	t.Parallel()
	input := validInput()
	input.NormalizedHostname = ""
	input.Result = ResultBlocked
	input.ReasonCode = ReasonInvalidAuthority
	event, err := NewEvent(input)
	if err != nil {
		t.Fatal(err)
	}
	if event.HostHMAC != "" {
		t.Fatalf("unavailable host HMAC = %q", event.HostHMAC)
	}
}
