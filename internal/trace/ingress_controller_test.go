package trace

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func ingFixture(mod func(*networkingv1.Ingress)) *networkingv1.Ingress {
	ing := &networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Name: "ing", Namespace: "ns"}}
	if mod != nil {
		mod(ing)
	}
	return ing
}

func TestLivePods_ExcludesTerminalAndDeleting(t *testing.T) {
	now := metav1.Now()
	pod := func(name string, phase corev1.PodPhase, deleting bool) *corev1.Pod {
		p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name}, Status: corev1.PodStatus{Phase: phase}}
		if deleting {
			p.DeletionTimestamp = &now
		}
		return p
	}
	pods := []*corev1.Pod{
		pod("running", corev1.PodRunning, false),
		pod("pending", corev1.PodPending, false),
		pod("succeeded", corev1.PodSucceeded, false), // a completed Job pod under the selector
		pod("failed", corev1.PodFailed, false),
		pod("terminating", corev1.PodRunning, true), // rolling-update old pod being deleted
		nil,
	}
	live := livePods(pods)
	if len(live) != 2 {
		t.Fatalf("want 2 live pods (running + pending), got %d", len(live))
	}
	for _, p := range live {
		if p.Name != "running" && p.Name != "pending" {
			t.Errorf("unexpected live pod %q (terminal/deleting should be excluded)", p.Name)
		}
	}
}

func TestIngressEntryAddress(t *testing.T) {
	none := ingFixture(nil)
	if got := ingressEntryAddress(none); len(got) != 0 {
		t.Errorf("no status: got %v, want empty", got)
	}
	withHost := ingFixture(func(i *networkingv1.Ingress) {
		i.Status.LoadBalancer.Ingress = []networkingv1.IngressLoadBalancerIngress{{Hostname: "lb.example.com"}}
	})
	if got := ingressEntryAddress(withHost); len(got) != 1 || got[0] != "lb.example.com" {
		t.Errorf("hostname: got %v", got)
	}
	withIP := ingFixture(func(i *networkingv1.Ingress) {
		i.Status.LoadBalancer.Ingress = []networkingv1.IngressLoadBalancerIngress{{IP: "203.0.113.4"}}
	})
	if got := ingressEntryAddress(withIP); len(got) != 1 || got[0] != "203.0.113.4" {
		t.Errorf("ip: got %v", got)
	}
}

func TestHasCloudLBAnnotations(t *testing.T) {
	cases := []struct {
		name string
		anno map[string]string
		want bool
	}{
		{"none", nil, false},
		{"alb", map[string]string{"alb.ingress.kubernetes.io/scheme": "internet-facing"}, true},
		{"gce", map[string]string{"ingress.gcp.kubernetes.io/pre-shared-cert": "x"}, true},
		{"gke", map[string]string{"networking.gke.io/managed-certificates": "x"}, true},
		{"class-alb", map[string]string{"kubernetes.io/ingress.class": "alb"}, true},
		{"plain-nginx-anno", map[string]string{"nginx.ingress.kubernetes.io/rewrite-target": "/"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ing := ingFixture(func(i *networkingv1.Ingress) { i.Annotations = c.anno })
			if got := hasCloudLBAnnotations(ing); got != c.want {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}

// The honesty gating: with no cache (Dynamic nil → no class resolves), the finding
// must NEVER condemn unless the POSITIVE no-controller signal holds, and cloud /
// address signals must read as served, not broken.
func TestIngressControllerFinding_Honesty(t *testing.T) {
	t.Run("unwired deps (couldn't read IngressClasses) → soft pill, NEVER condemn", func(t *testing.T) {
		// Deps{} has a nil Dynamic/Discovery — Radar couldn't READ the classes,
		// which is not the same as "none configured". Fail toward silence: a soft
		// "couldn't identify the controller" pill, never the no-controller condemn
		// of a possibly-healthy Ingress.
		st := ingressControllerStatus(Deps{}, ingFixture(nil))
		if st.hasFinding {
			t.Fatalf("unwired deps must NOT condemn; got %+v", st.finding)
		}
		if st.servedBy == "" || !strings.Contains(st.servedByTitle, "IngressClasses") {
			t.Errorf("want the soft couldn't-identify pill; got servedBy=%q title=%q", st.servedBy, st.servedByTitle)
		}
	})

	t.Run("cloud-LB annotations → quiet servedBy pill, NO finding (never broken)", func(t *testing.T) {
		ing := ingFixture(func(i *networkingv1.Ingress) {
			i.Annotations = map[string]string{"alb.ingress.kubernetes.io/scheme": "internet-facing"}
		})
		st := ingressControllerStatus(Deps{}, ing)
		if st.hasFinding {
			t.Errorf("cloud-LB must NOT be a finding; got %+v", st.finding)
		}
		if st.servedBy == "" || !strings.Contains(st.servedByTitle, "cloud load balancer") {
			t.Errorf("want a cloud servedBy pill; got servedBy=%q title=%q", st.servedBy, st.servedByTitle)
		}
	})

	t.Run("has an address (a controller published it) → quiet pill, never no-controller", func(t *testing.T) {
		ing := ingFixture(func(i *networkingv1.Ingress) {
			i.Status.LoadBalancer.Ingress = []networkingv1.IngressLoadBalancerIngress{{Hostname: "x.elb.amazonaws.com"}}
		})
		st := ingressControllerStatus(Deps{}, ing)
		if st.hasFinding {
			t.Errorf("an address present must NOT be condemned as a finding; got %+v", st.finding)
		}
		if st.servedBy == "" {
			t.Errorf("want a servedBy pill when an address is published")
		}
	})
}

func TestKnownControllers_CloudClassified(t *testing.T) {
	for _, ctrl := range []string{"ingress.k8s.aws/alb", "k8s.io/ingress-gce"} {
		if info, ok := knownControllers[ctrl]; !ok || !info.cloud || len(info.labels) != 0 {
			t.Errorf("%s must be cloud with no pod labels (no in-cluster pods); got %+v ok=%v", ctrl, info, ok)
		}
	}
	if info := knownControllers["k8s.io/ingress-nginx"]; info.cloud || len(info.labels) == 0 {
		t.Errorf("ingress-nginx must be in-cluster with pod labels; got %+v", info)
	}
}

var _ = corev1.Pod{} // keep corev1 import for parity with sibling tests
