package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"

	internalopencost "github.com/skyhook-io/radar/internal/opencost"
	prometheuspkg "github.com/skyhook-io/radar/internal/prometheus"
	pkgopencost "github.com/skyhook-io/radar/pkg/opencost"
)

const maxOpenCostApplicationWorkloads = 100

type openCostApplicationRequest struct {
	Range     string                               `json:"range,omitempty"`
	Workloads []pkgopencost.ApplicationWorkloadRef `json:"workloads"`
}

func (s *Server) handleOpenCostApplication(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	_, inputs, unsupported, ok := s.parseOpenCostApplicationRequest(w, r)
	if !ok {
		return
	}

	client := prometheuspkg.GetClient()
	if client == nil {
		s.writeJSON(w, pkgopencost.UnavailableApplicationCostResponse(inputs, unsupported, pkgopencost.ReasonNoPrometheus))
		return
	}
	if _, _, err := client.EnsureConnected(r.Context()); err != nil {
		log.Printf("[opencost] EnsureConnected failed (application cost): %v", err)
		s.writeJSON(w, pkgopencost.UnavailableApplicationCostResponse(inputs, unsupported, pkgopencost.ReasonNoPrometheus))
		return
	}

	namespaceCosts := make(map[string]*pkgopencost.WorkloadCostResponse)
	for _, namespace := range applicationInputNamespaces(inputs) {
		namespaceCosts[namespace] = pkgopencost.ComputeWorkloadsFromProm(
			r.Context(), client.Prom(), namespace, internalopencost.BuildPodOwnerLookup(namespace))
	}

	s.writeJSON(w, pkgopencost.BuildApplicationCostResponse(inputs, unsupported, namespaceCosts))
}

func (s *Server) handleOpenCostApplicationTrend(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	req, inputs, unsupported, ok := s.parseOpenCostApplicationRequest(w, r)
	if !ok {
		return
	}
	refs := make([]pkgopencost.ApplicationWorkloadRef, 0, len(inputs)+len(unsupported))
	for _, input := range inputs {
		refs = append(refs, input.ApplicationWorkloadRef)
	}
	refs = append(refs, unsupported...)

	client := prometheuspkg.GetClient()
	if client == nil {
		s.writeJSON(w, pkgopencost.ComputeApplicationCostTrendFromProm(r.Context(), nil, pkgopencost.ApplicationTrendOptions{
			Range:     req.Range,
			Workloads: refs,
		}))
		return
	}
	if _, _, err := client.EnsureConnected(r.Context()); err != nil {
		log.Printf("[opencost] EnsureConnected failed (application trend): %v", err)
		s.writeJSON(w, pkgopencost.ComputeApplicationCostTrendFromProm(r.Context(), nil, pkgopencost.ApplicationTrendOptions{
			Range:     req.Range,
			Workloads: refs,
		}))
		return
	}

	s.writeJSON(w, pkgopencost.ComputeApplicationCostTrendFromProm(r.Context(), client.Prom(), pkgopencost.ApplicationTrendOptions{
		Range:     req.Range,
		Workloads: refs,
	}))
}

func (s *Server) parseOpenCostApplicationRequest(w http.ResponseWriter, r *http.Request) (openCostApplicationRequest, []pkgopencost.ApplicationWorkloadCostInput, []pkgopencost.ApplicationWorkloadRef, bool) {
	var req openCostApplicationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid application cost request")
		return req, nil, nil, false
	}
	if len(req.Workloads) == 0 {
		s.writeError(w, http.StatusBadRequest, "at least one workload is required")
		return req, nil, nil, false
	}
	if len(req.Workloads) > maxOpenCostApplicationWorkloads {
		s.writeError(w, http.StatusBadRequest, "too many workloads requested")
		return req, nil, nil, false
	}

	inputs := make([]pkgopencost.ApplicationWorkloadCostInput, 0, len(req.Workloads))
	unsupported := make([]pkgopencost.ApplicationWorkloadRef, 0)
	seen := make(map[string]bool, len(req.Workloads))
	for _, ref := range req.Workloads {
		ref.Kind = strings.TrimSpace(ref.Kind)
		ref.Namespace = strings.TrimSpace(ref.Namespace)
		ref.Name = strings.TrimSpace(ref.Name)
		if ref.Kind == "" || ref.Namespace == "" || ref.Name == "" || ref.Namespace == "_" {
			s.writeError(w, http.StatusBadRequest, "workload kind, namespace, and name are required")
			return req, nil, nil, false
		}

		kind, supported := pkgopencost.CanonicalWorkloadKind(ref.Kind)
		if supported {
			ref.Kind = kind
		}
		key := ref.Namespace + "/" + ref.Kind + "/" + ref.Name
		if seen[key] {
			continue
		}
		seen[key] = true

		if !supported {
			unsupported = append(unsupported, ref)
			continue
		}
		if status, msg, ok := s.preflightResourceGet(r, normalizeKind(ref.Kind), ref.Namespace, ref.Name, "apps"); !ok {
			s.writeError(w, status, msg)
			return req, nil, nil, false
		}
		_, desiredReplicas, ok := s.loadOpenCostWorkloadResource(w, ref.Kind, ref.Namespace, ref.Name)
		if !ok {
			return req, nil, nil, false
		}
		inputs = append(inputs, pkgopencost.ApplicationWorkloadCostInput{
			ApplicationWorkloadRef: ref,
			DesiredReplicas:        desiredReplicas,
		})
	}
	sort.Slice(inputs, func(i, j int) bool {
		return inputs[i].Namespace+"/"+inputs[i].Kind+"/"+inputs[i].Name < inputs[j].Namespace+"/"+inputs[j].Kind+"/"+inputs[j].Name
	})
	sort.Slice(unsupported, func(i, j int) bool {
		return unsupported[i].Namespace+"/"+unsupported[i].Kind+"/"+unsupported[i].Name < unsupported[j].Namespace+"/"+unsupported[j].Kind+"/"+unsupported[j].Name
	})
	return req, inputs, unsupported, true
}

func applicationInputNamespaces(inputs []pkgopencost.ApplicationWorkloadCostInput) []string {
	seen := make(map[string]bool)
	for _, input := range inputs {
		seen[input.Namespace] = true
	}
	namespaces := make([]string, 0, len(seen))
	for namespace := range seen {
		namespaces = append(namespaces, namespace)
	}
	sort.Strings(namespaces)
	return namespaces
}
