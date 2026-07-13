package server

import (
	"testing"

	topology "github.com/skyhook-io/radar/pkg/topology"
)

// deniedKindsKey is the grouping seam that keeps a user who is denied a
// cluster-scoped topology kind from sharing a more-privileged peer's
// pre-marshaled (un-stripped) frame. It must be empty for full access (the
// common case, so those users still coalesce) and stable + sorted otherwise.
func TestDeniedKindsKey(t *testing.T) {
	if got := deniedKindsKey(nil); got != "" {
		t.Fatalf("nil → %q, want empty (full-access users must coalesce)", got)
	}
	if got := deniedKindsKey(map[topology.NodeKind]bool{}); got != "" {
		t.Fatalf("empty → %q, want empty", got)
	}
	if got := deniedKindsKey(map[topology.NodeKind]bool{"Node": true}); got != "Node" {
		t.Fatalf("single → %q, want Node", got)
	}

	// Same set, different insertion order → identical key (map iteration order
	// must not leak into grouping, or two equally-denied users would build
	// duplicate frames).
	a := deniedKindsKey(map[topology.NodeKind]bool{"StorageClass": true, "Node": true, "PersistentVolume": true})
	b := deniedKindsKey(map[topology.NodeKind]bool{"Node": true, "PersistentVolume": true, "StorageClass": true})
	if a != b {
		t.Fatalf("unstable key across iteration order: %q vs %q", a, b)
	}
	if a != "Node,PersistentVolume,StorageClass" {
		t.Fatalf("key = %q, want Node,PersistentVolume,StorageClass", a)
	}
}

func TestNodeClassAuthorizationGroupsUseExactProviderResource(t *testing.T) {
	eksTuple := topology.SARTuple{Group: "eks.amazonaws.com", Resource: "nodeclasses"}
	customTuple := topology.SARTuple{Group: "infra.example.io", Resource: "customnodeclasses"}
	topo := &topology.Topology{
		Nodes: []topology.Node{
			{ID: "nodepool//default", Kind: topology.KindNodePool, Name: "default"},
			{ID: "nodeclass//shared/eks.amazonaws.com/nodeclass", Kind: topology.KindNodeClass, Name: "shared", Data: map[string]any{"apiVersion": "eks.amazonaws.com/v1", "resource": "nodeclasses"}},
			{ID: "nodeclass//shared/infra.example.io/customnodeclass", Kind: topology.KindNodeClass, Name: "shared", Data: map[string]any{"apiVersion": "infra.example.io/v1", "resource": "customnodeclasses"}},
		},
		Edges: []topology.Edge{
			{Source: "nodepool//default", Target: "nodeclass//shared/eks.amazonaws.com/nodeclass", Type: topology.EdgeConfigures},
			{Source: "nodepool//default", Target: "nodeclass//shared/infra.example.io/customnodeclass", Type: topology.EdgeConfigures},
		},
	}

	allowed := authorizedNodeClassTuples(topo, func(tuple topology.SARTuple) bool {
		return tuple == eksTuple
	})
	if !allowed[eksTuple] || allowed[customTuple] {
		t.Fatalf("allowed tuples = %+v, want EKS only", allowed)
	}
	if nodeClassTuplesKey(allowed) == nodeClassTuplesKey(map[topology.SARTuple]bool{customTuple: true}) {
		t.Fatal("different provider grants collapsed to one SSE authorization group")
	}

	filtered := cloneTopology(topo)
	filtered.StripNodeClassesExcept(allowed)
	if len(filtered.Nodes) != 2 || len(filtered.Edges) != 1 || filtered.Edges[0].Target != "nodeclass//shared/eks.amazonaws.com/nodeclass" {
		t.Fatalf("exact provider filter produced nodes=%+v edges=%+v", filtered.Nodes, filtered.Edges)
	}
	if len(topo.Nodes) != 3 || len(topo.Edges) != 2 {
		t.Fatal("filtering one SSE authorization group mutated the shared base topology")
	}
}

// clientCanSeeChange gates k8s_event (diff-bearing) frames per client so a
// restricted user doesn't receive change content for namespaces or cluster-scoped
// kinds their RBAC forbids.
func TestClientCanSeeChange(t *testing.T) {
	allAccess := ClientInfo{Namespaces: nil}
	scopedAB := ClientInfo{Namespaces: []string{"a", "b"}}
	noAccess := ClientInfo{Namespaces: []string{"__no_access__"}}
	deniedNodes := ClientInfo{DeniedKinds: map[topology.NodeKind]bool{"Node": true}}
	// A user who can't list namespaces has Namespace added to the deny set at
	// subscribe (handleSSE), so Namespace change events (cluster-scoped, name="")
	// are blocked.
	deniedNamespaces := ClientInfo{Namespaces: []string{"a"}, DeniedKinds: map[topology.NodeKind]bool{"Namespace": true}}

	cases := []struct {
		name      string
		info      ClientInfo
		namespace string
		kind      string
		want      bool
	}{
		{"all-access sees namespaced change", allAccess, "a", "ConfigMap", true},
		{"scoped sees allowed namespace", scopedAB, "a", "Deployment", true},
		{"scoped does NOT see other namespace", scopedAB, "c", "Deployment", false},
		{"no-access sees nothing namespaced", noAccess, "a", "ConfigMap", false},
		{"cluster-scoped allowed when not denied", scopedAB, "", "Node", true},
		{"cluster-scoped denied kind blocked", deniedNodes, "", "Node", false},
		{"cluster-scoped non-denied kind allowed", deniedNodes, "", "StorageClass", true},
		{"Namespace event blocked when can't list namespaces", deniedNamespaces, "", "Namespace", false},
		{"Namespace event allowed when can list namespaces", scopedAB, "", "Namespace", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := clientCanSeeChange(tc.info, tc.namespace, tc.kind); got != tc.want {
				t.Fatalf("clientCanSeeChange(%v, %q, %q) = %v, want %v", tc.info, tc.namespace, tc.kind, got, tc.want)
			}
		})
	}
}
