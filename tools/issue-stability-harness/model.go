package main

import "strings"

const corpusSchemaVersion = 1

type Corpus struct {
	SchemaVersion int                     `json:"schema_version"`
	Source        string                  `json:"source"`
	Run           *BenchmarkRunProvenance `json:"run,omitempty"`
	WireFields    []string                `json:"wire_fields"`
	Scenarios     []ScenarioFixture       `json:"scenarios"`
}

type BenchmarkRunProvenance struct {
	StatusFile           Provenance `json:"status_file"`
	SREGymRevision       string     `json:"sregym_revision"`
	ApplicationsRevision string     `json:"applications_revision"`
	RadarRevision        string     `json:"radar_revision"`
}

type ScenarioFixture struct {
	ID         int          `json:"id"`
	Name       string       `json:"name"`
	Provenance Provenance   `json:"provenance"`
	Stats      ExtractStats `json:"stats"`
	Snapshots  []Snapshot   `json:"snapshots"`
}

type Provenance struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}

type ExtractStats struct {
	Lines          int `json:"lines"`
	JSONLines      int `json:"json_lines"`
	MalformedJSON  int `json:"malformed_json_lines"`
	IssueToolCalls int `json:"issue_tool_calls"`
}

type Snapshot struct {
	Sequence   int            `json:"sequence"`
	CapturedAt string         `json:"captured_at,omitempty"`
	Line       int            `json:"line"`
	ToolCallID string         `json:"tool_call_id"`
	Issues     []IssueFixture `json:"issues"`
}

type IssueFixture struct {
	Severity             string        `json:"severity"`
	Source               string        `json:"source"`
	Category             string        `json:"category"`
	CategoryGroup        string        `json:"category_group,omitempty"`
	ID                   string        `json:"id"`
	GroupingScope        string        `json:"grouping_scope,omitempty"`
	Kind                 string        `json:"kind"`
	Group                string        `json:"group,omitempty"`
	Namespace            string        `json:"namespace,omitempty"`
	Name                 string        `json:"name"`
	Reason               string        `json:"reason"`
	FirstSeen            string        `json:"first_seen,omitempty"`
	LastSeen             string        `json:"last_seen,omitempty"`
	RestartCount         int32         `json:"restart_count,omitempty"`
	LastTerminatedReason string        `json:"last_terminated_reason,omitempty"`
	IssueTiming          string        `json:"issue_timing,omitempty"`
	IssueTimingBasis     string        `json:"issue_timing_basis,omitempty"`
	Stability            string        `json:"stability,omitempty"`
	StabilityBasis       string        `json:"stability_basis,omitempty"`
	StabilityConfidence  string        `json:"stability_confidence,omitempty"`
	CurrentReady         *bool         `json:"current_ready,omitempty"`
	HasReadinessProbe    *bool         `json:"has_readiness_probe,omitempty"`
	CurrentRunStartedAt  string        `json:"current_run_started_at,omitempty"`
	LastRestartAt        string        `json:"last_restart_at,omitempty"`
	ObservedRestartDelta *int32        `json:"observed_restart_delta,omitempty"`
	Members              []ResourceRef `json:"members,omitempty"`
}

type ResourceRef struct {
	Group     string `json:"group,omitempty"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
}

type GroundTruth struct {
	SchemaVersion     int                     `json:"schema_version"`
	Corpus            string                  `json:"corpus"`
	ExpectedRun       *BenchmarkRunProvenance `json:"expected_run,omitempty"`
	SupportingSources []Provenance            `json:"supporting_sources,omitempty"`
	Scenarios         []ScenarioGroundTruth   `json:"scenarios"`
	Excluded          []ExcludedScenario      `json:"excluded,omitempty"`
}

type ExcludedScenario struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type ScenarioGroundTruth struct {
	ID          int        `json:"id"`
	Name        string     `json:"name"`
	Injector    Provenance `json:"injector"`
	Exact       []Target   `json:"exact"`
	Causal      []Target   `json:"causal,omitempty"`
	KnownDecoys []Target   `json:"known_decoys,omitempty"`
}

type Target struct {
	ID          string       `json:"id"`
	Description string       `json:"description"`
	AnyOf       []RefMatcher `json:"any_of"`
}

type RefMatcher struct {
	Group      string `json:"group,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Namespace  string `json:"namespace,omitempty"`
	Name       string `json:"name,omitempty"`
	NamePrefix string `json:"name_prefix,omitempty"`
}

func (m RefMatcher) matches(ref ResourceRef) bool {
	if m.Kind == "" || (m.Name == "" && m.NamePrefix == "") || (m.Name != "" && m.NamePrefix != "") {
		return false
	}
	if m.Group != "" && !strings.EqualFold(m.Group, ref.Group) {
		return false
	}
	if m.Kind != "" && !strings.EqualFold(m.Kind, ref.Kind) {
		return false
	}
	if m.Namespace != "" && m.Namespace != ref.Namespace {
		return false
	}
	if m.Name != "" && m.Name != ref.Name {
		return false
	}
	return m.NamePrefix == "" || strings.HasPrefix(ref.Name, m.NamePrefix)
}

func (i IssueFixture) refs() []ResourceRef {
	refs := make([]ResourceRef, 0, len(i.Members)+1)
	refs = append(refs, ResourceRef{Group: i.Group, Kind: i.Kind, Namespace: i.Namespace, Name: i.Name})
	return append(refs, i.Members...)
}

func targetMatchesIssue(target Target, issue IssueFixture) bool {
	for _, matcher := range target.AnyOf {
		for _, ref := range issue.refs() {
			if matcher.matches(ref) {
				return true
			}
		}
	}
	return false
}

func restartDerived(issue IssueFixture) bool {
	return issue.RestartCount > 0 || issue.Category == "crashloop" || issue.Category == "high_restart"
}

func demotable(issue IssueFixture) bool {
	return issue.Stability == "self_healed"
}

func validStability(value string) bool {
	switch value {
	case "persistent", "recovering", "self_healed", "unknown":
		return true
	default:
		return false
	}
}
