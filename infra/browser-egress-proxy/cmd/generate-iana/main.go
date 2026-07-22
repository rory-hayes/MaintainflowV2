package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"go/format"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	ipv4URL          = "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xml"
	ipv6URL          = "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xml"
	maxSnapshotBytes = 1 << 20
	warningAge       = 30 * 24 * time.Hour
	maximumAge       = 90 * 24 * time.Hour
)

var policySourcePaths = []string{
	"internal/authority/normalize.go",
	"internal/policy/addresses.go",
	"internal/policy/decision.go",
	"internal/policy/domains.go",
}

type registryXML struct {
	Updated    string          `xml:"updated"`
	Registries []registryTable `xml:"registry"`
}

type registryTable struct {
	Records []registryRecord `xml:"record"`
}

type registryRecord struct {
	Address string `xml:"address"`
}

type registryManifest struct {
	Source      string `json:"source"`
	Updated     string `json:"updated"`
	SHA256      string `json:"sha256"`
	PrefixCount int    `json:"prefix_count"`
}

type policyManifest struct {
	SchemaVersion     int                         `json:"schema_version"`
	RetrievedAt       string                      `json:"retrieved_at"`
	Generator         string                      `json:"generator"`
	PolicyFingerprint string                      `json:"policy_fingerprint"`
	DomainDenylistSHA string                      `json:"domain_denylist_sha256"`
	PolicySourceSHA   string                      `json:"policy_source_sha256"`
	Registries        map[string]registryManifest `json:"registries"`
}

func main() {
	root := flag.String("root", ".", "browser-egress-proxy directory")
	refresh := flag.Bool("refresh", false, "download fresh snapshots from IANA before generating")
	check := flag.Bool("check", false, "fail if checked-in generated policy differs")
	retrievedAt := flag.String("retrieved-at", "", "snapshot retrieval date in YYYY-MM-DD")
	flag.Parse()
	if *refresh && *check {
		fatal(errors.New("-refresh and -check cannot be combined"))
	}

	policyDir := filepath.Join(*root, "policy")
	generatedPath := filepath.Join(*root, "internal", "policy", "iana_generated.go")
	manifestPath := filepath.Join(policyDir, "policy-manifest.json")
	v4Path := filepath.Join(policyDir, "iana-ipv4-special-registry.xml")
	v6Path := filepath.Join(policyDir, "iana-ipv6-special-registry.xml")
	denylistPath := filepath.Join(policyDir, "domain-denylist.yaml")

	if *refresh {
		freshV4, err := fetchSnapshot(ipv4URL, 4)
		if err != nil {
			fatal(err)
		}
		freshV6, err := fetchSnapshot(ipv6URL, 6)
		if err != nil {
			fatal(err)
		}
		if err := atomicWrite(v4Path, freshV4); err != nil {
			fatal(err)
		}
		if err := atomicWrite(v6Path, freshV6); err != nil {
			fatal(err)
		}
		if *retrievedAt == "" {
			*retrievedAt = time.Now().UTC().Format(time.DateOnly)
		}
	}

	v4Bytes := mustRead(v4Path)
	v6Bytes := mustRead(v6Path)
	denylistBytes := mustRead(denylistPath)
	v4, v4Prefixes := mustParseRegistry(v4Bytes, 4)
	v6, v6Prefixes := mustParseRegistry(v6Bytes, 6)
	allPrefixes := uniqueSorted(append(append([]string(nil), v4Prefixes...), v6Prefixes...))

	if *retrievedAt == "" {
		if existing, err := readManifest(manifestPath); err == nil {
			*retrievedAt = existing.RetrievedAt
		}
	}
	retrievedTime, err := time.Parse(time.DateOnly, *retrievedAt)
	if err != nil {
		fatal(errors.New("-retrieved-at must be a valid YYYY-MM-DD date"))
	}
	if *check {
		age := time.Since(retrievedTime)
		if age < -24*time.Hour {
			fatal(errors.New("IANA snapshot retrieval date is in the future"))
		}
		if age > maximumAge {
			fatal(errors.New("IANA snapshot exceeds the 90-day release maximum; refresh is required"))
		}
		if age > warningAge {
			fmt.Fprintln(os.Stderr, "warning: IANA snapshot is older than 30 days")
		}
	}

	v4Hash := hash(v4Bytes)
	v6Hash := hash(v6Bytes)
	denylistHash := hash(denylistBytes)
	policySourceHash := hashPolicySources(*root)
	fingerprint := hash([]byte(v4Hash + "\n" + v6Hash + "\n" + denylistHash + "\n" + policySourceHash + "\n"))
	manifest := policyManifest{
		SchemaVersion:     1,
		RetrievedAt:       *retrievedAt,
		Generator:         "go run ./cmd/generate-iana",
		PolicyFingerprint: fingerprint,
		DomainDenylistSHA: denylistHash,
		PolicySourceSHA:   policySourceHash,
		Registries: map[string]registryManifest{
			"ipv4": {Source: ipv4URL, Updated: v4.Updated, SHA256: v4Hash, PrefixCount: len(v4Prefixes)},
			"ipv6": {Source: ipv6URL, Updated: v6.Updated, SHA256: v6Hash, PrefixCount: len(v6Prefixes)},
		},
	}

	generatedBytes, err := renderGenerated(*retrievedAt, fingerprint, v4Hash, v6Hash, denylistHash, policySourceHash, allPrefixes)
	if err != nil {
		fatal(err)
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		fatal(err)
	}
	manifestBytes = append(manifestBytes, '\n')

	if *check {
		mustMatch(generatedPath, generatedBytes)
		mustMatch(manifestPath, manifestBytes)
		return
	}
	if err := atomicWrite(generatedPath, generatedBytes); err != nil {
		fatal(err)
	}
	if err := atomicWrite(manifestPath, manifestBytes); err != nil {
		fatal(err)
	}
}

func fetchSnapshot(source string, addressFamilyBits int) ([]byte, error) {
	parsed, err := url.Parse(source)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "www.iana.org" {
		return nil, errors.New("snapshot source must be an approved IANA HTTPS URL")
	}
	client := &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) > 2 || request.URL.Scheme != "https" || request.URL.Hostname() != "www.iana.org" {
				return errors.New("unapproved snapshot redirect")
			}
			return nil
		},
	}
	request, err := http.NewRequest(http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("IANA snapshot returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxSnapshotBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) == 0 || len(body) > maxSnapshotBytes {
		return nil, errors.New("IANA snapshot is empty or oversized")
	}
	if _, _, err := parseRegistry(body, addressFamilyBits); err != nil {
		return nil, err
	}
	return body, nil
}

func mustParseRegistry(body []byte, addressFamilyBits int) (registryXML, []string) {
	registry, prefixes, err := parseRegistry(body, addressFamilyBits)
	if err != nil {
		fatal(err)
	}
	return registry, prefixes
}

func parseRegistry(body []byte, addressFamilyBits ...int) (registryXML, []string, error) {
	if len(addressFamilyBits) > 1 || (len(addressFamilyBits) == 1 && addressFamilyBits[0] != 4 && addressFamilyBits[0] != 6) {
		return registryXML{}, nil, errors.New("registry address family must be IPv4 or IPv6")
	}
	var registry registryXML
	if err := xml.Unmarshal(body, &registry); err != nil {
		return registryXML{}, nil, fmt.Errorf("parse registry XML: %w", err)
	}
	if registry.Updated == "" || len(registry.Registries) == 0 {
		return registryXML{}, nil, errors.New("registry metadata is incomplete")
	}
	prefixes := make([]string, 0)
	for _, table := range registry.Registries {
		for _, record := range table.Records {
			for _, raw := range strings.Split(record.Address, ",") {
				raw = strings.TrimSpace(raw)
				if raw != "" {
					prefix, err := netip.ParsePrefix(raw)
					if err != nil {
						return registryXML{}, nil, fmt.Errorf("registry contains invalid prefix %q", raw)
					}
					if len(addressFamilyBits) == 1 && ((addressFamilyBits[0] == 4) != prefix.Addr().Is4()) {
						return registryXML{}, nil, fmt.Errorf("registry prefix %q has the wrong address family", raw)
					}
					prefixes = append(prefixes, raw)
				}
			}
		}
	}
	if len(prefixes) == 0 {
		return registryXML{}, nil, errors.New("registry contains no prefixes")
	}
	return registry, uniqueSorted(prefixes), nil
}

func renderGenerated(retrievedAt, fingerprint, v4Hash, v6Hash, denylistHash, policySourceHash string, prefixes []string) ([]byte, error) {
	var output bytes.Buffer
	fmt.Fprintln(&output, "// Code generated by cmd/generate-iana; DO NOT EDIT.")
	fmt.Fprintln(&output, "package policy")
	fmt.Fprintln(&output)
	fmt.Fprintf(&output, "const IANASnapshotRetrievedAt = %q\n", retrievedAt)
	fmt.Fprintf(&output, "const PolicyFingerprint = %q\n", fingerprint)
	fmt.Fprintf(&output, "const IANAIPv4SnapshotSHA256 = %q\n", v4Hash)
	fmt.Fprintf(&output, "const IANAIPv6SnapshotSHA256 = %q\n", v6Hash)
	fmt.Fprintf(&output, "const DomainDenylistSHA256 = %q\n", denylistHash)
	fmt.Fprintf(&output, "const PolicySourceSHA256 = %q\n", policySourceHash)
	fmt.Fprintln(&output)
	fmt.Fprintln(&output, "var ianaRegistryPrefixStrings = []string{")
	for _, prefix := range prefixes {
		fmt.Fprintf(&output, "\t%q,\n", prefix)
	}
	fmt.Fprintln(&output, "}")
	return format.Source(output.Bytes())
}

func readManifest(path string) (policyManifest, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return policyManifest{}, err
	}
	var manifest policyManifest
	if err := json.Unmarshal(contents, &manifest); err != nil {
		return policyManifest{}, err
	}
	return manifest, nil
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func hash(contents []byte) string {
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:])
}

func hashPolicySources(root string) string {
	digest := sha256.New()
	for _, relativePath := range policySourcePaths {
		contents := mustRead(filepath.Join(root, filepath.FromSlash(relativePath)))
		_, _ = io.WriteString(digest, relativePath+"\n")
		_, _ = digest.Write(contents)
		_, _ = io.WriteString(digest, "\n")
	}
	return hex.EncodeToString(digest.Sum(nil))
}

func mustRead(path string) []byte {
	contents, err := os.ReadFile(path)
	if err != nil {
		fatal(err)
	}
	return contents
}

func atomicWrite(path string, contents []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".generate-iana-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func mustMatch(path string, expected []byte) {
	actual, err := os.ReadFile(path)
	if err != nil {
		fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		fatal(fmt.Errorf("%s is stale; run go run ./cmd/generate-iana", path))
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
