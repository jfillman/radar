package traffic

import "testing"

// The latency gate used to require Hubble's L7Type == "RESPONSE", which excluded
// any source that measures latency without emitting Hubble's record types — the
// raw flow showed a value while every aggregated latency field stayed empty, so
// the graph's edge label never rendered one.
func TestAggregateFlowsRecordsLatencyFromAnySourceThatMeasuredIt(t *testing.T) {
	flows := []Flow{{
		Source:      Endpoint{Namespace: "demo", Name: "client"},
		Destination: Endpoint{Namespace: "demo", Name: "web"},
		Port:        80,
		LatencyNs:   2_000_000, // 2ms, and no L7Type: a metric-based source
	}}

	agg := AggregateFlows(flows)
	if len(agg) != 1 {
		t.Fatalf("expected 1 aggregated flow, got %d", len(agg))
	}
	if agg[0].LatencyP50Ms != 2 {
		t.Errorf("latencyP50Ms = %v, want 2 — a measured latency must reach the aggregate", agg[0].LatencyP50Ms)
	}
}

// Hubble's behaviour is unchanged: it sets LatencyNs only on responses, so a
// request-type flow contributes nothing either way.
func TestAggregateFlowsIgnoresFlowsWithNoMeasuredLatency(t *testing.T) {
	flows := []Flow{{
		Source:      Endpoint{Namespace: "demo", Name: "client"},
		Destination: Endpoint{Namespace: "demo", Name: "web"},
		Port:        80,
		L7Type:      "REQUEST",
		LatencyNs:   0,
	}}

	agg := AggregateFlows(flows)
	if len(agg) != 1 {
		t.Fatalf("expected 1 aggregated flow, got %d", len(agg))
	}
	if agg[0].LatencyP50Ms != 0 {
		t.Errorf("latencyP50Ms = %v, want 0", agg[0].LatencyP50Ms)
	}
}

// The per-path latency in Top Paths had the same gate as the edge latency, so
// fixing only the first left Top Paths empty for a metric-based source while the
// edge percentiles filled in.
func TestAggregateFlowsRecordsPerPathLatencyWithoutARecordType(t *testing.T) {
	flows := []Flow{{
		Source:      Endpoint{Namespace: "demo", Name: "client"},
		Destination: Endpoint{Namespace: "demo", Name: "web"},
		Port:        80,
		HTTPMethod:  "GET",
		HTTPPath:    "/",
		LatencyNs:   3_000_000, // 3ms, no L7Type
	}}

	agg := AggregateFlows(flows)
	if len(agg) != 1 || len(agg[0].TopHTTPPaths) != 1 {
		t.Fatalf("expected one aggregated flow with one path, got %+v", agg)
	}
	if got := agg[0].TopHTTPPaths[0].AvgMs; got != 3 {
		t.Errorf("path AvgMs = %v, want 3 — the same measurement the edge latency uses", got)
	}
}
