package server

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	capacitymodel "github.com/skyhook-io/radar/internal/capacity"
	"github.com/skyhook-io/radar/pkg/capacityapi"
	"github.com/skyhook-io/radar/pkg/karpenter"
)

const capacityDemandPageLimit = 25

func (s *Server) handleCapacityDemand(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}
	filters, stateFilter, poolFilter, err := parseCapacityDemandFilters(r.URL.Query())
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	pageRequest, err := parseCapacityPage(r.URL.Query(), capacityPageOptions{
		Scope:        "demand",
		Filters:      filters,
		DefaultLimit: capacityDemandPageLimit,
		MaxLimit:     capacityDemandPageLimit,
	})
	if err != nil {
		s.writeCapacityPageError(w, err)
		return
	}
	result, ok := s.loadCapacityModel(w, r)
	if !ok {
		return
	}
	response := capacityapi.NewDemandResponse(result.meta.GeneratedAt)
	response.ResponseMeta = result.meta
	response.State = result.state
	if result.model == nil || result.snapshot == nil {
		s.writeJSON(w, response)
		return
	}
	if poolFilter != "" {
		if _, found := result.model.Pool(poolFilter); !found {
			s.writeError(w, http.StatusNotFound, "NodePool not found")
			return
		}
	}

	pools := capacityDemandPoolInputs(result, poolFilter)
	groups := capacitymodel.BuildDemandGroupModels(capacitymodel.DemandInput{
		GeneratedAt:     result.meta.GeneratedAt,
		Pods:            result.snapshot.Pods,
		ResolvePodOwner: result.snapshot.ResolvePodOwner,
	})
	capacitymodel.ClassifyDemandGroupModels(groups, pools)
	if stateFilter != "" {
		filtered := groups[:0]
		for _, group := range groups {
			if group.Group.State == stateFilter {
				filtered = append(filtered, group)
			}
		}
		groups = filtered
	}
	snapshotFingerprint := capacitymodel.DemandSnapshotFingerprint(groups, pools)
	page, err := paginateCapacityKeysetWithSnapshot(groups, pageRequest, func(group capacitymodel.DemandGroupModel) string {
		return group.Group.ID
	}, snapshotFingerprint)
	if err != nil {
		s.writeCapacityPageError(w, err)
		return
	}
	response.Items = capacitymodel.EvaluateDemandGroupModels(page.items, pools, 0)
	response.Page = capacityapi.PageInfo{HasMore: page.hasMore, NextCursor: page.nextCursor}
	s.writeJSON(w, response)
}

func parseCapacityDemandFilters(query url.Values) (url.Values, capacityapi.DemandState, string, error) {
	filters := url.Values{}
	pool := strings.TrimSpace(query.Get("pool"))
	if values := query["pool"]; len(values) > 1 {
		return nil, "", "", fmt.Errorf("pool must be specified at most once")
	} else if pool != "" {
		filters.Set("pool", pool)
	}
	state := capacityapi.DemandState(strings.TrimSpace(query.Get("state")))
	if values := query["state"]; len(values) > 1 {
		return nil, "", "", fmt.Errorf("state must be specified at most once")
	}
	if state != "" {
		valid := map[capacityapi.DemandState]bool{
			capacityapi.DemandWaitingForScheduler: true,
			capacityapi.DemandHeld:                true,
			capacityapi.DemandAwaitingCapacity:    true,
			capacityapi.DemandBlocked:             true,
			capacityapi.DemandUnknown:             true,
		}
		if !valid[state] {
			return nil, "", "", fmt.Errorf("invalid demand state %q", state)
		}
		filters.Set("state", string(state))
	}
	namespaces := parseNamespaces(query)
	if namespaces != nil {
		sort.Strings(namespaces)
		filters["namespaces"] = namespaces
	}
	return filters, state, pool, nil
}

func capacityDemandPoolInputs(result capacityLoadResult, poolFilter string) []capacitymodel.DemandPoolInput {
	pools := make([]capacitymodel.DemandPoolInput, 0, len(result.snapshot.NodePools))
	for _, pool := range result.snapshot.NodePools {
		if pool == nil || (poolFilter != "" && pool.GetName() != poolFilter) {
			continue
		}
		input := capacitymodel.DemandPoolInput{NodePool: pool, ProvisionedKnown: karpenter.NodePoolStatusResources(pool) != nil}
		if observed, found := result.model.Pool(pool.GetName()); found && observed.Observation.NodeClass != nil {
			input.NodeClassReady = observed.Observation.NodeClass.Ready
		}
		pools = append(pools, input)
	}
	return pools
}
