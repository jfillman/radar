package portforward

import "testing"

// TestOwnerScoping verifies that each owner's forward is independent: stopping
// one owner never tears down another's, and status/reuse lookups are scoped
// correctly. This is the invariant that stops prometheus discovery and the
// traffic subsystem from clobbering each other's metrics tunnel.
func TestOwnerScoping(t *testing.T) {
	saved := reg
	t.Cleanup(func() { reg = saved })
	reg = &registry{forwards: map[Owner]*metricsForward{}}

	// Two owners hold live forwards in the same context.
	reg.forwards[OwnerPrometheus] = &metricsForward{active: true, localPort: 1111, namespace: "monitoring", serviceName: "prometheus", contextName: "ctxA"}
	reg.forwards[OwnerTraffic] = &metricsForward{active: true, localPort: 2222, namespace: "caretta", serviceName: "caretta-vm", contextName: "ctxA"}

	if got := GetConnectionInfo(OwnerPrometheus); !got.Connected || got.LocalPort != 1111 {
		t.Fatalf("prometheus info = %+v", got)
	}
	if got := GetConnectionInfo(OwnerTraffic); !got.Connected || got.LocalPort != 2222 {
		t.Fatalf("traffic info = %+v", got)
	}

	// Stopping prometheus's forward must not touch traffic's — the core fix.
	Stop(OwnerPrometheus)
	if GetConnectionInfo(OwnerPrometheus).Connected {
		t.Fatal("prometheus forward not stopped")
	}
	if !GetConnectionInfo(OwnerTraffic).Connected {
		t.Fatal("traffic forward was torn down by prometheus Stop (cross-owner clobber)")
	}

	// GetAddress peeks across owners (read-only reuse) and is context-scoped.
	if GetAddress(OwnerTraffic, "ctxA") == "" {
		t.Fatal("GetAddress should surface traffic's forward for ctxA")
	}
	if GetAddress(OwnerTraffic, "ctxB") != "" {
		t.Fatal("GetAddress must not match a different context")
	}
	if !IsConnectedForContext("ctxA") || IsConnectedForContext("ctxB") {
		t.Fatal("IsConnectedForContext scoping wrong")
	}
}

// TestGetAddressPrefersOwn verifies GetAddress returns the caller's own forward
// when it has one, rather than an arbitrary peer's — so a caller reuses its own
// live forward instead of probing an incompatible one.
func TestGetAddressPrefersOwn(t *testing.T) {
	saved := reg
	t.Cleanup(func() { reg = saved })
	reg = &registry{forwards: map[Owner]*metricsForward{}}
	reg.forwards[OwnerPrometheus] = &metricsForward{active: true, localPort: 1111, contextName: "ctxA"}
	reg.forwards[OwnerTraffic] = &metricsForward{active: true, localPort: 2222, contextName: "ctxA"}

	if got := GetAddress(OwnerPrometheus, "ctxA"); got != "http://localhost:1111" {
		t.Fatalf("prometheus got %q, want its own :1111", got)
	}
	if got := GetAddress(OwnerTraffic, "ctxA"); got != "http://localhost:2222" {
		t.Fatalf("traffic got %q, want its own :2222", got)
	}
	// With no own forward, fall back to the peer's.
	Stop(OwnerPrometheus)
	if got := GetAddress(OwnerPrometheus, "ctxA"); got != "http://localhost:2222" {
		t.Fatalf("prometheus fallback got %q, want peer :2222", got)
	}
}

// TestGetAddressForServiceIsTargetAware pins that the traffic (Caretta) source
// must NOT adopt the general Prometheus forward. With only a
// prometheus-owned forward to monitoring/prometheus-operated live, a Caretta
// lookup for caretta/caretta-vm must return empty (no cross-adoption), forcing a
// dedicated forward — whereas the old cross-owner GetAddress would hand back the
// wrong backend, which answers the generic probe but holds no caretta metrics.
func TestGetAddressForServiceIsTargetAware(t *testing.T) {
	saved := reg
	t.Cleanup(func() { reg = saved })
	reg = &registry{forwards: map[Owner]*metricsForward{}}

	// Only the general-metrics forward is up (owner=prometheus → prometheus-operated).
	reg.forwards[OwnerPrometheus] = &metricsForward{
		active: true, localPort: 15329, namespace: "monitoring", serviceName: "prometheus-operated", contextName: "ctxA",
	}

	// Old behavior: cross-owner fallback would adopt the wrong backend.
	if got := GetAddress(OwnerTraffic, "ctxA"); got != "http://localhost:15329" {
		t.Fatalf("precondition: GetAddress should surface the peer forward, got %q", got)
	}

	// Fixed behavior: target-aware lookup rejects the mismatched service.
	if got := GetAddressForService(OwnerTraffic, "ctxA", "caretta", "caretta-vm"); got != "" {
		t.Fatalf("target-aware lookup adopted the wrong forward: got %q, want empty", got)
	}

	// Once Caretta's own dedicated forward exists, it is reused by exact match.
	reg.forwards[OwnerTraffic] = &metricsForward{
		active: true, localPort: 22222, namespace: "caretta", serviceName: "caretta-vm", contextName: "ctxA",
	}
	if got := GetAddressForService(OwnerTraffic, "ctxA", "caretta", "caretta-vm"); got != "http://localhost:22222" {
		t.Fatalf("own matching forward: got %q, want :22222", got)
	}
	// A peer forward that DOES target the requested service is still reusable.
	delete(reg.forwards, OwnerTraffic)
	reg.forwards[OwnerPrometheus] = &metricsForward{
		active: true, localPort: 33333, namespace: "caretta", serviceName: "caretta-vm", contextName: "ctxA",
	}
	if got := GetAddressForService(OwnerTraffic, "ctxA", "caretta", "caretta-vm"); got != "http://localhost:33333" {
		t.Fatalf("matching peer forward: got %q, want :33333", got)
	}
	// Context scoping still holds.
	if got := GetAddressForService(OwnerTraffic, "ctxB", "caretta", "caretta-vm"); got != "" {
		t.Fatalf("must not match a different context, got %q", got)
	}
}

// TestStopBumpsEpochWhileEstablishing pins the invariant that a Stop lands even
// while a forward is still coming up (not yet active): stopForwardLocked must
// bump epoch for an inactive forward too, so the in-flight Start sees the change
// and refuses to publish a connection the caller already asked to stop. Reverting
// to an early-return-when-inactive reintroduces the "Stop misses in-flight
// establish" bug.
func TestStopBumpsEpochWhileEstablishing(t *testing.T) {
	f := &metricsForward{} // establishing: not yet active
	before := f.epoch
	stopForwardLocked(f)
	if f.epoch == before {
		t.Fatal("epoch not bumped for an inactive forward — a Stop during establishment would be silently lost")
	}
}
