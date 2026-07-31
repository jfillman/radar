package server

import (
	"testing"
	"time"
)

// The SSE change authorizer must not re-issue a SAR for a repeated (verb, group,
// resource, namespace) within the TTL — otherwise a long-lived stream re-SARs
// every frame once the shared permission cache expires, serially in the single
// broadcast goroutine. It must re-check after the TTL so RBAC changes propagate.
func TestMemoizedAuthorizer(t *testing.T) {
	calls := 0
	// base allows only "list secrets"; counts invocations.
	base := func(group, resource, namespace, verb string) bool {
		calls++
		return verb == "list" && resource == "secrets"
	}
	clock := time.Now()
	ctxName := "cluster-a"
	authz := memoizedAuthorizer(base, 2*time.Minute, func() string { return ctxName }, func() time.Time { return clock })

	if !authz("", "secrets", "team-a", "list") {
		t.Fatal("secrets/list should be allowed")
	}
	// Repeat within TTL → served from memo, no new base call.
	authz("", "secrets", "team-a", "list")
	authz("", "secrets", "team-a", "list")
	if calls != 1 {
		t.Fatalf("want 1 base call within TTL, got %d", calls)
	}

	// A different tuple is a distinct decision → one more base call.
	if authz("", "pods", "team-a", "list") {
		t.Fatal("pods/list should be denied by base")
	}
	if calls != 2 {
		t.Fatalf("want 2 base calls for a new tuple, got %d", calls)
	}

	// Past the TTL, the same tuple re-checks (propagates RBAC changes).
	clock = clock.Add(2*time.Minute + time.Second)
	authz("", "secrets", "team-a", "list")
	if calls != 3 {
		t.Fatalf("want a re-check after the TTL, got %d base calls", calls)
	}
}

// A kubeconfig context switch leaves SSE connections open, so the memo must not
// serve the previous cluster's decision for the new one — a changed context
// name is a cache miss even within the TTL, re-running the SAR against the new
// apiserver.
func TestMemoizedAuthorizer_ContextSwitchIsolatesDecisions(t *testing.T) {
	calls := 0
	// Same tuple resolves differently per cluster: allowed on cluster-a, denied
	// on cluster-b.
	var ctxName string
	base := func(group, resource, namespace, verb string) bool {
		calls++
		return ctxName == "cluster-a"
	}
	clock := time.Now()
	authz := memoizedAuthorizer(base, 2*time.Minute, func() string { return ctxName }, func() time.Time { return clock })

	ctxName = "cluster-a"
	if !authz("", "secrets", "team-a", "list") {
		t.Fatal("secrets/list should be allowed on cluster-a")
	}
	// Switch context well within the TTL — the old allow must NOT leak.
	ctxName = "cluster-b"
	if authz("", "secrets", "team-a", "list") {
		t.Fatal("cluster-a's allow leaked into cluster-b within the TTL")
	}
	if calls != 2 {
		t.Fatalf("want a fresh base call after context switch, got %d", calls)
	}
}

// If a context switch lands while the SAR is in flight, the fresh result was
// decided against a different apiserver than the key names — it must NOT be
// cached, or a switch-back within the TTL would serve the wrong cluster's
// decision.
func TestMemoizedAuthorizer_NoCacheWhenContextChangesDuringSAR(t *testing.T) {
	calls := 0
	ctxName := "cluster-a"
	base := func(group, resource, namespace, verb string) bool {
		calls++
		if calls == 1 {
			// simulate a context switch landing mid-SAR
			ctxName = "cluster-b"
		}
		return true
	}
	clock := time.Now()
	authz := memoizedAuthorizer(base, 2*time.Minute, func() string { return ctxName }, func() time.Time { return clock })

	// Key computed under cluster-a, but context flips to cluster-b during base →
	// result must not be cached under the cluster-a key.
	authz("", "secrets", "team-a", "list")
	// Back on cluster-a within the TTL: a cached (poisoned) entry would be served
	// with no new base call. A fresh call proves it wasn't cached.
	ctxName = "cluster-a"
	authz("", "secrets", "team-a", "list")
	if calls != 2 {
		t.Fatalf("switch-straddling SAR must not be cached; want 2 base calls, got %d", calls)
	}
}

// nil user (auth off) is a strict passthrough — every frame is allowed and no
// SAR is ever issued.
func TestNewSSEChangeAuthorizer_AuthOff(t *testing.T) {
	s := &Server{}
	authz := s.newSSEChangeAuthorizer(nil, nil)
	if !authz("", "secrets", "team-a", "list") {
		t.Fatal("auth-off authorizer must allow everything")
	}
}
