package trace

import "testing"

// Defect 1: ApplyInClusterResults reconciles the static would-deny WARNING off
// the live in-cluster pass but used to leave the svc:targetport-no-listener
// WARNING standing. The static reconcileTargetPortAdvisory reads h.Probes, which
// the in-cluster flow stamps only AFTER the verdict/diagnosis recompute - so a
// route the in-cluster pod just verified over REAL traffic would read
// verified/ConfidenceReal while the hop kept the targetPort warning, leaving a
// stale 'degraded' verdict and a 'Service targetPort likely wrong' diagnosis that
// the live success disproves. reconcileInClusterTargetPort must downgrade it.
func TestApplyInClusterResults_DowngradesTargetPortOnLivePass(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"},
		Verdict:  VerdictDegraded, // stale from the static targetPort prediction
		BrokenAt: -1,
		Routes: []RouteResult{{
			Route: "mismatch", Target: "mismatch:80",
			Outcome: OutcomeVerified, Confidence: ConfidenceReal,
			Evidence: "HTTP 200 · in-cluster",
		}},
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Meta:   map[string]any{"targetPortSuspectPorts": []int32{80}},
				Findings: []Finding{{
					Code: "svc:targetport-no-listener", Severity: SeverityWarning,
					Message: "Service targetPort :9999 matches no port the ready pods declare",
					Cause:   "Service targetPort likely wrong",
					Action:  "Confirm the Service targetPort matches the port the container listens on",
				}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
		},
	}

	ApplyInClusterResults(tr, nil)

	idx := findingIndexByCode(tr.Downstream[0].Findings, "svc:targetport-no-listener")
	if idx < 0 {
		t.Fatal("targetPort finding disappeared; want it downgraded to info, not dropped")
	}
	f := tr.Downstream[0].Findings[idx]
	if f.Severity != SeverityInfo {
		t.Errorf("severity = %q, want info - live in-cluster traffic reached the suspect port", f.Severity)
	}
	if f.Cause != "" {
		t.Errorf("downgraded finding must drop the 'likely wrong' Cause, got %q", f.Cause)
	}
	if tr.Verdict == VerdictDegraded {
		t.Error("verdict must re-derive off 'degraded' once the contradicted targetPort warning is info")
	}
	if tr.Diagnosis != nil && tr.Diagnosis.CauseCode == "svc:targetport-no-listener" {
		t.Errorf("diagnosis must not promote the targetPort guess the live pass disproved, got %+v", tr.Diagnosis)
	}
}

// Port scope: a live in-cluster pass on a DIFFERENT port than the suspect must NOT
// clear the targetPort warning - mirrors the would-deny port-scope guard.
func TestApplyInClusterResults_KeepsTargetPortOnDifferentPortPass(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"},
		Verdict:  VerdictDegraded,
		BrokenAt: -1,
		Routes: []RouteResult{{
			Route: "mismatch", Target: "mismatch:443",
			Outcome: OutcomeVerified, Confidence: ConfidenceReal,
			Evidence: "HTTP 200 · in-cluster",
		}},
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}, {Port: 443}}},
				Meta:   map[string]any{"targetPortSuspectPorts": []int32{80}},
				Findings: []Finding{{
					Code: "svc:targetport-no-listener", Severity: SeverityWarning,
					Message: "Service targetPort :9999 matches no port the ready pods declare",
					Cause:   "Service targetPort likely wrong",
					Action:  "Confirm the Service targetPort matches the port the container listens on",
				}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
		},
	}

	ApplyInClusterResults(tr, nil)

	f := tr.Downstream[0].Findings[findingIndexByCode(tr.Downstream[0].Findings, "svc:targetport-no-listener")]
	if f.Severity != SeverityWarning {
		t.Errorf("severity = %q, want warning kept - the live pass hit :443, not the suspect :80", f.Severity)
	}
}
