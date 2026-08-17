package traffic

import (
	"context"
	"strings"
	"testing"

	"k8s.io/client-go/kubernetes/fake"

	"github.com/skyhook-io/radar/pkg/traffic"
)

// stubSource is a TrafficSource whose detection outcome the test dictates.
type stubSource struct {
	name   string
	result *DetectionResult
}

func (s *stubSource) Name() string { return s.name }

func (s *stubSource) Detect(context.Context) (*DetectionResult, error) { return s.result, nil }

func (s *stubSource) GetFlows(context.Context, FlowOptions) (*FlowsResponse, error) {
	return &FlowsResponse{Source: s.name, Flows: []Flow{}}, nil
}

func (s *stubSource) StreamFlows(context.Context, FlowOptions) (<-chan Flow, error) {
	ch := make(chan Flow)
	close(ch)
	return ch, nil
}

func (s *stubSource) Close() error { return nil }

// A source can be unavailable for a reason the user can act on: installed but
// with the wrong feature enabled, running but not scraped. Reporting only its
// name makes every such case indistinguishable from "not installed", so the
// explanation the source produced has to reach the response.
func TestDetectSources_CarriesWhyAnUnavailableSourceIsUnavailable(t *testing.T) {
	const reason = "Beyla is running but exposes no network flow metrics. " +
		`Add "network" to OTEL_EBPF_METRICS_FEATURES to enable them.`

	m := &Manager{k8sClient: fake.NewSimpleClientset(), sources: map[string]TrafficSource{
		"beyla": &stubSource{name: "beyla", result: &DetectionResult{
			Available: false,
			Present:   true,
			Version:   "v3.25.0",
			Message:   reason,
		}},
		"caretta": &stubSource{name: "caretta", result: &DetectionResult{
			Available: false,
			Message:   "Caretta not detected. Install Caretta for eBPF-based traffic visibility.",
		}},
	}}

	response, err := m.DetectSources(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The bare-name list stays as it was, so existing consumers are unaffected.
	if len(response.NotDetected) != 2 {
		t.Fatalf("notDetected = %v, want both sources", response.NotDetected)
	}

	var beyla *traffic.SourceStatus
	for i := range response.NotDetectedUnavailable {
		if response.NotDetectedUnavailable[i].Name == "beyla" {
			beyla = &response.NotDetectedUnavailable[i]
		}
	}
	if beyla == nil {
		t.Fatal("beyla's explanation was dropped; the user would see only 'not detected'")
	}
	if !strings.Contains(beyla.Message, "OTEL_EBPF_METRICS_FEATURES") {
		t.Errorf("message should say how to fix it, got: %q", beyla.Message)
	}
	assertEq(t, "status", beyla.Status, "not_found")
	assertEq(t, "version", beyla.Version, "v3.25.0")

	// Caretta is not installed at all. "Install Caretta" is what the
	// recommendation section is for; repeating it as a per-source problem would
	// bury the one source that does have a fixable problem.
	for _, s := range response.NotDetectedUnavailable {
		if s.Name == "caretta" {
			t.Errorf("a source that is merely absent must not be reported as unusable: %q", s.Message)
		}
	}
}
