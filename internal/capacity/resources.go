package capacity

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	resourcehelper "k8s.io/component-helpers/resource"
)

type ResourceAccounting struct {
	Allocatable       corev1.ResourceList
	ScheduledRequests corev1.ResourceList
	PendingRequests   corev1.ResourceList
	DaemonRequests    corev1.ResourceList
}

func EffectivePodRequests(pod *corev1.Pod) corev1.ResourceList {
	if pod == nil {
		return nil
	}
	requests := resourcehelper.PodRequests(pod, resourcehelper.PodResourcesOptions{
		UseStatusResources: true,
		InPlacePodLevelResourcesVerticalScalingEnabled: true,
		UseDRANodeAllocatableResourceClaimStatus:       true,
	})
	pods := requests[corev1.ResourcePods]
	pods.Add(*resource.NewQuantity(1, resource.DecimalSI))
	requests[corev1.ResourcePods] = pods
	return requests
}

func AccountResources(nodes []*corev1.Node, pods []*corev1.Pod) ResourceAccounting {
	accounting := ResourceAccounting{
		Allocatable:       corev1.ResourceList{},
		ScheduledRequests: corev1.ResourceList{},
		PendingRequests:   corev1.ResourceList{},
		DaemonRequests:    corev1.ResourceList{},
	}
	for _, node := range nodes {
		if node != nil {
			addResources(accounting.Allocatable, node.Status.Allocatable)
		}
	}
	for _, pod := range pods {
		if pod == nil || isTerminal(pod) {
			continue
		}
		if pod.Spec.NodeName == "" && pod.DeletionTimestamp != nil {
			continue
		}
		requests := EffectivePodRequests(pod)
		if pod.Spec.NodeName == "" {
			if !isDaemonSetPod(pod) && !isSchedulingGatedPod(pod) {
				addResources(accounting.PendingRequests, requests)
			}
			continue
		}
		addResources(accounting.ScheduledRequests, requests)
		if isDaemonSetPod(pod) {
			addResources(accounting.DaemonRequests, requests)
		}
	}
	return accounting
}

func isTerminal(pod *corev1.Pod) bool {
	return pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed
}

func isDaemonSetPod(pod *corev1.Pod) bool {
	owner := metav1.GetControllerOf(pod)
	if owner == nil || owner.Kind != "DaemonSet" {
		return false
	}
	return schema.FromAPIVersionAndKind(owner.APIVersion, owner.Kind).Group == "apps"
}

func isSchedulingGatedPod(pod *corev1.Pod) bool {
	return pod != nil && len(pod.Spec.SchedulingGates) > 0
}

func addResources(total, resources corev1.ResourceList) {
	for name, quantity := range resources {
		current := total[name]
		current.Add(quantity)
		total[name] = current
	}
}
