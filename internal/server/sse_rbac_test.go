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

// The sensitive-kind gate: two users in the SAME namespace with different
// grants must diverge on Secret/RBAC/webhook change frames. Being allowed a
// namespace must never imply receiving privileged change metadata from it
// (Secret key names, Role rules, webhook configs).
func TestClientCanSeeChangeSensitiveKinds(t *testing.T) {
	denySensitive := map[string]bool{
		"Secret": true, "Role": true, "RoleBinding": true,
		"ClusterRole": true, "ClusterRoleBinding": true,
		"MutatingWebhookConfiguration": true, "ValidatingWebhookConfiguration": true,
	}
	// Both clients can see namespace "a"; only one holds cluster-wide reads.
	privileged := ClientInfo{Namespaces: []string{"a"}}
	restricted := ClientInfo{Namespaces: []string{"a"}, DeniedSensitiveKinds: denySensitive}

	cases := []struct {
		name      string
		info      ClientInfo
		namespace string
		kind      string
		want      bool
	}{
		{"privileged sees Secret change in allowed ns", privileged, "a", "Secret", true},
		{"restricted does NOT see Secret change in ALLOWED ns", restricted, "a", "Secret", false},
		{"restricted does NOT see Role change in allowed ns", restricted, "a", "Role", false},
		{"restricted does NOT see RoleBinding change", restricted, "a", "RoleBinding", false},
		{"restricted does NOT see ClusterRole change", restricted, "", "ClusterRole", false},
		{"restricted does NOT see webhook change", restricted, "", "MutatingWebhookConfiguration", false},
		{"restricted still sees ordinary kinds in allowed ns", restricted, "a", "Deployment", true},
		{"restricted still sees ConfigMap (not in sensitive set)", restricted, "a", "ConfigMap", true},
		{"privileged unaffected on cluster-scoped sensitive", privileged, "", "ClusterRole", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := clientCanSeeChange(tc.info, tc.namespace, tc.kind); got != tc.want {
				t.Fatalf("clientCanSeeChange(%q, %q) = %v, want %v", tc.namespace, tc.kind, got, tc.want)
			}
		})
	}
}
