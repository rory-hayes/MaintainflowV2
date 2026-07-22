package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseRegistryHandlesCommaSeparatedPrefixes(t *testing.T) {
	t.Parallel()
	xmlBody := []byte(`<?xml version="1.0"?>
<registry xmlns="http://www.iana.org/assignments">
  <updated>2026-07-19</updated>
  <registry><record><address>192.0.0.170/32, 192.0.0.171/32</address></record></registry>
</registry>`)
	registry, prefixes, err := parseRegistry(xmlBody)
	if err != nil {
		t.Fatal(err)
	}
	if registry.Updated != "2026-07-19" || strings.Join(prefixes, ",") != "192.0.0.170/32,192.0.0.171/32" {
		t.Fatalf("registry = %+v, prefixes = %v", registry, prefixes)
	}
}

func TestParseRegistryRejectsInvalidOrEmptyPolicy(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`<registry><updated>2026-07-19</updated><registry><record><address>not-a-prefix</address></record></registry></registry>`,
		`<registry><updated>2026-07-19</updated><registry></registry></registry>`,
		`<registry><registry><record><address>10.0.0.0/8</address></record></registry></registry>`,
		`not xml`,
	} {
		if _, _, err := parseRegistry([]byte(body)); err == nil {
			t.Fatalf("invalid registry unexpectedly accepted: %q", body)
		}
	}
}

func TestParseRegistryRejectsWrongAddressFamily(t *testing.T) {
	t.Parallel()
	body := []byte(`<registry><updated>2026-07-19</updated><registry><record><address>2001:db8::/32</address></record></registry></registry>`)
	if _, _, err := parseRegistry(body, 4); err == nil {
		t.Fatal("IPv6 prefix was accepted in IPv4 snapshot")
	}
}

func TestRenderGeneratedIsFormattedAndDeterministic(t *testing.T) {
	t.Parallel()
	first, err := renderGenerated("2026-07-19", strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64), strings.Repeat("e", 64), []string{"10.0.0.0/8", "::1/128"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := renderGenerated("2026-07-19", strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64), strings.Repeat("e", 64), []string{"10.0.0.0/8", "::1/128"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) || !bytes.Contains(first, []byte(`"10.0.0.0/8"`)) {
		t.Fatalf("generated output is unstable or incomplete:\n%s", first)
	}
}
