package traffic

import "testing"

// A source that measures latency without emitting L7 record types must still
// reach the aggregate. Gating on the record type alone leaves the raw flow showing
// a value while every aggregated latency field stays empty, so the graph's edge
// label renders nothing.
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

// The graph reads directionUnknown off the aggregated edge, so this propagation is
// the only thing standing between the source marking a conversation unoriented and
// the arrowhead disappearing.
//
// An edge is unoriented only when nothing contributing to it established a
// direction. Unorientable flows carry port 0, which is also the port every edge
// carries in a Beyla install without dst.port, so they share an aggregation key
// with ordinary traffic — the opposite rule would let one stray UDP conversation
// strip the arrow off a destination's HTTP edge.
func TestAggregateFlowsMarksAnEdgeUnorientedOnlyWhenNothingOrientedIt(t *testing.T) {
	pair := func(unknown bool) Flow {
		return Flow{
			Source:           Endpoint{Namespace: "demo", Name: "client"},
			Destination:      Endpoint{Namespace: "kube-system", Name: "coredns"},
			Port:             0,
			DirectionUnknown: unknown,
		}
	}

	allUnknown := AggregateFlows([]Flow{pair(true), pair(true)})
	if len(allUnknown) != 1 {
		t.Fatalf("expected 1 aggregated edge, got %d", len(allUnknown))
	}
	if !allUnknown[0].DirectionUnknown {
		t.Error("nothing established a direction, so the edge must not claim one")
	}

	mixed := AggregateFlows([]Flow{pair(true), pair(false)})
	if mixed[0].DirectionUnknown {
		t.Error("one contributor established the direction, so the arrow is justified")
	}

	oriented := AggregateFlows([]Flow{pair(false), pair(false)})
	if oriented[0].DirectionUnknown {
		t.Error("an edge whose contributors are all oriented must keep its arrowhead")
	}
}
