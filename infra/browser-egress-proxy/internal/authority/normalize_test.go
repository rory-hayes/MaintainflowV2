package authority

import (
	"strings"
	"testing"
)

func TestNormalizeHostname(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "lowercase", input: "example.com", want: "example.com"},
		{name: "case fold", input: "WWW.Example.COM", want: "www.example.com"},
		{name: "one root dot", input: "example.com.", want: "example.com"},
		{name: "idna", input: "bücher.example", want: "xn--bcher-kva.example"},
		{name: "non transitional idna", input: "faß.de", want: "xn--fa-hia.de"},
		{name: "hyphen inside label", input: "safe-name.example", want: "safe-name.example"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := NormalizeHostname(test.input)
			if err != nil {
				t.Fatalf("NormalizeHostname(%q) error: %v", test.input, err)
			}
			if got != test.want {
				t.Fatalf("NormalizeHostname(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestNormalizeHostnameRejectsAmbiguousAndLocalForms(t *testing.T) {
	t.Parallel()
	longLabel := strings.Repeat("a", 64) + ".example"
	longName := strings.Repeat("a.", 126) + "example"
	inputs := []string{
		"", "example", "localhost", ".example.com", "example..com", "example.com..",
		"-example.com", "example-.com", "exa_mple.com", "*.example.com",
		" user.example", "user.example ", "user\texample.com", "user\nexample.com",
		"user@example.com", "https://example.com", "example.com/path", "example.com?q=1",
		"example.com#fragment", "example%2ecom", "127.0.0.1", "127.1", "2130706433",
		"0177.0.0.1", "0x7f.0x0.0x0.0x1", "[::1]", "fe80::1%25eth0",
		"example\u3002com", "example\uff0ecom", "example\uff61com", "xn--.example",
		longLabel, longName,
		string([]byte{'0', 0xe1, '.', '0'}),
	}
	for _, input := range inputs {
		input := input
		t.Run(input, func(t *testing.T) {
			t.Parallel()
			if got, err := NormalizeHostname(input); err == nil {
				t.Fatalf("NormalizeHostname(%q) unexpectedly succeeded as %q", input, got)
			}
		})
	}
}

func TestParseConnectAuthority(t *testing.T) {
	t.Parallel()
	valid := map[string]string{
		"example.com:443":    "example.com",
		"EXAMPLE.com:443":    "example.com",
		"bücher.example:443": "xn--bcher-kva.example",
		"example.com.:443":   "example.com",
	}
	for input, expected := range valid {
		actual, err := ParseConnectAuthority(input)
		if err != nil || actual != expected {
			t.Fatalf("ParseConnectAuthority(%q) = %q, %v; want %q", input, actual, err, expected)
		}
	}

	invalid := []string{
		"example.com", "example.com:80", "example.com:0443", "example.com:443/",
		"https://example.com:443", "user@example.com:443", "example.com:443?x=1",
		"127.0.0.1:443", "[::1]:443", "fe80::1%eth0:443", "example.com:443:443",
		" example.com:443", "example.com :443", "example.com:443 ",
	}
	for _, input := range invalid {
		if got, err := ParseConnectAuthority(input); err == nil {
			t.Fatalf("ParseConnectAuthority(%q) unexpectedly succeeded as %q", input, got)
		}
	}
}

func FuzzNormalizeHostname(f *testing.F) {
	for _, seed := range []string{
		"example.com", "EXAMPLE.com.", "bücher.example", "127.0.0.1", "user@example.com",
		"example%2ecom", "example\x00.com", "[::1]", "0177.0.0.1",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		normalized, err := NormalizeHostname(input)
		if err != nil {
			return
		}
		if normalized != strings.ToLower(normalized) || strings.HasSuffix(normalized, ".") ||
			strings.ContainsAny(normalized, "/\\@:#?%[]* ") || !strings.Contains(normalized, ".") {
			t.Fatalf("unsafe successful normalization %q -> %q", input, normalized)
		}
		again, err := NormalizeHostname(normalized)
		if err != nil || again != normalized {
			t.Fatalf("normalization is not idempotent: %q -> %q, %v", normalized, again, err)
		}
	})
}

func FuzzParseConnectAuthority(f *testing.F) {
	for _, seed := range []string{"example.com:443", "127.0.0.1:443", "[::1]:443", "example.com:80"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		host, err := ParseConnectAuthority(input)
		if err != nil {
			return
		}
		if host == "" || !strings.HasSuffix(input, ":443") {
			t.Fatalf("unsafe successful authority parse %q -> %q", input, host)
		}
	})
}
