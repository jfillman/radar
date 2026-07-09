package server

import (
	"errors"
	"log"
	"net/http"
	"slices"

	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/pkg/k8score"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

type ResourceCountsResponse struct {
	Counts      map[string]int `json:"counts"`
	Forbidden   []string       `json:"forbidden,omitempty"`
	Unavailable []string       `json:"unavailable,omitempty"`
	// Reasons maps a forbidden kind key to why it's hidden:
	//   "rbac_denied" — Radar's ServiceAccount can read the kind but the user's
	//      own RBAC denies it. Granting the user list access surfaces it.
	//   "unavailable" — Radar can't read the kind at all (no informer): its type
	//      isn't installed, the SA lacks RBAC, or the feature is off (e.g.
	//      rbac.viewRBAC). A user-level grant won't help.
	Reasons map[string]string `json:"reasons,omitempty"`
}

const (
	reasonRBACDenied  = "rbac_denied"
	reasonUnavailable = "unavailable"
)

const (
	endpointSliceCountKey       = "discovery.k8s.io/EndpointSlice"
	directCountNamespaceCap     = 50
	directCountProbeConcurrency = 8
)

func (s *Server) handleResourceCounts(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	namespaces := s.parseNamespacesForUser(r)
	if noNamespaceAccess(namespaces) {
		s.writeJSON(w, ResourceCountsResponse{Counts: map[string]int{}})
		return
	}

	cache := k8s.GetResourceCache()
	if cache == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Resource cache not available")
		return
	}

	counts := make(map[string]int)
	var forbidden []string
	var unavailable []string
	reasons := map[string]string{}
	covered := map[string]bool{}
	forbiddenSeen := map[string]bool{}
	unavailableSeen := map[string]bool{}

	countKey := func(group, kind string) string {
		if group != "" {
			return group + "/" + kind
		}
		return kind
	}
	markCounted := func(key string, count int) {
		counts[key] = count
		covered[key] = true
	}
	markForbidden := func(key, reason string) {
		if covered[key] {
			return
		}
		if !forbiddenSeen[key] {
			forbidden = append(forbidden, key)
			forbiddenSeen[key] = true
		}
		reasons[key] = reason
		covered[key] = true
	}
	markUnavailable := func(key string) {
		if covered[key] {
			return
		}
		if !unavailableSeen[key] {
			unavailable = append(unavailable, key)
			unavailableSeen[key] = true
		}
		covered[key] = true
	}
	countDirectProbe := func(key string, gvr schema.GroupVersionResource, namespaces []string) {
		dynamicCache := k8s.GetDynamicResourceCache()
		if dynamicCache == nil {
			markUnavailable(key)
			return
		}
		total, err := dynamicCache.CountDirectProbe(r.Context(), gvr, namespaces, directCountNamespaceCap, directCountProbeConcurrency)
		if err != nil {
			markUnavailable(key)
			if !errors.Is(err, k8score.ErrResourceCountUnavailable) {
				log.Printf("[resource-counts] Failed to count %s: %v", key, err)
			}
			return
		}
		markCounted(key, total)
	}

	for _, kl := range k8score.AllKindListers() {
		l := kl.Lister()(cache.ResourceCache)
		if l == nil {
			// No informer: Radar's SA can't read this kind (not installed, SA
			// RBAC, or feature off) — a user-level grant won't surface it.
			markForbidden(kl.CountKey(), reasonUnavailable)
			continue
		}
		// Cluster-scoped kinds: ListCountNamespaced ignores the namespace
		// filter and returns the cluster-wide count, so authorize the kind
		// per-user via SAR before counting.
		if k8s.IsClusterOnlyKind(kl.Kind()) {
			group, resource, ok := k8s.ClusterOnlyKindGVR(kl.Kind())
			if !ok {
				continue
			}
			// A core cluster-scoped kind always exists, so an RBAC denial is
			// surfaced as forbidden rather than silently omitted — otherwise the
			// UI shows "0 / No X found", indistinguishable from an empty cluster.
			if !s.canRead(r, group, resource, "", "list") {
				markForbidden(kl.CountKey(), reasonRBACDenied)
				continue
			}
		}
		n := k8score.ListCountNamespaced(l, namespaces)
		// Namespaces is cluster-scoped but exposed as a filtered list. For
		// namespace-restricted users (non-empty filter), the lister can't
		// honor the filter, so we report the count of namespaces they're
		// allowed to see rather than leaking the cluster-wide total.
		if kl.Kind() == "Namespace" && len(namespaces) > 0 {
			n = len(namespaces)
		}
		markCounted(kl.CountKey(), n)
	}

	// 2. Dynamic resources:
	//   - CRDs are counted only from already-watched informers.
	//   - Built-ins that do not have typed listers are counted with bounded
	//     direct probes, restricted to the existing built-in GVR catalogue.
	discovery := k8s.GetResourceDiscovery()
	dynamicCache := k8s.GetDynamicResourceCache()
	if discovery != nil && dynamicCache != nil {
		resources, err := discovery.GetAPIResources()
		if err != nil {
			log.Printf("[resource-counts] Failed to discover API resources for CRD counts: %v", err)
		} else {
			// Deduplicate CRDs by group+kind, keeping the most stable served version.
			type discoveredInfo struct {
				kind       string
				group      string
				resource   string
				version    string
				namespaced bool
				gvr        schema.GroupVersionResource
			}
			crdSeen := make(map[string]bool)
			crds := make(map[string]discoveredInfo)
			var crdOrder []string
			builtinSeen := make(map[string]bool)
			builtins := make(map[string]discoveredInfo)
			var builtinOrder []string
			for _, res := range resources {
				if !slices.Contains(res.Verbs, "list") {
					continue
				}
				key := countKey(res.Group, res.Kind)
				info := discoveredInfo{
					kind:       res.Kind,
					group:      res.Group,
					resource:   res.Name,
					version:    res.Version,
					namespaced: res.Namespaced,
					gvr:        schema.GroupVersionResource{Group: res.Group, Version: res.Version, Resource: res.Name},
				}
				if res.IsCRD {
					// Informer-backed counts only work for listable+watchable kinds.
					// Create-only review resources (LocalSubjectAccessReview, etc.)
					// never sync an informer and would log a permanent count error.
					if !slices.Contains(res.Verbs, "watch") {
						continue
					}
					if !crdSeen[key] {
						crdSeen[key] = true
						crdOrder = append(crdOrder, key)
						crds[key] = info
					} else if k8score.IsMoreStableVersion(res.Version, crds[key].version) {
						crds[key] = info
					}
					continue
				}
				if covered[key] {
					continue
				}
				if _, ok := k8s.BuiltinGVR(res.Name, res.Group); !ok {
					if _, ok := k8s.BuiltinGVR(res.Kind, res.Group); !ok {
						continue
					}
				}
				if !builtinSeen[key] {
					builtinSeen[key] = true
					builtinOrder = append(builtinOrder, key)
					builtins[key] = info
				} else if k8score.IsMoreStableVersion(res.Version, builtins[key].version) {
					builtins[key] = info
				}
			}

			watchedCounts := dynamicCache.CountWatched(namespaces)
			clusterScopedWatchedCounts := watchedCounts
			if len(namespaces) > 0 {
				clusterScopedWatchedCounts = dynamicCache.CountWatched(nil)
			}
			for _, key := range crdOrder {
				crd := crds[key]
				countSource := watchedCounts
				if !crd.namespaced {
					if !s.canRead(r, crd.group, crd.resource, "", "list") {
						continue
					}
					countSource = clusterScopedWatchedCounts
				}
				if n, ok := countSource[crd.gvr]; ok {
					markCounted(key, n)
					continue
				}
				markUnavailable(key)
			}
			for _, key := range builtinOrder {
				builtin := builtins[key]
				probeNamespaces := namespaces
				if !builtin.namespaced {
					if !s.canRead(r, builtin.group, builtin.resource, "", "list") {
						markForbidden(key, reasonRBACDenied)
						continue
					}
					probeNamespaces = nil
				}
				countDirectProbe(key, builtin.gvr, probeNamespaces)
			}
		}
	}
	if !covered[endpointSliceCountKey] {
		if gvr, ok := k8s.BuiltinGVR("endpointslices", "discovery.k8s.io"); ok {
			countDirectProbe(endpointSliceCountKey, gvr, namespaces)
		} else {
			markUnavailable(endpointSliceCountKey)
		}
	}

	s.writeJSON(w, ResourceCountsResponse{
		Counts:      counts,
		Forbidden:   forbidden,
		Unavailable: unavailable,
		Reasons:     reasons,
	})
}
