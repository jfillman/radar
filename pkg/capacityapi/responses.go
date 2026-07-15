package capacityapi

import "time"

type ActionSummary struct {
	Code            string             `json:"code"`
	Count           int                `json:"count"`
	HighestSeverity string             `json:"highestSeverity,omitempty"`
	Pools           []ResourceIdentity `json:"pools"`
	DemandGroupIDs  []string           `json:"demandGroupIds"`
	Truncated       bool               `json:"truncated"`
}

func NewActionSummary() ActionSummary {
	return ActionSummary{Pools: []ResourceIdentity{}, DemandGroupIDs: []string{}}
}

type OverviewSummary struct {
	Actions            []ActionSummary      `json:"actions"`
	AggregateDemand    *QuantityObservation `json:"aggregateDemand,omitempty"`
	PoolCount          int                  `json:"poolCount"`
	ClaimCount         *int                 `json:"claimCount,omitempty"`
	NodeCount          *int                 `json:"nodeCount,omitempty"`
	PendingPodCount    *int                 `json:"pendingPodCount,omitempty"`
	OrphanedClaimCount *int                 `json:"orphanedClaimCount,omitempty"`
	UnpooledNodeCount  *int                 `json:"unpooledNodeCount,omitempty"`
}

type OverviewResponse struct {
	ResponseMeta
	State          IntegrationState `json:"state"`
	Summary        OverviewSummary  `json:"summary"`
	Pools          []PoolSummary    `json:"pools"`
	PoolsTruncated bool             `json:"poolsTruncated"`
}

func NewOverviewResponse(generatedAt time.Time) OverviewResponse {
	return OverviewResponse{
		ResponseMeta: NewResponseMeta(generatedAt),
		State:        IntegrationSyncing,
		Summary:      OverviewSummary{Actions: []ActionSummary{}},
		Pools:        []PoolSummary{},
	}
}

type PoolDetailResponse struct {
	ResponseMeta
	State IntegrationState `json:"state"`
	Pool  *PoolObservation `json:"pool,omitempty"`
}

func NewPoolDetailResponse(generatedAt time.Time) PoolDetailResponse {
	return PoolDetailResponse{ResponseMeta: NewResponseMeta(generatedAt), State: IntegrationSyncing}
}

type PoolListResponse struct {
	ResponseMeta
	State IntegrationState `json:"state"`
	Items []PoolSummary    `json:"items"`
	Page  PageInfo         `json:"page"`
}

func NewPoolListResponse(generatedAt time.Time) PoolListResponse {
	return PoolListResponse{
		ResponseMeta: NewResponseMeta(generatedAt),
		State:        IntegrationSyncing,
		Items:        []PoolSummary{},
	}
}

type MemberListResponse struct {
	ResponseMeta
	State IntegrationState `json:"state"`
	Pool  ResourceIdentity `json:"pool"`
	Type  MemberType       `json:"type"`
	Items []PoolMember     `json:"items"`
	Page  PageInfo         `json:"page"`
}

func NewMemberListResponse(generatedAt time.Time) MemberListResponse {
	return MemberListResponse{
		ResponseMeta: NewResponseMeta(generatedAt),
		State:        IntegrationSyncing,
		Items:        []PoolMember{},
	}
}

type DemandResponse struct {
	ResponseMeta
	State   IntegrationState `json:"state"`
	Summary *DemandSummary   `json:"summary,omitempty"`
	Items   []DemandGroup    `json:"items"`
	Page    PageInfo         `json:"page"`
}

func NewDemandResponse(generatedAt time.Time) DemandResponse {
	return DemandResponse{
		ResponseMeta: NewResponseMeta(generatedAt),
		State:        IntegrationSyncing,
		Items:        []DemandGroup{},
	}
}

type ActivityResponse struct {
	ResponseMeta
	State        IntegrationState  `json:"state"`
	Items        []ActivityEpisode `json:"items"`
	Page         PageInfo          `json:"page"`
	CursorStatus CursorStatus      `json:"cursorStatus"`
	CursorGap    *ObservationGap   `json:"cursorGap,omitempty"`
	Observation  ObservationWindow `json:"observation"`
}

func NewActivityResponse(generatedAt time.Time) ActivityResponse {
	return ActivityResponse{
		ResponseMeta: NewResponseMeta(generatedAt),
		State:        IntegrationSyncing,
		Items:        []ActivityEpisode{},
		CursorStatus: CursorValid,
		Observation: ObservationWindow{
			EndedAt: generatedAt,
			Sources: []EvidenceSource{},
			Gaps:    []ObservationGap{},
		},
	}
}
