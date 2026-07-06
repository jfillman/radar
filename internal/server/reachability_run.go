package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/skyhook-io/radar/internal/auth"
	"github.com/skyhook-io/radar/internal/issues"
	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/internal/reachability"
	"github.com/skyhook-io/radar/internal/trace"
	"github.com/skyhook-io/radar/pkg/probe"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"
)

type probeInClusterRequest struct {
	Target string `json:"target"` // clusterIP:port (or host:port)
	Host   string `json:"host,omitempty"`
	Scheme string `json:"scheme,omitempty"`
	Path   string `json:"path,omitempty"`
	Layers string `json:"layers,omitempty"`
}

type probeInClusterResponse struct {
	Results         []probe.Result `json:"results,omitempty"`
	FallbackCommand string         `json:"fallbackCommand,omitempty"`
	Error           string         `json:"error,omitempty"`
}

type probeCapabilityResponse struct {
	Allowed   bool   `json:"allowed"`
	Reason    string `json:"reason,omitempty"`
	Cluster   string `json:"cluster,omitempty"`
	Namespace string `json:"namespace"`
}

// handleProbeInClusterCapability tells the UI whether the in-cluster test will
// actually run for this caller, so the button only appears when it works (a
// button that 403s mid-incident is worse than none). It also names the cluster +
// namespace the probe pod would be created in — the safety rail, since the
// runner creates pods in whatever cluster Radar is connected to.
func (s *Server) handleProbeInClusterCapability(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	resp := probeCapabilityResponse{Cluster: k8s.GetContextName(), Namespace: namespace}
	if !s.requireConnected(w) {
		return
	}
	client := s.getClientForRequest(r)
	if client == nil {
		resp.Reason = "cluster client not available"
		s.writeJSON(w, resp)
		return
	}
	// Mirror the POST's namespace boundary so the capability answer matches what the
	// POST will actually allow — never report "allowed" for an out-of-scope namespace.
	namespaces := s.parseNamespacesForUser(r)
	if noNamespaceAccess(namespaces) || (namespace != "" && !namespaceAllowed(namespaces, namespace)) {
		resp.Reason = fmt.Sprintf("no access to namespace %q", namespace)
		s.writeJSON(w, resp)
		return
	}
	// The POST gate is additive: K8s RBAC AND the Cloud-role tier (Member). Mirror
	// the Cloud-role half here (without the 403) so the capability answer matches
	// what the POST will actually do — a cloud:viewer with the right RBAC must not
	// see allowed=true and then get a 403 cloud_role_insufficient on submit.
	if !auth.CloudRoleFromContext(r.Context()).AtLeast(auth.RoleMember) {
		resp.Reason = "your Radar Cloud role cannot run an in-cluster reachability test"
		s.writeJSON(w, resp)
		return
	}
	allowed, reason, err := reachability.Capability(r.Context(), client, namespace)
	switch {
	case err != nil:
		resp.Reason = "couldn't verify permissions to run an in-cluster test: " + err.Error()
	case !allowed:
		resp.Reason = reason
	default:
		resp.Allowed = true
	}
	s.writeJSON(w, resp)
}

// resolveReachabilityImage picks the probe image: an explicit config override
// wins, else radar's own running image (self-read via the base SA client), else
// RADAR_IMAGE / the version default. See reachability.ResolveImage.
func (s *Server) resolveReachabilityImage(ctx context.Context) string {
	override := ""
	if s.effectiveConfig != nil {
		override = s.effectiveConfig.ReachabilityImage
	}
	// Self-read must use radar's OWN service-account client, not the caller's
	// impersonated one — the deployed image is radar's knowledge, and the caller
	// may have no access to radar's namespace. Guard the typed-nil interface.
	var selfClient kubernetes.Interface
	if base := k8s.GetClient(); base != nil {
		selfClient = base
	}
	return reachability.ResolveImage(ctx, selfClient, override)
}

// handleProbeInCluster runs a reachability probe from INSIDE the cluster (real
// dataplane) via the shared reachability runner: a short-lived, restricted,
// self-destructing Job that runs `radar probe`. It is the ONLY mutating action in
// the diagnostics surface and is hemmed in — it runs as the CALLER's RBAC
// (impersonation), gates on a real capability check BEFORE creating anything, and
// degrades to a copyable kubectl command where the caller can't create Jobs.
func (s *Server) handleProbeInCluster(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if !s.requireConnected(w) {
		return
	}
	// Creating the probe Job is the one mutating action here, so it additively
	// gates on the Cloud-role tier every other mutating handler enforces (helm at
	// Member) — K8s RBAC alone would let a sub-Member Cloud user bypass that layer.
	if !s.requireCloudRole(w, r, auth.RoleMember, "run an in-cluster reachability test") {
		return
	}
	// Same namespace boundary as handleTrace/handleTraceInCluster: never create probe
	// Jobs in a namespace outside the caller's scope (this is a MUTATING action).
	namespaces := s.parseNamespacesForUser(r)
	if noNamespaceAccess(namespaces) || (namespace != "" && !namespaceAllowed(namespaces, namespace)) {
		writeJSONStatus(w, http.StatusForbidden, probeInClusterResponse{Error: fmt.Sprintf("forbidden: no access to namespace %q", namespace)})
		return
	}
	var req probeInClusterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Target) == "" {
		s.writeError(w, http.StatusBadRequest, "target (clusterIP:port) is required")
		return
	}
	// Sanitize the caller-supplied dial destination before it reaches the probe pod:
	// require a well-formed host:port, and strip any ../ from the path.
	if _, _, err := net.SplitHostPort(strings.TrimSpace(req.Target)); err != nil {
		s.writeError(w, http.StatusBadRequest, "target must be host:port")
		return
	}
	if p := strings.TrimSpace(req.Path); p != "" {
		req.Path = path.Clean("/" + p)
	}
	auth.AuditLog(r, namespace, name)

	client := s.getClientForRequest(r)
	if client == nil {
		s.writeError(w, http.StatusServiceUnavailable, "cluster client not available — check cluster connection")
		return
	}

	results, fallback, err := reachability.Run(r.Context(), client, reachability.RunOptions{
		Image:     s.resolveReachabilityImage(r.Context()),
		Namespace: namespace,
		Target:    req.Target,
		Host:      req.Host,
		Scheme:    req.Scheme,
		Path:      req.Path,
		Layers:    req.Layers,
	})
	if err != nil {
		// A capability denial or an apiserver Forbidden is a 403 (the caller can't
		// run it); every other "ran but couldn't finish" is a 200 carrying the
		// honest reason + the copyable fallback so the user can run it by hand.
		status := http.StatusOK
		var capErr *reachability.CapabilityError
		if errors.As(err, &capErr) || apierrors.IsForbidden(err) {
			status = http.StatusForbidden
		}
		writeJSONStatus(w, status, probeInClusterResponse{FallbackCommand: fallback, Error: err.Error()})
		return
	}
	s.writeJSON(w, probeInClusterResponse{Results: results})
}

type traceInClusterRequest struct {
	Path string `json:"path,omitempty"`
}

type traceInClusterResponse struct {
	Trace          *trace.Trace                       `json:"trace"`
	InClusterTests []reachability.InClusterTestResult `json:"inClusterTests,omitempty"`
}

// handleTraceInCluster is the WHOLE-subject in-cluster reachability test: it
// builds the probed trace, runs the live in-cluster probe for each intended route
// (per-route, keyed by InClusterResultKey so a probe of one route can't falsely
// vouch for a sibling that shares its backend), folds the results in via the
// canonical trace.ApplyInClusterResults (which re-derives outcome/confidence/
// verdict/coverage/diagnosis and reconciles contradicted netpol predictions), and
// returns the FINALIZED trace. The frontend just displays it — there is no
// second, weaker merge that could diverge from this server-authoritative one.
func (s *Server) handleTraceInCluster(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}
	kind := chi.URLParam(r, "kind")
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if !trace.IsEntryKind(kind) {
		s.writeError(w, http.StatusBadRequest, "trace is only supported for Service, Ingress, HTTPRoute, GRPCRoute, or Gateway")
		return
	}
	// Creating transient probe pods is the one mutating action here — gate on the
	// Cloud-role tier every mutating handler enforces (Member), mirroring
	// handleProbeInCluster and the MCP diagnose(inCluster) path.
	if !s.requireCloudRole(w, r, auth.RoleMember, "run an in-cluster reachability test") {
		return
	}
	namespaces := s.parseNamespacesForUser(r)
	// Mirror handleTrace: never leak that a resource exists outside the caller's
	// namespace scope — return an unknown-verdict trace instead.
	if noNamespaceAccess(namespaces) || (namespace != "" && !namespaceAllowed(namespaces, namespace)) {
		s.writeJSON(w, traceInClusterResponse{Trace: &trace.Trace{
			Subject:    trace.ResourceRef{Kind: kind, Namespace: namespace, Name: name},
			Downstream: []trace.Hop{},
			Upstreams:  []trace.Hop{},
			Verdict:    trace.VerdictUnknown,
			BrokenAt:   -1,
			Reason:     "no namespace access for current user",
		}})
		return
	}
	var req traceInClusterRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // path is optional; a decode miss defaults to "/"

	deps := trace.Deps{
		Cache:             k8s.GetResourceCache(),
		Dynamic:           k8s.GetDynamicResourceCache(),
		Discovery:         k8s.GetResourceDiscovery(),
		Issues:            issues.NewCacheProvider(),
		Client:            k8s.ClientFromContext(r.Context()),
		AllowedNamespaces: namespaces,
	}
	// Probe must run so routes carry their per-route InClusterRequest; an
	// in-cluster test with no probed routes would be a silent no-op.
	tr, err := trace.BuildTraceWithOptions(r.Context(), deps, kind, namespace, name, trace.Options{Probe: true, ProbePath: req.Path})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	auth.AuditLog(r, namespace, name)

	tests, byTarget := reachability.RunInClusterTests(r.Context(), tr, namespace)
	// Canonical fold: upgrades confidence, re-derives verdict/coverage/diagnosis,
	// and reconciles netpol would-deny predictions the live success contradicts.
	trace.ApplyInClusterResults(tr, byTarget)
	// Stamp the live probes onto their hops so the per-hop reachability matrix shows
	// the "real in-cluster traffic" column — the route outcomes already reflect them.
	stampInClusterProbes(tr, tests)
	s.writeJSON(w, traceInClusterResponse{Trace: tr, InClusterTests: tests})
}

// stampInClusterProbes appends each route's live in-cluster probe results to the
// hop that carries its backend, stamping the in-cluster vantage + data path so the
// matrix attributes them to the "real" column. A probe that didn't get through
// from the throwaway pod is recorded as a SKIP (not a confirmed break) — the same
// fail-toward-silence the route fold already applies, so the matrix never paints a
// red unreachable a different client identity could contradict.
func stampInClusterProbes(tr *trace.Trace, tests []reachability.InClusterTestResult) {
	if tr == nil {
		return
	}
	backendName := func(target string) string {
		if i := strings.LastIndex(target, ":"); i > 0 {
			return target[:i]
		}
		return target
	}
	for _, tst := range tests {
		if len(tst.Results) == 0 {
			continue
		}
		name := backendName(tst.Target)
		for hi := range tr.Downstream {
			if tr.Downstream[hi].Resource.Name != name {
				continue
			}
			// Two downstream hops can share a Service name across namespaces
			// (Gateway API cross-namespace backendRef). Match the hop by name AND
			// namespace so a probe lands on its own hop; a second same-named hop
			// in another namespace gets its own probes (no early break). When the
			// result carries no TargetNamespace (same-namespace backend), match by
			// name alone.
			if tst.TargetNamespace != "" && tr.Downstream[hi].Resource.Namespace != tst.TargetNamespace {
				continue
			}
			for _, pr := range tst.Results {
				pr.Vantage = probe.VantageInCluster
				if pr.Path == "" {
					pr.Path = probe.PathData
				}
				if !pr.Skipped && !pr.OK {
					pr.Skipped = true
					if pr.Reason == "" {
						pr.Reason = "in-cluster probe from a throwaway pod didn't get through — this can differ from real client traffic (source-scoped NetworkPolicy / mesh mTLS), so it's not treated as a confirmed failure"
					}
				}
				tr.Downstream[hi].Probes = append(tr.Downstream[hi].Probes, pr)
			}
		}
	}
}

func writeJSONStatus(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
