package server

import (
	"errors"
	"fmt"
	"testing"

	internalopencost "github.com/skyhook-io/radar/internal/opencost"
	prometheuspkg "github.com/skyhook-io/radar/internal/prometheus"
	pkgopencost "github.com/skyhook-io/radar/pkg/opencost"
)

func TestOpenCostConnectionFailureReason(t *testing.T) {
	if got := internalopencost.ConnectionFailureReason(fmt.Errorf("wrapped: %w", prometheuspkg.ErrPrometheusNotFound)); got != pkgopencost.ReasonNoPrometheus {
		t.Fatalf("not-found reason = %q, want %q", got, pkgopencost.ReasonNoPrometheus)
	}
	if got := internalopencost.ConnectionFailureReason(errors.New("manual URL unreachable")); got != pkgopencost.ReasonQueryError {
		t.Fatalf("connection-error reason = %q, want %q", got, pkgopencost.ReasonQueryError)
	}
}

func TestFocusOpenCostWorkloadScaledToZeroReturnsCurrentZero(t *testing.T) {
	resp := focusOpenCostWorkload(&pkgopencost.WorkloadCostResponse{
		Available: false,
		Reason:    pkgopencost.ReasonNoMetrics,
		Namespace: "default",
	}, "Deployment", "default", "checkout", 0)

	if !resp.Available {
		t.Fatalf("expected scaled-to-zero workload to be available, got %+v", resp)
	}
	if resp.Current == nil {
		t.Fatalf("expected zero current row, got nil")
	}
	if resp.Current.Name != "checkout" || resp.Current.Kind != "Deployment" {
		t.Fatalf("current row = %s/%s, want checkout/Deployment", resp.Current.Name, resp.Current.Kind)
	}
	if resp.Current.HourlyCost != 0 || resp.Current.Replicas != 0 {
		t.Fatalf("current row should be zero cost and zero replicas, got %+v", resp.Current)
	}
}

func TestFocusOpenCostWorkloadMissingTargetWithReplicasReturnsNoMetrics(t *testing.T) {
	resp := focusOpenCostWorkload(&pkgopencost.WorkloadCostResponse{
		Available: true,
		Namespace: "default",
		Workloads: []pkgopencost.WorkloadCost{
			{Name: "other", Kind: "Deployment", HourlyCost: 1, Replicas: 1},
		},
	}, "Deployment", "default", "checkout", 2)

	if resp.Available {
		t.Fatalf("expected missing workload with desired replicas to be unavailable, got %+v", resp)
	}
	if resp.Reason != pkgopencost.ReasonNoMetrics {
		t.Fatalf("Reason = %q, want %q", resp.Reason, pkgopencost.ReasonNoMetrics)
	}
}
