package trace

import (
	"testing"

	"github.com/skyhook-io/radar/pkg/probe"
)

func httpProbe(v probe.Vantage, p probe.Path, ok bool, detail string) probe.Result {
	r := probe.Result{Layer: probe.LayerHTTP, Target: "checkout:80", Vantage: v, Path: p, OK: ok, Detail: detail}
	if ok {
		r.Tone = probe.ToneHealthy
	} else {
		r.Tone = probe.ToneUnhealthy
	}
	return r
}

// The case the whole change exists for: a Service that works from inside the
// cluster and fails from a laptop. Both are non-apiserver, so the rollup buckets
// them together and worst-wins collapses to unreachable - with no field left to
// say it DID work in-cluster. That is what made the UI report one vantage's
// result under another's name.
func TestPerVantageKeepsDisagreementTheRollupDestroys(t *testing.T) {
	probes := []probe.Result{
		httpProbe(probe.VantageInCluster, probe.PathData, true, "HTTP 200"),
		httpProbe(probe.VantageLocal, probe.PathData, false, "connection refused"),
	}
	r, ok := routeFromProbes("checkout.example.com/", "checkout:80", probes)
	if !ok {
		t.Fatal("expected a route result")
	}
	// The rollup is unchanged - it stays the documented lossy summary.
	if r.Outcome != OutcomeUnreachable {
		t.Errorf("rollup outcome = %q, want the worst-wins %q", r.Outcome, OutcomeUnreachable)
	}
	if len(r.ByVantage) != 2 {
		t.Fatalf("ByVantage = %d entries, want 2: %+v", len(r.ByVantage), r.ByVantage)
	}
	byV := map[string]VantageResult{}
	for _, v := range r.ByVantage {
		byV[v.Vantage] = v
	}
	if got := byV[string(probe.VantageInCluster)].Outcome; got == OutcomeUnreachable {
		t.Errorf("in-cluster outcome = %q; the vantage that WORKED must not inherit the merged failure", got)
	}
	if got := byV[string(probe.VantageLocal)].Outcome; got != OutcomeUnreachable {
		t.Errorf("local outcome = %q, want %q", got, OutcomeUnreachable)
	}
}

// A relayed request bypasses kube-proxy, NetworkPolicy and the mesh, so it can
// never be read as real-traffic proof - per group, exactly as the rollup rules.
func TestPerVantageMarksApiserverIndirect(t *testing.T) {
	probes := []probe.Result{
		httpProbe(probe.VantageLocal, probe.PathAPIServer, true, "HTTP 200"),
		httpProbe(probe.VantageInCluster, probe.PathData, true, "HTTP 200"),
	}
	r, _ := routeFromProbes("r", "checkout:80", probes)
	for _, v := range r.ByVantage {
		want := ConfidenceReal
		if v.Path == string(probe.PathAPIServer) {
			want = ConfidenceIndirect
		}
		if v.Confidence != want {
			t.Errorf("%s/%s confidence = %q, want %q", v.Vantage, v.Path, v.Confidence, want)
		}
	}
}

// The same vantage relayed through the API server is a DIFFERENT claim from one
// that used the real network path, so the key is (vantage, path), not vantage.
func TestPerVantageSplitsOneVantageAcrossMechanisms(t *testing.T) {
	probes := []probe.Result{
		httpProbe(probe.VantageLocal, probe.PathData, false, "connection refused"),
		httpProbe(probe.VantageLocal, probe.PathAPIServer, true, "HTTP 200"),
	}
	r, _ := routeFromProbes("r", "checkout:80", probes)
	if len(r.ByVantage) != 2 {
		t.Fatalf("want the two mechanisms kept apart, got %+v", r.ByVantage)
	}
}

func TestPerVantageDropsSkippedProbes(t *testing.T) {
	skipped := httpProbe(probe.VantageInCluster, probe.PathData, false, "")
	skipped.Skipped = true
	probes := []probe.Result{httpProbe(probe.VantageLocal, probe.PathData, true, "HTTP 200"), skipped}
	r, _ := routeFromProbes("r", "checkout:80", probes)
	if len(r.ByVantage) != 1 || r.ByVantage[0].Vantage != string(probe.VantageLocal) {
		t.Errorf("a skipped probe carries no observation and must not become a vantage row: %+v", r.ByVantage)
	}
}

// An in-cluster run observes ONE vantage. Replacing the list wholesale would
// delete the laptop's and the proxy's results, which are still true - and are
// exactly the disagreement this field exists to keep.
func TestMergeVantagesKeepsVantagesTheRunDidNotObserve(t *testing.T) {
	prior := []VantageResult{
		{Vantage: "local", Path: "data", Outcome: OutcomeUnreachable, Confidence: ConfidenceReal},
		{Vantage: "local", Path: "apiserver", Outcome: OutcomeVerified, Confidence: ConfidenceIndirect},
	}
	fresh := []VantageResult{{Vantage: "in-cluster", Path: "data", Outcome: OutcomeVerified, Confidence: ConfidenceReal}}
	got := mergeVantages(prior, fresh)
	if len(got) != 3 {
		t.Fatalf("want prior 2 + fresh 1, got %+v", got)
	}
	if got[0].Vantage != "local" || got[0].Path != "data" {
		t.Errorf("prior order must be stable so rows don't jump on a re-run: %+v", got)
	}
}

func TestMergeVantagesReplacesTheSameVantage(t *testing.T) {
	prior := []VantageResult{{Vantage: "in-cluster", Path: "data", Outcome: OutcomeUnreachable}}
	fresh := []VantageResult{{Vantage: "in-cluster", Path: "data", Outcome: OutcomeVerified}}
	got := mergeVantages(prior, fresh)
	if len(got) != 1 || got[0].Outcome != OutcomeVerified {
		t.Errorf("a newer observation of the SAME vantage supersedes the older one: %+v", got)
	}
}

func TestMergeVantagesWithNothingFreshKeepsPrior(t *testing.T) {
	prior := []VantageResult{{Vantage: "local", Path: "data", Outcome: OutcomeVerified}}
	if got := mergeVantages(prior, nil); len(got) != 1 {
		t.Errorf("a run that observed nothing must not erase what was known: %+v", got)
	}
}

func podsHopWith(probes ...probe.Result) Hop {
	return Hop{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods", Probes: probes}
}

func podProbe(v probe.Vantage, p probe.Path, ok bool) probe.Result {
	r := probe.Result{Layer: probe.LayerTCP, Target: "10.244.1.5:8080", Vantage: v, Path: p, OK: ok}
	if !ok {
		r.Tone = probe.ToneUnhealthy
	}
	return r
}

// The one boundary two observations can establish: the Service was unreachable
// from a vantage, yet the SAME vantage reached the Pods behind it directly, so
// the break is the Service's own routing.
func TestLocalizeBoundariesNamesServiceRoutingFromTheSandwich(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{podsHopWith(podProbe(probe.VantageInCluster, probe.PathData, true))},
		Routes: []RouteResult{{
			Route:   "r",
			Outcome: OutcomeUnreachable,
			ByVantage: []VantageResult{
				{Vantage: "in-cluster", Path: "data", Outcome: OutcomeUnreachable},
			},
		}},
	}
	localizeBoundaries(tr)
	if got := tr.Routes[0].ByVantage[0].FailedBoundary; got != BoundaryServiceRouting {
		t.Errorf("FailedBoundary = %q, want %q - Service unreachable + Pods reachable from the SAME vantage localizes the break", got, BoundaryServiceRouting)
	}
}

// A different vantage reaching the Pods proves nothing about this one - that is
// the cross-vantage attribution the whole change exists to prevent.
func TestLocalizeBoundariesWillNotBorrowAnotherVantagesPodEvidence(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{podsHopWith(podProbe(probe.VantageLocal, probe.PathAPIServer, true))},
		Routes: []RouteResult{{
			Route:     "r",
			Outcome:   OutcomeUnreachable,
			ByVantage: []VantageResult{{Vantage: "in-cluster", Path: "data", Outcome: OutcomeUnreachable}},
		}},
	}
	localizeBoundaries(tr)
	if got := tr.Routes[0].ByVantage[0].FailedBoundary; got != "" {
		t.Errorf("FailedBoundary = %q, want empty", got)
	}
}

// Both sides failing is an undifferentiated failure: the break could be the
// Service OR the workload, so it must colour nothing.
func TestLocalizeBoundariesStaysSilentWhenPodsAlsoFailed(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{podsHopWith(podProbe(probe.VantageInCluster, probe.PathData, false))},
		Routes: []RouteResult{{
			Route:     "r",
			Outcome:   OutcomeUnreachable,
			ByVantage: []VantageResult{{Vantage: "in-cluster", Path: "data", Outcome: OutcomeUnreachable}},
		}},
	}
	localizeBoundaries(tr)
	if got := tr.Routes[0].ByVantage[0].FailedBoundary; got != "" {
		t.Errorf("FailedBoundary = %q, want empty when neither side is known good", got)
	}
}

func TestLocalizeBoundariesIgnoresSkippedPodProbes(t *testing.T) {
	skipped := podProbe(probe.VantageInCluster, probe.PathData, true)
	skipped.Skipped = true
	tr := &Trace{
		Downstream: []Hop{podsHopWith(skipped)},
		Routes: []RouteResult{{
			Route:     "r",
			Outcome:   OutcomeUnreachable,
			ByVantage: []VantageResult{{Vantage: "in-cluster", Path: "data", Outcome: OutcomeUnreachable}},
		}},
	}
	localizeBoundaries(tr)
	if got := tr.Routes[0].ByVantage[0].FailedBoundary; got != "" {
		t.Errorf("a skipped probe carries no observation: got %q", got)
	}
}

// A route that got through has no boundary to name.
func TestLocalizeBoundariesLeavesReachableRoutesAlone(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{podsHopWith(podProbe(probe.VantageInCluster, probe.PathData, true))},
		Routes: []RouteResult{{
			Route:     "r",
			Outcome:   OutcomeVerified,
			ByVantage: []VantageResult{{Vantage: "in-cluster", Path: "data", Outcome: OutcomeVerified}},
		}},
	}
	localizeBoundaries(tr)
	if got := tr.Routes[0].ByVantage[0].FailedBoundary; got != "" {
		t.Errorf("FailedBoundary = %q on a verified route", got)
	}
}
