package server

import (
	"encoding/json"
	"testing"

	"github.com/skyhook-io/radar/pkg/traffic"
)

// The flows handler hand-builds its JSON payload, so a field the source sets can
// be silently dropped on the way out. WarningKind decides whether the client
// retries, and a dropped one is indistinguishable from a source that never set
// it — which means a permanent condition gets retried forever.
func TestTrafficFlowsPayloadKeepsWarningKind(t *testing.T) {
	response := &traffic.FlowsResponse{
		Source:      "beyla",
		Flows:       []traffic.Flow{},
		Warning:     "Beyla is not exporting dst.port and transport.",
		WarningKind: traffic.WarningPartial,
	}

	encoded, err := json.Marshal(trafficFlowsPayload(response, response.Flows))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded["warning"] == "" || decoded["warning"] == nil {
		t.Fatal("warning missing from the payload")
	}
	if got := decoded["warningKind"]; got != traffic.WarningPartial {
		t.Errorf("warningKind = %v, want %q — the client cannot tell a permanent condition from a hiccup without it",
			got, traffic.WarningPartial)
	}

	// A source that sets no kind must not gain one: absent means transient, and
	// inventing a value here would change how existing sources are retried.
	plain := &traffic.FlowsResponse{Source: "caretta", Flows: []traffic.Flow{}, Warning: "port-forward not ready"}
	if _, ok := trafficFlowsPayload(plain, plain.Flows)["warningKind"]; ok {
		t.Error("warningKind should be absent when the source did not set one")
	}
}
