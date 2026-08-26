package k8s

import (
	"reflect"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/skyhook-io/radar/pkg/k8score"
)

func TestGetWorkloadSelectorResolvesRolloutWorkloadRef(t *testing.T) {
	deploymentSelector := &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}}
	replicaSetSelector := &metav1.LabelSelector{MatchLabels: map[string]string{"app": "worker"}}
	core, err := k8score.NewResourceCache(k8score.CacheConfig{
		Client: fake.NewClientset(
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api-source", Namespace: "prod"}, Spec: appsv1.DeploymentSpec{Selector: deploymentSelector}},
			&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "worker-source", Namespace: "prod"}, Spec: appsv1.ReplicaSetSpec{Selector: replicaSetSelector}},
		),
		ResourceTypes: map[string]bool{k8score.Deployments: true, k8score.ReplicaSets: true},
		DeferredTypes: map[string]bool{},
	})
	if err != nil {
		t.Fatalf("NewResourceCache: %v", err)
	}
	t.Cleanup(core.Stop)
	cache := &ResourceCache{ResourceCache: core}

	rolloutGVR := schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "rollouts"}
	newRollout := func(name, refKind, refName string) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Rollout",
			"metadata":   map[string]any{"name": name, "namespace": "prod"},
			"spec": map[string]any{
				"workloadRef": map[string]any{"apiVersion": "apps/v1", "kind": refKind, "name": refName},
			},
		}}
	}
	dynamicClient := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{rolloutGVR: "RolloutList"},
		newRollout("api", "Deployment", "api-source"),
		newRollout("worker", "ReplicaSet", "worker-source"),
	)
	if err := InitTestDynamicResourceCache(dynamicClient, []APIResource{{
		Group: "argoproj.io", Version: "v1alpha1", Kind: "Rollout", Name: "rollouts", Namespaced: true, Verbs: []string{"list", "watch"},
	}}); err != nil {
		t.Fatalf("InitTestDynamicResourceCache: %v", err)
	}
	t.Cleanup(ResetTestDynamicState)

	for _, tc := range []struct {
		name string
		want *metav1.LabelSelector
	}{
		{name: "api", want: deploymentSelector},
		{name: "worker", want: replicaSetSelector},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := GetWorkloadSelector(cache, "rollout", "prod", tc.name)
			if err != nil {
				t.Fatalf("GetWorkloadSelector: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("selector = %+v, want %+v", got, tc.want)
			}
		})
	}
}
