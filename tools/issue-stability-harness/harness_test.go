package main

import (
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestExtractTranscriptFromMixedJSONL(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "fixture.log")
	payload := `{"issues":[{"severity":"critical","source":"problem","category":"crashloop","id":"decoy","kind":"Deployment","group":"apps","namespace":"demo","name":"catalog","reason":"CrashLoopBackOff","restart_count":2,"issue_timing":"started_at_resource_creation","issue_timing_basis":"pod_creation"}]}`
	lines := []string{
		"ordinary harness output",
		`{"broken"`,
		marshalLine(t, map[string]any{
			"type": "assistant",
			"message": map[string]any{"content": []map[string]any{
				{"type": "tool_use", "id": "other", "name": "mcp__radar__diagnose"},
				{"type": "tool_use", "id": "issues-1", "name": "mcp__radar__issues"},
			}},
		}),
		marshalLine(t, map[string]any{
			"type":      "user",
			"timestamp": "2026-07-20T20:01:32Z",
			"message": map[string]any{"content": []map[string]any{
				{"type": "tool_result", "tool_use_id": "other", "content": []map[string]any{{"type": "text", "text": payload}}},
				{"type": "tool_result", "tool_use_id": "issues-1", "content": []map[string]any{{"type": "text", "text": payload}}},
			}},
			"tool_use_result": []map[string]any{{"type": "text", "text": payload}},
		}),
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}

	fixture, fields, err := extractTranscript(path, 99, "mixed")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := len(fixture.Snapshots), 1; got != want {
		t.Fatalf("snapshots = %d, want %d", got, want)
	}
	if got, want := fixture.Stats.MalformedJSON, 1; got != want {
		t.Fatalf("malformed lines = %d, want %d", got, want)
	}
	if got, want := fixture.Stats.IssueToolCalls, 1; got != want {
		t.Fatalf("issue tool calls = %d, want %d", got, want)
	}
	if got := fixture.Snapshots[0].Issues[0]; got.Name != "catalog" || got.RestartCount != 2 {
		t.Fatalf("issue = %+v", got)
	}
	if !fields["restart_count"] || fields["stability"] {
		t.Fatalf("wire fields = %v", fields)
	}
}

func TestExtractDirectoryCapturesRunProvenance(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	status := strings.Join([]string{
		"Batch fixture",
		"SREGym branch: radar-bench @ 9b412c4",
		"SREGym-applications submodule: 18620ed",
		"Radar binary: /tmp/radar main @ 699d9074",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, "STATUS.txt"), []byte(status), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "1-example-claudecode_radar.log"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	corpus, err := extractDirectory(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if corpus.Run == nil || corpus.Run.SREGymRevision != "9b412c4" || corpus.Run.ApplicationsRevision != "18620ed" || corpus.Run.RadarRevision != "699d9074" {
		t.Fatalf("run provenance = %+v", corpus.Run)
	}
	if corpus.Run.StatusFile.File != "STATUS.txt" || len(corpus.Run.StatusFile.SHA256) != 64 {
		t.Fatalf("status provenance = %+v", corpus.Run.StatusFile)
	}
}

func TestSoftSortDemotesOneSeverityNotMembership(t *testing.T) {
	t.Parallel()
	issues := []IssueFixture{
		{ID: "decoy", Severity: "critical", Stability: "self_healed"},
		{ID: "real-critical", Severity: "critical", Stability: "persistent"},
		{ID: "real-warning", Severity: "warning", Stability: "persistent"},
		{ID: "unknown-warning", Severity: "warning"},
	}
	baseline, candidate := softSortAfterCap(issues, 200)
	if membershipChanges(baseline, candidate) != 0 {
		t.Fatal("candidate changed issue membership")
	}
	if got, want := rankedIDs(candidate), []string{"real-critical", "real-warning", "unknown-warning", "decoy"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("candidate order = %v, want %v", got, want)
	}
	newRank := ranks(candidate)
	if got := countActiveInversions(baseline, newRank); got != 0 {
		t.Fatalf("active inversions = %d", got)
	}
}

func TestSoftSortRunsAfterBaselineCap(t *testing.T) {
	t.Parallel()
	issues := make([]IssueFixture, 205)
	issues[0] = IssueFixture{ID: "decoy", Severity: "critical", Stability: "self_healed"}
	for index := 1; index < len(issues); index++ {
		issues[index] = IssueFixture{ID: "active-" + string(rune(index)), Severity: "warning", Stability: "persistent"}
	}
	baseline, candidate := softSortAfterCap(issues, 200)
	if len(candidate) != 200 || membershipChanges(baseline, candidate) != 0 {
		t.Fatalf("cap invariant failed: baseline=%d candidate=%d membership_changes=%d", len(baseline), len(candidate), membershipChanges(baseline, candidate))
	}
	for _, row := range candidate {
		if row.OriginalIndex >= 200 {
			t.Fatalf("row outside baseline cap entered candidate: %+v", row)
		}
	}
}

func TestSoftSortPreservesEveryActivePair(t *testing.T) {
	t.Parallel()
	rng := rand.New(rand.NewSource(42))
	for iteration := 0; iteration < 200; iteration++ {
		issues := make([]IssueFixture, 1+rng.Intn(250))
		criticalCount := rng.Intn(len(issues) + 1)
		for index := range issues {
			severity := "warning"
			if index < criticalCount {
				severity = "critical"
			}
			issues[index] = IssueFixture{ID: string(rune(index)), Severity: severity}
			if rng.Intn(4) == 0 {
				issues[index].Stability = "self_healed"
			}
		}
		baseline, candidate := softSortAfterCap(issues, 200)
		if got := membershipChanges(baseline, candidate); got != 0 {
			t.Fatalf("iteration %d membership changes = %d", iteration, got)
		}
		if got := countActiveInversions(baseline, ranks(candidate)); got != 0 {
			t.Fatalf("iteration %d active inversions = %d", iteration, got)
		}
	}
}

func TestSyntheticGateCanProveIntendedEffect(t *testing.T) {
	t.Parallel()
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{{
		ID: 1, Name: "startup-noise", Provenance: validTestProvenance("startup.log"), Stats: ExtractStats{IssueToolCalls: 1}, Snapshots: []Snapshot{{Sequence: 1, CapturedAt: "2026-07-20T20:01:00Z", ToolCallID: "issues-1", Issues: []IssueFixture{
			withEvidence(IssueFixture{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "self_healed", StabilityBasis: "trusted_probe_and_restart_history"}, true, 0),
			withEvidence(IssueFixture{ID: "real", Kind: "Deployment", Namespace: "demo", Name: "api", Severity: "warning", Category: "crashloop", RestartCount: 4, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1),
		}}},
	}}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Corpus: "synthetic", Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "startup-noise", Injector: validTestProvenance("startup.py"),
		Exact:       []Target{target("real", "Deployment", "demo", "api")},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")},
	}}}
	report := evaluateCorpusWithMinimum(corpus, truth, 200, 1, 1)
	if !report.Gate.Green {
		t.Fatalf("gate = red: %v", report.Gate.Reasons)
	}
	if report.KnownDecoyRowsDemoted != 1 || report.RealFaultDemoted != 0 || report.ActiveActiveInversions != 0 {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestSyntheticGateRejectsDemotedGroundTruth(t *testing.T) {
	t.Parallel()
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{{
		ID: 1, Name: "false-positive", Snapshots: []Snapshot{{Issues: []IssueFixture{
			withEvidence(IssueFixture{ID: "real", Kind: "Deployment", Namespace: "demo", Name: "api", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "self_healed", StabilityBasis: "unsafe_guess"}, true, 0),
			withEvidence(IssueFixture{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "warning", Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1),
		}}},
	}}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "false-positive", Injector: validTestProvenance("false-positive.py"),
		Exact:       []Target{target("real", "Deployment", "demo", "api")},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")},
	}}}
	report := evaluateCorpus(corpus, truth, 200, 1)
	if report.Gate.Green {
		t.Fatal("unsafe candidate unexpectedly passed")
	}
	if report.GroundTruthDemotableFP != 1 || report.RealFaultDemoted != 1 || report.GroundTruthPairwiseLosses != 1 || report.TopKVisibilityLosses != 1 {
		t.Fatalf("unsafe metrics = %+v", report)
	}
}

func TestGateRequiresEveryExactTarget(t *testing.T) {
	t.Parallel()
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{{
		ID: 1, Name: "multi-target", Snapshots: []Snapshot{{Issues: []IssueFixture{
			withEvidence(IssueFixture{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "self_healed", StabilityBasis: "trusted_probe_and_restart_history"}, true, 0),
			withEvidence(IssueFixture{ID: "real-one", Kind: "Deployment", Namespace: "demo", Name: "api-one", Severity: "warning", Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1),
		}}},
	}}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "multi-target", Injector: validTestProvenance("multi.py"),
		Exact: []Target{
			target("real-one", "Deployment", "demo", "api-one"),
			target("real-two", "Deployment", "demo", "api-two"),
		},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")},
	}}}
	report := evaluateCorpus(corpus, truth, 200, 10)
	if report.Gate.Green || report.ExactTargets.Present != 1 || report.ExactTargets.Total != 2 || report.ScenariosWithAllExactTargets != 0 {
		t.Fatalf("partial multi-target coverage passed: %+v", report)
	}
}

func TestGateProtectsCausalAffectedWorkloads(t *testing.T) {
	t.Parallel()
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{{
		ID: 18, Name: "secret-rotation", Snapshots: []Snapshot{{Issues: []IssueFixture{
			{ID: "secret", Kind: "Secret", Namespace: "demo", Name: "db-conn", Severity: "critical"},
			withEvidence(IssueFixture{ID: "victim", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "self_healed", StabilityBasis: "unsafe_guess"}, true, 0),
			withEvidence(IssueFixture{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "startup-noise", Severity: "warning", Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1),
		}}},
	}}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{{
		ID: 18, Name: "secret-rotation", Injector: validTestProvenance("secret.py"),
		Exact:       []Target{target("secret", "Secret", "demo", "db-conn")},
		Causal:      []Target{target("catalog-victim", "Deployment", "demo", "catalog")},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "startup-noise")},
	}}}
	report := evaluateCorpus(corpus, truth, 200, 10)
	if report.Gate.Green || report.CausalTargets.Present != 1 || report.GroundTruthDemotableFP != 1 || report.RealFaultDemoted != 1 {
		t.Fatalf("causal workload was not protected: %+v", report)
	}
}

func TestGateRequiresRawTemporalEvidence(t *testing.T) {
	t.Parallel()
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{{
		ID: 1, Name: "opaque-labels", Snapshots: []Snapshot{{Issues: []IssueFixture{
			{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "self_healed", StabilityBasis: "opaque_classifier"},
			{ID: "real", Kind: "Deployment", Namespace: "demo", Name: "api", Severity: "warning", Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "opaque_classifier"},
		}}},
	}}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "opaque-labels", Injector: validTestProvenance("opaque.py"),
		Exact:       []Target{target("real", "Deployment", "demo", "api")},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")},
	}}}
	report := evaluateCorpus(corpus, truth, 200, 10)
	if report.Gate.Green || report.ReclassificationEvidenceRows != 0 || !hasReason(report.Gate.Reasons, "auditable temporal evidence") {
		t.Fatalf("opaque labels passed: %+v", report)
	}
}

func TestTemporalEvidenceMustBeCoherent(t *testing.T) {
	t.Parallel()
	const capturedAt = "2026-07-20T20:01:00Z"
	valid := withEvidence(IssueFixture{Category: "crashloop", RestartCount: 2}, true, 0)
	if !reclassificationEvidenceComplete(valid, capturedAt) {
		t.Fatal("coherent evidence was rejected")
	}
	cases := map[string]IssueFixture{
		"malformed restart time": func() IssueFixture { issue := valid; issue.LastRestartAt = "x"; return issue }(),
		"future restart":         func() IssueFixture { issue := valid; issue.LastRestartAt = "2026-07-20T20:02:00Z"; return issue }(),
		"run before restart":     func() IssueFixture { issue := valid; issue.CurrentRunStartedAt = "2026-07-20T19:59:00Z"; return issue }(),
		"negative delta":         withEvidence(IssueFixture{Category: "crashloop", RestartCount: 2}, true, -1),
		"delta over total":       withEvidence(IssueFixture{Category: "crashloop", RestartCount: 2}, true, 3),
	}
	for name, issue := range cases {
		if reclassificationEvidenceComplete(issue, capturedAt) {
			t.Errorf("%s passed", name)
		}
	}
}

func TestGateRejectsExactTargetBeyondCap(t *testing.T) {
	t.Parallel()
	issues := []IssueFixture{
		withEvidence(IssueFixture{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "self_healed", StabilityBasis: "trusted_probe_and_restart_history"}, true, 0),
	}
	for index := 1; index < 200; index++ {
		issues = append(issues, IssueFixture{ID: "filler-" + string(rune(index)), Kind: "ConfigMap", Namespace: "demo", Name: "filler", Severity: "warning"})
	}
	issues = append(issues, IssueFixture{ID: "real", Kind: "ConfigMap", Namespace: "demo", Name: "root-cause", Severity: "warning"})
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{{ID: 1, Name: "over-cap", Snapshots: []Snapshot{{Issues: issues}}}}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "over-cap", Injector: validTestProvenance("cap.py"),
		Exact:       []Target{target("real", "ConfigMap", "demo", "root-cause")},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")},
	}}}
	report := evaluateCorpus(corpus, truth, 200, 10)
	if report.Gate.Green || report.ExactTargets.Present != 1 || report.ExactTargetsWithinCap.Present != 0 || report.ExactTargetsSafetyEvaluable.Present != 0 {
		t.Fatalf("outside-cap exact target passed: %+v", report)
	}
}

func TestMinimumDecoyEffectIsExplicitAndNontrivial(t *testing.T) {
	t.Parallel()
	corpus := Corpus{SchemaVersion: corpusSchemaVersion}
	corpus.Source = "synthetic"
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Corpus: "synthetic"}
	for id := 1; id <= 3; id++ {
		decoy := withEvidence(IssueFixture{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "warning", Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1)
		realSeverity := "critical"
		if id == 1 {
			decoy.Severity = "critical"
			decoy.Stability = "self_healed"
			decoy.StabilityBasis = "trusted_probe_and_restart_history"
			decoy = withEvidence(decoy, true, 0)
			realSeverity = "warning"
		}
		real := withEvidence(IssueFixture{ID: "real", Kind: "Deployment", Namespace: "demo", Name: "api", Severity: realSeverity, Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1)
		issues := []IssueFixture{real, decoy}
		if id == 1 {
			issues = []IssueFixture{decoy, real}
		}
		corpus.Scenarios = append(corpus.Scenarios, ScenarioFixture{
			ID: id, Name: "case", Provenance: validTestProvenance("case.log"), Stats: ExtractStats{IssueToolCalls: 1},
			Snapshots: []Snapshot{{Sequence: 1, CapturedAt: "2026-07-20T20:01:00Z", ToolCallID: "issues-1", Issues: issues}},
		})
		truth.Scenarios = append(truth.Scenarios, ScenarioGroundTruth{ID: id, Name: "case", Injector: validTestProvenance("case.py"), Exact: []Target{target("real", "Deployment", "demo", "api")}, KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")}})
	}
	report := evaluateCorpusWithMinimum(corpus, truth, 200, 10, 0.5)
	if report.Gate.Green || report.KnownDecoyScenarioDemotionRate != 1.0/3.0 || !hasReason(report.Gate.Reasons, "below the 0.500 minimum") {
		t.Fatalf("weak intended effect passed: %+v", report)
	}
	if relaxed := evaluateCorpusWithMinimum(corpus, truth, 200, 10, 1.0/3.0); !relaxed.Gate.Green {
		t.Fatalf("explicit threshold was not honored: %v", relaxed.Gate.Reasons)
	}
}

func TestScenarioAnyDoesNotHideWeakOccurrenceCoverage(t *testing.T) {
	t.Parallel()
	fixture := ScenarioFixture{
		ID: 1, Name: "repeated-decoy", Provenance: validTestProvenance("repeated.log"), Stats: ExtractStats{IssueToolCalls: 4},
	}
	toolCallIDs := []string{"issues-1", "issues-2", "issues-3", "issues-4"}
	for index := range toolCallIDs {
		decoy := withEvidence(IssueFixture{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1)
		if index == 0 {
			decoy = withEvidence(decoy, true, 0)
			decoy.Stability = "self_healed"
			decoy.StabilityBasis = "trusted_probe_and_restart_history"
		}
		real := withEvidence(IssueFixture{ID: "real", Kind: "Deployment", Namespace: "demo", Name: "api", Severity: "warning", Category: "crashloop", RestartCount: 2, Stability: "persistent", StabilityBasis: "restart_observed"}, false, 1)
		fixture.Snapshots = append(fixture.Snapshots, Snapshot{Sequence: index + 1, CapturedAt: "2026-07-20T20:01:00Z", ToolCallID: toolCallIDs[index], Issues: []IssueFixture{decoy, real}})
	}
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{fixture}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Corpus: "synthetic", Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "repeated-decoy", Injector: validTestProvenance("repeated.py"),
		Exact:       []Target{target("real", "Deployment", "demo", "api")},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")},
	}}}
	report := evaluateCorpusWithMinimum(corpus, truth, 200, 10, 0.5)
	if report.KnownDecoyScenarioDemotionRate != 1 || report.KnownDecoyRowClassificationRate != 0.25 || report.KnownDecoyRowDemotionRate != 0.25 {
		t.Fatalf("effect rates = scenario %.2f classification %.2f eligible %.2f", report.KnownDecoyScenarioDemotionRate, report.KnownDecoyRowClassificationRate, report.KnownDecoyRowDemotionRate)
	}
	if report.Gate.Green || !hasReason(report.Gate.Reasons, "occurrence classification rate") || !hasReason(report.Gate.Reasons, "eligible-occurrence demotion rate") {
		t.Fatalf("scenario-any result hid weak occurrence coverage: %+v", report)
	}
}

func TestGroundTruthValidationRejectsDuplicateIDsAndVacuousMatchers(t *testing.T) {
	t.Parallel()
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{
		{ID: 1, Name: "first", Injector: validTestProvenance("first.py"), Exact: []Target{{ID: "same", AnyOf: []RefMatcher{{}}}, {ID: "same", AnyOf: []RefMatcher{{Kind: "Pod", Name: "pod"}}}}},
		{ID: 1, Name: "duplicate", Injector: validTestProvenance("second.py"), Exact: []Target{target("valid", "Pod", "demo", "pod")}},
	}}
	reasons := validateInputs(Corpus{}, truth)
	if !hasReason(reasons, "duplicate ground-truth scenario ID 1") || !hasReason(reasons, "repeats target ID \"same\"") || !hasReason(reasons, "matcher 0 is vacuous") {
		t.Fatalf("validation reasons = %v", reasons)
	}
	if (RefMatcher{}).matches(ResourceRef{Kind: "Pod", Name: "anything"}) {
		t.Fatal("vacuous matcher matched a resource")
	}
}

func TestCorpusValidationRejectsUnauditableSnapshots(t *testing.T) {
	t.Parallel()
	corpus := Corpus{Source: "wrong", Scenarios: []ScenarioFixture{{
		ID: 1, Name: "case", Snapshots: []Snapshot{{Sequence: 0, ToolCallID: ""}},
	}}}
	truth := GroundTruth{Corpus: "expected", Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "case", Injector: validTestProvenance("case.py"), Exact: []Target{target("pod", "Pod", "demo", "pod")},
	}}}
	reasons := validateInputs(corpus, truth)
	for _, fragment := range []string{"does not match", "invalid transcript provenance", "parsed 1 snapshots from 0 issues tool calls", "invalid or duplicate snapshot sequence", "empty or duplicate snapshot tool_call_id"} {
		if !hasReason(reasons, fragment) {
			t.Errorf("missing %q in %v", fragment, reasons)
		}
	}
}

func TestSyntheticGateRejectsInvalidAndOutOfScopeLabels(t *testing.T) {
	t.Parallel()
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{{
		ID: 1, Name: "bad-labels", Snapshots: []Snapshot{{Issues: []IssueFixture{
			{ID: "real", Kind: "ConfigMap", Namespace: "demo", Name: "config", Severity: "critical", Category: "config_error", Stability: "self_healed", StabilityBasis: "readiness"},
			{ID: "decoy", Kind: "Deployment", Namespace: "demo", Name: "catalog", Severity: "critical", Category: "crashloop", RestartCount: 2, Stability: "maybe", StabilityBasis: "guess"},
		}}},
	}}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{{
		ID: 1, Name: "bad-labels", Injector: validTestProvenance("bad-labels.py"),
		Exact:       []Target{target("real", "ConfigMap", "demo", "config")},
		KnownDecoys: []Target{target("decoy", "Deployment", "demo", "catalog")},
	}}}
	report := evaluateCorpus(corpus, truth, 200, 10)
	if report.Gate.Green || report.OutOfScopeDemotableRows != 1 || report.InvalidStabilityRows != 1 {
		t.Fatalf("bad labels were not rejected: %+v", report)
	}
}

func TestAvailableWireSignatureCollisionIsReported(t *testing.T) {
	t.Parallel()
	signature := IssueFixture{
		Severity: "critical", Category: "crashloop", Reason: "CrashLoopBackOff", RestartCount: 2,
		IssueTiming: "started_at_resource_creation", IssueTimingBasis: "pod_creation",
	}
	real := signature
	real.ID, real.Kind, real.Namespace, real.Name = "real", "Deployment", "social-network", "url-shorten-mongodb"
	decoy := signature
	decoy.ID, decoy.Kind, decoy.Namespace, decoy.Name = "decoy", "Deployment", "astronomy-shop", "product-catalog"
	corpus := Corpus{SchemaVersion: corpusSchemaVersion, Source: "synthetic", Scenarios: []ScenarioFixture{
		{ID: 6, Name: "auth", Snapshots: []Snapshot{{Sequence: 1, Issues: []IssueFixture{real}}}},
		{ID: 15, Name: "shadow", Snapshots: []Snapshot{{Sequence: 1, Issues: []IssueFixture{decoy}}}},
	}}
	truth := GroundTruth{SchemaVersion: corpusSchemaVersion, Scenarios: []ScenarioGroundTruth{
		{ID: 6, Name: "auth", Injector: validTestProvenance("auth.py"), Exact: []Target{target("real", "Deployment", "social-network", "url-shorten-mongodb")}},
		{ID: 15, Name: "shadow", Injector: validTestProvenance("shadow.py"), Exact: []Target{target("other", "Deployment", "astronomy-shop", "frontend-proxy")}, KnownDecoys: []Target{target("decoy", "Deployment", "astronomy-shop", "product-catalog")}},
	}}
	report := evaluateCorpus(corpus, truth, 200, 10)
	if got, want := len(report.AvailableSignalCollisions), 1; got != want {
		t.Fatalf("collisions = %d, want %d: %+v", got, want, report.AvailableSignalCollisions)
	}
	collision := report.AvailableSignalCollisions[0]
	if !strings.Contains(collision.GroundTruthAt[0], "url-shorten-mongodb") || !strings.Contains(collision.KnownDecoyAt[0], "product-catalog") {
		t.Fatalf("collision = %+v", collision)
	}
}

func TestGroundTruthManifestCovers29UsableScenarios(t *testing.T) {
	t.Parallel()
	var truth GroundTruth
	if err := readJSON(filepath.Join("testdata", "ground-truth.json"), &truth); err != nil {
		t.Fatal(err)
	}
	if got, want := len(truth.Scenarios), 29; got != want {
		t.Fatalf("scenarios = %d, want %d", got, want)
	}
	ids := map[int]bool{}
	for _, scenario := range truth.Scenarios {
		if ids[scenario.ID] {
			t.Fatalf("duplicate scenario ID %d", scenario.ID)
		}
		ids[scenario.ID] = true
		if len(scenario.Exact) == 0 || scenario.Injector.File == "" || len(scenario.Injector.SHA256) != 64 {
			t.Fatalf("incomplete ground truth for scenario %d: %+v", scenario.ID, scenario)
		}
	}
	if ids[19] || len(truth.Excluded) != 1 || truth.Excluded[0].ID != 19 {
		t.Fatalf("scenario 19 exclusion = %+v", truth.Excluded)
	}
	if truth.ExpectedRun == nil || truth.ExpectedRun.SREGymRevision != "9b412c4" || truth.ExpectedRun.ApplicationsRevision != "18620ed" || truth.ExpectedRun.RadarRevision != "699d9074" {
		t.Fatalf("benchmark run provenance = %+v", truth.ExpectedRun)
	}
	if got, want := len(truth.SupportingSources), 2; got != want {
		t.Fatalf("supporting sources = %d, want %d", got, want)
	}
	assertGroundTruthRelations(t, truth, 1, "quota", "search-victim")
	assertGroundTruthRelations(t, truth, 24, "pod-policy", "recommendation-victim")
}

func TestCommittedCorpusFailsClosedWithPublishedDenominators(t *testing.T) {
	t.Parallel()
	var corpus Corpus
	if err := readJSON(filepath.Join("testdata", "corpus.json"), &corpus); err != nil {
		t.Fatal(err)
	}
	var truth GroundTruth
	if err := readJSON(filepath.Join("testdata", "ground-truth.json"), &truth); err != nil {
		t.Fatal(err)
	}
	report := evaluateCorpus(corpus, truth, 200, 10)
	if report.Gate.Green {
		t.Fatal("captured corpus cannot support a green production-sort gate")
	}
	if report.ScenariosLoaded != 29 || report.Snapshots != 42 || report.IssueRows != 104 || report.RestartRows != 53 {
		t.Fatalf("corpus denominators changed: scenarios=%d snapshots=%d issues=%d restart=%d", report.ScenariosLoaded, report.Snapshots, report.IssueRows, report.RestartRows)
	}
	if report.ScenariosWithExactGroundTruth != 12 || report.ExactTargets.Present != 19 || report.ExactTargets.Total != 37 || report.ScenariosSafetyEvaluable != 4 {
		t.Fatalf("exact denominators changed: scenarios=%d targets=%d/%d safety=%d", report.ScenariosWithExactGroundTruth, report.ExactTargets.Present, report.ExactTargets.Total, report.ScenariosSafetyEvaluable)
	}
	if report.ScenariosWithCausalGroundTruth != 3 || report.CausalTargets.Present != 3 || report.CausalTargets.Total != 13 || report.CausalTargetsSafetyEvaluable.Present != 0 {
		t.Fatalf("causal denominators changed: scenarios=%d targets=%d/%d safety=%d", report.ScenariosWithCausalGroundTruth, report.CausalTargets.Present, report.CausalTargets.Total, report.CausalTargetsSafetyEvaluable.Present)
	}
	if report.BasisAnnotatedRestartRows != 0 || report.KnownDecoyScenariosPresent != 10 || report.KnownDecoyScenariosDemoted != 0 {
		t.Fatalf("candidate coverage changed: annotated=%d decoy_present=%d decoy_demoted=%d", report.BasisAnnotatedRestartRows, report.KnownDecoyScenariosPresent, report.KnownDecoyScenariosDemoted)
	}
	if report.GroundTruthBelowDecoyAfter != 3 {
		t.Fatalf("ground truth below decoy = %d, want 3", report.GroundTruthBelowDecoyAfter)
	}
	if report.KnownDecoyRows != 16 || report.KnownDecoyRowsWithOpportunity != 16 || report.KnownDecoyRowClassificationRate != 0 || report.KnownDecoyRowDemotionRate != 0 {
		t.Fatalf("known-decoy occurrence metrics changed: %+v", report)
	}
	if len(report.AvailableSignalCollisions) != 1 || !strings.Contains(report.AvailableSignalCollisions[0].GroundTruthAt[0], "url-shorten-mongodb") {
		t.Fatalf("wire collision changed: %+v", report.AvailableSignalCollisions)
	}
	var expected EvaluationReport
	if err := readJSON(filepath.Join("testdata", "batch11-report.json"), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(report, expected) {
		t.Fatal("checked-in report does not match a fresh evaluation")
	}
}

func marshalLine(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func target(id, kind, namespace, name string) Target {
	return Target{ID: id, AnyOf: []RefMatcher{{Kind: kind, Namespace: namespace, Name: name}}}
}

func rankedIDs(rows []rankedIssue) []string {
	ids := make([]string, len(rows))
	for index, row := range rows {
		ids[index] = row.Issue.ID
	}
	return ids
}

func ranks(rows []rankedIssue) map[int]int {
	ranks := make(map[int]int, len(rows))
	for rank, row := range rows {
		ranks[row.OriginalIndex] = rank
	}
	return ranks
}

func withEvidence(issue IssueFixture, ready bool, restartDelta int32) IssueFixture {
	issue.CurrentReady = &ready
	hasReadinessProbe := true
	issue.HasReadinessProbe = &hasReadinessProbe
	issue.LastRestartAt = "2026-07-20T20:00:00Z"
	issue.ObservedRestartDelta = &restartDelta
	if ready {
		issue.CurrentRunStartedAt = "2026-07-20T20:00:01Z"
	}
	return issue
}

func validTestProvenance(file string) Provenance {
	return Provenance{File: file, SHA256: strings.Repeat("a", 64)}
}

func hasReason(reasons []string, fragment string) bool {
	for _, reason := range reasons {
		if strings.Contains(reason, fragment) {
			return true
		}
	}
	return false
}

func assertGroundTruthRelations(t *testing.T, truth GroundTruth, scenarioID int, exactID, causalID string) {
	t.Helper()
	for _, scenario := range truth.Scenarios {
		if scenario.ID != scenarioID {
			continue
		}
		if len(scenario.Exact) != 1 || scenario.Exact[0].ID != exactID || len(scenario.Causal) != 1 || scenario.Causal[0].ID != causalID {
			t.Fatalf("scenario %d relations = exact %+v causal %+v", scenarioID, scenario.Exact, scenario.Causal)
		}
		return
	}
	t.Fatalf("scenario %d missing", scenarioID)
}
