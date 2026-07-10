package opencost

import "sort"

// BuildApplicationCostResponse folds namespace workload-cost responses into a
// single app-scoped current-cost response.
func BuildApplicationCostResponse(inputs []ApplicationWorkloadCostInput, unsupported []ApplicationWorkloadRef, namespaceCosts map[string]*WorkloadCostResponse) *ApplicationCostResponse {
	out := &ApplicationCostResponse{
		Coverage: ApplicationCostCoverage{
			Total:       len(inputs) + len(unsupported),
			Unsupported: append([]ApplicationWorkloadRef(nil), unsupported...),
		},
	}

	for _, input := range inputs {
		row := focusApplicationWorkloadCost(input, namespaceCosts[input.Namespace])
		out.Workloads = append(out.Workloads, row)
		if row.Available && row.Current != nil {
			out.Coverage.Included++
			addApplicationCostTotal(&out.Totals, *row.Current)
			continue
		}
		out.Coverage.Unavailable = append(out.Coverage.Unavailable, ApplicationWorkloadStatus{
			ApplicationWorkloadRef: input.ApplicationWorkloadRef,
			Reason:                 row.Reason,
			ScaledToZero:           row.ScaledToZero,
		})
	}

	finalizeApplicationCostTotals(&out.Totals)
	sort.Slice(out.Workloads, func(i, j int) bool {
		left, right := out.Workloads[i], out.Workloads[j]
		leftCost, rightCost := 0.0, 0.0
		if left.Current != nil {
			leftCost = left.Current.HourlyCost
		}
		if right.Current != nil {
			rightCost = right.Current.HourlyCost
		}
		if leftCost != rightCost {
			return leftCost > rightCost
		}
		return applicationRefSortKey(left.ApplicationWorkloadRef) < applicationRefSortKey(right.ApplicationWorkloadRef)
	})
	sortApplicationRefs(out.Coverage.Unsupported)
	sortApplicationStatuses(out.Coverage.Unavailable)

	out.Available = out.Coverage.Included > 0
	out.Partial = len(out.Coverage.Unsupported) > 0 || len(out.Coverage.Unavailable) > 0
	if !out.Available {
		out.Reason = applicationUnavailableReason(out.Coverage.Unavailable)
	}
	return out
}

// UnavailableApplicationCostResponse returns a shaped app response for
// cluster-wide failures that happen before per-namespace cost can be queried.
func UnavailableApplicationCostResponse(inputs []ApplicationWorkloadCostInput, unsupported []ApplicationWorkloadRef, reason string) *ApplicationCostResponse {
	statuses := make([]ApplicationWorkloadStatus, 0, len(inputs))
	for _, input := range inputs {
		statuses = append(statuses, ApplicationWorkloadStatus{
			ApplicationWorkloadRef: input.ApplicationWorkloadRef,
			Reason:                 reason,
		})
	}
	sortApplicationStatuses(statuses)
	unsupportedCopy := append([]ApplicationWorkloadRef(nil), unsupported...)
	sortApplicationRefs(unsupportedCopy)
	return &ApplicationCostResponse{
		Available: false,
		Reason:    reason,
		Partial:   len(unsupportedCopy) > 0,
		Coverage: ApplicationCostCoverage{
			Total:       len(inputs) + len(unsupportedCopy),
			Unavailable: statuses,
			Unsupported: unsupportedCopy,
		},
	}
}

func focusApplicationWorkloadCost(input ApplicationWorkloadCostInput, resp *WorkloadCostResponse) ApplicationWorkloadCost {
	row := ApplicationWorkloadCost{ApplicationWorkloadRef: input.ApplicationWorkloadRef}
	if resp == nil {
		row.Reason = ReasonQueryError
		return row
	}
	if resp.Available {
		for i := range resp.Workloads {
			wl := resp.Workloads[i]
			if wl.Kind == input.Kind && wl.Name == input.Name {
				row.Available = true
				row.Current = &wl
				return row
			}
		}
		if input.DesiredReplicas == 0 {
			row.Available = true
			row.ScaledToZero = true
			row.Current = zeroApplicationWorkloadCost(input.Kind, input.Name)
			return row
		}
		row.Reason = ReasonNoMetrics
		return row
	}
	if resp.Reason == ReasonNoMetrics && input.DesiredReplicas == 0 {
		row.Available = true
		row.ScaledToZero = true
		row.Current = zeroApplicationWorkloadCost(input.Kind, input.Name)
		return row
	}
	row.Reason = resp.Reason
	if row.Reason == "" {
		row.Reason = ReasonQueryError
	}
	return row
}

func zeroApplicationWorkloadCost(kind, name string) *WorkloadCost {
	return &WorkloadCost{
		Name:       name,
		Kind:       kind,
		HourlyCost: 0,
		CPUCost:    0,
		MemoryCost: 0,
		Replicas:   0,
		Efficiency: 0,
		IdleCost:   0,
	}
}

func addApplicationCostTotal(total *ApplicationCostTotals, wl WorkloadCost) {
	total.HourlyCost += wl.HourlyCost
	total.CPUCost += wl.CPUCost
	total.MemoryCost += wl.MemoryCost
	total.Replicas += wl.Replicas
	total.CPUUsageCost += wl.CPUUsageCost
	total.MemoryUsageCost += wl.MemoryUsageCost
}

func finalizeApplicationCostTotals(total *ApplicationCostTotals) {
	allocCost := total.CPUCost + total.MemoryCost
	usageCost := total.CPUUsageCost + total.MemoryUsageCost
	total.HourlyCost = roundTo(total.HourlyCost, 4)
	total.CPUCost = roundTo(total.CPUCost, 4)
	total.MemoryCost = roundTo(total.MemoryCost, 4)
	total.CPUUsageCost = roundTo(total.CPUUsageCost, 4)
	total.MemoryUsageCost = roundTo(total.MemoryUsageCost, 4)
	total.Efficiency = efficiencyPct(usageCost, allocCost)
	total.IdleCost = roundTo(idleFromUsage(usageCost, allocCost), 4)
}

func applicationUnavailableReason(statuses []ApplicationWorkloadStatus) string {
	for _, status := range statuses {
		if status.Reason == ReasonQueryError || status.Reason == ReasonNoPrometheus {
			return status.Reason
		}
	}
	if len(statuses) > 0 {
		return statuses[0].Reason
	}
	return ReasonNoMetrics
}

func sortApplicationRefs(refs []ApplicationWorkloadRef) {
	sort.Slice(refs, func(i, j int) bool {
		return applicationRefSortKey(refs[i]) < applicationRefSortKey(refs[j])
	})
}

func sortApplicationStatuses(statuses []ApplicationWorkloadStatus) {
	sort.Slice(statuses, func(i, j int) bool {
		return applicationRefSortKey(statuses[i].ApplicationWorkloadRef) < applicationRefSortKey(statuses[j].ApplicationWorkloadRef)
	})
}

func applicationRefSortKey(ref ApplicationWorkloadRef) string {
	return ref.Namespace + "/" + ref.Kind + "/" + ref.Name
}
