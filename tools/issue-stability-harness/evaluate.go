package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"
)

type CountCoverage struct {
	Total   int `json:"total"`
	Present int `json:"present"`
}

type GateResult struct {
	Green   bool     `json:"green"`
	Reasons []string `json:"reasons"`
}

type EvaluationReport struct {
	SchemaVersion                   int                      `json:"schema_version"`
	Corpus                          string                   `json:"corpus"`
	Run                             *BenchmarkRunProvenance  `json:"run,omitempty"`
	ScenariosExpected               int                      `json:"scenarios_expected"`
	ScenariosLoaded                 int                      `json:"scenarios_loaded"`
	IssueToolCalls                  int                      `json:"issue_tool_calls"`
	Snapshots                       int                      `json:"snapshots"`
	IssueRows                       int                      `json:"issue_rows"`
	RestartRows                     int                      `json:"restart_rows"`
	AnnotatedRestartRows            int                      `json:"annotated_restart_rows"`
	BasisAnnotatedRestartRows       int                      `json:"basis_annotated_restart_rows"`
	ReclassificationEvidenceRows    int                      `json:"reclassification_evidence_rows"`
	InvalidStabilityRows            int                      `json:"invalid_stability_rows"`
	OutOfScopeDemotableRows         int                      `json:"out_of_scope_demotable_rows"`
	FieldCoverage                   map[string]CountCoverage `json:"field_coverage"`
	ExactTargets                    CountCoverage            `json:"exact_targets"`
	ExactTargetsWithinCap           CountCoverage            `json:"exact_targets_within_cap"`
	ExactTargetsSafetyEvaluable     CountCoverage            `json:"exact_targets_safety_evaluable"`
	CausalTargets                   CountCoverage            `json:"causal_targets"`
	CausalTargetsWithinCap          CountCoverage            `json:"causal_targets_within_cap"`
	CausalTargetsSafetyEvaluable    CountCoverage            `json:"causal_targets_safety_evaluable"`
	ScenariosWithExactGroundTruth   int                      `json:"scenarios_with_exact_ground_truth"`
	ScenariosWithAllExactTargets    int                      `json:"scenarios_with_all_exact_targets"`
	ScenariosWithCausalGroundTruth  int                      `json:"scenarios_with_causal_ground_truth"`
	ScenariosWithAllCausalTargets   int                      `json:"scenarios_with_all_causal_targets"`
	ScenariosSafetyEvaluable        int                      `json:"scenarios_safety_evaluable"`
	GroundTruthDemotableFP          int                      `json:"ground_truth_demotable_false_positives"`
	ScenariosWithGroundTruthFP      int                      `json:"scenarios_with_ground_truth_false_positive"`
	RealFaultDemoted                int                      `json:"real_fault_demoted"`
	ScenariosWithRealFaultDemoted   int                      `json:"scenarios_with_real_fault_demoted"`
	GroundTruthPairwiseLosses       int                      `json:"ground_truth_pairwise_losses"`
	ScenariosWithPairwiseLoss       int                      `json:"scenarios_with_pairwise_loss"`
	GroundTruthBelowDecoyAfter      int                      `json:"ground_truth_below_decoy_after"`
	ScenariosWithGTBelowDecoy       int                      `json:"scenarios_with_ground_truth_below_decoy"`
	ActiveActiveInversions          int                      `json:"active_active_inversions"`
	TopKVisibilityLosses            int                      `json:"top_k_visibility_losses"`
	CapMembershipChanges            int                      `json:"cap_membership_changes"`
	KnownDecoyScenariosPresent      int                      `json:"known_decoy_scenarios_present"`
	KnownDecoyScenariosClassified   int                      `json:"known_decoy_scenarios_classified"`
	KnownDecoyScenariosDemoted      int                      `json:"known_decoy_scenarios_demoted"`
	KnownDecoyScenarioDemotionRate  float64                  `json:"known_decoy_scenario_demotion_rate"`
	MinimumDecoyRate                float64                  `json:"minimum_decoy_rate"`
	KnownDecoyRows                  int                      `json:"known_decoy_rows"`
	KnownDecoyRowsClassified        int                      `json:"known_decoy_rows_classified"`
	KnownDecoyRowClassificationRate float64                  `json:"known_decoy_row_classification_rate"`
	KnownDecoyRowsWithOpportunity   int                      `json:"known_decoy_rows_with_rank_opportunity"`
	KnownDecoyRowsDemoted           int                      `json:"known_decoy_rows_demoted"`
	KnownDecoyRowDemotionRate       float64                  `json:"known_decoy_row_demotion_rate"`
	AvailableSignalCollisions       []SignalCollision        `json:"available_signal_collisions"`
	RankChangeDistribution          map[string]int           `json:"rank_change_distribution"`
	Scenarios                       []ScenarioEvaluation     `json:"scenarios"`
	Gate                            GateResult               `json:"gate"`
}

type SignalCollision struct {
	Signature     string   `json:"signature"`
	GroundTruthAt []string `json:"ground_truth_at"`
	KnownDecoyAt  []string `json:"known_decoy_at"`
}

type ScenarioEvaluation struct {
	ID                         int      `json:"id"`
	Name                       string   `json:"name"`
	Snapshots                  int      `json:"snapshots"`
	IssueRows                  int      `json:"issue_rows"`
	ExactTargetsPresent        int      `json:"exact_targets_present"`
	ExactTargetsTotal          int      `json:"exact_targets_total"`
	ExactTargetsWithinCap      int      `json:"exact_targets_within_cap"`
	ExactTargetsEvaluable      int      `json:"exact_targets_evaluable"`
	CausalTargetsPresent       int      `json:"causal_targets_present"`
	CausalTargetsTotal         int      `json:"causal_targets_total"`
	CausalTargetsWithinCap     int      `json:"causal_targets_within_cap"`
	CausalTargetsEvaluable     int      `json:"causal_targets_evaluable"`
	SafetyEvaluable            bool     `json:"safety_evaluable"`
	KnownDecoyPresent          bool     `json:"known_decoy_present"`
	KnownDecoyClassified       bool     `json:"known_decoy_classified"`
	KnownDecoyDemoted          bool     `json:"known_decoy_demoted"`
	GroundTruthDemotableFP     int      `json:"ground_truth_demotable_false_positives"`
	RealFaultDemoted           int      `json:"real_fault_demoted"`
	GroundTruthPairwiseLosses  int      `json:"ground_truth_pairwise_losses"`
	GroundTruthBelowDecoyAfter int      `json:"ground_truth_below_decoy_after"`
	TopKVisibilityLosses       int      `json:"top_k_visibility_losses"`
	Notes                      []string `json:"notes,omitempty"`
}

type rankedIssue struct {
	Issue         IssueFixture
	OriginalIndex int
}

const unsetMinimumDecoyRate = 0.0

func evaluateCorpus(corpus Corpus, truth GroundTruth, capLimit, topK int) EvaluationReport {
	return evaluateCorpusWithMinimum(corpus, truth, capLimit, topK, unsetMinimumDecoyRate)
}

func evaluateCorpusWithMinimum(corpus Corpus, truth GroundTruth, capLimit, topK int, minimumDecoyRate float64) EvaluationReport {
	report := EvaluationReport{
		SchemaVersion:          1,
		Corpus:                 corpus.Source,
		Run:                    corpus.Run,
		ScenariosExpected:      len(truth.Scenarios),
		ScenariosLoaded:        len(corpus.Scenarios),
		FieldCoverage:          map[string]CountCoverage{},
		RankChangeDistribution: map[string]int{},
		MinimumDecoyRate:       minimumDecoyRate,
	}
	report.Gate.Reasons = append(report.Gate.Reasons, validateInputs(corpus, truth)...)
	if math.IsNaN(minimumDecoyRate) || minimumDecoyRate < 0 || minimumDecoyRate > 1 {
		report.Gate.Reasons = append(report.Gate.Reasons, fmt.Sprintf("minimum decoy rate must be in [0,1], got %v", minimumDecoyRate))
	}
	if corpus.SchemaVersion != corpusSchemaVersion {
		report.Gate.Reasons = append(report.Gate.Reasons, fmt.Sprintf("unsupported corpus schema %d", corpus.SchemaVersion))
	}
	if truth.SchemaVersion != corpusSchemaVersion {
		report.Gate.Reasons = append(report.Gate.Reasons, fmt.Sprintf("unsupported ground-truth schema %d", truth.SchemaVersion))
	}
	truthByID := make(map[int]ScenarioGroundTruth, len(truth.Scenarios))
	for _, scenario := range truth.Scenarios {
		truthByID[scenario.ID] = scenario
		report.ExactTargets.Total += len(scenario.Exact)
		report.ExactTargetsWithinCap.Total += len(scenario.Exact)
		report.ExactTargetsSafetyEvaluable.Total += len(scenario.Exact)
		report.CausalTargets.Total += len(scenario.Causal)
		report.CausalTargetsWithinCap.Total += len(scenario.Causal)
		report.CausalTargetsSafetyEvaluable.Total += len(scenario.Causal)
	}

	loadedIDs := map[int]bool{}
	groundTruthSignatures := map[string]map[string]bool{}
	decoySignatures := map[string]map[string]bool{}
	for _, fixture := range corpus.Scenarios {
		loadedIDs[fixture.ID] = true
		report.IssueToolCalls += fixture.Stats.IssueToolCalls
		gt, ok := truthByID[fixture.ID]
		result := ScenarioEvaluation{ID: fixture.ID, Name: fixture.Name, Snapshots: len(fixture.Snapshots)}
		if !ok {
			result.Notes = append(result.Notes, "no ground-truth entry")
			report.Scenarios = append(report.Scenarios, result)
			continue
		}
		if fixture.Name != gt.Name {
			result.Notes = append(result.Notes, fmt.Sprintf("name mismatch: fixture=%q ground_truth=%q", fixture.Name, gt.Name))
		}
		result.ExactTargetsTotal = len(gt.Exact)
		result.CausalTargetsTotal = len(gt.Causal)
		exactSeen := make([]bool, len(gt.Exact))
		exactWithinCapSeen := make([]bool, len(gt.Exact))
		exactEvaluable := make([]bool, len(gt.Exact))
		causalSeen := make([]bool, len(gt.Causal))
		causalWithinCapSeen := make([]bool, len(gt.Causal))
		causalEvaluable := make([]bool, len(gt.Causal))

		for _, snapshot := range fixture.Snapshots {
			report.Snapshots++
			report.IssueRows += len(snapshot.Issues)
			result.IssueRows += len(snapshot.Issues)
			candidateEvidenceComplete := true
			for _, issue := range snapshot.Issues {
				countIssueFields(&report, issue, snapshot.CapturedAt)
				if restartDerived(issue) && (!validStability(issue.Stability) || issue.StabilityBasis == "" || !reclassificationEvidenceComplete(issue, snapshot.CapturedAt)) {
					candidateEvidenceComplete = false
				}
			}

			exactIndices := map[int]bool{}
			causalIndices := map[int]bool{}
			baselineLimit := capLength(len(snapshot.Issues), capLimit)
			for targetIndex, target := range gt.Exact {
				indices := matchingIssueIndices(snapshot.Issues, target)
				if len(indices) > 0 {
					exactSeen[targetIndex] = true
				}
				for _, index := range indices {
					exactIndices[index] = true
					if index < baselineLimit {
						exactWithinCapSeen[targetIndex] = true
						if candidateEvidenceComplete {
							exactEvaluable[targetIndex] = true
						}
					}
				}
			}
			for targetIndex, target := range gt.Causal {
				indices := matchingIssueIndices(snapshot.Issues, target)
				if len(indices) > 0 {
					causalSeen[targetIndex] = true
				}
				for _, index := range indices {
					causalIndices[index] = true
					if index < baselineLimit {
						causalWithinCapSeen[targetIndex] = true
						if candidateEvidenceComplete {
							causalEvaluable[targetIndex] = true
						}
					}
				}
			}
			protectedIndices := unionIndices(exactIndices, causalIndices)
			decoyIndices := map[int]bool{}
			for _, target := range gt.KnownDecoys {
				for _, index := range matchingIssueIndices(snapshot.Issues, target) {
					decoyIndices[index] = true
				}
			}
			if len(decoyIndices) > 0 {
				result.KnownDecoyPresent = true
			}

			baseline, candidate := softSortAfterCap(snapshot.Issues, capLimit)
			newRank := make(map[int]int, len(candidate))
			for rank, row := range candidate {
				newRank[row.OriginalIndex] = rank
			}
			for rank, row := range baseline {
				delta := newRank[row.OriginalIndex] - rank
				report.RankChangeDistribution[strconv.Itoa(delta)]++
			}
			report.CapMembershipChanges += membershipChanges(baseline, candidate)
			activeInversions := countActiveInversions(baseline, newRank)
			report.ActiveActiveInversions += activeInversions

			for index := range protectedIndices {
				if restartDerived(snapshot.Issues[index]) {
					addSignatureExample(groundTruthSignatures, availableSignalSignature(snapshot.Issues[index]), fixture, snapshot, snapshot.Issues[index])
				}
				if index >= len(baseline) {
					continue
				}
				if demotable(snapshot.Issues[index]) {
					report.GroundTruthDemotableFP++
					result.GroundTruthDemotableFP++
				}
				delta := newRank[index] - index
				if delta > 0 {
					report.RealFaultDemoted++
					result.RealFaultDemoted++
				}
				if index < topK && newRank[index] >= topK {
					report.TopKVisibilityLosses++
					result.TopKVisibilityLosses++
				}
			}
			for index := range decoyIndices {
				if restartDerived(snapshot.Issues[index]) {
					addSignatureExample(decoySignatures, availableSignalSignature(snapshot.Issues[index]), fixture, snapshot, snapshot.Issues[index])
				}
				if index >= len(baseline) {
					continue
				}
				report.KnownDecoyRows++
				if wouldMoveIfSelfHealed(snapshot.Issues, index, capLimit) {
					report.KnownDecoyRowsWithOpportunity++
				}
				if demotable(snapshot.Issues[index]) {
					report.KnownDecoyRowsClassified++
					result.KnownDecoyClassified = true
				}
				if demotable(snapshot.Issues[index]) && newRank[index] > index {
					report.KnownDecoyRowsDemoted++
					result.KnownDecoyDemoted = true
				}
			}
			losses := countPairwiseLosses(protectedIndices, decoyIndices, newRank)
			report.GroundTruthPairwiseLosses += losses
			result.GroundTruthPairwiseLosses += losses
			below := countGroundTruthBelowDecoy(protectedIndices, decoyIndices, newRank)
			report.GroundTruthBelowDecoyAfter += below
			result.GroundTruthBelowDecoyAfter += below
		}

		for targetIndex, seen := range exactSeen {
			if seen {
				result.ExactTargetsPresent++
				report.ExactTargets.Present++
			}
			if exactWithinCapSeen[targetIndex] {
				result.ExactTargetsWithinCap++
				report.ExactTargetsWithinCap.Present++
			}
			if exactEvaluable[targetIndex] {
				result.ExactTargetsEvaluable++
				report.ExactTargetsSafetyEvaluable.Present++
			}
		}
		for targetIndex, seen := range causalSeen {
			if seen {
				result.CausalTargetsPresent++
				report.CausalTargets.Present++
			}
			if causalWithinCapSeen[targetIndex] {
				result.CausalTargetsWithinCap++
				report.CausalTargetsWithinCap.Present++
			}
			if causalEvaluable[targetIndex] {
				result.CausalTargetsEvaluable++
				report.CausalTargetsSafetyEvaluable.Present++
			}
		}
		if result.ExactTargetsPresent > 0 {
			report.ScenariosWithExactGroundTruth++
		} else {
			result.Notes = append(result.Notes, "exact ground-truth subject absent from every issues snapshot")
		}
		if result.ExactTargetsTotal > 0 && result.ExactTargetsPresent == result.ExactTargetsTotal {
			report.ScenariosWithAllExactTargets++
		} else if result.ExactTargetsPresent > 0 {
			result.Notes = append(result.Notes, "only some exact ground-truth targets appear in issues")
		}
		if result.CausalTargetsPresent > 0 {
			report.ScenariosWithCausalGroundTruth++
		}
		if result.CausalTargetsTotal > 0 && result.CausalTargetsPresent == result.CausalTargetsTotal {
			report.ScenariosWithAllCausalTargets++
		} else if result.CausalTargetsPresent > 0 {
			result.Notes = append(result.Notes, "only some causal ground-truth targets appear in issues")
		}
		result.SafetyEvaluable = result.ExactTargetsTotal > 0 &&
			result.ExactTargetsEvaluable == result.ExactTargetsTotal &&
			result.CausalTargetsEvaluable == result.CausalTargetsTotal
		if result.SafetyEvaluable {
			report.ScenariosSafetyEvaluable++
		} else if result.ExactTargetsPresent > 0 || result.CausalTargetsPresent > 0 {
			result.Notes = append(result.Notes, "protected targets are outside the cap or restart rows lack auditable candidate evidence")
		}
		if result.KnownDecoyPresent {
			report.KnownDecoyScenariosPresent++
		}
		if result.KnownDecoyClassified {
			report.KnownDecoyScenariosClassified++
		}
		if result.KnownDecoyDemoted {
			report.KnownDecoyScenariosDemoted++
		}
		if result.GroundTruthDemotableFP > 0 {
			report.ScenariosWithGroundTruthFP++
		}
		if result.RealFaultDemoted > 0 {
			report.ScenariosWithRealFaultDemoted++
		}
		if result.GroundTruthPairwiseLosses > 0 {
			report.ScenariosWithPairwiseLoss++
		}
		if result.GroundTruthBelowDecoyAfter > 0 {
			report.ScenariosWithGTBelowDecoy++
		}
		report.Scenarios = append(report.Scenarios, result)
	}

	for id := range truthByID {
		if !loadedIDs[id] {
			report.Gate.Reasons = append(report.Gate.Reasons, fmt.Sprintf("ground-truth scenario %d is missing from corpus", id))
		}
	}
	for signature, groundTruthAt := range groundTruthSignatures {
		knownDecoyAt := decoySignatures[signature]
		if len(knownDecoyAt) == 0 {
			continue
		}
		report.AvailableSignalCollisions = append(report.AvailableSignalCollisions, SignalCollision{
			Signature:     signature,
			GroundTruthAt: sortedKeys(groundTruthAt),
			KnownDecoyAt:  sortedKeys(knownDecoyAt),
		})
	}
	sort.Slice(report.AvailableSignalCollisions, func(i, j int) bool {
		return report.AvailableSignalCollisions[i].Signature < report.AvailableSignalCollisions[j].Signature
	})
	if report.KnownDecoyScenariosPresent > 0 {
		report.KnownDecoyScenarioDemotionRate = float64(report.KnownDecoyScenariosDemoted) / float64(report.KnownDecoyScenariosPresent)
	}
	if report.KnownDecoyRows > 0 {
		report.KnownDecoyRowClassificationRate = float64(report.KnownDecoyRowsClassified) / float64(report.KnownDecoyRows)
	}
	if report.KnownDecoyRowsWithOpportunity > 0 {
		report.KnownDecoyRowDemotionRate = float64(report.KnownDecoyRowsDemoted) / float64(report.KnownDecoyRowsWithOpportunity)
	}
	report.Gate.Reasons = append(report.Gate.Reasons, gateReasons(report)...)
	report.Gate.Green = len(report.Gate.Reasons) == 0
	sort.Slice(report.Scenarios, func(i, j int) bool { return report.Scenarios[i].ID < report.Scenarios[j].ID })
	return report
}

func validateInputs(corpus Corpus, truth GroundTruth) []string {
	var reasons []string
	if corpus.Source == "" {
		reasons = append(reasons, "corpus source is empty")
	}
	if truth.Corpus == "" {
		reasons = append(reasons, "ground-truth corpus source is empty")
	}
	if corpus.Source != truth.Corpus {
		reasons = append(reasons, fmt.Sprintf("corpus source %q does not match ground truth %q", corpus.Source, truth.Corpus))
	}
	corpusIDs := map[int]string{}
	for _, scenario := range corpus.Scenarios {
		if previous, duplicate := corpusIDs[scenario.ID]; duplicate {
			reasons = append(reasons, fmt.Sprintf("duplicate corpus scenario ID %d (%q and %q)", scenario.ID, previous, scenario.Name))
		} else {
			corpusIDs[scenario.ID] = scenario.Name
		}
		if !validProvenance(scenario.Provenance) {
			reasons = append(reasons, fmt.Sprintf("corpus scenario %d has invalid transcript provenance", scenario.ID))
		}
		if len(scenario.Snapshots) != scenario.Stats.IssueToolCalls {
			reasons = append(reasons, fmt.Sprintf("corpus scenario %d parsed %d snapshots from %d issues tool calls", scenario.ID, len(scenario.Snapshots), scenario.Stats.IssueToolCalls))
		}
		sequences := map[int]bool{}
		toolCallIDs := map[string]bool{}
		for _, snapshot := range scenario.Snapshots {
			if snapshot.Sequence < 1 || sequences[snapshot.Sequence] {
				reasons = append(reasons, fmt.Sprintf("corpus scenario %d has invalid or duplicate snapshot sequence %d", scenario.ID, snapshot.Sequence))
			}
			sequences[snapshot.Sequence] = true
			if snapshot.ToolCallID == "" || toolCallIDs[snapshot.ToolCallID] {
				reasons = append(reasons, fmt.Sprintf("corpus scenario %d has empty or duplicate snapshot tool_call_id %q", scenario.ID, snapshot.ToolCallID))
			}
			toolCallIDs[snapshot.ToolCallID] = true
		}
	}

	truthIDs := map[int]string{}
	for _, scenario := range truth.Scenarios {
		if previous, duplicate := truthIDs[scenario.ID]; duplicate {
			reasons = append(reasons, fmt.Sprintf("duplicate ground-truth scenario ID %d (%q and %q)", scenario.ID, previous, scenario.Name))
		} else {
			truthIDs[scenario.ID] = scenario.Name
		}
		if scenario.Name == "" {
			reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d has an empty name", scenario.ID))
		}
		if len(scenario.Exact) == 0 {
			reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d has no exact targets", scenario.ID))
		}
		if !validProvenance(scenario.Injector) {
			reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d has invalid injector provenance", scenario.ID))
		}
		targetIDs := map[string]string{}
		for _, relation := range []struct {
			name    string
			targets []Target
		}{
			{name: "exact", targets: scenario.Exact},
			{name: "causal", targets: scenario.Causal},
			{name: "known_decoy", targets: scenario.KnownDecoys},
		} {
			for _, target := range relation.targets {
				if previous, duplicate := targetIDs[target.ID]; duplicate {
					reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d repeats target ID %q in %s and %s", scenario.ID, target.ID, previous, relation.name))
				} else {
					targetIDs[target.ID] = relation.name
				}
				reasons = append(reasons, validateTarget(scenario.ID, relation.name, target)...)
			}
		}
	}

	for _, scenario := range corpus.Scenarios {
		expectedName, ok := truthIDs[scenario.ID]
		if !ok {
			reasons = append(reasons, fmt.Sprintf("corpus scenario %d (%q) has no ground-truth entry", scenario.ID, scenario.Name))
			continue
		}
		if scenario.Name != expectedName {
			reasons = append(reasons, fmt.Sprintf("scenario %d name mismatch: corpus=%q ground_truth=%q", scenario.ID, scenario.Name, expectedName))
		}
	}

	excludedIDs := map[int]bool{}
	for _, excluded := range truth.Excluded {
		if excludedIDs[excluded.ID] {
			reasons = append(reasons, fmt.Sprintf("duplicate excluded scenario ID %d", excluded.ID))
		}
		excludedIDs[excluded.ID] = true
		if _, included := truthIDs[excluded.ID]; included {
			reasons = append(reasons, fmt.Sprintf("scenario %d is both included and excluded in ground truth", excluded.ID))
		}
		if excluded.Reason == "" {
			reasons = append(reasons, fmt.Sprintf("excluded scenario %d has no reason", excluded.ID))
		}
	}

	if truth.ExpectedRun != nil {
		if corpus.Run == nil {
			reasons = append(reasons, "corpus lacks expected benchmark run provenance")
		} else if *corpus.Run != *truth.ExpectedRun {
			reasons = append(reasons, "corpus benchmark run provenance does not match ground truth")
		}
		if !validRunProvenance(*truth.ExpectedRun) {
			reasons = append(reasons, "ground truth has invalid benchmark run provenance")
		}
	}
	for _, source := range truth.SupportingSources {
		if !validProvenance(source) {
			reasons = append(reasons, fmt.Sprintf("invalid supporting-source provenance for %q", source.File))
		}
	}
	return reasons
}

func validateTarget(scenarioID int, relation string, target Target) []string {
	var reasons []string
	if target.ID == "" {
		reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d has an empty %s target ID", scenarioID, relation))
	}
	if len(target.AnyOf) == 0 {
		reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d target %q has no matchers", scenarioID, target.ID))
	}
	for index, matcher := range target.AnyOf {
		if matcher.Kind == "" || (matcher.Name == "" && matcher.NamePrefix == "") {
			reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d target %q matcher %d is vacuous", scenarioID, target.ID, index))
		}
		if matcher.Name != "" && matcher.NamePrefix != "" {
			reasons = append(reasons, fmt.Sprintf("ground-truth scenario %d target %q matcher %d sets both name and name_prefix", scenarioID, target.ID, index))
		}
	}
	return reasons
}

func validRunProvenance(run BenchmarkRunProvenance) bool {
	return validProvenance(run.StatusFile) && validHexRevision(run.SREGymRevision) &&
		validHexRevision(run.ApplicationsRevision) && validHexRevision(run.RadarRevision)
}

func validProvenance(provenance Provenance) bool {
	return provenance.File != "" && len(provenance.SHA256) == 64 && validHex(provenance.SHA256)
}

func validHexRevision(revision string) bool {
	return len(revision) >= 7 && len(revision) <= 40 && validHex(revision)
}

func validHex(value string) bool {
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return value != ""
}

func availableSignalSignature(issue IssueFixture) string {
	return fmt.Sprintf("category=%s;reason=%s;restart_count=%d;issue_timing=%s;issue_timing_basis=%s",
		issue.Category, issue.Reason, issue.RestartCount, issue.IssueTiming, issue.IssueTimingBasis)
}

func addSignatureExample(index map[string]map[string]bool, signature string, fixture ScenarioFixture, snapshot Snapshot, issue IssueFixture) {
	if index[signature] == nil {
		index[signature] = map[string]bool{}
	}
	location := fmt.Sprintf("%d/%s snapshot=%d %s/%s/%s", fixture.ID, fixture.Name, snapshot.Sequence, issue.Kind, issue.Namespace, issue.Name)
	index[signature][location] = true
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func countIssueFields(report *EvaluationReport, issue IssueFixture, capturedAt string) {
	reportField := func(field string, present bool) {
		coverage := report.FieldCoverage[field]
		coverage.Total++
		if present {
			coverage.Present++
		}
		report.FieldCoverage[field] = coverage
	}
	reportField("stability", issue.Stability != "")
	reportField("stability_basis", issue.StabilityBasis != "")
	reportField("current_ready", issue.CurrentReady != nil)
	reportField("has_readiness_probe", issue.HasReadinessProbe != nil)
	reportField("current_run_started_at", issue.CurrentRunStartedAt != "")
	reportField("last_restart_at", issue.LastRestartAt != "")
	reportField("observed_restart_delta", issue.ObservedRestartDelta != nil)
	if issue.Stability != "" && !validStability(issue.Stability) {
		report.InvalidStabilityRows++
	}
	if demotable(issue) && !restartDerived(issue) {
		report.OutOfScopeDemotableRows++
	}
	if !restartDerived(issue) {
		return
	}
	report.RestartRows++
	if issue.Stability != "" {
		report.AnnotatedRestartRows++
	}
	if validStability(issue.Stability) && issue.StabilityBasis != "" {
		report.BasisAnnotatedRestartRows++
	}
	if reclassificationEvidenceComplete(issue, capturedAt) {
		report.ReclassificationEvidenceRows++
	}
}

func reclassificationEvidenceComplete(issue IssueFixture, capturedAt string) bool {
	if issue.CurrentReady == nil || issue.HasReadinessProbe == nil || issue.LastRestartAt == "" || issue.ObservedRestartDelta == nil {
		return false
	}
	if *issue.ObservedRestartDelta < 0 || *issue.ObservedRestartDelta > issue.RestartCount {
		return false
	}
	captured, err := time.Parse(time.RFC3339Nano, capturedAt)
	if err != nil {
		return false
	}
	lastRestart, err := time.Parse(time.RFC3339Nano, issue.LastRestartAt)
	if err != nil || lastRestart.After(captured) {
		return false
	}
	if issue.CurrentRunStartedAt == "" {
		return !*issue.CurrentReady
	}
	currentRunStarted, err := time.Parse(time.RFC3339Nano, issue.CurrentRunStartedAt)
	return err == nil && !currentRunStarted.Before(lastRestart) && !currentRunStarted.After(captured)
}

func matchingIssueIndices(issues []IssueFixture, target Target) []int {
	var indices []int
	for index, issue := range issues {
		if targetMatchesIssue(target, issue) {
			indices = append(indices, index)
		}
	}
	return indices
}

func unionIndices(left, right map[int]bool) map[int]bool {
	union := make(map[int]bool, len(left)+len(right))
	for index := range left {
		union[index] = true
	}
	for index := range right {
		union[index] = true
	}
	return union
}

func softSortAfterCap(issues []IssueFixture, capLimit int) ([]rankedIssue, []rankedIssue) {
	limit := capLength(len(issues), capLimit)
	baseline := make([]rankedIssue, limit)
	for index := 0; index < limit; index++ {
		baseline[index] = rankedIssue{Issue: issues[index], OriginalIndex: index}
	}
	candidate := append([]rankedIssue(nil), baseline...)
	sort.SliceStable(candidate, func(i, j int) bool {
		left, right := candidate[i], candidate[j]
		leftRank := effectiveSeverity(left.Issue)
		rightRank := effectiveSeverity(right.Issue)
		if leftRank != rightRank {
			return leftRank > rightRank
		}
		if demotable(left.Issue) != demotable(right.Issue) {
			return !demotable(left.Issue)
		}
		return false
	})
	return baseline, candidate
}

func capLength(length, capLimit int) int {
	if capLimit > 0 && capLimit < length {
		return capLimit
	}
	return length
}

func wouldMoveIfSelfHealed(issues []IssueFixture, index, capLimit int) bool {
	if index >= capLength(len(issues), capLimit) {
		return false
	}
	counterfactual := append([]IssueFixture(nil), issues...)
	counterfactual[index].Stability = "self_healed"
	_, candidate := softSortAfterCap(counterfactual, capLimit)
	return ranksByOriginalIndex(candidate)[index] > index
}

func ranksByOriginalIndex(rows []rankedIssue) map[int]int {
	ranks := make(map[int]int, len(rows))
	for rank, row := range rows {
		ranks[row.OriginalIndex] = rank
	}
	return ranks
}

func effectiveSeverity(issue IssueFixture) int {
	rank := 0
	switch issue.Severity {
	case "critical":
		rank = 2
	case "warning":
		rank = 1
	}
	if demotable(issue) {
		rank--
	}
	return rank
}

func membershipChanges(baseline, candidate []rankedIssue) int {
	counts := map[int]int{}
	for _, row := range baseline {
		counts[row.OriginalIndex]++
	}
	for _, row := range candidate {
		counts[row.OriginalIndex]--
	}
	changes := 0
	for _, count := range counts {
		if count < 0 {
			changes -= count
		} else {
			changes += count
		}
	}
	return changes
}

func countActiveInversions(baseline []rankedIssue, newRank map[int]int) int {
	inversions := 0
	for i := 0; i < len(baseline); i++ {
		if demotable(baseline[i].Issue) {
			continue
		}
		for j := i + 1; j < len(baseline); j++ {
			if demotable(baseline[j].Issue) {
				continue
			}
			if newRank[baseline[i].OriginalIndex] > newRank[baseline[j].OriginalIndex] {
				inversions++
			}
		}
	}
	return inversions
}

func countPairwiseLosses(exact, decoys map[int]bool, newRank map[int]int) int {
	losses := 0
	for realIndex := range exact {
		realNewRank, realPresent := newRank[realIndex]
		if !realPresent {
			continue
		}
		for decoyIndex := range decoys {
			decoyNewRank, decoyPresent := newRank[decoyIndex]
			if decoyPresent && realIndex < decoyIndex && realNewRank > decoyNewRank {
				losses++
			}
		}
	}
	return losses
}

func countGroundTruthBelowDecoy(exact, decoys map[int]bool, newRank map[int]int) int {
	below := 0
	for realIndex := range exact {
		realNewRank, realPresent := newRank[realIndex]
		if !realPresent {
			continue
		}
		for decoyIndex := range decoys {
			decoyNewRank, decoyPresent := newRank[decoyIndex]
			if decoyPresent && realNewRank > decoyNewRank {
				below++
			}
		}
	}
	return below
}

func gateReasons(report EvaluationReport) []string {
	var reasons []string
	if report.MinimumDecoyRate == unsetMinimumDecoyRate {
		reasons = append(reasons, "minimum decoy rate is unset; choose an evidence-backed value for go/no-go")
	}
	if report.ScenariosLoaded != report.ScenariosExpected {
		reasons = append(reasons, fmt.Sprintf("loaded %d/%d expected scenarios", report.ScenariosLoaded, report.ScenariosExpected))
	}
	if report.Snapshots != report.IssueToolCalls {
		reasons = append(reasons, fmt.Sprintf("parsed %d snapshots from %d issues tool calls", report.Snapshots, report.IssueToolCalls))
	}
	if report.ExactTargets.Present != report.ExactTargets.Total {
		reasons = append(reasons, fmt.Sprintf("exact ground truth appears for %d/%d targets across %d/%d scenarios", report.ExactTargets.Present, report.ExactTargets.Total, report.ScenariosWithExactGroundTruth, report.ScenariosExpected))
	}
	if report.ExactTargetsWithinCap.Present != report.ExactTargetsWithinCap.Total {
		reasons = append(reasons, fmt.Sprintf("%d/%d exact targets are visible inside the baseline cap", report.ExactTargetsWithinCap.Present, report.ExactTargetsWithinCap.Total))
	}
	if report.ExactTargetsSafetyEvaluable.Present != report.ExactTargetsSafetyEvaluable.Total {
		reasons = append(reasons, fmt.Sprintf("candidate safety is evaluable for %d/%d exact targets", report.ExactTargetsSafetyEvaluable.Present, report.ExactTargetsSafetyEvaluable.Total))
	}
	if report.CausalTargets.Present != report.CausalTargets.Total {
		reasons = append(reasons, fmt.Sprintf("causal ground truth appears for %d/%d targets", report.CausalTargets.Present, report.CausalTargets.Total))
	}
	if report.CausalTargetsWithinCap.Present != report.CausalTargetsWithinCap.Total {
		reasons = append(reasons, fmt.Sprintf("%d/%d causal targets are visible inside the baseline cap", report.CausalTargetsWithinCap.Present, report.CausalTargetsWithinCap.Total))
	}
	if report.CausalTargetsSafetyEvaluable.Present != report.CausalTargetsSafetyEvaluable.Total {
		reasons = append(reasons, fmt.Sprintf("candidate safety is evaluable for %d/%d causal targets", report.CausalTargetsSafetyEvaluable.Present, report.CausalTargetsSafetyEvaluable.Total))
	}
	if report.ScenariosSafetyEvaluable != report.ScenariosExpected {
		reasons = append(reasons, fmt.Sprintf("candidate safety is evaluable in %d/%d scenarios", report.ScenariosSafetyEvaluable, report.ScenariosExpected))
	}
	if report.RestartRows == 0 {
		reasons = append(reasons, "corpus has no restart-derived issue rows")
	} else if report.BasisAnnotatedRestartRows != report.RestartRows {
		reasons = append(reasons, fmt.Sprintf("candidate stability+basis covers %d/%d restart-derived rows", report.BasisAnnotatedRestartRows, report.RestartRows))
	}
	if report.ReclassificationEvidenceRows != report.RestartRows {
		reasons = append(reasons, fmt.Sprintf("auditable temporal evidence covers %d/%d restart-derived rows", report.ReclassificationEvidenceRows, report.RestartRows))
	}
	if report.InvalidStabilityRows != 0 {
		reasons = append(reasons, fmt.Sprintf("%d rows use an invalid stability value", report.InvalidStabilityRows))
	}
	if report.OutOfScopeDemotableRows != 0 {
		reasons = append(reasons, fmt.Sprintf("%d non-restart rows are classified self_healed", report.OutOfScopeDemotableRows))
	}
	if report.GroundTruthDemotableFP != 0 {
		reasons = append(reasons, fmt.Sprintf("%d ground-truth rows are classified demotable", report.GroundTruthDemotableFP))
	}
	if report.RealFaultDemoted != 0 {
		reasons = append(reasons, fmt.Sprintf("%d ground-truth rows lose rank", report.RealFaultDemoted))
	}
	if report.GroundTruthPairwiseLosses != 0 {
		reasons = append(reasons, fmt.Sprintf("%d ground-truth/decoy pairwise losses", report.GroundTruthPairwiseLosses))
	}
	if report.GroundTruthBelowDecoyAfter != 0 {
		reasons = append(reasons, fmt.Sprintf("%d ground-truth rows remain below a known decoy", report.GroundTruthBelowDecoyAfter))
	}
	if report.ActiveActiveInversions != 0 {
		reasons = append(reasons, fmt.Sprintf("%d active-active inversions", report.ActiveActiveInversions))
	}
	if report.TopKVisibilityLosses != 0 {
		reasons = append(reasons, fmt.Sprintf("%d ground-truth top-k visibility losses", report.TopKVisibilityLosses))
	}
	if report.CapMembershipChanges != 0 {
		reasons = append(reasons, fmt.Sprintf("%d issue membership changes at the cap", report.CapMembershipChanges))
	}
	if report.KnownDecoyScenariosPresent == 0 {
		reasons = append(reasons, "no known decoy is present, so intended effect is untested")
	} else if report.MinimumDecoyRate > 0 && report.KnownDecoyScenarioDemotionRate < report.MinimumDecoyRate {
		reasons = append(reasons, fmt.Sprintf("known-decoy scenario demotion rate %.3f is below the %.3f minimum (%d/%d)", report.KnownDecoyScenarioDemotionRate, report.MinimumDecoyRate, report.KnownDecoyScenariosDemoted, report.KnownDecoyScenariosPresent))
	}
	if report.KnownDecoyRows == 0 {
		reasons = append(reasons, "no known-decoy occurrence is visible inside the baseline cap")
	} else if report.MinimumDecoyRate > 0 && report.KnownDecoyRowClassificationRate < report.MinimumDecoyRate {
		reasons = append(reasons, fmt.Sprintf("known-decoy occurrence classification rate %.3f is below the %.3f minimum (%d/%d)", report.KnownDecoyRowClassificationRate, report.MinimumDecoyRate, report.KnownDecoyRowsClassified, report.KnownDecoyRows))
	}
	if report.KnownDecoyRowsWithOpportunity == 0 {
		reasons = append(reasons, "no known-decoy occurrence has a rank-demotion opportunity")
	} else if report.MinimumDecoyRate > 0 && report.KnownDecoyRowDemotionRate < report.MinimumDecoyRate {
		reasons = append(reasons, fmt.Sprintf("known-decoy eligible-occurrence demotion rate %.3f is below the %.3f minimum (%d/%d)", report.KnownDecoyRowDemotionRate, report.MinimumDecoyRate, report.KnownDecoyRowsDemoted, report.KnownDecoyRowsWithOpportunity))
	}
	return reasons
}
