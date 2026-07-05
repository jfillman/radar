package server

import (
	"fmt"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/skyhook-io/radar/internal/k8s"
	internalopencost "github.com/skyhook-io/radar/internal/opencost"
	prometheuspkg "github.com/skyhook-io/radar/internal/prometheus"
	pkgopencost "github.com/skyhook-io/radar/pkg/opencost"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

func (s *Server) handleOpenCostWorkload(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	kind, namespace, name, ok := s.parseOpenCostWorkloadRequest(w, r)
	if !ok {
		return
	}
	_, desiredReplicas, ok := s.loadOpenCostWorkloadResource(w, kind, namespace, name)
	if !ok {
		return
	}

	resp := &pkgopencost.WorkloadCostDetailResponse{
		Namespace: namespace,
		Kind:      kind,
		Name:      name,
	}

	client := prometheuspkg.GetClient()
	if client == nil {
		resp.Available = false
		resp.Reason = pkgopencost.ReasonNoPrometheus
		s.writeJSON(w, resp)
		return
	}
	if _, _, err := client.EnsureConnected(r.Context()); err != nil {
		log.Printf("[opencost] EnsureConnected failed (workload %s %s/%s): %v", kind, namespace, name, err)
		resp.Available = false
		resp.Reason = pkgopencost.ReasonNoPrometheus
		s.writeJSON(w, resp)
		return
	}

	workloads := pkgopencost.ComputeWorkloadsFromProm(r.Context(), client.Prom(), namespace, internalopencost.BuildPodOwnerLookup(namespace))
	s.writeJSON(w, focusOpenCostWorkload(workloads, kind, namespace, name, desiredReplicas))
}

func (s *Server) handleOpenCostWorkloadTrend(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	kind, namespace, name, ok := s.parseOpenCostWorkloadRequest(w, r)
	if !ok {
		return
	}
	if _, _, ok := s.loadOpenCostWorkloadResource(w, kind, namespace, name); !ok {
		return
	}

	resp := &pkgopencost.WorkloadCostTrendResponse{
		Namespace: namespace,
		Kind:      kind,
		Name:      name,
		Range:     r.URL.Query().Get("range"),
	}

	client := prometheuspkg.GetClient()
	if client == nil {
		resp.Available = false
		resp.Reason = pkgopencost.ReasonNoPrometheus
		s.writeJSON(w, resp)
		return
	}
	if _, _, err := client.EnsureConnected(r.Context()); err != nil {
		log.Printf("[opencost] EnsureConnected failed (workload trend %s %s/%s): %v", kind, namespace, name, err)
		resp.Available = false
		resp.Reason = pkgopencost.ReasonNoPrometheus
		s.writeJSON(w, resp)
		return
	}

	s.writeJSON(w, pkgopencost.ComputeWorkloadCostTrendFromProm(r.Context(), client.Prom(), pkgopencost.WorkloadTrendOptions{
		Range:     r.URL.Query().Get("range"),
		Namespace: namespace,
		Kind:      kind,
		Name:      name,
	}))
}

func (s *Server) parseOpenCostWorkloadRequest(w http.ResponseWriter, r *http.Request) (kind, namespace, name string, ok bool) {
	kind, supported := pkgopencost.CanonicalWorkloadKind(chi.URLParam(r, "kind"))
	if !supported {
		s.writeError(w, http.StatusBadRequest, "only deployments, statefulsets, and daemonsets are supported")
		return "", "", "", false
	}
	namespace = chi.URLParam(r, "namespace")
	name = chi.URLParam(r, "name")
	if namespace == "" || namespace == "_" || name == "" {
		s.writeError(w, http.StatusBadRequest, "namespace and name are required")
		return "", "", "", false
	}

	if status, msg, ok := s.preflightResourceGet(r, normalizeKind(kind), namespace, name, "apps"); !ok {
		s.writeError(w, status, msg)
		return "", "", "", false
	}
	return kind, namespace, name, true
}

func (s *Server) loadOpenCostWorkloadResource(w http.ResponseWriter, kind, namespace, name string) (any, int, bool) {
	cache := k8s.GetResourceCache()
	if cache == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Resource cache not available")
		return nil, 0, false
	}

	switch kind {
	case "Deployment":
		if cache.Deployments() == nil {
			s.writeError(w, http.StatusForbidden, "insufficient permissions to access deployments")
			return nil, 0, false
		}
		deploy, err := cache.Deployments().Deployments(namespace).Get(name)
		if err != nil {
			s.writeOpenCostWorkloadGetError(w, kind, namespace, name, err)
			return nil, 0, false
		}
		replicas := int32(1)
		if deploy.Spec.Replicas != nil {
			replicas = *deploy.Spec.Replicas
		}
		return deploy, int(replicas), true
	case "StatefulSet":
		if cache.StatefulSets() == nil {
			s.writeError(w, http.StatusForbidden, "insufficient permissions to access statefulsets")
			return nil, 0, false
		}
		sts, err := cache.StatefulSets().StatefulSets(namespace).Get(name)
		if err != nil {
			s.writeOpenCostWorkloadGetError(w, kind, namespace, name, err)
			return nil, 0, false
		}
		replicas := int32(1)
		if sts.Spec.Replicas != nil {
			replicas = *sts.Spec.Replicas
		}
		return sts, int(replicas), true
	case "DaemonSet":
		if cache.DaemonSets() == nil {
			s.writeError(w, http.StatusForbidden, "insufficient permissions to access daemonsets")
			return nil, 0, false
		}
		ds, err := cache.DaemonSets().DaemonSets(namespace).Get(name)
		if err != nil {
			s.writeOpenCostWorkloadGetError(w, kind, namespace, name, err)
			return nil, 0, false
		}
		return ds, int(ds.Status.DesiredNumberScheduled), true
	default:
		s.writeError(w, http.StatusBadRequest, "only deployments, statefulsets, and daemonsets are supported")
		return nil, 0, false
	}
}

func (s *Server) writeOpenCostWorkloadGetError(w http.ResponseWriter, kind, namespace, name string, err error) {
	if apierrors.IsNotFound(err) {
		s.writeError(w, http.StatusNotFound, fmt.Sprintf("%s %s/%s not found", kind, namespace, name))
		return
	}
	log.Printf("[opencost] Failed to get %s %s/%s: %v", kind, namespace, name, err)
	s.writeError(w, http.StatusInternalServerError, "failed to get workload")
}

func focusOpenCostWorkload(resp *pkgopencost.WorkloadCostResponse, kind, namespace, name string, desiredReplicas int) *pkgopencost.WorkloadCostDetailResponse {
	out := &pkgopencost.WorkloadCostDetailResponse{
		Namespace: namespace,
		Kind:      kind,
		Name:      name,
	}
	if resp == nil {
		out.Available = false
		out.Reason = pkgopencost.ReasonQueryError
		return out
	}
	if resp.Available {
		for i := range resp.Workloads {
			wl := resp.Workloads[i]
			if wl.Kind == kind && wl.Name == name {
				out.Available = true
				out.Current = &wl
				return out
			}
		}
		if desiredReplicas == 0 {
			out.Available = true
			out.Current = zeroWorkloadCost(kind, name)
			return out
		}
		out.Available = false
		out.Reason = pkgopencost.ReasonNoMetrics
		return out
	}
	if resp.Reason == pkgopencost.ReasonNoMetrics && desiredReplicas == 0 {
		out.Available = true
		out.Current = zeroWorkloadCost(kind, name)
		return out
	}
	out.Available = false
	out.Reason = resp.Reason
	return out
}

func zeroWorkloadCost(kind, name string) *pkgopencost.WorkloadCost {
	return &pkgopencost.WorkloadCost{
		Name:       name,
		Kind:       kind,
		HourlyCost: 0,
		CPUCost:    0,
		MemoryCost: 0,
		Replicas:   0,
		Efficiency: 0,
		IdleCost:   0,
	}
}
