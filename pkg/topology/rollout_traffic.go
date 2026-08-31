package topology

import (
	corev1 "k8s.io/api/core/v1"
)

// rolloutPodTemplateHashLabel mirrors pkg/rollouts.PodTemplateHashLabel — kept
// as a local string literal rather than an import, matching how every other
// owner/grouping label in this package (workflows.argoproj.io/workflow,
// batch.kubernetes.io/job-name, app.kubernetes.io/name, ...) is already an
// inline literal rather than a cross-package constant.
const rolloutPodTemplateHashLabel = "rollouts-pod-template-hash"

// rolloutTrafficInfo is a Rollout's live traffic-routing state, read once
// while building the Rollout's own node and reused when matching Services
// and classifying its Pods/ReplicaSets by role (canary/stable/active/preview).
type rolloutTrafficInfo struct {
	// currentPodHash/stableRS classify a canary Rollout's revisions.
	// stableRS is checked first (see rolloutTrafficRole) so a fully-promoted
	// Rollout — where the two coincide — reads as "stable", not "canary".
	currentPodHash string
	stableRS       string
	// activeSelector/previewSelector classify a blueGreen Rollout's revisions.
	activeSelector  string
	previewSelector string

	canaryService  string
	stableService  string
	activeService  string
	previewService string

	// nil means the Rollout hasn't reported a weight yet (e.g. before the
	// first canary step sets one) — distinct from a real 0%.
	canaryWeight *int64
	stableWeight *int64
}

// rolloutTrafficRole classifies a pod-template-hash value against a Rollout's
// live status pointers. Returns "" when the hash matches none of them (e.g.
// an old, no-longer-relevant revision, or the Rollout has no status yet).
func rolloutTrafficRole(podTemplateHash string, info rolloutTrafficInfo) string {
	if podTemplateHash == "" {
		return ""
	}
	switch podTemplateHash {
	case info.stableRS:
		return "stable"
	case info.currentPodHash:
		return "canary"
	case info.activeSelector:
		return "active"
	case info.previewSelector:
		return "preview"
	default:
		return ""
	}
}

// podRolloutTrafficRole resolves a Pod's traffic role via its owning
// ReplicaSet — nil/"" when the pod isn't owned by a Rollout-owned ReplicaSet,
// or the owning Rollout has no traffic info recorded.
func podRolloutTrafficRole(pod *corev1.Pod, replicaSetToRollout map[string]string, rolloutTrafficByID map[string]rolloutTrafficInfo) string {
	for _, ref := range pod.OwnerReferences {
		if ref.Kind != "ReplicaSet" {
			continue
		}
		rolloutID, ok := replicaSetToRollout[pod.Namespace+"/"+ref.Name]
		if !ok {
			continue
		}
		info, ok := rolloutTrafficByID[rolloutID]
		if !ok {
			continue
		}
		return rolloutTrafficRole(pod.Labels[rolloutPodTemplateHashLabel], info)
	}
	return ""
}
