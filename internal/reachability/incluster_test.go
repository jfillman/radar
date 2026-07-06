package reachability

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/skyhook-io/radar/internal/trace"
)

// TestRunInClusterTests_NilClientIsHonest: with no impersonated client in context,
// the in-cluster run must report an honest per-route status + a copyable fallback
// command - never panic, never silently drop the request.
func TestRunInClusterTests_NilClientIsHonest(t *testing.T) {
	tr := &trace.Trace{
		Routes: []trace.RouteResult{{
			Route: "api", Target: "api:80", Outcome: trace.OutcomeReached, Confidence: trace.ConfidenceIndirect,
			InClusterRequest: &trace.ProbeRequest{Scheme: "http", Path: "/"},
		}},
	}
	tests, byTarget := RunInClusterTests(context.Background(), tr, "prod")
	if len(tests) != 1 {
		t.Fatalf("want 1 per-route result, got %d", len(tests))
	}
	if tests[0].Status == "" {
		t.Error("a nil client must yield an honest status, not an empty/successful result")
	}
	if tests[0].FallbackCommand == "" || !strings.Contains(tests[0].FallbackCommand, "kubectl run") {
		t.Errorf("nil-client result must carry a copyable fallback command, got %q", tests[0].FallbackCommand)
	}
	if len(byTarget) != 0 {
		t.Error("no results should be folded into the trace when the probe couldn't run")
	}
}

// TestRunInClusterTests_NilClientDoesNotConsumeCap: a nil client fails auth for
// EVERY route and creates no probe pod, so it must not burn the per-call probe
// cap - routes past the cap must still report the auth failure, never "capped".
func TestRunInClusterTests_NilClientDoesNotConsumeCap(t *testing.T) {
	var routes []trace.RouteResult
	for i := 0; i < MaxInClusterProbes+2; i++ {
		routes = append(routes, trace.RouteResult{
			Route: fmt.Sprintf("r%d", i), Target: fmt.Sprintf("svc%d:80", i),
			Outcome: trace.OutcomeReached, Confidence: trace.ConfidenceIndirect,
			InClusterRequest: &trace.ProbeRequest{Scheme: "http", Path: "/"},
		})
	}
	tests, _ := RunInClusterTests(context.Background(), &trace.Trace{Routes: routes}, "prod")
	if len(tests) != len(routes) {
		t.Fatalf("want %d results, got %d", len(routes), len(tests))
	}
	for i, r := range tests {
		if strings.Contains(r.Status, "capped") {
			t.Errorf("route %d mislabeled 'capped' under a nil client: %q", i, r.Status)
		}
		if !strings.Contains(r.Status, "auth") {
			t.Errorf("route %d should report the auth failure, got %q", i, r.Status)
		}
	}
}
