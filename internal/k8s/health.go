package k8s

import (
	"time"

	corev1 "k8s.io/api/core/v1"

	"github.com/skyhook-io/radar/pkg/health"
)

// Pod health classification now lives in the shared pkg/health package so every
// consumer (topology, timeline, packages, servers) reduces to one classifier.
// The functions below are thin shims that preserve the original signatures and
// outputs, so existing internal callers (dashboards, MCP counters, detectors)
// are untouched. Node health still lives here pending its own migration.

// crashLoopReason is the canonical reason a stable-crashloop pod emits. Used by
// the problem detector to recognize the normalized reason pkg/health emits.
const crashLoopReason = "CrashLoopBackOff"

// highRestartReason is the canonical reason for a container that is actively
// thrashing but is not a classic CrashLoopBackOff.
const highRestartReason = "HighRestartCount"

const readinessProbeFailedReason = "ReadinessProbeFailed"

const readinessProbeInvalidReason = "ReadinessProbeInvalid"
const livenessProbeInvalidReason = "LivenessProbeInvalid"
const initContainerStalledReason = "InitContainerStalled"

// highRestartThreshold is the cumulative per-container RestartCount above which
// a still-unhealthy container is treated as actively thrashing.
const highRestartThreshold = 3

// ClassifyPodHealth determines if a pod is "healthy", "warning", or "error".
// Legacy three-value projection of the canonical health.Pod verdict.
func ClassifyPodHealth(pod *corev1.Pod, now time.Time) string {
	return health.Pod(pod, now).LegacyString()
}

// PodProblemReason returns a short reason string for a problematic pod. The
// classifier is clock-injected; problem rows are only computed for pods already
// flagged as problems, so time.Now() here just reuses the same active tests.
func PodProblemReason(pod *corev1.Pod) string {
	return health.PodProblemReason(pod, time.Now())
}

// PodProblemMessage returns the kubelet's waiting/terminated message for the
// first container in a problem state.
func PodProblemMessage(pod *corev1.Pod) string {
	return health.PodProblemMessage(pod)
}

// PodRestartContext extracts total restarts + the most recent termination reason.
func PodRestartContext(pod *corev1.Pod) (restartCount int32, lastTerminatedReason string) {
	return health.PodRestartContext(pod)
}

// IsPodUnschedulable reports whether the scheduler tried and failed to place the
// pod (PodScheduled=False, reason=Unschedulable).
func IsPodUnschedulable(pod *corev1.Pod) bool {
	return health.IsPodUnschedulable(pod)
}

func podCrashLoopDiagnosis(pod *corev1.Pod, now time.Time) (cause, action string) {
	return health.PodCrashLoopDiagnosis(pod, now)
}

func podHasReadinessProbeFailure(pod *corev1.Pod, now time.Time) bool {
	return health.PodHasReadinessProbeFailure(pod, now)
}

// NodeHealth describes the health of a single node.
type NodeHealth struct {
	Ready         bool
	Unschedulable bool
	Pressures     []string // "MemoryPressure", "DiskPressure", "PIDPressure"
	Version       string   // kubelet version
	Reason        string   // condition message if NotReady
}

// ClassifyNodeHealth evaluates a node's conditions and spec.
func ClassifyNodeHealth(node *corev1.Node) NodeHealth {
	h := NodeHealth{
		Unschedulable: node.Spec.Unschedulable,
		Version:       node.Status.NodeInfo.KubeletVersion,
	}

	for _, cond := range node.Status.Conditions {
		switch cond.Type {
		case corev1.NodeReady:
			h.Ready = cond.Status == corev1.ConditionTrue
			if !h.Ready && cond.Message != "" {
				h.Reason = cond.Message
			}
		case corev1.NodeMemoryPressure:
			if cond.Status == corev1.ConditionTrue {
				h.Pressures = append(h.Pressures, "MemoryPressure")
			}
		case corev1.NodeDiskPressure:
			if cond.Status == corev1.ConditionTrue {
				h.Pressures = append(h.Pressures, "DiskPressure")
			}
		case corev1.NodePIDPressure:
			if cond.Status == corev1.ConditionTrue {
				h.Pressures = append(h.Pressures, "PIDPressure")
			}
		}
	}

	return h
}
