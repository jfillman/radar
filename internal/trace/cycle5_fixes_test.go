package trace

import (
	"strings"
	"testing"

	"github.com/skyhook-io/radar/pkg/probe"
)

// Defect 1: a multi-route headline whose every passing route was reached ONLY via
// the apiserver proxy must say proxy-only - not a bare "All N routes reachable"
// that contradicts CoverageVerdict (which returns unknown on !anyRealPass).
func TestCoverageHeadline_MultiRouteProxyOnly(t *testing.T) {
	tr := &Trace{
		Subject: ResourceRef{Kind: "Ingress", Namespace: "prod", Name: "shop"},
		Verdict: VerdictHealthy, // internal verdict; CoverageVerdict corrects it to unknown
		Routes: []RouteResult{
			{Route: "a.example.com/", Target: "a:80", Outcome: OutcomeReached, Confidence: ConfidenceIndirect},
			{Route: "b.example.com/", Target: "b:80", Outcome: OutcomeVerified, Confidence: ConfidenceIndirect},
		},
		Coverage: &Coverage{Tested: 2, Passed: 2},
	}
	h := CoverageHeadline(tr)
	if strings.Contains(h, "routes reachable") && !strings.Contains(h, "API server") {
		t.Errorf("headline = %q, want a proxy-only qualifier, not a bare 'reachable'", h)
	}
	if !strings.Contains(h, "API server") {
		t.Errorf("headline = %q, want it to name the API server (real path not confirmed)", h)
	}
	if CoverageVerdict(tr) != VerdictUnknown {
		t.Errorf("CoverageVerdict = %q, want unknown for proxy-only - headline must agree", CoverageVerdict(tr))
	}
}

// A multi-route headline with at least one REAL pass keeps the confident wording.
func TestCoverageHeadline_MultiRouteRealStaysReachable(t *testing.T) {
	tr := &Trace{
		Subject: ResourceRef{Kind: "Ingress", Namespace: "prod", Name: "shop"},
		Routes: []RouteResult{
			{Route: "a/", Target: "a:80", Outcome: OutcomeVerified, Confidence: ConfidenceReal},
			{Route: "b/", Target: "b:80", Outcome: OutcomeVerified, Confidence: ConfidenceReal},
		},
		Coverage: &Coverage{Tested: 2, Passed: 2},
	}
	if h := CoverageHeadline(tr); !strings.Contains(h, "All 2 routes reachable") {
		t.Errorf("headline = %q, want the confident 'All 2 routes reachable'", h)
	}
}

// Defect 12: a shared (Port==0) front-door HTTP 2xx must NOT, on its own, VERIFY a
// backend port route whose own probes didn't independently succeed - it caps at
// "reached", never a false green "verified · real".
func TestRoutesByPort_SharedFrontDoorDoesNotVerifyPort(t *testing.T) {
	shared := []probe.Result{
		{Layer: probe.LayerHTTP, Target: "http://shop/", Port: 0, OK: true, Tone: probe.ToneHealthy, Vantage: probe.VantageLocal},
	}
	// The backend's own :9090 probe skipped (non-HTTP from a laptop) - only the
	// shared front-door / 2xx is live for this port.
	skipped := probe.Skipped(probe.LayerHTTP, "port 9090", probe.VantageLocal, "non-HTTP port - can't verify from here")
	skipped.Port = 9090
	probes := append(append([]probe.Result{}, shared...), skipped)
	routes := routesByPort("api/", "api", "api:9090", probes, []int32{9090}, nil)
	if len(routes) != 1 {
		t.Fatalf("want 1 route, got %d", len(routes))
	}
	if routes[0].Outcome == OutcomeVerified {
		t.Errorf("outcome = verified - a port-agnostic front-door 2xx must not verify a backend port route")
	}
	if routes[0].Outcome != OutcomeReached {
		t.Errorf("outcome = %q, want reached (front door reached, this port not independently verified)", routes[0].Outcome)
	}
}

// A port's OWN healthy HTTP probe still wins to verified even alongside the shared
// front-door context.
func TestRoutesByPort_OwnHealthyStillVerifies(t *testing.T) {
	shared := []probe.Result{
		{Layer: probe.LayerHTTP, Target: "http://shop/", Port: 0, OK: true, Tone: probe.ToneHealthy, Vantage: probe.VantageLocal},
	}
	own := probe.Result{Layer: probe.LayerHTTP, Target: "port 80", Port: 80, OK: true, Tone: probe.ToneHealthy, Vantage: probe.VantageInCluster}
	probes := append(append([]probe.Result{}, shared...), own)
	routes := routesByPort("api/", "api", "api:80", probes, []int32{80}, nil)
	if len(routes) != 1 || routes[0].Outcome != OutcomeVerified {
		t.Fatalf("want a verified route from the port's own healthy probe, got %+v", routes)
	}
}

// Defect 2: when an in-cluster confirmation flips a broken verdict toward healthy,
// the stale Reason + BrokenRoute must be cleared so they don't contradict the
// now-healthy projection.
func TestApplyInClusterResults_ClearsStaleReasonAndBrokenRoute(t *testing.T) {
	podRef := ResourceRef{Kind: "Pods", Namespace: "prod"}
	tr := &Trace{
		Subject:     ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"},
		Verdict:     VerdictBroken,
		Reason:      "the entry is unreachable - traffic can't pass through it",
		BrokenAt:    1,
		BrokenRoute: &podRef,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"}, Edge: "entry:Service"},
			{Resource: podRef, Edge: "Service->Pods"},
		},
		Routes:   []RouteResult{{Route: "api", Target: "api:80", Outcome: OutcomeVerified, Confidence: ConfidenceReal}},
		Coverage: &Coverage{Tested: 1, Passed: 1},
	}
	ApplyInClusterResults(tr, nil)
	if tr.Verdict != VerdictHealthy {
		t.Fatalf("verdict = %q, want healthy", tr.Verdict)
	}
	if tr.Reason != "" {
		t.Errorf("Reason = %q, want cleared - a stale break sentence must not survive a flip to healthy", tr.Reason)
	}
	if tr.BrokenRoute != nil {
		t.Errorf("BrokenRoute = %+v, want nil - no break remains", tr.BrokenRoute)
	}
}

// TestApplyInClusterResults_UpgradesCollapsedUnknown pins the in-cluster path
// against the verdict-collapse regression: an unknown that the coverage collapse
// produced because the laptop trace was apiserver-only (UnknownClass empty) MUST
// re-derive after the in-cluster pass upgrades its routes to real. Only a genuine
// special-shape unknown (UnknownClass set) stays unknown. Without the guard fix,
// the "Test in-cluster" button could never lift a trace off unknown.
func TestApplyInClusterResults_UpgradesCollapsedUnknown(t *testing.T) {
	base := func(unknownClass string) *Trace {
		return &Trace{
			Subject:      ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"},
			Verdict:      VerdictUnknown,
			UnknownClass: unknownClass,
			BrokenAt:     -1,
			Downstream: []Hop{
				{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"}, Edge: "entry:Service"},
				{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
			},
			Routes:   []RouteResult{{Route: "api", Target: "api:80", Outcome: OutcomeVerified, Confidence: ConfidenceReal}},
			Coverage: &Coverage{Tested: 1, Passed: 1},
		}
	}
	// Collapse-induced unknown (no UnknownClass): the in-cluster real pass must lift it.
	up := base("")
	ApplyInClusterResults(up, nil)
	if up.Verdict != VerdictHealthy {
		t.Errorf("collapse-unknown after in-cluster real pass = %q, want healthy (must re-derive)", up.Verdict)
	}
	// Genuine special-shape unknown (e.g. selectorless): stays unknown.
	special := base(UnknownClassByDesign)
	ApplyInClusterResults(special, nil)
	if special.Verdict != VerdictUnknown {
		t.Errorf("special-shape unknown = %q, want unknown preserved", special.Verdict)
	}
}
