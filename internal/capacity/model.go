package capacity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/skyhook-io/radar/pkg/capacityapi"
	"github.com/skyhook-io/radar/pkg/karpenter"
	"github.com/skyhook-io/radar/pkg/subject"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const (
	instanceTypeLabel             = "node.kubernetes.io/instance-type"
	zoneLabel                     = "topology.kubernetes.io/zone"
	architectureLabel             = "kubernetes.io/arch"
	defaultTopWorkloads           = 10
	defaultPendingEligibleGroups  = 50
	defaultWorkloadNodeLimit      = 50
	defaultCompositionBucketLimit = 20
)

type NodeUsageSample struct {
	Resources  corev1.ResourceList
	ObservedAt time.Time
}

type Snapshot struct {
	GeneratedAt              time.Time
	NodePools                []*unstructured.Unstructured
	NodeClaims               []*unstructured.Unstructured
	NodeClasses              map[string]*unstructured.Unstructured
	UnavailableNodeClassRefs map[string]bool
	Nodes                    []*corev1.Node
	Pods                     []*corev1.Pod
	NodeUsage                map[string]NodeUsageSample
	Coverage                 capacityapi.CoverageBySource
	ResolvePodOwner          func(*corev1.Pod) *subject.Ref
}

type PoolModel struct {
	Observation capacityapi.PoolObservation
	Nodes       []capacityapi.PoolMember
	Claims      []capacityapi.PoolMember
	Workloads   []capacityapi.PoolMember
}

type Model struct {
	GeneratedAt        time.Time
	Pools              []PoolModel
	PendingPodCount    int
	OrphanedClaimCount int
	UnpooledNodeCount  int
}

func NodeClassLookupKey(group, kind, name string) string {
	return group + "\x00" + kind + "\x00" + name
}

func Build(snapshot Snapshot) Model {
	if snapshot.GeneratedAt.IsZero() {
		snapshot.GeneratedAt = time.Now().UTC()
	}
	model := Model{GeneratedAt: snapshot.GeneratedAt, Pools: []PoolModel{}}

	poolsByName := make(map[string]*unstructured.Unstructured, len(snapshot.NodePools))
	modelsByName := make(map[string]*PoolModel, len(snapshot.NodePools))
	for _, pool := range snapshot.NodePools {
		if pool == nil || pool.GetName() == "" {
			continue
		}
		poolsByName[pool.GetName()] = pool
		poolModel := PoolModel{
			Observation: basePoolObservation(pool, snapshot),
			Nodes:       []capacityapi.PoolMember{},
			Claims:      []capacityapi.PoolMember{},
			Workloads:   []capacityapi.PoolMember{},
		}
		model.Pools = append(model.Pools, poolModel)
		modelsByName[pool.GetName()] = &model.Pools[len(model.Pools)-1]
	}

	claimsByPool := map[string][]*unstructured.Unstructured{}
	poolForNodeName := map[string]string{}
	poolForProviderID := map[string]string{}
	claimForNodeName := map[string]*unstructured.Unstructured{}
	claimForProviderID := map[string]*unstructured.Unstructured{}
	rejectedNodeNames := map[string]bool{}
	rejectedProviderIDs := map[string]bool{}
	for _, claim := range snapshot.NodeClaims {
		pool, _ := karpenter.ResolveNodePoolForClaim(claim, poolsByName)
		if pool == nil {
			if claim != nil {
				model.OrphanedClaimCount++
				if nodeName := karpenter.ClaimNodeName(claim); nodeName != "" {
					rejectedNodeNames[nodeName] = true
				}
				if providerID := karpenter.ClaimProviderID(claim); providerID != "" {
					rejectedProviderIDs[providerID] = true
				}
			}
			continue
		}
		poolName := pool.GetName()
		claimsByPool[poolName] = append(claimsByPool[poolName], claim)
		if nodeName := karpenter.ClaimNodeName(claim); nodeName != "" {
			poolForNodeName[nodeName] = poolName
			claimForNodeName[nodeName] = claim
		}
		if providerID := karpenter.ClaimProviderID(claim); providerID != "" {
			poolForProviderID[providerID] = poolName
			claimForProviderID[providerID] = claim
		}
	}

	nodesByPool := map[string][]*corev1.Node{}
	poolForNode := make(map[string]string, len(poolForNodeName))
	for nodeName, poolName := range poolForNodeName {
		poolForNode[nodeName] = poolName
	}
	nodeForClaim := map[*unstructured.Unstructured]*corev1.Node{}
	for _, node := range snapshot.Nodes {
		if node == nil || node.Name == "" {
			continue
		}
		poolName := poolForNodeName[node.Name]
		claim := claimForNodeName[node.Name]
		if poolName == "" && node.Spec.ProviderID != "" {
			poolName = poolForProviderID[node.Spec.ProviderID]
			claim = claimForProviderID[node.Spec.ProviderID]
		}
		rejectedClaimLink := rejectedNodeNames[node.Name] || (node.Spec.ProviderID != "" && rejectedProviderIDs[node.Spec.ProviderID])
		if poolName == "" && !rejectedClaimLink {
			poolName = node.Labels[karpenter.NodePoolLabelKey]
		}
		if modelsByName[poolName] == nil {
			model.UnpooledNodeCount++
			continue
		}
		nodesByPool[poolName] = append(nodesByPool[poolName], node)
		poolForNode[node.Name] = poolName
		if claim != nil {
			nodeForClaim[claim] = node
		}
	}

	podsByPool := map[string][]*corev1.Pod{}
	for _, pod := range snapshot.Pods {
		if pod == nil || isTerminal(pod) {
			continue
		}
		if pod.Spec.NodeName == "" {
			if pod.DeletionTimestamp == nil && !isDaemonSetPod(pod) {
				model.PendingPodCount++
			}
			continue
		}
		if poolName := poolForNode[pod.Spec.NodeName]; poolName != "" {
			podsByPool[poolName] = append(podsByPool[poolName], pod)
		}
	}

	for i := range model.Pools {
		poolName := model.Pools[i].Observation.Resource.Ref.Name
		populatePool(&model.Pools[i], claimsByPool[poolName], nodesByPool[poolName], podsByPool[poolName], nodeForClaim, snapshot)
	}
	sort.Slice(model.Pools, func(i, j int) bool {
		return poolModelLess(model.Pools[i], model.Pools[j])
	})
	return model
}

func AttachPendingEligibilityForPool(model *Model, snapshot Snapshot, poolName string) {
	if model == nil || poolName == "" {
		return
	}
	poolModel, found := model.Pool(poolName)
	if !found || poolModel.Observation.Workloads == nil {
		return
	}
	var nodePool *unstructured.Unstructured
	for _, pool := range snapshot.NodePools {
		if pool != nil && pool.GetName() == poolName {
			nodePool = pool
			break
		}
	}
	if nodePool == nil {
		return
	}

	input := DemandPoolInput{NodePool: nodePool, ProvisionedKnown: karpenter.NodePoolStatusResources(nodePool) != nil}
	if poolModel.Observation.NodeClass != nil {
		input.NodeClassReady = poolModel.Observation.NodeClass.Ready
	}
	asOf := snapshot.GeneratedAt
	if asOf.IsZero() {
		asOf = model.GeneratedAt
	}
	groups := BuildDemandGroupModels(DemandInput{
		GeneratedAt:     asOf,
		Pods:            snapshot.Pods,
		ResolvePodOwner: snapshot.ResolvePodOwner,
	})
	workloads := poolModel.Observation.Workloads
	workloads.PendingEligibleGroupIDs = []string{}
	workloads.PendingEligibleGroupsMeta = capacityapi.BoundedResultMeta{}
	for _, group := range groups {
		if evaluateDemandPool(group.scheduling, group.requests, input).Result != capacityapi.PoolDeclaredCompatible {
			continue
		}
		workloads.PendingEligibleGroupsMeta.Total++
		if len(workloads.PendingEligibleGroupIDs) < defaultPendingEligibleGroups {
			workloads.PendingEligibleGroupIDs = append(workloads.PendingEligibleGroupIDs, group.Group.ID)
		} else {
			workloads.PendingEligibleGroupsMeta.Truncated = true
		}
	}
	workloads.PendingEligibleGroupsMeta.Returned = len(workloads.PendingEligibleGroupIDs)
}

func (m Model) Pool(name string) (*PoolModel, bool) {
	for i := range m.Pools {
		if m.Pools[i].Observation.Resource.Ref.Name == name {
			return &m.Pools[i], true
		}
	}
	return nil, false
}

func (m Model) Summaries() []capacityapi.PoolSummary {
	result := make([]capacityapi.PoolSummary, 0, len(m.Pools))
	for _, pool := range m.Pools {
		summary := capacityapi.NewPoolSummary()
		summary.Resource = pool.Observation.Resource
		summary.Mode = pool.Observation.Mode
		summary.Ready = pool.Observation.Ready
		if pool.Observation.NodeClass != nil {
			ref := pool.Observation.NodeClass.Reference
			summary.NodeClass = &ref
		}
		summary.Ledger = pool.Observation.Ledger
		summary.Claims = pool.Observation.Claims
		summary.Nodes = pool.Observation.Nodes
		summary.IssueCount = len(pool.Observation.Issues)
		summary.FactCount = len(pool.Observation.Facts)
		result = append(result, summary)
	}
	return result
}

func basePoolObservation(pool *unstructured.Unstructured, snapshot Snapshot) capacityapi.PoolObservation {
	observation := capacityapi.NewPoolObservation()
	observation.Resource = identityForUnstructured(pool)
	observation.Generation = pool.GetGeneration()
	observation.SpecFingerprint = specFingerprint(pool)
	createdTimestamp := pool.GetCreationTimestamp()
	if !createdTimestamp.IsZero() {
		created := createdTimestamp.Time
		observation.CreatedAt = &created
	}
	conditions := karpenter.NodePoolConditions(pool)
	observation.Conditions = normalizeConditions(conditions)
	if ready := karpenter.NodePoolReadyCondition(pool); ready != nil && ready.ObservedGeneration > 0 {
		observed := ready.ObservedGeneration
		observation.ObservedGeneration = &observed
	}
	switch karpenter.NodePoolReadiness(pool) {
	case karpenter.ReadinessReady:
		observation.Ready = boolPointer(true)
	case karpenter.ReadinessNotReady:
		observation.Ready = boolPointer(false)
		detail := "The NodePool Ready condition is false."
		if ready := karpenter.NodePoolReadyCondition(pool); ready != nil && ready.Message != "" {
			detail = ready.Message
		}
		observation.Facts = append(observation.Facts, capacityapi.PostureFact{
			Code: "nodepool_not_ready", Summary: "NodePool is not ready", Detail: detail,
			SourcePaths: []string{"status.conditions[type=Ready]"},
		})
	}

	normalized := karpenter.NormalizeNodePoolSpec(pool)
	if normalized.Replicas != nil {
		observation.Mode = capacityapi.PoolModeStatic
	} else {
		observation.Mode = capacityapi.PoolModeDynamic
	}
	observation.Configuration = poolConfiguration(normalized)
	observation.Disruption = disruptionPolicy(normalized)
	observation.Coverage = copyCoverage(snapshot.Coverage)

	if len(normalized.Limits) > 0 {
		configured := QuantityObservation(normalized.Limits, capacityapi.CertaintyExact, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "nodepool.spec.limits")
		observation.Ledger.ConfiguredLimit = &configured
	}
	provisionedResources := karpenter.NodePoolStatusResources(pool)
	if provisionedResources != nil {
		provisioned := QuantityObservation(provisionedResources, capacityapi.CertaintyExact, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "nodepool.status.resources")
		observation.Ledger.Provisioned = &provisioned
		observation.Ledger.LimitPressure = limitPressure(provisionedResources, normalized.Limits)
	}
	if len(normalized.Limits) > 0 && provisionedResources != nil {
		headroom := QuantityObservation(subtractLeftResourceLists(normalized.Limits, provisionedResources), capacityapi.CertaintyExact, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "nodepool.spec.limits", "nodepool.status.resources")
		observation.Ledger.LimitHeadroom = &headroom
	}
	for _, pressure := range observation.Ledger.LimitPressure {
		if pressure.Percent != nil && *pressure.Percent >= 80 {
			observation.Facts = append(observation.Facts, capacityapi.PostureFact{
				Code:        "configured_limit_pressure",
				Summary:     pressure.Resource + " provisioned capacity is near its configured limit",
				SourcePaths: []string{"spec.limits." + pressure.Resource, "status.resources." + pressure.Resource},
			})
		}
	}

	if normalized.NodeClassRef != nil {
		ref := capacityapi.NodeClassReference{
			Group:      normalized.NodeClassRef.Group,
			Kind:       normalized.NodeClassRef.Kind,
			Name:       normalized.NodeClassRef.Name,
			APIVersion: normalized.NodeClassRef.APIVersion,
		}
		nodeClass := capacityapi.NewNodeClassObservation(ref)
		if resource := snapshot.NodeClasses[NodeClassLookupKey(ref.Group, ref.Kind, ref.Name)]; resource != nil {
			identity := identityForUnstructured(resource)
			nodeClass.Resource = &identity
			nodeClass.Reference.APIVersion = resource.GetAPIVersion()
			nodeClass.Conditions = normalizeConditions(karpenter.Conditions(resource))
			switch karpenter.ResourceReadiness(resource) {
			case karpenter.ReadinessReady:
				nodeClass.Ready = boolPointer(true)
			case karpenter.ReadinessNotReady:
				nodeClass.Ready = boolPointer(false)
				detail := "The NodeClass Ready condition is false."
				for _, condition := range karpenter.Conditions(resource) {
					if condition.Type == "Ready" && condition.Message != "" {
						detail = condition.Message
						break
					}
				}
				observation.Facts = append(observation.Facts, capacityapi.PostureFact{
					Code: "nodeclass_not_ready", Summary: ref.Kind + " is not ready", Detail: detail,
					SourcePaths: []string{"nodeClass.status.conditions[type=Ready]"},
				})
			}
		} else if snapshot.UnavailableNodeClassRefs[NodeClassLookupKey(ref.Group, ref.Kind, ref.Name)] {
			observation.Facts = append(observation.Facts, capacityapi.PostureFact{
				Code: "nodeclass_kind_not_installed", Summary: ref.Kind + " API is not installed",
				Detail: ref.Group, SourcePaths: []string{"spec.template.spec.nodeClassRef"},
			})
		} else if coverage := snapshot.Coverage[capacityapi.CoverageNodeClasses]; coverage.Status == capacityapi.CoverageAvailable {
			observation.Facts = append(observation.Facts, capacityapi.PostureFact{
				Code: "nodeclass_not_found", Summary: ref.Kind + " reference was not found",
				Detail: ref.Name, SourcePaths: []string{"spec.template.spec.nodeClassRef"},
			})
		}
		observation.NodeClass = &nodeClass
	}
	return observation
}

func populatePool(model *PoolModel, claims []*unstructured.Unstructured, nodes []*corev1.Node, pods []*corev1.Pod, nodeForClaim map[*unstructured.Unstructured]*corev1.Node, snapshot Snapshot) {
	observation := &model.Observation
	nodeCertainty := sourceCertainty(snapshot.Coverage, capacityapi.CoverageNodes)
	podCertainty := sourceCertainty(snapshot.Coverage, capacityapi.CoveragePods)
	claimCertainty := sourceCertainty(snapshot.Coverage, capacityapi.CoverageNodeClaims)
	scheduledCertainty := scheduledRequestCertainty(snapshot.Coverage)

	accounting := AccountResources(nodes, pods)
	allocatable := QuantityObservation(accounting.Allocatable, nodeCertainty, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "nodes.status.allocatable")
	requests := QuantityObservation(accounting.ScheduledRequests, scheduledCertainty, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "pods.spec.resources")
	observation.Ledger.Allocatable = &allocatable
	observation.Ledger.ScheduledRequests = &requests
	unallocatedCertainty := differenceCertainty(nodeCertainty, podCertainty)
	unallocated := QuantityObservation(subtractResourceLists(accounting.Allocatable, accounting.ScheduledRequests), unallocatedCertainty, capacityapi.GranularityAggregateNotBinpacked, snapshot.GeneratedAt, "nodes.status.allocatable", "pods.spec.resources")
	observation.Ledger.AggregateUnallocatedRequests = &unallocated

	if sourceObserved(snapshot.Coverage, capacityapi.CoverageNodeClaims) {
		observation.Claims = &capacityapi.ClaimLifecycleSummary{Total: len(claims)}
	}
	inFlightResources := corev1.ResourceList{}
	inFlightCount := 0
	inFlightCapacityCount := 0
	for _, claim := range claims {
		if claim == nil {
			continue
		}
		stage := claimStage(claim)
		if observation.Claims != nil {
			incrementClaimStage(observation.Claims, stage)
		}
		if stage != capacityapi.ClaimStageReady && stage != capacityapi.ClaimStageFailed && stage != capacityapi.ClaimStageTerminating && karpenter.ClaimNodeName(claim) == "" && nodeForClaim[claim] == nil {
			inFlightCount++
			if capacityResources := karpenter.NodeClaimCapacity(claim); capacityResources != nil {
				inFlightCapacityCount++
				addResources(inFlightResources, capacityResources)
			}
		}
		member := capacityapi.NewClaimMember()
		member.Stage = stage
		member.Conditions = normalizeConditions(karpenter.NodeClaimConditions(claim))
		member.NodeName = karpenter.ClaimNodeName(claim)
		capacityResources := karpenter.NodeClaimCapacity(claim)
		if capacityResources != nil {
			capacityObservation := QuantityObservation(capacityResources, claimCertainty, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "nodeclaims.status.capacity")
			member.Capacity = &capacityObservation
		}
		if node := nodeForClaim[claim]; node != nil {
			identity := identityForNode(node)
			member.Node = &identity
		}
		model.Claims = append(model.Claims, capacityapi.PoolMember{Type: capacityapi.MemberClaim, Resource: identityForUnstructured(claim), Claim: &member})
	}
	if inFlightCount > 0 {
		certainty := claimCertainty
		if inFlightCapacityCount == 0 {
			certainty = capacityapi.CertaintyUnknown
		} else if inFlightCapacityCount < inFlightCount && certainty == capacityapi.CertaintyExact {
			certainty = capacityapi.CertaintyLowerBound
		}
		inFlight := QuantityObservation(inFlightResources, certainty, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "nodeclaims.status.capacity")
		observation.Ledger.InFlightCapacity = &inFlight
	}

	if sourceObserved(snapshot.Coverage, capacityapi.CoverageNodes) {
		observation.Nodes = &capacityapi.NodeLifecycleSummary{Total: len(nodes)}
		composition := capacityapi.NewPoolComposition()
		observation.Composition = &composition
	}
	podsByNode := map[string][]*corev1.Pod{}
	for _, pod := range pods {
		if pod != nil && pod.Spec.NodeName != "" {
			podsByNode[pod.Spec.NodeName] = append(podsByNode[pod.Spec.NodeName], pod)
		}
	}
	usageResources := corev1.ResourceList{}
	coveredAllocatable := corev1.ResourceList{}
	coveredNodes := 0
	var actualAsOf time.Time
	for _, node := range nodes {
		if node == nil {
			continue
		}
		ready := nodeReady(node)
		if observation.Nodes != nil {
			if ready == nil {
				observation.Nodes.NotReady++
			} else if *ready {
				observation.Nodes.Ready++
			} else {
				observation.Nodes.NotReady++
			}
			if node.Spec.Unschedulable {
				observation.Nodes.Cordoned++
			}
			if node.DeletionTimestamp != nil {
				observation.Nodes.Terminating++
			}
		}

		member := capacityapi.NewNodeMember()
		member.Ready = ready
		member.Cordoned = node.Spec.Unschedulable
		member.Conditions = normalizeNodeConditions(node.Status.Conditions)
		member.InstanceType = node.Labels[instanceTypeLabel]
		member.CapacityType = node.Labels[karpenter.CapacityTypeLabelKey]
		member.Zone = node.Labels[zoneLabel]
		member.Architecture = node.Labels[architectureLabel]
		member.Image = node.Status.NodeInfo.OSImage
		if sourceObserved(snapshot.Coverage, capacityapi.CoveragePods) {
			podCount := len(podsByNode[node.Name])
			member.PodCount = &podCount
		}
		nodeAllocatable := QuantityObservation(node.Status.Allocatable, nodeCertainty, capacityapi.GranularityPerNode, snapshot.GeneratedAt, "node.status.allocatable")
		member.Allocatable = &nodeAllocatable
		nodeRequests := AccountResources(nil, podsByNode[node.Name]).ScheduledRequests
		nodeRequestObservation := QuantityObservation(nodeRequests, podCertainty, capacityapi.GranularityPerNode, snapshot.GeneratedAt, "pods.spec.resources")
		member.ScheduledRequests = &nodeRequestObservation
		if sample, ok := snapshot.NodeUsage[node.Name]; ok {
			coveredNodes++
			addResources(usageResources, sample.Resources)
			addResources(coveredAllocatable, node.Status.Allocatable)
			if actualAsOf.IsZero() || sample.ObservedAt.Before(actualAsOf) {
				actualAsOf = sample.ObservedAt
			}
			usage := capacityapi.NewUsageObservation(sample.ObservedAt)
			usage.CoveredNodes = 1
			usage.TotalNodes = 1
			usage.Quantity = QuantityObservation(sample.Resources, capacityapi.CertaintyExact, capacityapi.GranularityPerNode, sample.ObservedAt, "metrics.k8s.io/nodes")
			usage.CoveredAllocatable = QuantityObservation(node.Status.Allocatable, nodeCertainty, capacityapi.GranularityPerNode, sample.ObservedAt, "node.status.allocatable")
			usage.Utilization = utilization(sample.Resources, node.Status.Allocatable)
			member.ActualUsage = &usage
		}
		model.Nodes = append(model.Nodes, capacityapi.PoolMember{Type: capacityapi.MemberNode, Resource: identityForNode(node), Node: &member})
		if observation.Composition != nil {
			addComposition(observation.Composition, node)
		}
	}
	if coveredNodes > 0 {
		usage := capacityapi.NewUsageObservation(actualAsOf)
		usage.CoveredNodes = coveredNodes
		usage.TotalNodes = len(nodes)
		usage.Quantity = QuantityObservation(usageResources, capacityapi.CertaintyExact, capacityapi.GranularityAggregate, actualAsOf, "metrics.k8s.io/nodes")
		usage.CoveredAllocatable = QuantityObservation(coveredAllocatable, nodeCertainty, capacityapi.GranularityAggregate, actualAsOf, "node.status.allocatable")
		usage.Utilization = utilization(usageResources, coveredAllocatable)
		observation.Ledger.ActualUsage = &usage
	}

	model.Workloads = buildWorkloadMembers(pods, snapshot)
	if sourceObserved(snapshot.Coverage, capacityapi.CoverageWorkloads) {
		workloads := capacityapi.NewWorkloadSummary()
		observation.Workloads = &workloads
	}
	if observation.Workloads != nil {
		observation.Workloads.ScheduledPodCount = len(pods)
		observation.Workloads.WorkloadCount = len(model.Workloads)
		observation.Workloads.TopScheduledMeta.Total = len(model.Workloads)
	}
	limit := len(model.Workloads)
	if limit > defaultTopWorkloads {
		limit = defaultTopWorkloads
		if observation.Workloads != nil {
			observation.Workloads.TopScheduledMeta.Truncated = true
		}
	}
	if observation.Workloads != nil {
		observation.Workloads.TopScheduledMeta.Returned = limit
		for _, item := range model.Workloads[:limit] {
			observation.Workloads.TopScheduled = append(observation.Workloads.TopScheduled, capacityapi.WorkloadAttribution{
				Owner:    item.Workload.Owner,
				PodCount: item.Workload.PodCount,
				Requests: item.Workload.Requests,
			})
		}
	}

	sortMembers(model.Nodes)
	sortMembers(model.Claims)
	sortMembers(model.Workloads)
	if observation.Composition != nil {
		sortComposition(observation.Composition)
	}
}

func poolConfiguration(spec karpenter.NodePoolSpec) capacityapi.PoolConfiguration {
	configuration := capacityapi.NewPoolConfiguration()
	configuration.Weight = spec.Weight
	configuration.Replicas = spec.Replicas
	for key, value := range spec.TemplateLabels {
		configuration.Labels[key] = value
	}
	for _, requirement := range spec.Requirements {
		configuration.Requirements = append(configuration.Requirements, capacityapi.Requirement{
			Key: requirement.Key, Operator: string(requirement.Operator), Values: append([]string{}, requirement.Values...), MinValues: requirement.MinValues,
		})
	}
	for _, taint := range spec.Taints {
		configuration.Taints = append(configuration.Taints, capacityapi.Taint{Key: taint.Key, Value: taint.Value, Effect: string(taint.Effect)})
	}
	for _, taint := range spec.StartupTaints {
		configuration.StartupTaints = append(configuration.StartupTaints, capacityapi.Taint{Key: taint.Key, Value: taint.Value, Effect: string(taint.Effect)})
	}
	configuration.ExpireAfter = spec.ExpireAfter
	configuration.TerminationGracePeriod = spec.TerminationGracePeriod
	return configuration
}

func disruptionPolicy(spec karpenter.NodePoolSpec) capacityapi.DisruptionPolicy {
	policy := capacityapi.NewDisruptionPolicy()
	policy.ConsolidationPolicy = spec.Disruption.ConsolidationPolicy
	policy.ConsolidateAfter = spec.Disruption.ConsolidateAfter
	for _, budget := range spec.Disruption.Budgets {
		policy.Budgets = append(policy.Budgets, capacityapi.DisruptionBudget{
			Nodes: budget.Nodes, Reasons: append([]string{}, budget.Reasons...), Schedule: budget.Schedule, Duration: budget.Duration,
		})
	}
	return policy
}

func buildWorkloadMembers(pods []*corev1.Pod, snapshot Snapshot) []capacityapi.PoolMember {
	type aggregate struct {
		owner    subject.Ref
		pods     int
		requests corev1.ResourceList
		nodes    map[string]capacityapi.ResourceIdentity
	}
	groups := map[string]*aggregate{}
	for _, pod := range pods {
		if pod == nil {
			continue
		}
		owner := defaultPodOwner(pod)
		if snapshot.ResolvePodOwner != nil {
			if resolved := snapshot.ResolvePodOwner(pod); resolved != nil {
				owner = *resolved
			}
		}
		key := owner.Group + "\x00" + owner.Kind + "\x00" + owner.Namespace + "\x00" + owner.Name
		group := groups[key]
		if group == nil {
			group = &aggregate{owner: owner, requests: corev1.ResourceList{}, nodes: map[string]capacityapi.ResourceIdentity{}}
			groups[key] = group
		}
		group.pods++
		addResources(group.requests, EffectivePodRequests(pod))
		if pod.Spec.NodeName != "" {
			group.nodes[pod.Spec.NodeName] = capacityapi.ResourceIdentity{Ref: subject.Ref{Kind: "Node", Name: pod.Spec.NodeName}, APIVersion: "v1"}
		}
	}

	result := make([]capacityapi.PoolMember, 0, len(groups))
	certainty := scheduledRequestCertainty(snapshot.Coverage)
	for _, group := range groups {
		workload := capacityapi.NewWorkloadMember()
		workload.Owner = group.owner
		workload.PodCount = group.pods
		requests := QuantityObservation(group.requests, certainty, capacityapi.GranularityAggregate, snapshot.GeneratedAt, "pods.spec.resources")
		workload.Requests = &requests
		nodeNames := make([]string, 0, len(group.nodes))
		for name := range group.nodes {
			nodeNames = append(nodeNames, name)
		}
		sort.Strings(nodeNames)
		workload.NodesMeta.Total = len(nodeNames)
		nodeLimit := len(nodeNames)
		if nodeLimit > defaultWorkloadNodeLimit {
			nodeLimit = defaultWorkloadNodeLimit
			workload.NodesMeta.Truncated = true
		}
		workload.NodesMeta.Returned = nodeLimit
		for _, name := range nodeNames[:nodeLimit] {
			workload.Nodes = append(workload.Nodes, group.nodes[name])
		}
		result = append(result, capacityapi.PoolMember{
			Type:     capacityapi.MemberWorkload,
			Resource: capacityapi.ResourceIdentity{Ref: group.owner},
			Workload: &workload,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Workload.PodCount != result[j].Workload.PodCount {
			return result[i].Workload.PodCount > result[j].Workload.PodCount
		}
		return memberKey(result[i]) < memberKey(result[j])
	})
	return result
}

func defaultPodOwner(pod *corev1.Pod) subject.Ref {
	for _, owner := range pod.OwnerReferences {
		if owner.Controller != nil && *owner.Controller {
			return subject.Ref{Group: schema.FromAPIVersionAndKind(owner.APIVersion, owner.Kind).Group, Kind: owner.Kind, Namespace: pod.Namespace, Name: owner.Name}
		}
	}
	return subject.Ref{Kind: "Pod", Namespace: pod.Namespace, Name: pod.Name}
}

func identityForUnstructured(resource *unstructured.Unstructured) capacityapi.ResourceIdentity {
	group := schema.FromAPIVersionAndKind(resource.GetAPIVersion(), resource.GetKind()).Group
	return capacityapi.ResourceIdentity{
		Ref:        subject.Ref{Group: group, Kind: resource.GetKind(), Namespace: resource.GetNamespace(), Name: resource.GetName()},
		APIVersion: resource.GetAPIVersion(),
		UID:        string(resource.GetUID()),
	}
}

func identityForNode(node *corev1.Node) capacityapi.ResourceIdentity {
	return capacityapi.ResourceIdentity{Ref: subject.Ref{Kind: "Node", Name: node.Name}, APIVersion: "v1", UID: string(node.UID)}
}

func specFingerprint(resource *unstructured.Unstructured) string {
	spec, _, _ := unstructured.NestedFieldNoCopy(resource.Object, "spec")
	payload, err := json.Marshal(spec)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func normalizeConditions(conditions []metav1.Condition) []capacityapi.Condition {
	result := make([]capacityapi.Condition, 0, len(conditions))
	for _, condition := range conditions {
		normalized := capacityapi.Condition{
			Type: condition.Type, Status: capacityapi.ConditionStatus(condition.Status), Reason: condition.Reason, Message: condition.Message,
		}
		if condition.ObservedGeneration > 0 {
			observed := condition.ObservedGeneration
			normalized.ObservedGeneration = &observed
		}
		if !condition.LastTransitionTime.IsZero() {
			transition := condition.LastTransitionTime.Time
			normalized.LastTransitionTime = &transition
		}
		result = append(result, normalized)
	}
	return result
}

func normalizeNodeConditions(conditions []corev1.NodeCondition) []capacityapi.Condition {
	result := make([]capacityapi.Condition, 0, len(conditions))
	for _, condition := range conditions {
		normalized := capacityapi.Condition{
			Type: string(condition.Type), Status: capacityapi.ConditionStatus(condition.Status), Reason: condition.Reason, Message: condition.Message,
		}
		if !condition.LastTransitionTime.IsZero() {
			transition := condition.LastTransitionTime.Time
			normalized.LastTransitionTime = &transition
		}
		result = append(result, normalized)
	}
	return result
}

func findCondition(conditions []metav1.Condition, conditionType string) *metav1.Condition {
	for i := range conditions {
		if conditions[i].Type == conditionType {
			return &conditions[i]
		}
	}
	return nil
}

func conditionBool(status metav1.ConditionStatus) *bool {
	switch status {
	case metav1.ConditionTrue:
		return boolPointer(true)
	case metav1.ConditionFalse:
		return boolPointer(false)
	default:
		return nil
	}
}

func nodeReady(node *corev1.Node) *bool {
	for _, condition := range node.Status.Conditions {
		if condition.Type == corev1.NodeReady {
			return conditionBool(metav1.ConditionStatus(condition.Status))
		}
	}
	return nil
}

func claimStage(claim *unstructured.Unstructured) capacityapi.ClaimStage {
	if claim.GetDeletionTimestamp() != nil {
		return capacityapi.ClaimStageTerminating
	}
	conditions := karpenter.NodeClaimConditions(claim)
	if condition := findCondition(conditions, "Ready"); condition != nil && condition.Status == metav1.ConditionTrue {
		return capacityapi.ClaimStageReady
	}
	for _, condition := range conditions {
		if isClaimLifecycleCondition(condition.Type) && condition.Status == metav1.ConditionFalse && (strings.Contains(strings.ToLower(condition.Reason), "fail") || strings.Contains(strings.ToLower(condition.Reason), "error")) {
			return capacityapi.ClaimStageFailed
		}
	}
	for _, candidate := range []struct {
		condition string
		stage     capacityapi.ClaimStage
	}{{"Initialized", capacityapi.ClaimStageInitialized}, {"Registered", capacityapi.ClaimStageRegistered}, {"Launched", capacityapi.ClaimStageLaunched}} {
		if condition := findCondition(conditions, candidate.condition); condition != nil && condition.Status == metav1.ConditionTrue {
			return candidate.stage
		}
	}
	return capacityapi.ClaimStagePending
}

func isClaimLifecycleCondition(conditionType string) bool {
	switch conditionType {
	case "Ready", "Initialized", "Registered", "Launched":
		return true
	default:
		return false
	}
}

func incrementClaimStage(summary *capacityapi.ClaimLifecycleSummary, stage capacityapi.ClaimStage) {
	switch stage {
	case capacityapi.ClaimStageReady:
		summary.Ready++
	case capacityapi.ClaimStageInitialized:
		summary.Initialized++
	case capacityapi.ClaimStageRegistered:
		summary.Registered++
	case capacityapi.ClaimStageLaunched:
		summary.Launched++
	case capacityapi.ClaimStageFailed:
		summary.Failed++
	case capacityapi.ClaimStageTerminating:
		summary.Terminating++
	default:
		summary.Pending++
	}
}

func addComposition(composition *capacityapi.PoolComposition, node *corev1.Node) {
	addBucket(&composition.CapacityTypes, valueOrUnknown(node.Labels[karpenter.CapacityTypeLabelKey]))
	addBucket(&composition.InstanceTypes, valueOrUnknown(node.Labels[instanceTypeLabel]))
	addBucket(&composition.Zones, valueOrUnknown(node.Labels[zoneLabel]))
	addBucket(&composition.Architectures, valueOrUnknown(node.Labels[architectureLabel]))
	addBucket(&composition.Images, valueOrUnknown(node.Status.NodeInfo.OSImage))
}

func addBucket(buckets *[]capacityapi.CompositionBucket, value string) {
	for i := range *buckets {
		if (*buckets)[i].Value == value {
			(*buckets)[i].Count++
			return
		}
	}
	*buckets = append(*buckets, capacityapi.CompositionBucket{Value: value, Count: 1})
}

func sortComposition(composition *capacityapi.PoolComposition) {
	for _, axis := range []struct {
		buckets *[]capacityapi.CompositionBucket
		meta    *capacityapi.BoundedResultMeta
	}{
		{&composition.CapacityTypes, &composition.CapacityTypesMeta},
		{&composition.InstanceTypes, &composition.InstanceTypesMeta},
		{&composition.Zones, &composition.ZonesMeta},
		{&composition.Architectures, &composition.ArchitecturesMeta},
		{&composition.Images, &composition.ImagesMeta},
	} {
		buckets := axis.buckets
		sort.Slice(*buckets, func(i, j int) bool {
			if (*buckets)[i].Count != (*buckets)[j].Count {
				return (*buckets)[i].Count > (*buckets)[j].Count
			}
			return (*buckets)[i].Value < (*buckets)[j].Value
		})
		axis.meta.Total = len(*buckets)
		if len(*buckets) > defaultCompositionBucketLimit {
			*buckets = (*buckets)[:defaultCompositionBucketLimit]
			axis.meta.Truncated = true
		}
		axis.meta.Returned = len(*buckets)
	}
}

func valueOrUnknown(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}

func sourceCertainty(coverage capacityapi.CoverageBySource, source capacityapi.CoverageSource) capacityapi.Certainty {
	entry, ok := coverage[source]
	if !ok || entry.Status == capacityapi.CoverageDenied || entry.Status == capacityapi.CoverageSyncing || entry.Status == capacityapi.CoverageUnavailable || entry.Status == capacityapi.CoverageError {
		return capacityapi.CertaintyUnknown
	}
	if entry.Status == capacityapi.CoverageAvailable && entry.Scope == capacityapi.CoverageScopeCluster {
		return capacityapi.CertaintyExact
	}
	return capacityapi.CertaintyLowerBound
}

func scheduledRequestCertainty(coverage capacityapi.CoverageBySource) capacityapi.Certainty {
	pods := sourceCertainty(coverage, capacityapi.CoveragePods)
	nodes := sourceCertainty(coverage, capacityapi.CoverageNodes)
	claims := sourceCertainty(coverage, capacityapi.CoverageNodeClaims)
	attribution := capacityapi.CertaintyUnknown
	if nodes == capacityapi.CertaintyExact || claims == capacityapi.CertaintyExact {
		attribution = capacityapi.CertaintyExact
	} else if nodes == capacityapi.CertaintyLowerBound || claims == capacityapi.CertaintyLowerBound {
		attribution = capacityapi.CertaintyLowerBound
	}
	if pods == capacityapi.CertaintyUnknown || attribution == capacityapi.CertaintyUnknown {
		return capacityapi.CertaintyUnknown
	}
	if pods == capacityapi.CertaintyExact && attribution == capacityapi.CertaintyExact {
		return capacityapi.CertaintyExact
	}
	return capacityapi.CertaintyLowerBound
}

func sourceObserved(coverage capacityapi.CoverageBySource, source capacityapi.CoverageSource) bool {
	entry, ok := coverage[source]
	return ok && (entry.Status == capacityapi.CoverageAvailable || entry.Status == capacityapi.CoveragePartial)
}

func copyCoverage(source capacityapi.CoverageBySource) capacityapi.CoverageBySource {
	result := capacityapi.CoverageBySource{}
	for name, coverage := range source {
		coverage.Namespaces = append([]string{}, coverage.Namespaces...)
		coverage.ImpactFields = append([]string{}, coverage.ImpactFields...)
		result[name] = coverage
	}
	return result
}

func sortMembers(items []capacityapi.PoolMember) {
	sort.Slice(items, func(i, j int) bool { return memberKey(items[i]) < memberKey(items[j]) })
}

func memberKey(member capacityapi.PoolMember) string {
	ref := member.Resource.Ref
	return string(member.Type) + "\x00" + ref.Group + "\x00" + ref.Kind + "\x00" + ref.Namespace + "\x00" + ref.Name
}

func poolModelLess(left, right PoolModel) bool {
	leftReady := left.Observation.Ready
	rightReady := right.Observation.Ready
	leftRank := readinessRank(leftReady)
	rightRank := readinessRank(rightReady)
	if leftRank != rightRank {
		return leftRank < rightRank
	}
	leftPressure := highestPressure(left.Observation.Ledger.LimitPressure)
	rightPressure := highestPressure(right.Observation.Ledger.LimitPressure)
	if leftPressure != rightPressure {
		return leftPressure > rightPressure
	}
	return left.Observation.Resource.Ref.Name < right.Observation.Resource.Ref.Name
}

func readinessRank(ready *bool) int {
	if ready == nil {
		return 1
	}
	if !*ready {
		return 0
	}
	return 2
}

func highestPressure(pressures []capacityapi.LimitPressure) float64 {
	result := -1.0
	for _, pressure := range pressures {
		if pressure.Percent != nil && *pressure.Percent > result {
			result = *pressure.Percent
		}
	}
	return result
}

func boolPointer(value bool) *bool { return &value }
