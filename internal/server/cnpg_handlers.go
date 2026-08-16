package server

import (
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/skyhook-io/radar/internal/k8s"
)

const cnpgGroup = "postgresql.cnpg.io"

// CNPGCatalogUser is one Cluster pinned to an image catalog.
type CNPGCatalogUser struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	// Major is the PostgreSQL major the Cluster asks the catalog for. A
	// reference without one lands here as 0, which the screen must not describe
	// as "asks for PostgreSQL 0".
	Major int `json:"major,omitempty"`
	// Image the Cluster resolved and is running now. A cluster pinned to a
	// catalog carries no spec.imageName, so this is the only place the running
	// image appears.
	Image string `json:"image,omitempty"`
}

// CNPGCatalogUsersResponse lists the Clusters referencing one image catalog.
type CNPGCatalogUsersResponse struct {
	Clusters []CNPGCatalogUser `json:"clusters"`
}

// handleCNPGCatalogUsers returns the Clusters pinned to an image catalog.
//
//	GET /api/cnpg/imagecatalogs/{namespace}/{name}/clusters
//	GET /api/cnpg/clusterimagecatalogs/{name}/clusters
//
// A ClusterImageCatalog is cluster-scoped and may be referenced from any
// namespace, so the answer's scope is not the subject's. Asking the generic
// resource list without a namespace would inherit the caller's namespace view
// filter — a browsing preference — and report "nothing uses this" on the
// strength of whichever namespaces they happen to be looking at. Scope follows
// permission here, as it does for the RBAC reverse lookups.
func (s *Server) handleCNPGCatalogUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}
	name := chi.URLParam(r, "name")
	if name == "" {
		s.writeError(w, http.StatusBadRequest, "catalog name is required")
		return
	}
	// Empty for the cluster-scoped route, which is what tells the two apart:
	// a Cluster's imageCatalogRef.kind must match the catalog it names.
	namespace := chi.URLParam(r, "namespace")
	wantKind := "ClusterImageCatalog"
	if namespace != "" {
		wantKind = "ImageCatalog"
	}

	if !s.canRead(r, cnpgGroup, "clusters", namespace, "list") {
		s.writeError(w, http.StatusForbidden, "no access to CloudNativePG clusters")
		return
	}
	cache := k8s.GetResourceCache()
	if cache == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Resource cache not available")
		return
	}
	// A namespaced catalog can only be referenced from its own namespace; a
	// cluster-scoped one from anywhere.
	items, err := cache.ListDynamicWithGroup(r.Context(), "Cluster", namespace, cnpgGroup)
	if err != nil {
		// Absent on every cluster without CloudNativePG, which is not a fault.
		s.writeJSON(w, CNPGCatalogUsersResponse{Clusters: []CNPGCatalogUser{}})
		return
	}

	resp := CNPGCatalogUsersResponse{Clusters: []CNPGCatalogUser{}}
	for _, u := range items {
		if u == nil {
			continue
		}
		ref, found, _ := unstructured.NestedMap(u.Object, "spec", "imageCatalogRef")
		if !found {
			continue
		}
		refName, _ := ref["name"].(string)
		if refName != name {
			continue
		}
		// Kyverno-style defaulting: an omitted kind means the namespaced form.
		refKind, _ := ref["kind"].(string)
		if refKind == "" {
			refKind = "ImageCatalog"
		}
		if refKind != wantKind {
			continue
		}
		user := CNPGCatalogUser{Namespace: u.GetNamespace(), Name: u.GetName()}
		if major, ok, _ := unstructured.NestedInt64(u.Object, "spec", "imageCatalogRef", "major"); ok {
			user.Major = int(major)
		}
		if img, _, _ := unstructured.NestedString(u.Object, "status", "image"); img != "" {
			user.Image = img
		}
		resp.Clusters = append(resp.Clusters, user)
	}
	sort.Slice(resp.Clusters, func(i, j int) bool {
		if resp.Clusters[i].Namespace != resp.Clusters[j].Namespace {
			return resp.Clusters[i].Namespace < resp.Clusters[j].Namespace
		}
		return resp.Clusters[i].Name < resp.Clusters[j].Name
	})
	s.writeJSON(w, resp)
}
