package discovery

import (
	"context"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// KubeReader is the narrow surface probes need from the typed kube
// client. Defining the interface here lets unit tests swap a fake in
// without dragging the whole client-go fake apparatus per probe.
// Presence-only discovery: probes never read Secret material, so the
// reader surface is List-only (pods for env/image signatures, CRs for
// operator signatures).
type KubeReader interface {
	ListPods(ctx context.Context, ns string) (*corev1.PodList, error)
}

// DynReader is the narrow surface for CRD lookups.
type DynReader interface {
	List(ctx context.Context, gvr schema.GroupVersionResource, ns string) (*unstructured.UnstructuredList, error)
}

// LiveKube wraps a real *kubernetes.Clientset as a KubeReader.
type LiveKube struct{ C kubernetes.Interface }

func (l LiveKube) ListPods(ctx context.Context, ns string) (*corev1.PodList, error) {
	return l.C.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
}

// LiveDyn wraps a real dynamic.Interface as a DynReader.
type LiveDyn struct{ C dynamic.Interface }

func (l LiveDyn) List(ctx context.Context, gvr schema.GroupVersionResource, ns string) (*unstructured.UnstructuredList, error) {
	if ns == "" {
		return l.C.Resource(gvr).List(ctx, metav1.ListOptions{})
	}
	return l.C.Resource(gvr).Namespace(ns).List(ctx, metav1.ListOptions{})
}
