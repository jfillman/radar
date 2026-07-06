package trace

import (
	"testing"

	"github.com/skyhook-io/radar/pkg/probe"
)

// Defects 2 & 12: ApplyInClusterResults re-derives the verdict over the updated
// findings - a stale 'degraded' left after a would-deny downgrade must not sit
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
		t.Errorf("verdict = %q, want healthy - clean findings must re-derive over a stale degraded", tr.Verdict)
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

// Defect 2: ApplyInClusterResults must prune the SkipClassVantage "run radar
// in-cluster" NotTested rows for routes the live in-cluster pass just upgraded to a
// real reach/verify. Otherwise the response reports the route verified while
// advising "run radar in-cluster" for the SAME route, and coverage counts it as
// Passed AND Skipped.
func TestApplyInClusterResults_PrunesResolvedVantageSkip(t *testing.T) {
	tr := &Trace{
		Verdict: VerdictUnknown, // skip verdict re-derive; isolate the coverage/NotTested fold
		Routes: []RouteResult{{
			Route:            "api:80",
			Target:           "api:80",
			TargetNamespace:  "prod",
			Outcome:          OutcomeNotTested,
			InClusterRequest: &ProbeRequest{Host: "api", Path: "/"},
		}},
		NotTested: []RouteSkip{{
			Route:       "api:80",
			Reason:      "couldn't reach an internal address from your machine - run radar in-cluster",
			ReasonClass: SkipClassVantage,
		}},
	}
	key := InClusterResultKey("api:80", "api:80", "prod")
	byTarget := map[string][]probe.Result{
		key: {{
			Layer:   probe.LayerTCP,
			Target:  "10.0.0.1:80",
			Path:    probe.PathData,
			Port:    80,
			OK:      true,
			Vantage: probe.VantageInCluster,
		}},
	}

	ApplyInClusterResults(tr, byTarget)

	if got := tr.Routes[0].Outcome; got != OutcomeReached && got != OutcomeVerified {
		t.Fatalf("route Outcome = %q, want reached/verified after live in-cluster pass", got)
	}
	if tr.Routes[0].Confidence != ConfidenceReal {
		t.Fatalf("route Confidence = %q, want real", tr.Routes[0].Confidence)
	}
	if len(tr.NotTested) != 0 {
		t.Errorf("NotTested = %+v, want empty - the live pass satisfied the run-in-cluster advice", tr.NotTested)
	}
	if tr.Coverage == nil {
		t.Fatal("Coverage nil")
	}
	if tr.Coverage.Skipped != 0 {
		t.Errorf("Coverage.Skipped = %d, want 0 (no stale same-route skip)", tr.Coverage.Skipped)
	}
	if tr.Coverage.Passed != 1 {
		t.Errorf("Coverage.Passed = %d, want 1", tr.Coverage.Passed)
	}
}

// Regression: a vantage skip whose route did NOT get a live in-cluster pass must
// survive - pruning must be scoped to routes the live pass actually resolved.
func TestApplyInClusterResults_KeepsUnresolvedVantageSkip(t *testing.T) {
	tr := &Trace{
		Verdict: VerdictUnknown,
		Routes: []RouteResult{{
			Route:            "api:80",
			Target:           "api:80",
			TargetNamespace:  "prod",
			Outcome:          OutcomeNotTested,
			InClusterRequest: &ProbeRequest{Host: "api", Path: "/"},
		}},
		NotTested: []RouteSkip{{
			Route:       "other:80",
			Reason:      "couldn't reach an internal address from your machine - run radar in-cluster",
			ReasonClass: SkipClassVantage,
		}},
	}
	// No byTarget result for api:80 → route stays NotTested, nothing resolved.
	ApplyInClusterResults(tr, map[string][]probe.Result{})

	if len(tr.NotTested) != 1 {
		t.Errorf("NotTested = %+v, want the unresolved vantage skip preserved", tr.NotTested)
	}
}

// Defect 1: ApplyInClusterResults reconciles the static would-deny WARNING off
// the live in-cluster pass but used to leave the svc:targetport-no-listener
// WARNING standing. The static reconcileTargetPortAdvisory reads h.Probes, which
// the in-cluster flow stamps only AFTER the verdict/diagnosis recompute - so a
// route the in-cluster pod just verified over REAL traffic would read
// verified/ConfidenceReal while the hop kept the targetPort warning, leaving a
// stale 'degraded' verdict and a 'Service targetPort likely wrong' diagnosis that
// the live success disproves. reconcileInClusterTargetPort must downgrade it.
func TestApplyInClusterResults_DowngradesTargetPortOnLivePass(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"},
		Verdict:  VerdictDegraded, // stale from the static targetPort prediction
		BrokenAt: -1,
		Routes: []RouteResult{{
			Route: "mismatch", Target: "mismatch:80",
			Outcome: OutcomeVerified, Confidence: ConfidenceReal,
			Evidence: "HTTP 200 · in-cluster",
		}},
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Meta:   map[string]any{"targetPortSuspectPorts": []int32{80}},
				Findings: []Finding{{
					Code: "svc:targetport-no-listener", Severity: SeverityWarning,
					Message: "Service targetPort :9999 matches no port the ready pods declare",
					Cause:   "Service targetPort likely wrong",
					Action:  "Confirm the Service targetPort matches the port the container listens on",
				}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
		},
	}

	ApplyInClusterResults(tr, nil)

	idx := findingIndexByCode(tr.Downstream[0].Findings, "svc:targetport-no-listener")
	if idx < 0 {
		t.Fatal("targetPort finding disappeared; want it downgraded to info, not dropped")
	}
	f := tr.Downstream[0].Findings[idx]
	if f.Severity != SeverityInfo {
		t.Errorf("severity = %q, want info - live in-cluster traffic reached the suspect port", f.Severity)
	}
	if f.Cause != "" {
		t.Errorf("downgraded finding must drop the 'likely wrong' Cause, got %q", f.Cause)
	}
	if tr.Verdict == VerdictDegraded {
		t.Error("verdict must re-derive off 'degraded' once the contradicted targetPort warning is info")
	}
	if tr.Diagnosis != nil && tr.Diagnosis.CauseCode == "svc:targetport-no-listener" {
		t.Errorf("diagnosis must not promote the targetPort guess the live pass disproved, got %+v", tr.Diagnosis)
	}
}

// Port scope: a live in-cluster pass on a DIFFERENT port than the suspect must NOT
// clear the targetPort warning - mirrors the would-deny port-scope guard.
func TestApplyInClusterResults_KeepsTargetPortOnDifferentPortPass(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"},
		Verdict:  VerdictDegraded,
		BrokenAt: -1,
		Routes: []RouteResult{{
			Route: "mismatch", Target: "mismatch:443",
			Outcome: OutcomeVerified, Confidence: ConfidenceReal,
			Evidence: "HTTP 200 · in-cluster",
		}},
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}, {Port: 443}}},
				Meta:   map[string]any{"targetPortSuspectPorts": []int32{80}},
				Findings: []Finding{{
					Code: "svc:targetport-no-listener", Severity: SeverityWarning,
					Message: "Service targetPort :9999 matches no port the ready pods declare",
					Cause:   "Service targetPort likely wrong",
					Action:  "Confirm the Service targetPort matches the port the container listens on",
				}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
		},
	}

	ApplyInClusterResults(tr, nil)

	f := tr.Downstream[0].Findings[findingIndexByCode(tr.Downstream[0].Findings, "svc:targetport-no-listener")]
	if f.Severity != SeverityWarning {
		t.Errorf("severity = %q, want warning kept - the live pass hit :443, not the suspect :80", f.Severity)
	}
}
