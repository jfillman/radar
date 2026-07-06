package trace

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestDetectMesh(t *testing.T) {
	sidecar := func(name string) *corev1.Pod {
		return &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}, {Name: name}}}}
	}
	labeled := func(labels, annos map[string]string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Labels: labels, Annotations: annos}}
	}
	cases := []struct {
		name string
		pod  *corev1.Pod
		want string
	}{
		{"istio sidecar container", sidecar("istio-proxy"), "Istio"},
		{"linkerd sidecar container", sidecar("linkerd-proxy"), "Linkerd"},
		{"consul sidecar container", sidecar("consul-dataplane"), "Consul"},
		{"istio rev label", labeled(map[string]string{"istio.io/rev": "stable"}, nil), "Istio"},
		{"istio status annotation", labeled(nil, map[string]string{"sidecar.istio.io/status": "{...}"}), "Istio"},
		{"linkerd inject label", labeled(map[string]string{"linkerd.io/inject": "enabled"}, nil), "Linkerd"},
		{"consul connect-inject annotation", labeled(nil, map[string]string{"consul.hashicorp.com/connect-inject": "true"}), "Consul"},
		{"plain pod, no mesh", &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}}}, ""},
		{"linkerd inject disabled is not a mesh", labeled(map[string]string{"linkerd.io/inject": "disabled"}, nil), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := detectMesh([]*corev1.Pod{c.pod}); got != c.want {
				t.Errorf("detectMesh = %q, want %q", got, c.want)
			}
		})
	}
}

// TestDetectMesh_AdvisoryIsInfoOnly pins the contract that a meshed pod yields an
// INFO advisory finding, never a verdict-escalating severity (a probe failing on
// mTLS must not read as "broken").
func TestDetectMesh_AdvisoryIsInfoOnly(t *testing.T) {
	meshed := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "istio-proxy"}}}}
	hop := buildPodsHop(Deps{}, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "prod"}}, []*corev1.Pod{meshed}, false)
	var found *Finding
	for i := range hop.Findings {
		if hop.Findings[i].Code == "mesh:probe-may-fail-mtls" {
			found = &hop.Findings[i]
		}
	}
	if found == nil {
		t.Fatal("expected a mesh:probe-may-fail-mtls advisory on a meshed pods hop")
	}
	if found.Severity != SeverityInfo {
		t.Errorf("mesh advisory severity = %q, want INFO (it must never escalate the verdict)", found.Severity)
	}
}

// Defect 1: selectedPods must distinguish "genuinely nothing to read" (no svc /
// no selector → readable-empty) from "can't read pod state" (Pods lister
// unavailable, e.g. Pods kind RBAC-disabled at startup → unreadable). Lumping the
// uncertain case in with the empty case stamps a confident "0 ready pods" under
// uncertainty, contradicting the function's documented contract.
func TestSelectedPods_NilListerIsUnreadable(t *testing.T) {
	withSelector := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "shop"},
		Spec:       corev1.ServiceSpec{Selector: map[string]string{"app": "shop"}},
	}
	// A selector exists but Deps.Cache is nil → can't read pods → unreadable.
	if pods, unreadable := selectedPods(Deps{}, withSelector); !unreadable || pods != nil {
		t.Errorf("selector + nil cache: got pods=%v unreadable=%v, want nil/true (uncertain, not a confident empty)", pods, unreadable)
	}
	// No selector → headless/selectorless Service, genuinely nothing to enumerate.
	noSelector := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "db"}}
	if pods, unreadable := selectedPods(Deps{}, noSelector); unreadable || pods != nil {
		t.Errorf("no selector: got pods=%v unreadable=%v, want nil/false (nothing to read)", pods, unreadable)
	}
	// nil Service → nothing to read.
	if pods, unreadable := selectedPods(Deps{}, nil); unreadable || pods != nil {
		t.Errorf("nil svc: got pods=%v unreadable=%v, want nil/false", pods, unreadable)
	}
}
