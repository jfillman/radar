package trace

import (
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Defect 1: a kube-system-resident workload whose egress rule allows port 53 to a
// same-namespace podSelector matching CoreDNS DOES reach DNS — the gap must not
// false-fire. A non-kube-system source keeps the prior "gap fires" behavior.
func TestRuleDestCoversDNS_KubeSystemSource(t *testing.T) {
	coreDNS := rule(nil, peerPod(sel("k8s-app", "kube-dns")))
	if got := ruleDestCoversDNS(&coreDNS, metav1.NamespaceSystem); got != triYes {
		t.Errorf("kube-system source + CoreDNS podSelector: dest cover = %v, want triYes", got)
	}
	// A kube-system source whose peer is NOT CoreDNS stays uncovered (gap may fire).
	other := rule(nil, peerPod(sel("app", "other")))
	if got := ruleDestCoversDNS(&other, metav1.NamespaceSystem); got == triYes {
		t.Errorf("kube-system source + non-CoreDNS podSelector: dest cover = %v, want not-triYes", got)
	}
	// A normal namespace source: same-namespace podSelector does not reach CoreDNS.
	if got := ruleDestCoversDNS(&coreDNS, "prod"); got == triYes {
		t.Errorf("non-kube-system source: same-ns podSelector must not cover DNS, got %v", got)
	}
}

// Defect 3: routeBackendDrained marks an explicit weight-0 backend with a live
// sibling as drained; a traffic-carrying or weight-omitted backend is not.
func TestRouteBackendDrained(t *testing.T) {
	route := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata":   map[string]any{"name": "r", "namespace": "prod"},
		"spec": map[string]any{
			"rules": []any{map[string]any{"backendRefs": []any{
				map[string]any{"name": "stable", "weight": int64(100)},
				map[string]any{"name": "canary", "weight": int64(0)},
			}}},
		},
	}}
	if !routeBackendDrained(route, "prod", "canary") {
		t.Error("canary (weight 0, live sibling) must be drained")
	}
	if routeBackendDrained(route, "prod", "stable") {
		t.Error("stable (weight 100) must NOT be drained")
	}

	// Weight omitted on the zero-candidate → defaults to traffic-carrying.
	noWeight := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "r", "namespace": "prod"},
		"spec": map[string]any{"rules": []any{map[string]any{"backendRefs": []any{
			map[string]any{"name": "stable", "weight": int64(100)},
			map[string]any{"name": "canary"},
		}}}},
	}}
	if routeBackendDrained(noWeight, "prod", "canary") {
		t.Error("weight-omitted backend must NOT be drained")
	}

	// All-zero (no live sibling) → not drained (no traffic anywhere, not a cutover).
	allZero := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "r", "namespace": "prod"},
		"spec": map[string]any{"rules": []any{map[string]any{"backendRefs": []any{
			map[string]any{"name": "a", "weight": int64(0)},
			map[string]any{"name": "b", "weight": int64(0)},
		}}}},
	}}
	if routeBackendDrained(allZero, "prod", "a") {
		t.Error("all-zero weights (no live sibling) must NOT be drained")
	}
}

// Defect 3: a DOWN drained (weight-0) backend must not drag the verdict to
// broken/degraded — it carries zero traffic by design.
func TestComputeVerdict_DrainedBackendExcluded(t *testing.T) {
	tr := &Trace{
		Subject: ResourceRef{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Namespace: "prod", Name: "r"},
		Verdict: VerdictHealthy,
		Downstream: []Hop{
			{Resource: ResourceRef{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Namespace: "prod", Name: "r"}, Edge: "entry:HTTPRoute"},
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "stable"}, Edge: "HTTPRoute->Service"},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "canary"}, Edge: "HTTPRoute->Service",
				Meta:     map[string]any{"drained": true},
				Findings: []Finding{{Code: "route:drained-weight-zero", Severity: SeverityInfo}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods",
				Findings: []Finding{{Code: "svc:no-ready-endpoints", Severity: SeverityCritical, Message: "0/0 ready"}}},
		},
	}
	if v, _ := computeVerdict(tr); v != VerdictHealthy {
		t.Errorf("verdict = %q, want healthy — a down DRAINED backend must not condemn the path", v)
	}
}

// Defect 3: a drained backend hop folds into coverage as a benign skip (no
// coverage lost), never a failed route or a coverage gap.
func TestBuildRoutes_DrainedBackendBenignSkip(t *testing.T) {
	tr := &Trace{
		Subject: ResourceRef{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Namespace: "prod", Name: "r"},
		Downstream: []Hop{
			{Resource: ResourceRef{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Namespace: "prod", Name: "r"}, Edge: "entry:HTTPRoute",
				Config: &HopConfig{Rules: []RouteRule{{Backends: []BackendRef{{Name: "stable"}}}, {Backends: []BackendRef{{Name: "canary"}}}}}},
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "stable"}, Edge: "HTTPRoute->Service", Config: &HopConfig{Ports: []PortMap{{Port: 80}}}},
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "canary"}, Edge: "HTTPRoute->Service",
				Config:   &HopConfig{Ports: []PortMap{{Port: 80}}},
				Meta:     map[string]any{"drained": true},
				Findings: []Finding{{Code: "route:drained-weight-zero", Severity: SeverityInfo}}},
		},
	}
	_, skips := buildRoutes(tr)
	var benignDrained bool
	for _, s := range skips {
		if s.ReasonClass == SkipClassBenign && strings.Contains(s.Reason, "drained") {
			benignDrained = true
		}
	}
	if !benignDrained {
		t.Errorf("drained backend must yield a benign skip, got skips=%+v", skips)
	}
}

// Defects 2 & 12: ApplyInClusterResults re-derives the verdict over the updated
// findings — a stale 'degraded' left after a would-deny downgrade must not sit
// beside a now-healthy projection.
func TestApplyInClusterResults_RederivesVerdict(t *testing.T) {
	tr := &Trace{
		Subject: ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"},
		Verdict: VerdictDegraded, // stale from a static would-deny prediction
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"}, Edge: "entry:Service"},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
		},
		Routes:   []RouteResult{{Route: "api", Target: "api:80", Outcome: OutcomeVerified, Confidence: ConfidenceReal}},
		Coverage: &Coverage{Tested: 1, Passed: 1},
	}
	ApplyInClusterResults(tr, nil)
	if tr.Verdict != VerdictHealthy {
		t.Errorf("verdict = %q, want healthy — clean findings must re-derive over a stale degraded", tr.Verdict)
	}
}

// Defect 13: an upstream missing_ref critical (about a sibling backend route)
// must NOT block the broken→degraded benign softening for a scale-to-0 here.
func TestHasNonBenignCriticalFinding_ScopesUpstreamMissingRef(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"}, Edge: "entry:Service"},
		},
		Upstreams: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Namespace: "prod", Name: "shop"}, Edge: "entry:Ingress",
				Findings: []Finding{{Code: "missing_ref:ghost", Severity: SeverityCritical, Message: "/other references ghost"}}},
		},
	}
	if hasNonBenignCriticalFinding(tr) {
		t.Error("upstream missing_ref critical must be scoped out (sibling route), not block softening")
	}
	// A downstream critical IS scanned unconditionally.
	tr.Downstream[0].Findings = []Finding{{Code: "svc:no-controller", Severity: SeverityCritical}}
	if !hasNonBenignCriticalFinding(tr) {
		t.Error("a downstream critical must still register")
	}
}
