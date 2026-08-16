package server

import (
	"os"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/skyhook-io/radar/internal/auth"
)

// Velero resolves an unset spec.storageLocation to the location marked default.
// Reading absent as "no location" would drop every backup taken with the default
// settings out of the list — which is most of them — and leave a storage location
// page saying nothing depends on it.
func TestVeleroBackupLocation_AppliesVeleroDefault(t *testing.T) {
	for _, c := range []struct {
		name string
		spec map[string]interface{}
		want string
	}{
		{"explicit location", map[string]interface{}{"storageLocation": "dr-replica"}, "dr-replica"},
		{"absent means default", map[string]interface{}{}, "default"},
		{"empty means default", map[string]interface{}{"storageLocation": ""}, "default"},
	} {
		t.Run(c.name, func(t *testing.T) {
			u := &unstructured.Unstructured{Object: map[string]interface{}{"spec": c.spec}}
			if got := veleroBackupLocation(u); got != c.want {
				t.Errorf("veleroBackupLocation(%v) = %q, want %q", c.spec, got, c.want)
			}
		})
	}
}

// A caller who may not list Backups is told so. An empty list would read as "this
// storage location holds nothing", which on the page someone opens to decide
// whether they can still restore is the worst possible wrong answer.
func TestVeleroStoredBackups_DeniesRatherThanReportingAnEmptyLocation(t *testing.T) {
	env := newAuthTestServer(t)
	perms := &auth.UserPermissions{AllowedNamespaces: []string{"velero"}}
	allow(perms, veleroGroup, "backups", "velero", false)
	env.srv.permCache.Set("nobody", perms)

	resp := env.authGet(t, "/api/velero/backupstoragelocations/velero/default/backups", "nobody", "")
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("status = %d, want 403 for a caller who may not list backups", resp.StatusCode)
	}
}

// Same contract as the other reverse lookups: an absent CRD is a real "nothing
// here"; every other failure is a failure to look and must not read as an empty
// location.
func TestVeleroStoredBackups_SeparatesAnAbsentCRDFromAFailedRead(t *testing.T) {
	src := mustReadSource(t, "velero_handlers.go")
	for _, want := range []string{"k8s.ErrUnknownDynamicKind", "errDynamicNotSynced", "listDynamicSynced", "sanitizeForLog"} {
		if !strings.Contains(src, want) {
			t.Errorf("handler does not use %s — a failed or unsynced read would report an empty location", want)
		}
	}
}

func mustReadSource(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
