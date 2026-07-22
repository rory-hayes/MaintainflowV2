package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"maintainflow/browser-egress-proxy/internal/policy"
)

func validRuntimeEnvironment(root string) map[string]string {
	return map[string]string{
		"MF_DIALER_LISTEN_ADDR":              "[fdaa::1234]:9443",
		"MF_DIALER_HEALTH_ADDR":              "127.0.0.1:8081",
		"MF_DIALER_TLS_CERT_FILE":            filepath.Join(root, "server.crt"),
		"MF_DIALER_TLS_KEY_FILE":             filepath.Join(root, "server.key"),
		"MF_DIALER_CLIENT_CA_FILE":           filepath.Join(root, "client-ca.crt"),
		"MF_DIALER_ALLOWED_CLIENT_SPIFFE_ID": "spiffe://maintainflow/interceptor",
		"MF_DIALER_DOT_RESOLVERS":            "1.1.1.1:853|one.one.one.one,8.8.8.8:853|dns.google",
		"MF_DIALER_AUDIT_PEPPER":             strings.Repeat("p", 32),
		"MF_DIALER_IMAGE_DIGEST":             "sha256:" + strings.Repeat("a", 64),
		"MF_DIALER_DOMAIN_DENYLIST_FILE":     filepath.Join(root, "denylist.yaml"),
	}
}

func TestLoadRuntimeUsesLockedSafetyProfile(t *testing.T) {
	t.Parallel()
	environment := validRuntimeEnvironment(t.TempDir())
	configuration, err := LoadRuntime(func(key string) string { return environment[key] })
	if err != nil {
		t.Fatal(err)
	}
	if configuration.PolicyVersion != policy.PolicyFingerprint || configuration.ListenAddress.Port() != 9443 ||
		configuration.DNSConnectBudget != DefaultDNSConnectBudget {
		t.Fatalf("runtime configuration drifted: %+v", configuration)
	}
}

func TestLoadRuntimeRejectsPublicListenerAndResolverNames(t *testing.T) {
	t.Parallel()
	for _, mutation := range []func(map[string]string){
		func(values map[string]string) { values["MF_DIALER_LISTEN_ADDR"] = "0.0.0.0:9443" },
		func(values map[string]string) { values["MF_DIALER_HEALTH_ADDR"] = "10.0.0.1:8081" },
		func(values map[string]string) {
			values["MF_DIALER_DOT_RESOLVERS"] = "dns.google:853|dns.google,1.1.1.1:853|one.one.one.one"
		},
		func(values map[string]string) {
			values["MF_DIALER_ALLOWED_CLIENT_SPIFFE_ID"] = "https://maintainflow/interceptor"
		},
	} {
		environment := validRuntimeEnvironment(t.TempDir())
		mutation(environment)
		if _, err := LoadRuntime(func(key string) string { return environment[key] }); err == nil {
			t.Fatal("unsafe runtime configuration was accepted")
		}
	}
}

func TestLoadVerifiedDomainPolicyRequiresGeneratedFingerprint(t *testing.T) {
	t.Parallel()
	root := filepath.Clean(filepath.Join("..", ".."))
	path, err := filepath.Abs(filepath.Join(root, "policy", "domain-denylist.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadVerifiedDomainPolicy(path)
	if err != nil || !loaded.Ready() {
		t.Fatalf("load reviewed policy: %v", err)
	}
	tampered := filepath.Join(t.TempDir(), "denylist.yaml")
	contents, _ := os.ReadFile(path)
	if err := os.WriteFile(tampered, append(contents, []byte("# tampered\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadVerifiedDomainPolicy(tampered); err == nil {
		t.Fatal("tampered denylist was accepted")
	}
}
