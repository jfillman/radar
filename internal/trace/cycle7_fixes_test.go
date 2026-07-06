package trace

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

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

// Defect 4: a single-host Ingress route's label is path-only ("/api"), so
// routeHostKey returns "" and a NotTested route both counts its own skipped
// transport probe (under the host key) AND itself - inflating Coverage.Skipped.
// recountCoverage must recover the host from a host-bearing field (the declared
// host on InClusterRequest) so the dedup fires.
func TestRecountCoverage_SingleHostNotTestedNoDoubleCount(t *testing.T) {
	tr := &Trace{
		Routes: []RouteResult{{
			Route:            "/api", // path-only label (single-host Ingress)
			Target:           "shop:80",
			Outcome:          OutcomeNotTested,
			InClusterRequest: &ProbeRequest{Host: "shop.example.com", Path: "/api"},
		}},
		// The route's own skipped transport probe, keyed by host in NotTested.
		NotTested: []RouteSkip{{
			Route:       "shop.example.com:443",
			Reason:      "the entry path couldn't be reached from where Radar ran",
			ReasonClass: SkipClassVantage,
		}},
	}
	recountCoverage(tr)
	if tr.Coverage == nil {
		t.Fatal("Coverage nil")
	}
	if tr.Coverage.Skipped != 1 {
		t.Errorf("Coverage.Skipped = %d, want 1 - the not-tested route and its skip row are the SAME gap, not two", tr.Coverage.Skipped)
	}
}

// Regression: the multi-host case (route label carries the host) still dedups.
func TestRecountCoverage_MultiHostNotTestedDedup(t *testing.T) {
	tr := &Trace{
		Routes: []RouteResult{{
			Route:   "shop.example.com/api", // host-qualified (multi-host Ingress)
			Target:  "shop:80",
			Outcome: OutcomeNotTested,
		}},
		NotTested: []RouteSkip{{
			Route:       "shop.example.com:443",
			Reason:      "the entry path couldn't be reached from where Radar ran",
			ReasonClass: SkipClassVantage,
		}},
	}
	recountCoverage(tr)
	if tr.Coverage.Skipped != 1 {
		t.Errorf("Coverage.Skipped = %d, want 1 (host-qualified label dedups)", tr.Coverage.Skipped)
	}
}

// A host-less not-tested route (subject/port identity, no front-door host) with no
// matching skip row is still its own genuine gap - counted once.
func TestRecountCoverage_HostlessNotTestedCountsOnce(t *testing.T) {
	tr := &Trace{
		Routes: []RouteResult{{
			Route:   ":8080",
			Target:  "svc:8080",
			Outcome: OutcomeNotTested,
		}},
	}
	recountCoverage(tr)
	if tr.Coverage.Skipped != 1 {
		t.Errorf("Coverage.Skipped = %d, want 1 (genuine gap, no dedup partner)", tr.Coverage.Skipped)
	}
}
