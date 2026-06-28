package trace

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes/fake"

	"github.com/skyhook-io/radar/pkg/probe"
)

// TestDiagnoseDoc_ProxyProbeAutoRunWording guards the honesty fix: the proxy
// reachability probe auto-runs on Diagnose-tab mount (WorkloadView.tsx), so the
// doc must not claim the active test "Runs only when the operator clicks Run
// test" — that was true only of the in-cluster Job test. Pins the corrected
// copy so the false claim can't be reintroduced.
func TestDiagnoseDoc_ProxyProbeAutoRunWording(t *testing.T) {
	b, err := os.ReadFile("../../docs/diagnose.md")
	if err != nil {
		t.Fatalf("read diagnose.md: %v", err)
	}
	doc := string(b)
	if strings.Contains(doc, "Runs only when the operator clicks") {
		t.Errorf("diagnose.md still claims the active test runs only on click — proxy probe auto-runs on tab open")
	}
	if !strings.Contains(doc, "runs automatically once when the **Diagnose** tab opens") {
		t.Errorf("diagnose.md should describe the proxy probe auto-running once on tab open")
	}
}

// TestProbePodsByName_SkipsUDPAndSCTP pins that probePodsByName guards
// UDP/SCTP container ports the same way probePodsByIP and probeService do.
// A UDP port whose name/number trips the HTTP heuristic (e.g. UDP 8080 named
// "metrics", or a UDP port named "web") must NOT be sent to the apiserver
// pod-proxy HTTP probe — no TCP listener exists, "connection refused" would
// falsely condemn a healthy non-TCP pod. Laptop vantage runs the apiserver
// path only, so a missing skip would surface as a real broken row.
func TestProbePodsByName_SkipsUDPAndSCTP(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	stubProxyProbes(t)
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Pods", Namespace: "ns"},
			Config: &HopConfig{
				ContainerPorts: []ContainerPortRef{
					{Container: "metrics", Port: 8080, Name: "metrics", Protocol: "UDP"},
					{Container: "sig", Port: 9000, Name: "web", Protocol: "SCTP"},
					{Container: "http", Port: 80, Name: "http", Protocol: "TCP"},
				},
				PodNames: []string{"pod-x"},
			},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 2 * time.Second}, fake.NewClientset())
	results := tr.Downstream[0].Probes

	for _, want := range []struct {
		port  int32
		proto string
	}{{8080, "UDP"}, {9000, "SCTP"}} {
		var rows []probe.Result
		for _, r := range results {
			if r.Port == want.port {
				rows = append(rows, r)
			}
		}
		if len(rows) != 1 {
			t.Fatalf("port %d (%s): want exactly one (skipped) row, got %d: %+v", want.port, want.proto, len(rows), rows)
		}
		r := rows[0]
		if !r.Skipped {
			t.Errorf("port %d (%s): want a Skipped row, got %+v", want.port, want.proto, r)
		}
		if !strings.Contains(r.Reason, want.proto) {
			t.Errorf("port %d: skip reason %q should name %s", want.port, r.Reason, want.proto)
		}
		if r.OK {
			t.Errorf("port %d (%s): a skipped non-TCP port must not read as reached: %+v", want.port, want.proto, r)
		}
	}

	// The TCP port on the SAME pod is still probed via the apiserver path.
	var sawTCP bool
	for _, r := range results {
		if r.Port == 80 && r.Path == probe.PathAPIServer && !r.Skipped {
			sawTCP = true
		}
	}
	if !sawTCP {
		t.Errorf("TCP port 80 should still get an apiserver-path probe, got %+v", results)
	}
}
