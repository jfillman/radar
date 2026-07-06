package trace

import (
	"strings"
	"testing"

	"github.com/skyhook-io/radar/pkg/probe"
)

// Defect 1: nonHTTPSkipReason must only append "Reachability still checked at the
// TCP level." when a data-path TCP probe ACTUALLY ran for this hop. In-cluster only
// dials a routable address, so a headless Service (no ClusterIP) or a pods hop with
// names but no IPs runs no TCP probe even in-cluster - claiming TCP was checked there
// overclaims a check that did not happen.
func TestNonHTTPSkipReason_TCPClaimGatedOnTCPRan(t *testing.T) {
	const tcpClaim = " Reachability still checked at the TCP level."

	// In-cluster gRPC WITH a data-path TCP probe → may truthfully claim TCP.
	got := nonHTTPSkipReason("grpc", "", 9000, probe.VantageInCluster, true)
	if !strings.Contains(got, tcpClaim) {
		t.Errorf("in-cluster gRPC + tcpRan: %q missing TCP claim", got)
	}

	// In-cluster gRPC with NO TCP probe (headless / no pod IPs) → must NOT claim TCP.
	got = nonHTTPSkipReason("grpc", "", 9000, probe.VantageInCluster, false)
	if strings.Contains(got, tcpClaim) {
		t.Errorf("in-cluster gRPC, no TCP probe: %q overclaims TCP check", got)
	}

	// Laptop gRPC → "run in-cluster" hint, never the TCP claim.
	got = nonHTTPSkipReason("grpc", "", 9000, probe.VantageLocal, false)
	if strings.Contains(got, tcpClaim) {
		t.Errorf("laptop gRPC: %q overclaims TCP check", got)
	}
	if !strings.Contains(got, "Run Radar from in-cluster") {
		t.Errorf("laptop gRPC: %q missing run-in-cluster hint", got)
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
