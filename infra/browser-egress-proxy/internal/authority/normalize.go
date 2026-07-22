package authority

import (
	"errors"
	"net/netip"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

var (
	ErrInvalidHostname  = errors.New("invalid hostname")
	ErrInvalidAuthority = errors.New("invalid CONNECT authority")

	lookupProfile = idna.New(
		idna.MapForLookup(),
		idna.StrictDomainName(true),
		idna.Transitional(false),
		idna.VerifyDNSLength(true),
		idna.ValidateLabels(true),
		idna.BidiRule(),
	)
)

// NormalizeHostname applies strict UTS #46 lookup processing and returns the
// canonical lower-case ASCII DNS name without a trailing root dot. Exactly one
// trailing dot is accepted. URL syntax, IP literals, alternate IP spellings,
// search-domain names, and ambiguous separators are rejected before lookup.
func NormalizeHostname(input string) (string, error) {
	if input == "" || !utf8.ValidString(input) || input != strings.TrimSpace(input) {
		return "", ErrInvalidHostname
	}
	for _, r := range input {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return "", ErrInvalidHostname
		}
	}
	if strings.ContainsAny(input, "/\\@:#?%[]*") ||
		strings.ContainsAny(input, "\u3002\uff0e\uff61") {
		return "", ErrInvalidHostname
	}

	if strings.HasSuffix(input, ".") {
		input = strings.TrimSuffix(input, ".")
		if input == "" || strings.HasSuffix(input, ".") {
			return "", ErrInvalidHostname
		}
	}

	ascii, err := lookupProfile.ToASCII(input)
	if err != nil {
		return "", ErrInvalidHostname
	}
	ascii = strings.ToLower(ascii)
	if len(ascii) == 0 || len(ascii) > 253 {
		return "", ErrInvalidHostname
	}

	labels := strings.Split(ascii, ".")
	if len(labels) < 2 || looksLikeAlternateIP(labels) {
		return "", ErrInvalidHostname
	}
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", ErrInvalidHostname
		}
		for i := 0; i < len(label); i++ {
			character := label[i]
			if (character < 'a' || character > 'z') &&
				(character < '0' || character > '9') && character != '-' {
				return "", ErrInvalidHostname
			}
		}
	}
	if _, err := netip.ParseAddr(ascii); err == nil {
		return "", ErrInvalidHostname
	}
	return ascii, nil
}

// ParseConnectAuthority accepts only hostname:443 authority form. The caller
// remains responsible for requiring HTTP/1.1 CONNECT when the slice-2 listener
// is implemented.
func ParseConnectAuthority(input string) (string, error) {
	if input == "" || input != strings.TrimSpace(input) ||
		strings.ContainsAny(input, "/\\@?#%[]") || strings.Count(input, ":") != 1 {
		return "", ErrInvalidAuthority
	}
	host, port, ok := strings.Cut(input, ":")
	if !ok || port != "443" {
		return "", ErrInvalidAuthority
	}
	normalized, err := NormalizeHostname(host)
	if err != nil {
		return "", ErrInvalidAuthority
	}
	return normalized, nil
}

func looksLikeAlternateIP(labels []string) bool {
	for _, label := range labels {
		if label == "" {
			return false
		}
		candidate := label
		if strings.HasPrefix(candidate, "0x") || strings.HasPrefix(candidate, "0X") {
			candidate = candidate[2:]
			if candidate == "" {
				return false
			}
			for _, character := range candidate {
				if !((character >= '0' && character <= '9') ||
					(character >= 'a' && character <= 'f') ||
					(character >= 'A' && character <= 'F')) {
					return false
				}
			}
			continue
		}
		for _, character := range candidate {
			if character < '0' || character > '9' {
				return false
			}
		}
	}
	return true
}
