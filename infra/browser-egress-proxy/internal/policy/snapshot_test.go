package policy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestSnapshotHashesAndManifest(t *testing.T) {
	t.Parallel()
	v4 := mustReadTestFile(t, "../../policy/iana-ipv4-special-registry.xml")
	v6 := mustReadTestFile(t, "../../policy/iana-ipv6-special-registry.xml")
	manifestBytes := mustReadTestFile(t, "../../policy/policy-manifest.json")
	if hashTest(v4) != IANAIPv4SnapshotSHA256 || hashTest(v6) != IANAIPv6SnapshotSHA256 {
		t.Fatal("generated snapshot hashes do not match checked-in XML")
	}
	var manifest struct {
		RetrievedAt       string `json:"retrieved_at"`
		PolicyFingerprint string `json:"policy_fingerprint"`
		PolicySourceSHA   string `json:"policy_source_sha256"`
		Registries        map[string]struct {
			SHA256      string `json:"sha256"`
			PrefixCount int    `json:"prefix_count"`
		} `json:"registries"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.RetrievedAt != IANASnapshotRetrievedAt || manifest.PolicyFingerprint != PolicyFingerprint {
		t.Fatalf("manifest identity does not match generated code: %+v", manifest)
	}
	if manifest.PolicySourceSHA != PolicySourceSHA256 {
		t.Fatalf("manifest policy source hash does not match generated code")
	}
	if manifest.Registries["ipv4"].SHA256 != IANAIPv4SnapshotSHA256 ||
		manifest.Registries["ipv6"].SHA256 != IANAIPv6SnapshotSHA256 ||
		manifest.Registries["ipv4"].PrefixCount+manifest.Registries["ipv6"].PrefixCount != len(RegistryPrefixes()) {
		t.Fatalf("manifest registry data does not match generated policy: %+v", manifest.Registries)
	}
}

func mustReadTestFile(t *testing.T, path string) []byte {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return contents
}

func hashTest(contents []byte) string {
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:])
}
