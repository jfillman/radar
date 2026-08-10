package topology

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// v1 Claim -> bound XR -> composed MRs, via spec.resourceRef (singular) on the
// Claim and spec.resourceRefs (plural) on the XR.
func TestBuildCrossplaneV1ClaimChainEdges(t *testing.T) {
	claimGVR := schema.GroupVersionResource{Group: "demo.example.io", Version: "v1alpha1", Resource: "databaseclaims"}
	xrGVR := schema.GroupVersionResource{Group: "demo.example.io", Version: "v1alpha1", Resource: "xdatabases"}
	objGVR := schema.GroupVersionResource{Group: "kubernetes.crossplane.io", Version: "v1alpha2", Resource: "objects"}

	claim := karpenterTopologyObject("demo.example.io/v1alpha1", "DatabaseClaim", "example-database", "claim-uid", map[string]any{
		"spec": map[string]any{
			"compositionRef": map[string]any{"name": "xdatabases.demo.example.io"},
			"resourceRef": map[string]any{
				"apiVersion": "demo.example.io/v1alpha1", "kind": "XDatabase", "name": "example-database-xr",
			},
		},
	})
	claim.SetNamespace("demo-app")

	xr := karpenterTopologyObject("demo.example.io/v1alpha1", "XDatabase", "example-database-xr", "xr-uid", map[string]any{
		"spec": map[string]any{
			"resourceRefs": []any{
				map[string]any{"apiVersion": "kubernetes.crossplane.io/v1alpha2", "kind": "Object", "name": "example-database-configmap"},
				map[string]any{"apiVersion": "kubernetes.crossplane.io/v1alpha2", "kind": "Object", "name": "example-database-service"},
				map[string]any{"apiVersion": "kubernetes.crossplane.io/v1alpha2", "kind": "Object", "name": "example-database-connection"},
			},
		},
	})

	mr := func(name string) *unstructured.Unstructured {
		return karpenterTopologyObject("kubernetes.crossplane.io/v1alpha2", "Object", name, name+"-uid", map[string]any{
			"spec": map[string]any{"providerConfigRef": map[string]any{"name": "default"}},
		})
	}

	dynamic := &karpenterDynamicProvider{
		exact: map[string]schema.GroupVersionResource{},
		resources: map[schema.GroupVersionResource][]*unstructured.Unstructured{
			claimGVR: {claim},
			xrGVR:    {xr},
			objGVR:   {mr("example-database-configmap"), mr("example-database-service"), mr("example-database-connection")},
		},
		kinds: map[schema.GroupVersionResource]string{
			claimGVR: "DatabaseClaim", xrGVR: "XDatabase", objGVR: "Object",
		},
		watched:            []schema.GroupVersionResource{claimGVR, xrGVR, objGVR},
		listCalls:          make(map[schema.GroupVersionResource]int),
		listNamespaceCalls: make(map[schema.GroupVersionResource]int),
	}

	topo, err := NewBuilder(&mockProvider{}).WithDynamic(dynamic).Build(DefaultBuildOptions())
	if err != nil {
		t.Fatalf("Build() error: %v", err)
	}

	claimID := "databaseclaim/demo-app/example-database"
	xrID := "xdatabase//example-database-xr"
	composed := []string{"object//example-database-configmap", "object//example-database-service", "object//example-database-connection"}

	for _, id := range append([]string{claimID, xrID}, composed...) {
		if findNode(topo, id) == nil {
			t.Fatalf("missing Crossplane node %q; nodes=%+v", id, topo.Nodes)
		}
	}
	if !hasKarpenterTopologyEdge(topo, claimID, xrID, EdgeManages) {
		t.Fatalf("missing claim -> XR manages edge; edges=%+v", topo.Edges)
	}
	for _, mrID := range composed {
		if !hasKarpenterTopologyEdge(topo, xrID, mrID, EdgeManages) {
			t.Fatalf("missing XR -> composed edge %s; edges=%+v", mrID, topo.Edges)
		}
	}
	// A claim has no composed refs of its own — no direct claim -> MR edge.
	for _, mrID := range composed {
		if hasKarpenterTopologyEdge(topo, claimID, mrID, EdgeManages) {
			t.Fatalf("unexpected claim -> composed edge %s", mrID)
		}
	}
}

// v2 namespaced XR -> composed namespaced MRs, via spec.crossplane.resourceRefs.
func TestBuildCrossplaneV2NamespacedXREdges(t *testing.T) {
	xrGVR := schema.GroupVersionResource{Group: "demo.example.io", Version: "v1alpha1", Resource: "appstacks"}
	objGVR := schema.GroupVersionResource{Group: "kubernetes.m.crossplane.io", Version: "v1alpha1", Resource: "objects"}

	xr := karpenterTopologyObject("demo.example.io/v1alpha1", "AppStack", "web-stack", "xr-uid", map[string]any{
		"spec": map[string]any{
			"crossplane": map[string]any{
				"resourceRefs": []any{
					map[string]any{"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object", "name": "web-stack-configmap"},
					map[string]any{"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object", "name": "web-stack-service"},
				},
			},
		},
	})
	xr.SetNamespace("v2-app")

	mr := func(name string) *unstructured.Unstructured {
		o := karpenterTopologyObject("kubernetes.m.crossplane.io/v1alpha1", "Object", name, name+"-uid", map[string]any{
			"spec": map[string]any{"providerConfigRef": map[string]any{"name": "default", "kind": "ProviderConfig"}},
		})
		o.SetNamespace("v2-app")
		return o
	}

	dynamic := &karpenterDynamicProvider{
		exact: map[string]schema.GroupVersionResource{},
		resources: map[schema.GroupVersionResource][]*unstructured.Unstructured{
			xrGVR:  {xr},
			objGVR: {mr("web-stack-configmap"), mr("web-stack-service")},
		},
		kinds: map[schema.GroupVersionResource]string{
			xrGVR: "AppStack", objGVR: "Object",
		},
		watched:            []schema.GroupVersionResource{xrGVR, objGVR},
		listCalls:          make(map[schema.GroupVersionResource]int),
		listNamespaceCalls: make(map[schema.GroupVersionResource]int),
	}

	topo, err := NewBuilder(&mockProvider{}).WithDynamic(dynamic).Build(DefaultBuildOptions())
	if err != nil {
		t.Fatalf("Build() error: %v", err)
	}

	xrID := "appstack/v2-app/web-stack"
	composed := []string{"object/v2-app/web-stack-configmap", "object/v2-app/web-stack-service"}
	if findNode(topo, xrID) == nil {
		t.Fatalf("missing namespaced XR node %q; nodes=%+v", xrID, topo.Nodes)
	}
	for _, mrID := range composed {
		if findNode(topo, mrID) == nil {
			t.Fatalf("missing composed node %q; nodes=%+v", mrID, topo.Nodes)
		}
		if !hasKarpenterTopologyEdge(topo, xrID, mrID, EdgeManages) {
			t.Fatalf("missing v2 XR -> composed edge %s; edges=%+v", mrID, topo.Edges)
		}
	}
}
