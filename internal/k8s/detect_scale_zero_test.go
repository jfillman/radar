package k8s

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func argoRolloutScaled(name, ns string, replicas int64, tmplLabels map[string]string) *unstructured.Unstructured {
	lbls := map[string]any{}
	for k, v := range tmplLabels {
		lbls[k] = v
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Rollout",
		"metadata":   map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{
			"replicas": replicas,
			"template": map[string]any{"metadata": map[string]any{"labels": lbls}},
		},
	}}
}

// withRollout sets up the typed + dynamic caches with one Service and one Argo
// Rollout, returning the Service. The caller asserts on scaledToZeroBackingWorkload.
func withRollout(t *testing.T, replicas int64) *corev1.Service {
	t.Helper()
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "prod"},
		Spec:       corev1.ServiceSpec{Selector: map[string]string{"app": "api"}},
	}
	if err := InitTestResourceCache(fake.NewClientset(svc)); err != nil {
		t.Fatalf("InitTestResourceCache: %v", err)
	}
	rolloutGVR := schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "rollouts"}
	dynClient := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{rolloutGVR: "RolloutList"},
		argoRolloutScaled("api", "prod", replicas, map[string]string{"app": "api"}),
	)
	if err := InitTestDynamicResourceCache(dynClient, []APIResource{
		{Group: "argoproj.io", Version: "v1alpha1", Kind: "Rollout", Name: "rollouts", Verbs: []string{"list", "watch"}},
	}); err != nil {
		t.Fatalf("InitTestDynamicResourceCache: %v", err)
	}
	dynCache := GetDynamicResourceCache()
	if err := dynCache.EnsureWatching(rolloutGVR); err != nil {
		t.Fatalf("EnsureWatching rollouts: %v", err)
	}
	if !dynCache.WaitForSync(rolloutGVR, 2*time.Second) {
		t.Fatal("rollout dynamic cache did not sync")
	}
	return svc
}

// TestScaledToZero_RolloutAtZeroIsSoftened: an Argo Rollout scaled to 0 is the
// same deliberate-dormancy case as a Deployment at 0 — recognized so the trace
// reads degraded/benign, not red "broken".
func TestScaledToZero_RolloutAtZeroIsSoftened(t *testing.T) {
	defer ResetTestState()
	defer ResetTestDynamicState()
	svc := withRollout(t, 0)
	if zero, _ := scaledToZeroBackingWorkload(GetResourceCache(), svc); !zero {
		t.Error("Rollout at replicas=0 matching the selector should be recognized as scaled-to-zero")
	}
}

// TestScaledToZero_RolloutAboveZeroStaysCritical: a Rollout at replicas>0 with no
// ready pods is a REAL break (the workload wants pods but has none) — the guard
// must not soften it just because Rollouts can scale to 0.
func TestScaledToZero_RolloutAboveZeroStaysCritical(t *testing.T) {
	defer ResetTestState()
	defer ResetTestDynamicState()
	svc := withRollout(t, 2)
	if zero, _ := scaledToZeroBackingWorkload(GetResourceCache(), svc); zero {
		t.Error("Rollout at replicas>0 must NOT be softened — 0 ready under replicas>0 is a real break")
	}
}

// TestScaledToZero_NoRolloutCRDIsNotABreak: when the Rollout CRD isn't installed,
// the dynamic lookup returns ErrUnknownDynamicKind; absence must read as "no
// match", never an error that flips the result.
func TestScaledToZero_NoRolloutCRDIsNotABreak(t *testing.T) {
	defer ResetTestState()
	defer ResetTestDynamicState()
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "prod"},
		Spec:       corev1.ServiceSpec{Selector: map[string]string{"app": "api"}},
	}
	if err := InitTestResourceCache(fake.NewClientset(svc)); err != nil {
		t.Fatalf("InitTestResourceCache: %v", err)
	}
	if zero, uncertain := scaledToZeroBackingWorkload(GetResourceCache(), svc); zero || uncertain {
		t.Error("with no backing workload and no Rollout CRD, must not report scaled-to-zero or uncertain")
	}
}
