package capacityapi

import (
	"time"

	"github.com/skyhook-io/radar/pkg/issuesapi"
	"github.com/skyhook-io/radar/pkg/subject"
)

type DemandState string

const (
	DemandWaitingForScheduler DemandState = "waiting_for_scheduler"
	DemandHeld                DemandState = "held"
	DemandAwaitingCapacity    DemandState = "awaiting_capacity"
	DemandBlocked             DemandState = "blocked"
	DemandUnknown             DemandState = "unknown"
)

type SchedulingConstraint struct {
	Predicate  string   `json:"predicate"`
	Key        string   `json:"key,omitempty"`
	Operator   string   `json:"operator,omitempty"`
	Values     []string `json:"values"`
	SourcePath string   `json:"sourcePath"`
}

type SchedulingSignature struct {
	Fingerprint     string                 `json:"fingerprint"`
	Constraints     []SchedulingConstraint `json:"constraints"`
	ConstraintsMeta BoundedResultMeta      `json:"constraintsMeta"`
	Tolerations     []Toleration           `json:"tolerations"`
	TolerationsMeta BoundedResultMeta      `json:"tolerationsMeta"`
}

type SchedulerReason struct {
	Code      string    `json:"code"`
	Source    string    `json:"source"`
	Message   string    `json:"message,omitempty"`
	Count     int       `json:"count"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
}

type PoolEvaluationResult string

const (
	PoolDeclaredCompatible PoolEvaluationResult = "declared_compatible"
	PoolIncompatible       PoolEvaluationResult = "incompatible"
	PoolEvaluationUnknown  PoolEvaluationResult = "unknown"
)

type EvaluationEvidence struct {
	Predicate      string     `json:"predicate"`
	SourcePath     string     `json:"sourcePath"`
	ObservedValues []string   `json:"observedValues"`
	ExpectedValues []string   `json:"expectedValues"`
	Confidence     Confidence `json:"confidence"`
	Explanation    string     `json:"explanation"`
}

type PoolEvaluation struct {
	Pool                  subject.Ref          `json:"pool"`
	Result                PoolEvaluationResult `json:"result"`
	Evidence              []EvaluationEvidence `json:"evidence"`
	EvidenceMeta          BoundedResultMeta    `json:"evidenceMeta"`
	UnknownPredicates     []string             `json:"unknownPredicates"`
	UnknownPredicatesMeta BoundedResultMeta    `json:"unknownPredicatesMeta"`
}

type PoolEvaluationCounts struct {
	DeclaredCompatible int `json:"declaredCompatible"`
	Incompatible       int `json:"incompatible"`
	Unknown            int `json:"unknown"`
}

func NewPoolEvaluation() PoolEvaluation {
	return PoolEvaluation{
		Result:            PoolEvaluationUnknown,
		Evidence:          []EvaluationEvidence{},
		UnknownPredicates: []string{},
	}
}

type DemandGroup struct {
	ID                   string               `json:"id"`
	Fingerprint          string               `json:"fingerprint"`
	Owner                *subject.Ref         `json:"owner,omitempty"`
	Pods                 []ResourceIdentity   `json:"pods"`
	PodsMeta             BoundedResultMeta    `json:"podsMeta"`
	Namespace            string               `json:"namespace"`
	FirstSeen            time.Time            `json:"firstSeen"`
	LastSeen             time.Time            `json:"lastSeen"`
	PodCount             int                  `json:"podCount"`
	PerPodRequests       QuantityObservation  `json:"perPodRequests"`
	AggregateRequests    QuantityObservation  `json:"aggregateRequests"`
	SchedulingSignature  SchedulingSignature  `json:"schedulingSignature"`
	State                DemandState          `json:"state"`
	SchedulerReasons     []SchedulerReason    `json:"schedulerReasons"`
	SchedulerReasonsMeta BoundedResultMeta    `json:"schedulerReasonsMeta"`
	PoolEvaluations      []PoolEvaluation     `json:"poolEvaluations"`
	PoolEvaluationsMeta  BoundedResultMeta    `json:"poolEvaluationsMeta"`
	PoolEvaluationCounts PoolEvaluationCounts `json:"poolEvaluationCounts"`
	Issues               []issuesapi.Issue    `json:"issues"`
}

func NewDemandGroup(asOf time.Time) DemandGroup {
	return DemandGroup{
		Pods:                []ResourceIdentity{},
		PerPodRequests:      NewQuantityObservation(asOf),
		AggregateRequests:   NewQuantityObservation(asOf),
		SchedulingSignature: SchedulingSignature{Constraints: []SchedulingConstraint{}, Tolerations: []Toleration{}},
		State:               DemandUnknown,
		SchedulerReasons:    []SchedulerReason{},
		PoolEvaluations:     []PoolEvaluation{},
		Issues:              []issuesapi.Issue{},
	}
}
