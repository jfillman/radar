package k8s

import (
	"context"
	"errors"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/skyhook-io/radar/pkg/rollouts"
)

var ErrWorkloadAccessDenied = errors.New("workload access denied")

// GetWorkloadSelector returns the label selector for a workload from cache.
// kind is case-insensitive and accepts either singular ("deployment") or plural
// ("deployments") — matches K8s canonical Kind or REST-style plural.
func GetWorkloadSelector(cache *ResourceCache, kind, namespace, name string) (*metav1.LabelSelector, error) {
	switch kind {
	case "deployment", "deployments":
		lister := cache.Deployments()
		if lister == nil {
			return nil, fmt.Errorf("%w: list deployments", ErrWorkloadAccessDenied)
		}
		dep, err := lister.Deployments(namespace).Get(name)
		if err != nil {
			return nil, fmt.Errorf("deployment %s/%s: %w", namespace, name, err)
		}
		return dep.Spec.Selector, nil

	case "statefulset", "statefulsets":
		lister := cache.StatefulSets()
		if lister == nil {
			return nil, fmt.Errorf("%w: list statefulsets", ErrWorkloadAccessDenied)
		}
		sts, err := lister.StatefulSets(namespace).Get(name)
		if err != nil {
			return nil, fmt.Errorf("statefulset %s/%s: %w", namespace, name, err)
		}
		return sts.Spec.Selector, nil

	case "daemonset", "daemonsets":
		lister := cache.DaemonSets()
		if lister == nil {
			return nil, fmt.Errorf("%w: list daemonsets", ErrWorkloadAccessDenied)
		}
		ds, err := lister.DaemonSets(namespace).Get(name)
		if err != nil {
			return nil, fmt.Errorf("daemonset %s/%s: %w", namespace, name, err)
		}
		return ds.Spec.Selector, nil

	case "job", "jobs":
		lister := cache.Jobs()
		if lister == nil {
			return nil, fmt.Errorf("%w: list jobs", ErrWorkloadAccessDenied)
		}
		job, err := lister.Jobs(namespace).Get(name)
		if err != nil {
			return nil, fmt.Errorf("job %s/%s: %w", namespace, name, err)
		}
		if job.Spec.Selector == nil {
			return &metav1.LabelSelector{
				MatchLabels: map[string]string{"batch.kubernetes.io/job-name": name},
			}, nil
		}
		return job.Spec.Selector, nil

	case "workflow", "workflows":
		if _, err := cache.GetDynamicWithGroup(context.Background(), "Workflow", namespace, name, "argoproj.io"); err != nil {
			return nil, fmt.Errorf("workflow %s/%s: %w", namespace, name, err)
		}
		return &metav1.LabelSelector{
			MatchLabels: map[string]string{"workflows.argoproj.io/workflow": name},
		}, nil

	case "rollout", "rollouts":
		rollout, err := cache.GetDynamicWithGroup(context.Background(), "Rollout", namespace, name, "argoproj.io")
		if err != nil {
			return nil, fmt.Errorf("rollout %s/%s: %w", namespace, name, err)
		}
		raw, found, err := unstructured.NestedMap(rollout.Object, "spec", "selector")
		if err != nil {
			return nil, fmt.Errorf("rollout %s/%s selector: %w", namespace, name, err)
		}
		if found {
			var selector metav1.LabelSelector
			if err := runtime.DefaultUnstructuredConverter.FromUnstructured(raw, &selector); err != nil {
				return nil, fmt.Errorf("rollout %s/%s selector: %w", namespace, name, err)
			}
			return &selector, nil
		}

		refKind, refName, ok := rollouts.WorkloadRef(rollout)
		if !ok {
			return nil, fmt.Errorf("rollout %s/%s has no selector", namespace, name)
		}
		switch refKind {
		case "Deployment":
			lister := cache.Deployments()
			if lister == nil {
				return nil, fmt.Errorf("%w: list deployments", ErrWorkloadAccessDenied)
			}
			deployment, err := lister.Deployments(namespace).Get(refName)
			if err != nil {
				return nil, fmt.Errorf("deployment %s/%s referenced by rollout %s: %w", namespace, refName, name, err)
			}
			return deployment.Spec.Selector, nil
		case "ReplicaSet":
			lister := cache.ReplicaSets()
			if lister == nil {
				return nil, fmt.Errorf("%w: list replicasets", ErrWorkloadAccessDenied)
			}
			replicaSet, err := lister.ReplicaSets(namespace).Get(refName)
			if err != nil {
				return nil, fmt.Errorf("replicaset %s/%s referenced by rollout %s: %w", namespace, refName, name, err)
			}
			return replicaSet.Spec.Selector, nil
		default:
			return nil, fmt.Errorf("rollout %s/%s has no selector and references %s %s", namespace, name, refKind, refName)
		}

	default:
		return nil, fmt.Errorf("unsupported workload kind: %s", kind)
	}
}

// GetContainersForPod returns container names to target for log collection.
// If selectedContainer is non-empty, validates it against containers.
// If includeInit is true, also checks init containers.
// If selectedContainer is empty, returns all main container names.
func GetContainersForPod(pod *corev1.Pod, selectedContainer string, includeInit bool) []string {
	if selectedContainer != "" {
		for _, c := range pod.Spec.Containers {
			if c.Name == selectedContainer {
				return []string{selectedContainer}
			}
		}
		if includeInit {
			for _, c := range pod.Spec.InitContainers {
				if c.Name == selectedContainer {
					return []string{selectedContainer}
				}
			}
		}
		return nil
	}
	containers := make([]string, 0, len(pod.Spec.Containers))
	for _, c := range pod.Spec.Containers {
		containers = append(containers, c.Name)
	}
	return containers
}
