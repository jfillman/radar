package topology

import (
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	k8score "github.com/skyhook-io/radar/pkg/k8score"
)

type calicoTestProvider struct {
	*mockProvider
	namespaces []*corev1.Namespace
}

func (p *calicoTestProvider) Namespaces() ([]*corev1.Namespace, error) {
	return p.namespaces, nil
}

type calicoTestDynamic struct {
	gvrs      map[string]schema.GroupVersionResource
	resources map[schema.GroupVersionResource][]*unstructured.Unstructured
	watched   []schema.GroupVersionResource
}

func (d *calicoTestDynamic) List(gvr schema.GroupVersionResource, _ string) ([]*unstructured.Unstructured, error) {
	return d.resources[gvr], nil
}

func (d *calicoTestDynamic) ListNamespaces(gvr schema.GroupVersionResource, _ []string) ([]*unstructured.Unstructured, error) {
	return d.resources[gvr], nil
}

func (d *calicoTestDynamic) Get(gvr schema.GroupVersionResource, namespace, name string) (*unstructured.Unstructured, error) {
	for _, resource := range d.resources[gvr] {
		if resource.GetNamespace() == namespace && resource.GetName() == name {
			return resource, nil
		}
	}
	return nil, nil
}

func (d *calicoTestDynamic) GetWatchedResources() []schema.GroupVersionResource { return d.watched }
func (d *calicoTestDynamic) GetDiscoveryStatus() k8score.CRDDiscoveryStatus {
	return k8score.CRDDiscoveryComplete
}
func (d *calicoTestDynamic) GetGVR(kindOrName string) (schema.GroupVersionResource, bool) {
	for key, gvr := range d.gvrs {
		if key == "projectcalico.org\x00"+kindOrName || key == "crd.projectcalico.org\x00"+kindOrName {
			return gvr, true
		}
	}
	return schema.GroupVersionResource{}, false
}
func (d *calicoTestDynamic) GetGVRWithGroup(kindOrName, group string) (schema.GroupVersionResource, bool) {
	gvr, ok := d.gvrs[group+"\x00"+kindOrName]
	return gvr, ok
}
func (d *calicoTestDynamic) GetKindForGVR(gvr schema.GroupVersionResource) string {
	for key, candidate := range d.gvrs {
		if candidate == gvr {
			return key[len(gvr.Group)+1:]
		}
	}
	return ""
}
func (d *calicoTestDynamic) IsCRD(string) bool { return true }

func calicoTestObject(group, version, kind, namespace, name string, spec map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": group + "/" + version,
		"kind":       kind,
		"metadata": map[string]any{
			"name":      name,
			"namespace": namespace,
		},
		"spec": spec,
	}}
}

func calicoTestDynamicFor(group string) *calicoTestDynamic {
	definitions := []struct {
		kind       string
		resource   string
		version    string
		namespaced bool
	}{
		{"NetworkPolicy", "networkpolicies", "v3", true},
		{"GlobalNetworkPolicy", "globalnetworkpolicies", "v3", false},
		{"StagedNetworkPolicy", "stagednetworkpolicies", "v3", true},
		{"StagedGlobalNetworkPolicy", "stagedglobalnetworkpolicies", "v3", false},
		{"StagedKubernetesNetworkPolicy", "stagedkubernetesnetworkpolicies", "v3", true},
	}
	d := &calicoTestDynamic{
		gvrs:      map[string]schema.GroupVersionResource{},
		resources: map[schema.GroupVersionResource][]*unstructured.Unstructured{},
	}
	for _, definition := range definitions {
		gvr := schema.GroupVersionResource{Group: group, Version: definition.version, Resource: definition.resource}
		d.gvrs[group+"\x00"+definition.kind] = gvr
		switch definition.kind {
		case "NetworkPolicy":
			d.resources[gvr] = []*unstructured.Unstructured{calicoTestObject(group, definition.version, definition.kind, "demo", "frontend-policy", map[string]any{
				"selector": "app == 'frontend'",
			})}
		case "GlobalNetworkPolicy":
			d.resources[gvr] = []*unstructured.Unstructured{calicoTestObject(group, definition.version, definition.kind, "", "backend-global", map[string]any{
				"selector": "app == 'backend'",
			})}
		case "StagedNetworkPolicy":
			d.resources[gvr] = []*unstructured.Unstructured{calicoTestObject(group, definition.version, definition.kind, "demo", "frontend-staged", map[string]any{
				"selector":     "app == 'frontend'",
				"stagedAction": "Deny",
			})}
		case "StagedGlobalNetworkPolicy":
			d.resources[gvr] = []*unstructured.Unstructured{calicoTestObject(group, definition.version, definition.kind, "", "all-staged", map[string]any{
				"selector": "all()",
			})}
		case "StagedKubernetesNetworkPolicy":
			d.resources[gvr] = []*unstructured.Unstructured{calicoTestObject(group, definition.version, definition.kind, "demo", "frontend-kubernetes-staged", map[string]any{
				"podSelector": map[string]any{
					"matchLabels": map[string]any{"app": "frontend"},
				},
				"policyTypes": []any{"Ingress"},
				"ingress": []any{map[string]any{
					"from": []any{map[string]any{"podSelector": map[string]any{
						"matchLabels": map[string]any{"app": "backend"},
					}}},
				}},
			})}
		}
	}
	return d
}

func TestCalicoPolicyTopology(t *testing.T) {
	provider := &calicoTestProvider{
		mockProvider: &mockProvider{
			deployments: []*appsv1.Deployment{
				{ObjectMeta: metav1.ObjectMeta{Name: "frontend", Namespace: "demo"}, Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "frontend"}}}}},
				{ObjectMeta: metav1.ObjectMeta{Name: "backend", Namespace: "demo"}, Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "backend"}}}}},
			},
		},
	}

	topo, err := NewBuilder(provider).WithDynamic(calicoTestDynamicFor("projectcalico.org")).Build(DefaultBuildOptions())
	if err != nil {
		t.Fatalf("Build() error: %v", err)
	}

	nodes := map[NodeKind]Node{}
	for _, node := range topo.Nodes {
		if node.Kind == KindCalicoNetworkPolicy || node.Kind == KindCalicoGlobalNetworkPolicy || node.Kind == KindCalicoStagedNetworkPolicy || node.Kind == KindCalicoStagedGlobalNetworkPolicy || node.Kind == KindCalicoStagedKubernetesNetworkPolicy {
			nodes[node.Kind] = node
		}
	}
	for _, kind := range []NodeKind{KindCalicoNetworkPolicy, KindCalicoGlobalNetworkPolicy, KindCalicoStagedNetworkPolicy, KindCalicoStagedGlobalNetworkPolicy, KindCalicoStagedKubernetesNetworkPolicy} {
		node, ok := nodes[kind]
		if !ok {
			t.Fatalf("missing Calico node %s", kind)
		}
		if node.Data["apiVersion"] != "projectcalico.org/v3" {
			t.Errorf("%s apiVersion = %v", kind, node.Data["apiVersion"])
		}
	}
	if nodes[KindCalicoStagedNetworkPolicy].Status != StatusNeutral {
		t.Errorf("staged policy status = %s, want neutral", nodes[KindCalicoStagedNetworkPolicy].Status)
	}
	for _, edge := range topo.Edges {
		if edge.Source == "caliconetworkpolicy/demo/frontend-policy" && edge.Partial {
			t.Error("enforced Calico policy edge should not be partial")
		}
		if edge.Source == "calicostagednetworkpolicy/demo/frontend-staged" && !edge.Partial {
			t.Error("staged Calico policy edge should be partial")
		}
	}

	hasEdge := func(source, target string) bool {
		for _, edge := range topo.Edges {
			if edge.Type == EdgeProtects && edge.Source == source && edge.Target == target {
				return true
			}
		}
		return false
	}
	if !hasEdge("caliconetworkpolicy/demo/frontend-policy", "deployment/demo/frontend") {
		t.Error("namespaced Calico policy did not select frontend")
	}
	if !hasEdge("calicoglobalnetworkpolicy//backend-global", "deployment/demo/backend") {
		t.Error("global Calico policy did not select backend")
	}
	if !hasEdge("calicostagedkubernetesnetworkpolicy/demo/frontend-kubernetes-staged", "deployment/demo/frontend") {
		t.Error("staged Kubernetes Calico policy did not select frontend")
	}
	for _, edge := range topo.Edges {
		if edge.Source == "calicostagedkubernetesnetworkpolicy/demo/frontend-kubernetes-staged" && !edge.Partial {
			t.Error("staged Kubernetes Calico policy edge should be partial")
		}
	}
	if hasEdge("calicoglobalnetworkpolicy//backend-global", "deployment/demo/frontend") {
		t.Error("global Calico policy selected the wrong workload")
	}
	if nodes[KindCalicoStagedGlobalNetworkPolicy].Data["matchesAllPods"] != true {
		t.Error("all() staged global policy should advertise matchesAllPods")
	}
}

func TestStagedKubernetesCalicoPolicyIsExcludedFromGenericCRDs(t *testing.T) {
	provider := &calicoTestProvider{
		mockProvider: &mockProvider{
			deployments: []*appsv1.Deployment{
				{ObjectMeta: metav1.ObjectMeta{Name: "frontend", Namespace: "demo"}},
			},
		},
	}
	dynamic := calicoTestDynamicFor("projectcalico.org")
	gvr := dynamic.gvrs["projectcalico.org\x00StagedKubernetesNetworkPolicy"]
	dynamic.resources[gvr][0].SetOwnerReferences([]metav1.OwnerReference{{Kind: "Deployment", Name: "frontend"}})
	dynamic.watched = []schema.GroupVersionResource{gvr}

	topo, err := NewBuilder(provider).WithDynamic(dynamic).Build(BuildOptions{IncludeGenericCRDs: true})
	if err != nil {
		t.Fatalf("Build() error: %v", err)
	}

	var policyNodes int
	for _, node := range topo.Nodes {
		if node.Name == "frontend-kubernetes-staged" {
			policyNodes++
			if node.Kind != KindCalicoStagedKubernetesNetworkPolicy {
				t.Fatalf("staged policy was added as generic kind %s", node.Kind)
			}
		}
	}
	if policyNodes != 1 {
		t.Fatalf("staged policy node count = %d, want 1", policyNodes)
	}
}

func TestStagedCalicoPoliciesDoNotCountAsCoverage(t *testing.T) {
	workloadID := "deployment/demo/frontend"
	nodes := []Node{
		{ID: "calicostagednetworkpolicy/demo/preview", Kind: KindCalicoStagedNetworkPolicy, Data: map[string]any{
			"namespace":               "demo",
			"matchesAllPods":          true,
			"policyCoverageWorkloads": []string{workloadID},
		}},
		{ID: workloadID, Kind: KindDeployment, Data: map[string]any{}},
	}
	edges := []Edge{{Source: nodes[0].ID, Target: workloadID, Type: EdgeProtects, Partial: true}}

	annotateNodePolicyCoverage(nodes, edges, nil, nil, nil, nil)

	if got := nodes[1].Data["policyStatus"]; got != "unprotected" {
		t.Fatalf("staged policy coverage status = %v, want unprotected", got)
	}
}

func TestCalicoPolicySelectorsFailClosed(t *testing.T) {
	labels := map[string]string{"app": "frontend", "tier": "web"}
	tests := []struct {
		expression string
		want       bool
		valid      bool
	}{
		{"all()", true, true},
		{"app == 'frontend' && tier in {'web', 'api'}", true, true},
		{"app == 'backend' || has(tier)", true, true},
		{"app ==", false, false},
		{"app ??? 'frontend'", false, false},
	}
	for _, test := range tests {
		expression, valid := compileCalicoSelector(test.expression)
		if valid != test.valid {
			t.Errorf("compileCalicoSelector(%q) valid = %v, want %v", test.expression, valid, test.valid)
		}
		if valid && expression(labels) != test.want {
			t.Errorf("compileCalicoSelector(%q)(labels) = %v, want %v", test.expression, expression(labels), test.want)
		}
	}
}

func TestCalicoEndpointSelectorsUseAutomaticLabels(t *testing.T) {
	workload := newCalicoWorkload("deployment/demo/frontend", "demo", map[string]string{"app": "frontend"}, "default")

	for _, test := range []struct {
		name      string
		selector  string
		wantMatch bool
	}{
		{name: "namespace", selector: "projectcalico.org/namespace == 'demo'", wantMatch: true},
		{name: "orchestrator", selector: "projectcalico.org/orchestrator == 'k8s'", wantMatch: true},
		{name: "wrong namespace", selector: "projectcalico.org/namespace == 'other'", wantMatch: false},
		{name: "wrong orchestrator", selector: "projectcalico.org/orchestrator == 'calico'", wantMatch: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := calicoTestObject("projectcalico.org", "v3", "NetworkPolicy", "demo", test.name, map[string]any{"selector": test.selector})
			matched, valid := CompileCalicoPolicyMatcher(policy).Matches(workload.endpointLabels, nil, workload.serviceAccount, nil)
			if !valid || matched != test.wantMatch {
				t.Fatalf("selector %q matched=%v valid=%v, want matched=%v valid=true", test.selector, matched, valid, test.wantMatch)
			}
		})
	}
}

func TestStagedKubernetesCalicoPolicyUsesRawPodLabels(t *testing.T) {
	policy := calicoTestObject("projectcalico.org", "v3", "StagedKubernetesNetworkPolicy", "demo", "preview", map[string]any{
		"podSelector": map[string]any{"matchLabels": map[string]any{"projectcalico.org/namespace": "demo"}},
	})
	workload := newCalicoWorkload("deployment/demo/preview", "demo", map[string]string{"app": "preview"}, "default")
	matched, valid := CompileCalicoPolicyMatcher(policy).Matches(workload.labels, nil, workload.serviceAccount, nil)
	if !valid {
		t.Fatal("raw Kubernetes pod selector was invalid")
	}
	if matched {
		t.Fatal("staged Kubernetes policy matched a Calico automatic endpoint label")
	}
}

func TestCalicoGlobalNamespaceSelectorRequiresNamespaceLabels(t *testing.T) {
	provider := &calicoTestProvider{mockProvider: &mockProvider{deployments: []*appsv1.Deployment{{ObjectMeta: metav1.ObjectMeta{Name: "frontend", Namespace: "demo"}, Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "frontend"}}}}}}}}
	dynamic := calicoTestDynamicFor("projectcalico.org")
	gvr := dynamic.gvrs["projectcalico.org\x00GlobalNetworkPolicy"]
	dynamic.resources[gvr][0].Object["spec"].(map[string]any)["selector"] = "all()"
	dynamic.resources[gvr][0].Object["spec"].(map[string]any)["namespaceSelector"] = "team == 'prod'"

	topo, err := NewBuilder(provider).WithDynamic(dynamic).Build(DefaultBuildOptions())
	if err != nil {
		t.Fatalf("Build() error: %v", err)
	}
	for _, edge := range topo.Edges {
		if edge.Source == "calicoglobalnetworkpolicy//backend-global" && edge.Type == EdgeProtects {
			t.Fatal("global namespace selector matched without namespace labels")
		}
	}
}

func TestCalicoPolicyResourceRefsCarryGroup(t *testing.T) {
	policy := Node{
		ID: "calicoglobalnetworkpolicy//global", Kind: KindCalicoGlobalNetworkPolicy, Name: "global",
		Data: map[string]any{"namespace": "", "apiVersion": "projectcalico.org/v3"},
	}
	workload := Node{ID: "deployment/demo/web", Kind: KindDeployment, Name: "web", Data: map[string]any{"namespace": "demo"}}
	topo := &Topology{Nodes: []Node{policy, workload}, Edges: []Edge{{Source: policy.ID, Target: workload.ID, Type: EdgeProtects}}}
	rel := GetRelationships("Deployment", "demo", "web", topo, nil, nil)
	if rel == nil || len(rel.NetworkPolicies) != 1 || rel.NetworkPolicies[0].Group != "projectcalico.org" {
		t.Fatalf("NetworkPolicies = %+v, want one projectcalico.org ref", rel)
	}
}

func TestStagedKubernetesCalicoPolicyIdentity(t *testing.T) {
	for _, test := range []struct {
		group, version string
	}{
		{group: "projectcalico.org", version: "v3"},
		{group: "crd.projectcalico.org", version: "v1"},
	} {
		t.Run(test.group, func(t *testing.T) {
			node := Node{
				ID:   "calicostagedkubernetesnetworkpolicy/demo/preview",
				Kind: KindCalicoStagedKubernetesNetworkPolicy,
				Name: "preview",
				Data: map[string]any{"namespace": "demo", "apiVersion": test.group + "/" + test.version},
			}
			tuples, ok := CalicoPolicyRBACTuples(&node)
			if !ok || len(tuples) != 1 || tuples[0] != (SARTuple{Group: test.group, Resource: "stagedkubernetesnetworkpolicies", Namespace: "demo"}) {
				t.Fatalf("RBAC tuples = %+v, %v", tuples, ok)
			}
			if got := buildNodeID("stagedkubernetesnetworkpolicies", "demo", "preview", nil); got != "calicostagedkubernetesnetworkpolicy/demo/preview" {
				t.Fatalf("buildNodeID = %q", got)
			}
		})
	}
}

func TestCalicoPolicyFilterUsesExactGroupAndPreservesNativePolicy(t *testing.T) {
	sharedID := "calicoglobalnetworkpolicy//shared"
	legacyOnlyID := "calicoglobalnetworkpolicy//legacy-only"
	stagedID := "calicostagedglobalnetworkpolicy//preview"
	nativeID := "networkpolicy/demo/native"
	workloadID := "deployment/demo/web"
	topo := &Topology{
		Nodes: []Node{
			{ID: sharedID, Kind: KindCalicoGlobalNetworkPolicy, Name: "shared", Data: map[string]any{
				"apiVersion": "projectcalico.org/v3",
				"apiGroups":  []string{"projectcalico.org", "crd.projectcalico.org"},
			}},
			{ID: legacyOnlyID, Kind: KindCalicoGlobalNetworkPolicy, Name: "legacy-only", Data: map[string]any{
				"apiVersion": "crd.projectcalico.org/v1",
				"apiGroups":  []string{"crd.projectcalico.org"},
			}},
			{ID: stagedID, Kind: KindCalicoStagedGlobalNetworkPolicy, Name: "preview", Data: map[string]any{
				"apiVersion": "projectcalico.org/v3",
				"apiGroups":  []string{"projectcalico.org"},
			}},
			{ID: nativeID, Kind: KindNetworkPolicy, Name: "native", Data: map[string]any{"namespace": "demo", "apiVersion": "networking.k8s.io/v1"}},
			{ID: workloadID, Kind: KindDeployment, Name: "web", Data: map[string]any{"namespace": "demo"}},
		},
		Edges: []Edge{
			{Source: sharedID, Target: workloadID, Type: EdgeProtects},
			{Source: legacyOnlyID, Target: workloadID, Type: EdgeProtects},
			{Source: stagedID, Target: workloadID, Type: EdgeProtects, Partial: true},
			{Source: nativeID, Target: workloadID, Type: EdgeProtects},
		},
	}

	topo.StripCalicoPoliciesExcept(map[SARTuple]bool{
		{Group: "projectcalico.org", Resource: "globalnetworkpolicies"}:       true,
		{Group: "projectcalico.org", Resource: "stagedglobalnetworkpolicies"}: true,
	})

	if len(topo.Nodes) != 4 {
		t.Fatalf("nodes after exact Calico filter = %+v, want the dual-group policy plus staged, native and workload", topo.Nodes)
	}
	for _, node := range topo.Nodes {
		if node.ID == legacyOnlyID {
			t.Fatal("a crd.projectcalico.org-only policy survived a projectcalico.org-only filter")
		}
	}
	if len(topo.Edges) != 3 {
		t.Fatalf("edges after exact Calico filter = %+v, want 3", topo.Edges)
	}
	for _, edge := range topo.Edges {
		if edge.Source == stagedID && !edge.Partial {
			t.Fatal("staged Calico edge lost its partial marker")
		}
		if edge.Source == nativeID && edge.Partial {
			t.Fatal("native NetworkPolicy edge became partial")
		}
	}
}

func TestCalicoPolicyVisibleThroughEitherServingGroup(t *testing.T) {
	sharedID := "calicoglobalnetworkpolicy//shared"
	for _, allowedGroup := range []string{"projectcalico.org", "crd.projectcalico.org"} {
		t.Run(allowedGroup, func(t *testing.T) {
			topo := &Topology{Nodes: []Node{{
				ID: sharedID, Kind: KindCalicoGlobalNetworkPolicy, Name: "shared",
				Data: map[string]any{
					"apiVersion": "projectcalico.org/v3",
					"apiGroups":  []string{"projectcalico.org", "crd.projectcalico.org"},
				},
			}}}
			topo.StripCalicoPoliciesExcept(map[SARTuple]bool{
				{Group: allowedGroup, Resource: "globalnetworkpolicies"}: true,
			})
			if len(topo.Nodes) != 1 {
				t.Fatalf("policy readable through %s was stripped", allowedGroup)
			}
		})
	}

	topo := &Topology{Nodes: []Node{{
		ID: sharedID, Kind: KindCalicoGlobalNetworkPolicy, Name: "shared",
		Data: map[string]any{
			"apiVersion": "projectcalico.org/v3",
			"apiGroups":  []string{"projectcalico.org", "crd.projectcalico.org"},
		},
	}}}
	topo.StripCalicoPoliciesExcept(map[SARTuple]bool{})
	if len(topo.Nodes) != 0 {
		t.Fatal("policy survived with neither group authorized")
	}
}

func TestCalicoPseudoKindsResolveInNeighborhood(t *testing.T) {
	for _, test := range []struct {
		kind string
		want NodeKind
	}{
		{"NetworkPolicy", KindCalicoNetworkPolicy},
		{"GlobalNetworkPolicy", KindCalicoGlobalNetworkPolicy},
		{"StagedNetworkPolicy", KindCalicoStagedNetworkPolicy},
		{"StagedGlobalNetworkPolicy", KindCalicoStagedGlobalNetworkPolicy},
		{"StagedKubernetesNetworkPolicy", KindCalicoStagedKubernetesNetworkPolicy},
	} {
		node := Node{
			ID:   strings.ToLower(string(test.want)) + "//policy",
			Kind: test.want,
			Name: "policy",
			Data: map[string]any{"namespace": "", "apiVersion": "projectcalico.org/v3"},
		}
		topo := &Topology{Nodes: []Node{node}}
		sub := BuildNeighborhoodWithIndex(topo, ResourceRef{Kind: test.kind, Name: "policy", Group: "projectcalico.org"}, NeighborhoodOptions{Profile: ProfileAuto, Hops: 1}, nil, nil)
		if len(sub.Nodes) != 1 || sub.Nodes[0].Kind != test.want {
			t.Errorf("%s resolved to %+v, want %s", test.kind, sub.Nodes, test.want)
		}
	}
}

func TestBuildNeighborhood_CalicoPolicyResolvesFromEitherGroup(t *testing.T) {
	policyID := "caliconetworkpolicy/demo/shared"
	targetID := "deployment/demo/web"
	topo := &Topology{
		Nodes: []Node{
			{ID: policyID, Kind: KindCalicoNetworkPolicy, Name: "shared", Data: map[string]any{
				"namespace":  "demo",
				"apiVersion": "projectcalico.org/v3",
				"apiGroups":  []string{"projectcalico.org", "crd.projectcalico.org"},
			}},
			{ID: targetID, Kind: KindDeployment, Name: "web", Data: map[string]any{"namespace": "demo"}},
		},
		Edges: []Edge{{Source: policyID, Target: targetID, Type: EdgeProtects}},
	}

	for _, group := range []string{"projectcalico.org", "crd.projectcalico.org"} {
		t.Run(group, func(t *testing.T) {
			sub := BuildNeighborhoodWithIndex(topo, ResourceRef{
				Kind: "NetworkPolicy", Namespace: "demo", Name: "shared", Group: group,
			}, NeighborhoodOptions{Profile: ProfileAll, Hops: 1}, nil, nil)
			if len(sub.Nodes) != 2 || sub.Nodes[0].ID != policyID || sub.Nodes[1].ID != targetID {
				t.Fatalf("neighborhood via %s = %+v, want root %s and target %s", group, sub.Nodes, policyID, targetID)
			}
		})
	}
}

// calicoTestDynamicForBoth serves the same policies under both Calico API
// groups, which is what a cluster running the Calico apiserver does.
func calicoTestDynamicForBoth() *calicoTestDynamic {
	combined := calicoTestDynamicFor(calicoProjectGroup)
	legacy := calicoTestDynamicFor(calicoCRDGroup)
	for key, gvr := range legacy.gvrs {
		combined.gvrs[key] = gvr
		combined.resources[gvr] = legacy.resources[gvr]
	}
	return combined
}

func TestCalicoPolicyServedByBothGroupsBuildsOneNode(t *testing.T) {
	provider := &calicoTestProvider{mockProvider: &mockProvider{deployments: []*appsv1.Deployment{
		{ObjectMeta: metav1.ObjectMeta{Name: "frontend", Namespace: "demo"}, Spec: appsv1.DeploymentSpec{
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "frontend"}}},
		}},
	}}}

	topo, err := NewBuilder(provider).WithDynamic(calicoTestDynamicForBoth()).Build(DefaultBuildOptions())
	if err != nil {
		t.Fatalf("Build() error: %v", err)
	}

	seen := map[string]int{}
	for _, node := range topo.Nodes {
		if IsCalicoPolicyKind(node.Kind) {
			seen[string(node.Kind)+"/"+nodeNamespaceFromData(&node)+"/"+node.Name]++
		}
	}
	for identity, count := range seen {
		if count != 1 {
			t.Errorf("%s rendered %d times, want a single node for a policy both groups serve", identity, count)
		}
	}

	policyID := "caliconetworkpolicy/demo/frontend-policy"
	var policy *Node
	for i := range topo.Nodes {
		if topo.Nodes[i].ID == policyID {
			policy = &topo.Nodes[i]
		}
	}
	if policy == nil {
		t.Fatalf("no node with the unqualified ID %q; nodes = %+v", policyID, topo.Nodes)
	}
	tuples, ok := CalicoPolicyRBACTuples(policy)
	if !ok || len(tuples) != 2 {
		t.Fatalf("RBAC tuples = %+v (%v), want one per serving group", tuples, ok)
	}

	edges := 0
	for _, edge := range topo.Edges {
		if edge.Source == policyID && edge.Target == "deployment/demo/frontend" && edge.Type == EdgeProtects {
			edges++
		}
	}
	if edges != 1 {
		t.Fatalf("protects edges from %s = %d, want 1", policyID, edges)
	}
}

func TestCalicoStagedDeletionPreviewsNoProtection(t *testing.T) {
	// The Calico API rejects a selector on a staged deletion, so its spec carries
	// only the action — an absent selector that must not read as "selects all".
	deletion := calicoTestObject(calicoProjectGroup, "v3", "StagedNetworkPolicy", "demo", "retire-frontend", map[string]any{
		"stagedAction": "Delete",
	})
	ignored := calicoTestObject(calicoProjectGroup, "v3", "StagedNetworkPolicy", "demo", "parked", map[string]any{
		"stagedAction": "Ignore",
		"selector":     "all()",
	})
	if CalicoStagedActionPreviewsProtection(deletion) {
		t.Error("a staged deletion was treated as previewed protection")
	}
	if CalicoStagedActionPreviewsProtection(ignored) {
		t.Error("an ignored staged policy was treated as previewed protection")
	}
	set := calicoTestObject(calicoProjectGroup, "v3", "StagedNetworkPolicy", "demo", "tighten", map[string]any{
		"stagedAction": "Set",
		"selector":     "app == 'frontend'",
	})
	if !CalicoStagedActionPreviewsProtection(set) {
		t.Error("a staged Set was not treated as previewed protection")
	}

	provider := &calicoTestProvider{mockProvider: &mockProvider{deployments: []*appsv1.Deployment{
		{ObjectMeta: metav1.ObjectMeta{Name: "frontend", Namespace: "demo"}, Spec: appsv1.DeploymentSpec{
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "frontend"}}},
		}},
	}}}
	dynamic := calicoTestDynamicFor(calicoProjectGroup)
	dynamic.resources[dynamic.gvrs[calicoProjectGroup+"\x00StagedNetworkPolicy"]] = []*unstructured.Unstructured{deletion}

	topo, err := NewBuilder(provider).WithDynamic(dynamic).Build(DefaultBuildOptions())
	if err != nil {
		t.Fatalf("Build() error: %v", err)
	}

	deletionID := "calicostagednetworkpolicy/demo/retire-frontend"
	var node *Node
	for i := range topo.Nodes {
		if topo.Nodes[i].ID == deletionID {
			node = &topo.Nodes[i]
		}
	}
	if node == nil {
		t.Fatalf("the staged deletion is not rendered at all; nodes = %+v", topo.Nodes)
	}
	if node.Data["matchesAllPods"] == true {
		t.Error("a staged deletion claimed to select every workload")
	}
	if node.Data["policyCoverageWorkloads"] != nil {
		t.Errorf("a staged deletion claimed coverage: %v", node.Data["policyCoverageWorkloads"])
	}
	for _, edge := range topo.Edges {
		if edge.Source == deletionID {
			t.Errorf("a staged deletion drew a protects edge to %s", edge.Target)
		}
	}
}
