package reachability

import (
	"context"
	"fmt"
	"strings"

	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/internal/trace"
	"github.com/skyhook-io/radar/pkg/probe"
	"k8s.io/client-go/kubernetes"
)

// MaxInClusterProbes bounds how many probe pods one in-cluster reachability call
// will create, so a many-route Ingress can't fan out into a pod storm.
const MaxInClusterProbes = 5

// InClusterTestResult is one route's in-cluster probe outcome. Results is the raw
// probe set when it ran; Status carries the plain-English reason when it could not
// (pod couldn't start / RBAC), with FallbackCommand to run it manually.
type InClusterTestResult struct {
	Route           string              `json:"route"`
	Target          string              `json:"target,omitempty"`
	TargetNamespace string              `json:"targetNamespace,omitempty"`
	Request         *trace.ProbeRequest `json:"request,omitempty"`
	Results         []probe.Result      `json:"results,omitempty"`
	Status          string              `json:"status,omitempty"`
	FallbackCommand string              `json:"fallbackCommand,omitempty"`
}

// RunInClusterTests runs the live in-cluster probe for each intended route that
// can be tested (skips benign scale-to-0 routes and routes with no concrete
// request guess), via the shared reachability runner under the caller's RBAC. It
// returns the per-route results for the response AND a target→results map keyed by
// trace.InClusterResultKey for trace.ApplyInClusterResults. A nil client
// (impersonation failure) or a probe that couldn't run is reported honestly per
// route with a copyable fallback command — never a panic.
//
// This is the single definition both the REST handler and the MCP diagnose tool
// call, so the two paths can't diverge (the same per-route keying + fail-toward-
// silence semantics the backend documents on InClusterResultKey).
func RunInClusterTests(ctx context.Context, tr *trace.Trace, namespace string) ([]InClusterTestResult, map[string][]probe.Result) {
	typed := k8s.ClientFromContext(ctx)
	// Self-read uses radar's OWN service-account client (k8s.GetClient), not the
	// caller's impersonated one — the deployed image is radar's knowledge. Guard
	// the typed-nil interface so a nil base client falls through to RADAR_IMAGE.
	var selfClient kubernetes.Interface
	if base := k8s.GetClient(); base != nil {
		selfClient = base
	}
	image := ResolveImage(ctx, selfClient, "")
	tests := make([]InClusterTestResult, 0)
	byTarget := map[string][]probe.Result{}
	count := 0
	for i := range tr.Routes {
		r := tr.Routes[i]
		if r.Benign || r.InClusterRequest == nil || r.Target == "" {
			continue
		}
		// For a cross-namespace backend (Gateway API backendRef into another ns)
		// the bare "name:port" resolves in the probe pod's namespace and hits the
		// wrong Service or NXDOMAIN. Dial an FQDN (name.ns.svc:port) so it resolves
		// the intended Service regardless of where the probe pod runs.
		dialTarget := r.Target
		if r.TargetNamespace != "" && r.TargetNamespace != namespace {
			dialTarget = fqdnDialTarget(r.Target, r.TargetNamespace)
		}
		opts := RunOptions{
			Image: image, Namespace: namespace, Target: dialTarget,
			Scheme: r.InClusterRequest.Scheme, Host: r.InClusterRequest.Host, Path: r.InClusterRequest.Path,
			Layers: "tcp,http",
		}
		res := InClusterTestResult{Route: r.Route, Target: r.Target, TargetNamespace: r.TargetNamespace, Request: r.InClusterRequest}
		// No impersonated client → auth/impersonation failed for EVERY route. This
		// creates no probe pod, so it must be handled BEFORE the cap/counter —
		// otherwise each nil-client route burns a probe slot and routes past the cap
		// get mislabeled "capped" instead of reflecting the auth failure.
		if typed == nil {
			res.Status = "couldn't run the in-cluster probe: no impersonated cluster client (auth/impersonation failed)"
			res.FallbackCommand = FallbackCommand(opts)
			tests = append(tests, res)
			continue
		}
		if count >= MaxInClusterProbes {
			res.Status = fmt.Sprintf("not tested in-cluster: capped at %d probe pods per call", MaxInClusterProbes)
			tests = append(tests, res)
			continue
		}
		count++
		results, fallback, err := Run(ctx, typed, opts)
		switch {
		case err != nil:
			res.Status = err.Error()
			res.FallbackCommand = fallback
		case !inClusterClean(results):
			// The throwaway probe pod has a DIFFERENT identity than the real client,
			// so a source-scoped NetworkPolicy or mesh mTLS can deny it while real
			// traffic flows. Never let that escalate the static verdict to a
			// confident broken/unreachable — keep the failed probe informational and
			// don't fold it into the route outcome.
			res.Results = results
			res.Status = "in-cluster probe from a throwaway pod didn't get through — this can differ from real client traffic (source-scoped NetworkPolicy / mesh mTLS), so it's not treated as a confirmed failure"
			res.FallbackCommand = FallbackCommand(opts)
		case r.InClusterRequest.PathGuessed:
			// Only ONE guessed concrete path of a wildcard/regex route was probed.
			// Report it (informational) but don't fold it into byTarget — a guessed
			// path must not escalate the whole pattern route to verified-real.
			res.Results = results
			res.Status = "in-cluster probe reached the backend on a GUESSED path — the route is a pattern (wildcard/regex), so this confirms the backend is alive but not that every path the route matches is verified"
		default:
			res.Results = results
			byTarget[trace.InClusterResultKey(r.Route, r.Target, r.TargetNamespace)] = results
		}
		tests = append(tests, res)
	}
	return tests, byTarget
}

// fqdnDialTarget rewrites a "name:port" (or bare "name") target to its
// cluster-FQDN form "name.ns.svc:port" so a cross-namespace backend resolves
// from any probe-pod namespace.
func fqdnDialTarget(target, namespace string) string {
	name, port, hasPort := strings.Cut(target, ":")
	fqdn := name + "." + namespace + ".svc"
	if hasPort {
		return fqdn + ":" + port
	}
	return fqdn
}

// inClusterClean reports whether an in-cluster probe set is an unambiguous
// reach: at least one non-skipped probe succeeded and none failed. Only a clean
// result is folded into the route verdict — a probe failure from a throwaway pod
// must never escalate the static verdict to a confident unreachable.
func inClusterClean(results []probe.Result) bool {
	sawOK := false
	for _, p := range results {
		if p.Skipped {
			continue
		}
		if !p.OK {
			return false
		}
		// A 5xx sets OK=true (the transport reached a server) but Tone=Degraded.
		// The throwaway probe pod's identity/path/auth differs from real clients,
		// so its 5xx must stay informational — folding it would escalate the route
		// to a confident server-error condemn. Not a clean reach.
		if p.Tone == probe.ToneDegraded {
			return false
		}
		sawOK = true
	}
	return sawOK
}
