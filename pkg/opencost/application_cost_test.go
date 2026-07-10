package opencost

import "testing"

func TestBuildApplicationCostResponse_PartialAndScaledToZero(t *testing.T) {
	inputs := []ApplicationWorkloadCostInput{
		{ApplicationWorkloadRef: ApplicationWorkloadRef{Namespace: "default", Kind: "Deployment", Name: "api"}, DesiredReplicas: 2},
		{ApplicationWorkloadRef: ApplicationWorkloadRef{Namespace: "default", Kind: "Deployment", Name: "scaled"}, DesiredReplicas: 0},
		{ApplicationWorkloadRef: ApplicationWorkloadRef{Namespace: "default", Kind: "StatefulSet", Name: "missing"}, DesiredReplicas: 1},
	}
	unsupported := []ApplicationWorkloadRef{{Namespace: "default", Kind: "Job", Name: "import"}}
	got := BuildApplicationCostResponse(inputs, unsupported, map[string]*WorkloadCostResponse{
		"default": {
			Available: true,
			Namespace: "default",
			Workloads: []WorkloadCost{{
				Name:            "api",
				Kind:            "Deployment",
				HourlyCost:      0.2,
				CPUCost:         0.12,
				MemoryCost:      0.08,
				Replicas:        2,
				CPUUsageCost:    0.03,
				MemoryUsageCost: 0.02,
			}},
		},
	})

	if !got.Available {
		t.Fatalf("expected available partial response, got %+v", got)
	}
	if !got.Partial {
		t.Fatalf("expected Partial=true, got %+v", got)
	}
	if got.Coverage.Total != 4 || got.Coverage.Included != 2 {
		t.Fatalf("coverage = %+v, want total=4 included=2", got.Coverage)
	}
	if len(got.Coverage.Unavailable) != 1 || got.Coverage.Unavailable[0].Name != "missing" || got.Coverage.Unavailable[0].Reason != ReasonNoMetrics {
		t.Fatalf("unexpected unavailable coverage: %+v", got.Coverage.Unavailable)
	}
	if len(got.Coverage.Unsupported) != 1 || got.Coverage.Unsupported[0].Kind != "Job" {
		t.Fatalf("unexpected unsupported coverage: %+v", got.Coverage.Unsupported)
	}
	if got.Totals.HourlyCost != 0.2 || got.Totals.CPUCost != 0.12 || got.Totals.MemoryCost != 0.08 || got.Totals.Replicas != 2 {
		t.Fatalf("totals = %+v", got.Totals)
	}

	var scaled *ApplicationWorkloadCost
	for i := range got.Workloads {
		if got.Workloads[i].Name == "scaled" {
			scaled = &got.Workloads[i]
			break
		}
	}
	if scaled == nil || !scaled.Available || !scaled.ScaledToZero || scaled.Current == nil || scaled.Current.HourlyCost != 0 {
		t.Fatalf("scaled-to-zero row not preserved as valid zero: %+v", scaled)
	}
}
