package cloud

import (
	"os"
	"testing"
)

// withTempHome points HOME at a temp dir so credential files don't touch the
// developer's real ~/.radar.
func withTempHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	// os.UserHomeDir on some platforms consults other vars; HOME is the
	// dominant one on the CI/dev targets and is what t.Setenv controls.
}

func TestCredentials_RoundTrip(t *testing.T) {
	withTempHome(t)

	if _, ok := GetClusterCredential("kind-a"); ok {
		t.Fatal("expected no credential before save")
	}

	cred := ClusterCredential{
		HubBase: "https://api.radarhq.io", ClusterID: "abc123", ClusterName: "prod",
		Token: "rhc_secret", WSSURL: "wss://api.radarhq.io/agent",
	}
	if err := SaveClusterCredential("kind-a", cred); err != nil {
		t.Fatal(err)
	}

	got, ok := GetClusterCredential("kind-a")
	if !ok || got != cred {
		t.Fatalf("round-trip mismatch: %+v ok=%v", got, ok)
	}

	// A second context coexists.
	if err := SaveClusterCredential("kind-b", ClusterCredential{ClusterID: "def456", Token: "rhc_2"}); err != nil {
		t.Fatal(err)
	}
	if all := LoadCredentials(); len(all.Clusters) != 2 {
		t.Fatalf("want 2 clusters, got %d", len(all.Clusters))
	}
}

func TestCredentials_FileIs0600(t *testing.T) {
	withTempHome(t)
	if err := SaveClusterCredential("kind-a", ClusterCredential{Token: "rhc_secret"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(CredentialsPath())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("credentials file mode = %o, want 0600 (token is a secret)", perm)
	}
}

func TestCredentials_Remove(t *testing.T) {
	withTempHome(t)
	_ = SaveClusterCredential("kind-a", ClusterCredential{Token: "rhc_1"})

	removed, err := RemoveClusterCredential("kind-a")
	if err != nil || !removed {
		t.Fatalf("remove: removed=%v err=%v", removed, err)
	}
	if _, ok := GetClusterCredential("kind-a"); ok {
		t.Error("credential still present after remove")
	}

	// Removing a missing context is a no-op, not an error.
	removed, err = RemoveClusterCredential("kind-a")
	if err != nil || removed {
		t.Fatalf("second remove should be no-op: removed=%v err=%v", removed, err)
	}
}

func TestLoadCredentials_MissingFileIsEmpty(t *testing.T) {
	withTempHome(t)
	c := LoadCredentials()
	if c.Clusters == nil {
		t.Error("Clusters map must be non-nil even when the file is absent")
	}
	if len(c.Clusters) != 0 {
		t.Errorf("expected empty, got %d", len(c.Clusters))
	}
}
