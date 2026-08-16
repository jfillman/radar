package server

import (
	"errors"
	"log"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/skyhook-io/radar/internal/k8s"
)

const veleroGroup = "velero.io"

// VeleroStoredBackup is one Backup held in a storage location.
type VeleroStoredBackup struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Phase     string `json:"phase,omitempty"`
	// Expiration is when Velero will delete this backup. A location full of
	// backups that all expire next week is a different answer to "what can I
	// restore" than one that keeps them for a year.
	Expiration string `json:"expiration,omitempty"`
	// Completed is when the backup finished — the point in time a restore from
	// it would return to.
	Completed string `json:"completed,omitempty"`
}

// VeleroStoredBackupsResponse lists what one storage location holds.
type VeleroStoredBackupsResponse struct {
	Backups []VeleroStoredBackup `json:"backups"`
	// Restorable counts the backups that reached Completed. The rest are in the
	// location's namespace but are not something to restore from.
	Restorable int `json:"restorable"`
}

// handleVeleroStoredBackups returns the Backups held in one BackupStorageLocation.
//
//	GET /api/velero/backupstoragelocations/{namespace}/{name}/backups
//
// The inverse of the field a Backup carries. A storage location page that cannot
// say what depends on it leaves "this location is Unavailable" as a fact with no
// consequence attached, when the consequence — these are the backups you cannot
// restore from right now — is the reason anyone opened the page.
//
// Server-side, gated on listing Backups, for the same reason every other reverse
// lookup here is: the answer's scope belongs to permission, not to whichever
// namespaces the reader happens to be viewing.
func (s *Server) handleVeleroStoredBackups(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if namespace == "" || name == "" {
		s.writeError(w, http.StatusBadRequest, "storage location namespace and name are required")
		return
	}
	if !s.canRead(r, veleroGroup, "backups", namespace, "list") {
		s.writeError(w, http.StatusForbidden, "no access to Velero backups")
		return
	}
	cache := k8s.GetResourceCache()
	if cache == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Resource cache not available")
		return
	}

	// Backups live in the same namespace as the location that holds them —
	// Velero's own installation namespace.
	items, err := listDynamicSynced(r.Context(), cache, "Backup", veleroGroup, namespace)
	switch {
	case err == nil:
	case errors.Is(err, k8s.ErrUnknownDynamicKind):
		// No Velero on this cluster, so nothing is stored anywhere.
		s.writeJSON(w, VeleroStoredBackupsResponse{Backups: []VeleroStoredBackup{}})
		return
	case errors.Is(err, errDynamicNotSynced):
		s.writeError(w, http.StatusServiceUnavailable, "backups are still loading")
		return
	default:
		log.Printf("[velero] Failed to list Backups for storage location %s/%s: %v",
			sanitizeForLog(namespace), sanitizeForLog(name), err)
		s.writeError(w, http.StatusServiceUnavailable, "could not read Velero backups")
		return
	}

	resp := VeleroStoredBackupsResponse{Backups: []VeleroStoredBackup{}}
	for _, u := range items {
		if u == nil || veleroBackupLocation(u) != name {
			continue
		}
		b := VeleroStoredBackup{Namespace: u.GetNamespace(), Name: u.GetName()}
		b.Phase, _, _ = unstructured.NestedString(u.Object, "status", "phase")
		b.Expiration, _, _ = unstructured.NestedString(u.Object, "status", "expiration")
		b.Completed, _, _ = unstructured.NestedString(u.Object, "status", "completionTimestamp")
		if b.Phase == "Completed" {
			resp.Restorable++
		}
		resp.Backups = append(resp.Backups, b)
	}
	// Newest first: the question is almost always "what is the most recent thing
	// I can restore from".
	sort.Slice(resp.Backups, func(i, j int) bool {
		if resp.Backups[i].Completed != resp.Backups[j].Completed {
			return resp.Backups[i].Completed > resp.Backups[j].Completed
		}
		return resp.Backups[i].Name < resp.Backups[j].Name
	})
	s.writeJSON(w, resp)
}

// veleroBackupLocation is the storage location a Backup names, applying Velero's
// default. An unset spec.storageLocation means the location marked default, which
// Velero resolves at creation and records as the literal name "default" in every
// install that has not renamed it.
func veleroBackupLocation(u *unstructured.Unstructured) string {
	if loc, ok, _ := unstructured.NestedString(u.Object, "spec", "storageLocation"); ok && loc != "" {
		return loc
	}
	return "default"
}
