package server

import (
	"testing"

	"github.com/skyhook-io/radar/internal/reachability"
	"github.com/skyhook-io/radar/internal/trace"
	"github.com/skyhook-io/radar/pkg/probe"
)

// TestStampInClusterProbes_DemotesDegraded pins that a throwaway-pod result that
// reached the backend but degraded (OK=true, ToneDegraded - a 5xx or TLS/cert
// problem) is stamped as a SKIP, not a live degraded probe. The fold logic keeps
// it informational, so the matrix must not paint the path degraded.
func TestStampInClusterProbes_DemotesDegraded(t *testing.T) {
	tr := &trace.Trace{
		Downstream: []trace.Hop{
			{Resource: trace.ResourceRef{Kind: "Service", Name: "api"}},
		},
	}
	tests := []reachability.InClusterTestResult{{
		Route:  "api",
		Target: "api:80",
		Results: []probe.Result{
			{Layer: probe.LayerHTTP, OK: true, Tone: probe.ToneDegraded},
		},
	}}
	stampInClusterProbes(tr, tests)

	var inCluster []probe.Result
	for _, p := range tr.Downstream[0].Probes {
		if p.Vantage == probe.VantageInCluster {
			inCluster = append(inCluster, p)
		}
	}
	if len(inCluster) != 1 {
		t.Fatalf("want 1 stamped in-cluster probe, got %d", len(inCluster))
	}
	if !inCluster[0].Skipped {
		t.Errorf("a reached-but-degraded throwaway probe must be demoted to a skip so the matrix does not condemn the path, got %+v", inCluster[0])
	}
}

// TestStampInClusterProbes_KeepsCleanReach pins that a genuinely clean throwaway
// reach (OK, healthy) is stamped as a live, non-skipped probe - it is real
// evidence the matrix should show.
func TestStampInClusterProbes_KeepsCleanReach(t *testing.T) {
	tr := &trace.Trace{
		Downstream: []trace.Hop{
			{Resource: trace.ResourceRef{Kind: "Service", Name: "api"}},
		},
	}
	tests := []reachability.InClusterTestResult{{
		Route:  "api",
		Target: "api:80",
		Results: []probe.Result{
			{Layer: probe.LayerHTTP, OK: true, Tone: probe.ToneHealthy},
		},
	}}
	stampInClusterProbes(tr, tests)

	if len(tr.Downstream[0].Probes) != 1 || tr.Downstream[0].Probes[0].Skipped {
		t.Errorf("a clean in-cluster reach must stay a live probe, got %+v", tr.Downstream[0].Probes)
	}
}
