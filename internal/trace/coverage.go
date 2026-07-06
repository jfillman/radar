package trace

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/pkg/probe"
)

// Coverage-honest projection of a trace. This is a server-authoritative VIEW
// computed alongside the verdict (computeCoverage) - it never changes the
// verdict; it describes only what was actually tested. The invariant: the
// per-route Outcome+Confidence reflect REAL-TRAFFIC evidence; behind-the-gate
// / apiserver / direct-pod facts live on Localization, structurally apart, so
// they can never be mistaken for a real-traffic pass/fail.

// Route outcome vocabulary (coverage-honest; pairs with a Confidence).
const (
	OutcomeVerified    = "verified"     // real HTTP 2xx
	OutcomeReached     = "reached"      // 3xx/4xx, or transport-only (TCP/TLS) - reached, route not verified
	OutcomeServerError = "server-error" // 5xx - reached, backend erroring
	OutcomeUnreachable = "unreachable"  // transport failure
	OutcomeNotTested   = "not-tested"   // no non-skipped probe ran for this route
)

// Confidence qualifies an outcome by HOW it was learned.
const (
	ConfidenceReal     = "real"     // tested the way real traffic flows (direct dial / in-cluster data path)
	ConfidenceIndirect = "indirect" // only the apiserver proxy reached it - annotates, never sets the headline
)

// VantageAPIServer is the ONE operator-facing name for the apiserver-proxy
// vantage: a real request that took the CONTROL-PLANE path (API server →
// endpoint/kubelet → pod), bypassing kube-proxy (ClusterIP routing) and
// NetworkPolicy. Named by path, not real/fake - it proves the backend answers,
// not that the Service's real data path delivers. MUST stay identical to the TS
// const VIA_API_SERVER (reachVerdict.ts); pinned by TestVantageAPIServerName and
// the TS counterpart so the two headline generators can't drift.
const VantageAPIServer = "via API server"

// Skip reason classes. Only "coverage" + "vantage" are real coverage gaps that
// should cap a full-green headline; "benign" loses no coverage.
const (
	SkipClassCoverage = "coverage" // a declared path we genuinely couldn't test (UDP/wildcard/no-SNI/non-HTTP/truncated)
	SkipClassBenign   = "benign"   // no coverage lost (sampled identical pods, duplicate default backend)
	SkipClassVantage  = "vantage"  // couldn't reach the front door from HERE (laptop + internal) - a gap, not an outage
)

// Coverage counts intended routes: Tested = routes that got any non-skipped
// probe; Passed = reachable (verified/reached); Failed = unreachable/server-error;
// Skipped = routes/targets we could not test (len(NotTested)).
type Coverage struct {
	Tested  int `json:"tested"`
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Skipped int `json:"skipped"`
}

// ProbeFact is a minimal, JSON-light record of one probe, used for the
// behind-the-gate Localization list on a route.
type ProbeFact struct {
	Layer  string `json:"layer"`
	Path   string `json:"path,omitempty"` // data | apiserver | "" (direct)
	Target string `json:"target,omitempty"`
	OK     bool   `json:"ok"`
	Tone   string `json:"tone,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// RouteResult is one INTENDED route (a declared host+path→backend entry, or the
// Service→Pods chain for a Service subject) and its real-traffic outcome.
type RouteResult struct {
	Route  string `json:"route"`            // host+path identity, or the subject/port identity
	Target string `json:"target,omitempty"` // backend svc:port
	// TargetNamespace is the backend Service's namespace. For a cross-namespace
	// Gateway API backendRef this differs from the subject namespace, so the
	// in-cluster probe must dial an FQDN (name.ns.svc) rather than the bare name -
	// otherwise it resolves in the probe pod's namespace and hits the wrong
	// Service or NXDOMAIN.
	TargetNamespace string `json:"targetNamespace,omitempty"`
	Outcome         string `json:"outcome"` // see Outcome* constants
	// FailedLayer names which layer failed on a non-reachable route so the UI can say
	// exactly what broke: "tcp" | "tls" | "http" (unreachable), or "upstream" for a
	// 502/504 where HTTP was reached but the gateway couldn't reach its backend.
	// Empty for a reachable outcome.
	FailedLayer     string `json:"failedLayer,omitempty"`
	Confidence      string `json:"confidence,omitempty"`
	Evidence        string `json:"evidence,omitempty"`
	Command         string `json:"command,omitempty"`
	// Benign marks a route that is unreachable by DESIGN - the backing workload is
	// intentionally scaled to 0 (deliberate dormancy, not an outage). The Outcome
	// stays unreachable (factually true) but the headline/tone read amber-benign,
	// not red.
	Benign bool `json:"benign,omitempty"`
	// Localization holds behind-the-gate facts (apiserver proxy, direct-pod
	// dials). They explain WHERE a route broke / that a component answers, but
	// are kept apart so they can never feed Outcome/Confidence.
	Localization []ProbeFact `json:"localization,omitempty"`
	// InClusterRequest is the best-guess concrete request to test this route
	// from inside the cluster (the runner dials the Service directly, bypassing
	// the Ingress). It is a STARTING POINT the user can edit before running -
	// when the route's path is a pattern (regex/wildcard) there is no single
	// faithful request, so PathGuessed marks it as a guess. nil for routes that
	// aren't testable that way (a known static break with no backend).
	InClusterRequest *ProbeRequest `json:"inClusterRequest,omitempty"`
}

// ProbeRequest is a concrete HTTP request a user can run against a Service from
// inside the cluster. Every field is derivable from the declared route; Scheme
// comes from the BACKEND Service port (not the Ingress TLS, which terminates at
// the front door the in-cluster dial bypasses).
type ProbeRequest struct {
	Scheme      string `json:"scheme"`         // http | https
	Host        string `json:"host,omitempty"` // Host header / SNI (omitted when none declared)
	Path        string `json:"path"`           // request path
	PathGuessed bool   `json:"pathGuessed,omitempty"`
}

// RouteSkip is one route/target we could not actively test, with why + a
// copyable command where one can be formed honestly.
type RouteSkip struct {
	Route       string `json:"route,omitempty"`
	Reason      string `json:"reason"`
	ReasonClass string `json:"reasonClass,omitempty"`
	Command     string `json:"command,omitempty"`
}

// computeCoverage builds the coverage projection from the already-finalized
// trace. ADDITIVE: it reads Downstream/Upstreams/branches/probes and writes
// only the Coverage/Routes/NotTested/BrokenRoute fields. It never touches
// Verdict or BrokenAt.
func computeCoverage(t *Trace) {
	if t == nil {
		return
	}
	if t.BrokenAt >= 0 && t.BrokenAt < len(t.Downstream) {
		ref := t.Downstream[t.BrokenAt].Resource
		t.BrokenRoute = &ref
	}

	routes, unprobed := buildRoutes(t)
	t.Routes = routes
	upgradeDefinitiveBackendDown(t)
	t.NotTested = append(buildNotTested(t), unprobed...)

	// A static-only trace (no probing) leaves Coverage nil; the headline below
	// still resolves ("Configuration only - not yet tested").
	recountCoverage(t)
	// Single source of truth for the banner sentence - UI and MCP both read this.
	t.Headline = CoverageHeadline(t)
	t.Diagnosis = computeDiagnosis(t)
}

// upgradeDefinitiveBackendDown promotes a Service route's unreachability from
// indirect (apiserver-proxy-only) to a DEFINITIVE real failure when the backend
// has zero ready endpoints. Zero ready endpoints is an authoritative cache fact
// (pod / EndpointSlice readiness), not a vantage limitation - so the proxy's "no
// ready endpoints" IS the real answer, and every coverage-tone surface should
// read it as a genuine break (red), never the soft "couldn't confirm via the
// proxy" amber that indirect normally earns. Scoped to a single-Service subject,
// where the one route maps unambiguously to the one backend; multi-backend entries
// keep the conservative indirect read (a route can't be matched to its backend's
// readiness here without risking a mis-attribution). All ports of a Service share
// the same backend pods, so a 0-ready backend is definitive for every port.
func upgradeDefinitiveBackendDown(t *Trace) {
	if t.Subject.Kind != "Service" {
		return
	}
	// Definitive only: a CRITICAL no-ready-endpoints finding means zero ready pods
	// (authoritative). The WARNING variant ("couldn't verify whether the workload
	// is scaled to 0", Rollout lookup failed) is genuinely uncertain - leave it
	// soft so an unverifiable state is never condemned as a hard break.
	definitive := false
	for _, h := range t.Downstream {
		for i := range h.Findings {
			if h.Findings[i].Severity == SeverityCritical && isNoReadyEndpointsFinding(&h.Findings[i]) {
				definitive = true
				break
			}
		}
	}
	if !definitive {
		return
	}
	for i := range t.Routes {
		r := &t.Routes[i]
		if r.Outcome == OutcomeUnreachable && r.Confidence == ConfidenceIndirect && !r.Benign {
			r.Confidence = ConfidenceReal
		}
	}
}

// recountCoverage derives the tested/passed/failed/skipped tally from the
// current Routes + NotTested. Split out of computeCoverage so a later fold (an
// in-cluster probe upgrading a route) can re-tally without rebuilding routes.
func recountCoverage(t *Trace) {
	if len(t.Routes) == 0 && len(t.NotTested) == 0 {
		return
	}
	skipped := 0
	skippedRouteKeys := map[string]bool{}
	for _, s := range t.NotTested {
		// Benign skips (sampled identical pods, duplicate default backend) lose no
		// coverage by design - counting them would downgrade a fully-tested route
		// to footnote-green "· 1 not tested", contradicting SkipClassBenign.
		if s.ReasonClass == SkipClassBenign {
			continue
		}
		skipped++
		// Key on the host (RouteSkip.Route is a probe target like "shop.example.com"
		// or "host:port"); the not-tested route below carries the same host in its
		// Route label, so the two key spaces line up and the dedup actually fires.
		if h := routeHostKey(s.Route); h != "" {
			skippedRouteKeys[h] = true
		}
	}
	cov := Coverage{}
	for _, r := range t.Routes {
		switch r.Outcome {
		case OutcomeVerified, OutcomeReached:
			cov.Tested++
			cov.Passed++
		case OutcomeUnreachable, OutcomeServerError:
			cov.Tested++
			cov.Failed++
		case OutcomeNotTested:
			// A route whose only evidence was a DNS resolve (transport probes
			// skipped from this vantage) is a coverage gap. Count it once - if its
			// skipped transport-probe rows are already in NotTested (matched by host),
			// the route is already represented, so don't double-count it here.
			if h := routeResultHostKey(r); h == "" || !skippedRouteKeys[h] {
				skipped++
			}
		default:
			cov.Tested++
		}
	}
	cov.Skipped = skipped
	t.Coverage = &cov
}

// InClusterResultKey is the identity under which an in-cluster probe result is
// folded back onto its route. It must be UNIQUE per intended route: two routes
// that share a backend svc:port but differ by host/path (same Target) or by
// namespace (same name:port, different TargetNamespace) must NOT collide, or a
// clean probe of one route would falsely vouch for the other (a false
// "verified over live traffic"). Producer (internal/mcp runInClusterTests) and
// consumer (ApplyInClusterResults) MUST key identically.
func InClusterResultKey(route, target, targetNamespace string) string {
	return route + "\x00" + target + "\x00" + targetNamespace
}

// ApplyInClusterResults folds in-cluster probe results (keyed by InClusterResultKey)
// into the finalized trace. The in-cluster data path IS real traffic, so a route
// the apiserver proxy could only reach INDIRECTLY is re-derived from the live
// result and earns ConfidenceReal when reached/verified - closing the honesty gap
// the proxy vantage leaves open. Counts, headline, and diagnosis are recomputed so
// the whole projection stays consistent. Benign (intentional scale-to-0) routes
// are left untouched - they are deliberately dormant, not a path to confirm.
// Routes with no in-cluster result keep their prior (proxy/static) outcome.
func ApplyInClusterResults(t *Trace, byTarget map[string][]probe.Result) {
	if t == nil {
		return
	}
	for i := range t.Routes {
		if t.Routes[i].Benign {
			continue
		}
		res := byTarget[InClusterResultKey(t.Routes[i].Route, t.Routes[i].Target, t.Routes[i].TargetNamespace)]
		if len(res) == 0 {
			continue
		}
		rr, ok := routeFromProbes(t.Routes[i].Route, t.Routes[i].Target, res)
		if !ok {
			continue
		}
		// Preserve the route's identity guess so the agent/UI keep the editable
		// request; the outcome/confidence/evidence now reflect the live dataplane.
		rr.InClusterRequest = t.Routes[i].InClusterRequest
		rr.TargetNamespace = t.Routes[i].TargetNamespace
		t.Routes[i] = rr
	}
	// A route that was only DNS-resolvable from the laptop/proxy vantage carries a
	// SkipClassVantage "run radar in-cluster" row in NotTested. When the live pass
	// just upgraded that same route to a real reach/verify, that advice is stale and
	// contradictory (the user already ran in-cluster and it passed), and recountCoverage
	// would count the route as Passed AND its same-host skip row as Skipped. Drop the
	// vantage rows the live pass resolved before recounting.
	resolvedHosts := map[string]bool{}
	for i := range t.Routes {
		r := t.Routes[i]
		if r.Confidence != ConfidenceReal {
			continue
		}
		if r.Outcome != OutcomeVerified && r.Outcome != OutcomeReached {
			continue
		}
		if h := routeResultHostKey(r); h != "" {
			resolvedHosts[h] = true
		}
	}
	if len(resolvedHosts) > 0 {
		kept := t.NotTested[:0]
		for _, s := range t.NotTested {
			if s.ReasonClass == SkipClassVantage && resolvedHosts[routeHostKey(s.Route)] {
				continue
			}
			kept = append(kept, s)
		}
		t.NotTested = kept
	}
	// A static would-deny is a PREDICTION; live in-cluster traffic that actually
	// reached the backend is ground truth that the rule isn't blocking this path.
	// Downgrade the surviving would-deny WARNING so computeDiagnosis can't
	// re-promote a prediction that the confirmed live success contradicts.
	reconcileInClusterPolicy(t)
	// Same ground-truth principle for the targetPort suspicion: live in-cluster
	// traffic that reached the suspect Service port proves a listener exists, so
	// downgrade the surviving svc:targetport-no-listener WARNING before computeDiagnosis
	// can re-promote a static guess the confirmed live success contradicts. The static
	// reconcileTargetPortAdvisory reads h.Probes, which the in-cluster flow stamps only
	// after this recompute - so the fold must happen off the passed-backend ports here.
	reconcileInClusterTargetPort(t)
	// Re-derive the verdict over the updated findings, mirroring BuildTraceWithOptions:
	// a would-deny WARNING that reconcileInClusterPolicy just downgraded to info must
	// not leave a stale 'degraded' beside a now-healthy headline, and a surviving real
	// critical re-derives honestly to broken. Only a genuine special-shape unknown
	// (selectorless / RBAC / lookup failure / timed out; those set UnknownClass) stays
	// unknown. An unknown produced by the coverage collapse of a healthy-but-indirect
	// laptop trace (UnknownClass empty) MUST re-derive here, or the in-cluster pass that
	// just upgraded its routes to real can never lift it off unknown.
	if !(t.Verdict == VerdictUnknown && t.UnknownClass != "") {
		// computeVerdict only sets t.Reason when it's empty, so a prior "all routes
		// broken" sentence would survive a flip toward healthy. Clear it first so the
		// fresh verdict re-explains (or leaves it empty when there's nothing to explain).
		t.Reason = ""
		t.Verdict, t.BrokenAt = computeVerdict(t)
	}
	// BrokenAt may have moved (a live confirmation cleared an earlier break);
	// recountCoverage never refreshes BrokenRoute, so re-derive it the same way
	// computeCoverage does - nil when nothing is broken - or a healthy/degraded
	// trace ships a stale brokenRoute ref pointing at the now-contradicted hop.
	if t.BrokenAt >= 0 && t.BrokenAt < len(t.Downstream) {
		ref := t.Downstream[t.BrokenAt].Resource
		t.BrokenRoute = &ref
	} else {
		t.BrokenRoute = nil
	}
	recountCoverage(t)
	t.Headline = CoverageHeadline(t)
	t.Diagnosis = computeDiagnosis(t)
	// Same collapse as the standard path (BuildTraceWithOptions): ship the one
	// coverage-honest verdict so REST, UI, and MCP never diverge on the in-cluster
	// flow.
	t.Verdict = CoverageVerdict(t)
}

// reconcileInClusterPolicy downgrades a static netpol:would-deny WARNING to the
// reassuring info note on any Pods hop whose route was confirmed reachable over
// REAL in-cluster traffic. Without this, ApplyInClusterResults would fold the
// live success into the route outcome but leave the contradicting prediction on
// the hop, where primaryProblemFinding could re-promote it as the lead cause.
func reconcileInClusterPolicy(t *Trace) {
	passed, anyPass := passedBackends(t)
	if !anyPass {
		return
	}
	// downgrade rewrites a would-deny finding ONLY when the real pass actually
	// covered the port the deny is about (or the deny is all-ports). A pass on
	// :80 must not clear a :443 prediction. ports==nil means this branch had no
	// real pass at all.
	downgrade := func(start, end int, ports map[int32]bool) {
		for i := start; i < end && i < len(t.Downstream); i++ {
			h := &t.Downstream[i]
			if h.Meta == nil || h.Meta["policyVerdict"] != "would-deny" {
				continue
			}
			if !realPassCoversDenyPort(ports, hopDenyPort(h.Meta)) {
				continue
			}
			idx := findingIndexByCode(h.Findings, codePolicyWouldDeny)
			if idx < 0 {
				continue
			}
			h.Findings[idx] = Finding{
				Code:     codePolicyWouldDeny,
				Severity: SeverityInfo,
				Message:  "Traffic got through from inside the cluster. A network rule here would block it, but live in-cluster traffic actually reached the backend - so the rule isn't blocking this path.",
				Command:  h.Findings[idx].Command,
			}
			sortFindingsBySeverity(h.Findings)
		}
	}
	branches := downstreamBranches(t.Downstream)
	if len(branches) == 0 {
		// Single chain (Service subject): the one route covers the whole downstream.
		// Pool every passed port across the single route(s).
		downgrade(0, len(t.Downstream), anyPassedPorts(passed))
		return
	}
	for _, b := range branches {
		if ports, ok := branchPassedPorts(passed, t.Downstream[b.start].Resource); ok {
			downgrade(b.start, b.end, ports)
		}
	}
}

// reconcileInClusterTargetPort downgrades a static svc:targetport-no-listener
// WARNING to the reassuring info note on any Service hop whose suspect ports were
// all covered by REAL in-cluster traffic. The static path reconciles this off the
// hop's own probes (reconcileTargetPortAdvisory), but the in-cluster flow stamps
// those probes onto the hops only AFTER ApplyInClusterResults re-derives the
// verdict/diagnosis - so the suspect-port suspicion must be cleared here, off the
// passed-backend ports, or the route reads verified-over-real-traffic while the hop
// still condemns the targetPort the live traffic just proved has a listener.
// Mirrors reconcileInClusterPolicy: only a real pass on the exact suspect port
// clears it (a pass whose port couldn't be pinned does not).
func reconcileInClusterTargetPort(t *Trace) {
	passed, anyPass := passedBackends(t)
	if !anyPass {
		return
	}
	downgrade := func(start, end int, ports map[int32]bool) {
		for i := start; i < end && i < len(t.Downstream); i++ {
			h := &t.Downstream[i]
			if h.Meta == nil {
				continue
			}
			idx := findingIndexByCode(h.Findings, "svc:targetport-no-listener")
			if idx < 0 {
				continue
			}
			suspects := metaInt32Slice(h.Meta["targetPortSuspectPorts"])
			if len(suspects) == 0 {
				continue
			}
			allCovered := true
			for _, sp := range suspects {
				if !realPassCoversDenyPort(ports, sp) {
					allCovered = false
					break
				}
			}
			if !allCovered {
				continue
			}
			downgradeTargetPortFinding(&h.Findings[idx])
			sortFindingsBySeverity(h.Findings)
		}
	}
	branches := downstreamBranches(t.Downstream)
	if len(branches) == 0 {
		downgrade(0, len(t.Downstream), anyPassedPorts(passed))
		return
	}
	for _, b := range branches {
		if ports, ok := branchPassedPorts(passed, t.Downstream[b.start].Resource); ok {
			downgrade(b.start, b.end, ports)
		}
	}
}

// passedBackends maps "name\x00namespace" → the set of ports confirmed reachable
// over REAL in-cluster traffic for that backend (a port of 0 marks a pass whose
// port couldn't be pinned). Keyed by name AND namespace so a pass on nsA/svc
// can't silence a prediction scoped to nsB/svc.
func passedBackends(t *Trace) (map[string]map[int32]bool, bool) {
	passed := map[string]map[int32]bool{}
	anyPass := false
	for _, r := range t.Routes {
		if r.Confidence != ConfidenceReal {
			continue
		}
		if r.Outcome != OutcomeVerified && r.Outcome != OutcomeReached {
			continue
		}
		anyPass = true
		name, port := splitTargetPort(r.Target)
		key := name + "\x00" + r.TargetNamespace
		if passed[key] == nil {
			passed[key] = map[int32]bool{}
		}
		passed[key][port] = true
	}
	return passed, anyPass
}

func branchPassedPorts(passed map[string]map[int32]bool, res ResourceRef) (map[int32]bool, bool) {
	p, ok := passed[res.Name+"\x00"+res.Namespace]
	return p, ok
}

// anyPassedPorts unions every passed-port set - used for the single-chain Service
// subject where the one route's pass covers the whole downstream.
func anyPassedPorts(passed map[string]map[int32]bool) map[int32]bool {
	out := map[int32]bool{}
	for _, ports := range passed {
		for p := range ports {
			out[p] = true
		}
	}
	return out
}

// realPassCoversDenyPort reports whether a real pass clears a would-deny scoped
// to denyPort. An all-ports deny (denyPort 0) is cleared by any pass; a
// port-specific deny is cleared only by a pass on that exact port - a pass whose
// port we couldn't pin must not clear a specific-port prediction.
func realPassCoversDenyPort(ports map[int32]bool, denyPort int32) bool {
	if ports == nil {
		return false
	}
	if denyPort == 0 {
		return true
	}
	return ports[denyPort]
}

func splitTargetPort(target string) (string, int32) {
	name := target
	var port int32
	if i := strings.LastIndex(name, ":"); i > 0 {
		if p, err := strconv.ParseInt(name[i+1:], 10, 32); err == nil {
			port = int32(p)
		}
		name = name[:i]
	}
	return name, port
}

func hopDenyPort(meta map[string]any) int32 {
	if meta == nil {
		return 0
	}
	if v, ok := meta["policyDenyPort"]; ok {
		if p, ok := v.(int32); ok {
			return p
		}
	}
	return 0
}

// Diagnosis is the one-finding-that-matters, hoisted from the path so an agent
// (or the UI) doesn't have to hunt through path[].findings for the cause. Every
// field is PROMOTED from a real finding (or a coverage state) - never
// synthesized. CauseCode is the structured code, but ONLY for the trustworthy
// structural fingerprints (missing-ref / svc:*); a pod-state code (e.g.
// "problem:Completed" on a crashloop) would mislabel, so it is omitted and the
// honest Summary prose carries the diagnosis instead. The name says "code" so a
// consumer never mistakes the enum for the plain-English explanation (Summary).
type Diagnosis struct {
	CauseCode       string       `json:"causeCode,omitempty"`
	Summary         string       `json:"summary"`
	CulpritResource *ResourceRef `json:"culpritResource,omitempty"`
	NextAction      string       `json:"nextAction,omitempty"`
	Command         string       `json:"command,omitempty"`
}

// computeDiagnosis promotes the primary problem on the intended route into a
// Diagnosis, or describes the coverage state when there is no failure to
// explain (reachable only via the proxy, or nothing testable from here).
// Returns nil when every route was verified over real traffic - nothing to
// diagnose. Benign (intentional scale-to-0) routes are NOT treated as a problem
// here; their route already reads amber-benign with its own evidence.
func computeDiagnosis(t *Trace) *Diagnosis {
	if t == nil {
		return nil
	}
	if f, hopRef, ok := primaryProblemFinding(t); ok {
		d := &Diagnosis{
			Summary: firstNonEmpty(f.Cause, f.Message),
			Command: f.Command,
		}
		if trustworthyCauseCode(f.Code) {
			d.CauseCode = f.Code
		}
		// Culprit precedence: the specific object the finding is about (a named
		// Pod) → the named broken route (a missing backend) → the hop the finding
		// hangs on. Most-specific wins.
		switch {
		case f.Resource != nil:
			d.CulpritResource = f.Resource
		case t.BrokenRoute != nil:
			d.CulpritResource = t.BrokenRoute
		default:
			ref := hopRef
			d.CulpritResource = &ref
		}
		if f.Action != "" {
			d.NextAction = f.Action
		} else {
			d.NextAction = "investigate " + refLabel(d.CulpritResource)
		}
		return d
	}
	// A failed route with no classified finding - e.g. a backend that didn't
	// resolve (branchKnownBreak synthesizes evidence from absence, no Finding).
	// Promote the route's own real evidence; do NOT invent a cause code.
	if r, ok := worstNonBenignFailedRoute(t.Routes); ok {
		d := &Diagnosis{Summary: firstNonEmpty(r.Evidence, "route is unreachable")}
		if t.BrokenRoute != nil {
			d.CulpritResource = t.BrokenRoute
		}
		d.NextAction = "investigate " + firstNonEmpty(r.Route, r.Target)
		return d
	}
	if t.Coverage == nil {
		return nil
	}
	// Reachable, but only the apiserver proxy reached it - the real-traffic path
	// was never confirmed. The action is to test from inside the cluster.
	if t.Coverage.Tested > 0 && !anyRealPass(t.Routes) && anyIndirectReach(t.Routes) {
		return &Diagnosis{
			Summary:    "reachable via API server - the real-traffic path wasn't confirmed from here",
			NextAction: "run the in-cluster reachability test to confirm the real path",
		}
	}
	// Probing happened but nothing could actually be tested from this vantage. Lead
	// with the REAL reason there was nothing to test - a generic "couldn't test"
	// reads like a tool failure when the actual cause is actionable. Only when a probe
	// ACTUALLY ran - a static glance (the drawer) hasn't tried anything, so it gets no
	// "couldn't test" diagnosis.
	if t.Coverage.Tested == 0 && t.Coverage.Skipped > 0 && anyProbeRan(t) {
		// Nothing is RUNNING: the dominant fact is the workload, not the vantage.
		if hopsHaveScaleZero(t.Downstream) {
			return &Diagnosis{
				Summary:    "no running pods - the backing workload is scaled to 0, so there's nothing to reach",
				NextAction: "scale the workload up to test it (e.g. kubectl scale --replicas=1), or leave it if it's intentionally idle",
			}
		}
		// A skip we can act on DIRECTLY (HTTPS / non-HTTP that the proxy can't verify):
		// name the reason and hand over the exact command, not a vague in-cluster nudge.
		if len(t.NotTested) > 0 && t.NotTested[0].Command != "" {
			return &Diagnosis{
				Summary:    "couldn't verify from here - " + t.NotTested[0].Reason,
				NextAction: t.NotTested[0].Command,
			}
		}
		return &Diagnosis{
			Summary:    "couldn't actively test any route from here",
			NextAction: "run the in-cluster reachability test to confirm the real path",
		}
	}
	return nil
}

// realPassByBranch maps each downstream hop index to whether its branch's route
// was confirmed reachable over REAL traffic (direct dial / in-cluster data path).
// Used to demote a contradicted static would-deny prediction from the diagnosis.
func realPassByBranch(t *Trace) map[int]map[int32]bool {
	out := map[int]map[int32]bool{}
	passed, anyPass := passedBackends(t)
	if !anyPass {
		return out
	}
	branches := downstreamBranches(t.Downstream)
	if len(branches) == 0 {
		// Single chain (Service subject): the one route covers the whole downstream.
		ports := anyPassedPorts(passed)
		for i := range t.Downstream {
			out[i] = ports
		}
		return out
	}
	for _, b := range branches {
		if ports, ok := branchPassedPorts(passed, t.Downstream[b.start].Resource); ok {
			for i := b.start; i < b.end && i < len(t.Downstream); i++ {
				out[i] = ports
			}
		}
	}
	return out
}

// primaryProblemFinding returns the worst-severity critical/warning finding on
// the intended route, with the hop resource it hangs on. Anchors on the break
// hop (BrokenAt) and its downstream when one is set, else scans the whole
// downstream (a missing-ref break is expressed on the entry hop). Benign
// scale-to-0 findings are skipped - they are not a problem to diagnose.
func primaryProblemFinding(t *Trace) (Finding, ResourceRef, bool) {
	type cand struct {
		f     Finding
		hop   ResourceRef
		depth int
	}
	var cands []cand
	passed := realPassByBranch(t)
	gather := func(hops []Hop, base int) {
		for i, h := range hops {
			for _, f := range h.Findings {
				if isScaleZeroFinding(f) {
					continue
				}
				// A static would-deny is a PREDICTION, not ground truth. Once real
				// traffic actually passed this branch ON THE DENIED PORT (direct dial
				// or in-cluster data path), the prediction is contradicted and must not
				// lead the diagnosis - demote it out of the candidates. A pass on a
				// different port leaves the prediction standing.
				if f.Code == codePolicyWouldDeny && realPassCoversDenyPort(passed[base+i], hopDenyPort(h.Meta)) {
					continue
				}
				if f.Severity == SeverityCritical || f.Severity == SeverityWarning {
					cands = append(cands, cand{f, h.Resource, base + i})
				}
			}
		}
	}
	if t.BrokenAt >= 0 && t.BrokenAt < len(t.Downstream) {
		// For a multi-backend entry the flat downstream concatenates independent
		// branches. Bound the gather to the branch that actually contains BrokenAt
		// so a sibling route's finding can't be promoted as this route's culprit.
		if span, ok := branchContaining(t.Downstream, t.BrokenAt); ok {
			gather(t.Downstream[span.start:span.end], span.start)
		} else {
			gather(t.Downstream[t.BrokenAt:], t.BrokenAt)
		}
	}
	if len(cands) == 0 {
		gather(t.Downstream, 0)
	}
	if len(cands) == 0 {
		return Finding{}, ResourceRef{}, false
	}
	// Rank: worst severity first; then prefer a finding that names a specific
	// object (a Pod-level root cause) over a hop-level SYMPTOM - a crashloop pod
	// is the real culprit, the Service's "no ready endpoints" is just its shadow;
	// then the deepest hop (root cause sits downstream of the symptom); then code
	// for a stable tiebreak.
	sort.SliceStable(cands, func(i, j int) bool {
		ri, rj := severityRank(cands[i].f.Severity), severityRank(cands[j].f.Severity)
		if ri != rj {
			return ri > rj
		}
		si, sj := cands[i].f.Resource != nil, cands[j].f.Resource != nil
		if si != sj {
			return si
		}
		if cands[i].depth != cands[j].depth {
			return cands[i].depth > cands[j].depth
		}
		return cands[i].f.Code < cands[j].f.Code
	})
	return cands[0].f, cands[0].hop, true
}

// trustworthyCauseCode reports whether a finding code is a structural fingerprint
// safe to surface as the Diagnosis.CauseCode. Only the network-shape detectors
// qualify (missing-ref, svc:* - scaled-to-zero, no-ready-endpoints,
// targetport-no-listener, …). A pod-state issue code ("problem:Completed",
// "problem:CrashLoopBackOff") reflects transient runtime state and would
// mislabel the cause, so it is excluded - the honest prose Summary stands alone.
func trustworthyCauseCode(code string) bool {
	if code == "" {
		return false
	}
	return IsMissingRefCode(code) || strings.HasPrefix(code, "svc:")
}

// isScaleZeroFinding matches the intentional scale-to-0 marker in either form
// (the raw detection fingerprint, or the "<source>:<reason>" code that issue
// grouping leaves) - mirrors hopsHaveScaleZero.
func isScaleZeroFinding(f Finding) bool {
	return f.Code == k8s.ScaledToZeroFingerprint || strings.HasSuffix(f.Code, k8s.ScaledToZeroReason)
}

func worstNonBenignFailedRoute(routes []RouteResult) (RouteResult, bool) {
	var best RouteResult
	found := false
	for _, r := range routes {
		if r.Benign {
			continue
		}
		switch r.Outcome {
		case OutcomeUnreachable:
			return r, true // worst failure - return immediately
		case OutcomeServerError:
			if !found {
				best, found = r, true
			}
		}
	}
	return best, found
}

// allPassesIndirect reports whether every reachable (verified/reached) route was
// reached ONLY via the apiserver proxy - at least one such pass exists and none
// over the real-traffic path. When true the multi-route headline must say
// proxy-only, mirroring singleRouteHeadline, instead of bare "All N reachable".
func allPassesIndirect(routes []RouteResult) bool {
	return !anyRealPass(routes) && anyIndirectReach(routes)
}

func anyIndirectReach(routes []RouteResult) bool {
	for _, r := range routes {
		if r.Confidence == ConfidenceIndirect && (r.Outcome == OutcomeVerified || r.Outcome == OutcomeReached) {
			return true
		}
	}
	return false
}

func refLabel(r *ResourceRef) string {
	if r == nil {
		return "the path"
	}
	name := r.Name
	if r.Namespace != "" {
		name = r.Namespace + "/" + r.Name
	}
	if r.Kind != "" {
		return r.Kind + " " + name
	}
	return name
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// CoverageVerdict is the shipped verdict, reconciled with the coverage projection
// so it cannot contradict the headline or routes (bug B3). It reuses the internal
// verdict for broken, degraded, and unknown, which are already honest, and only
// corrects the one over-claim: a healthy verdict whose only verifying evidence is
// the apiserver proxy (indirect) is not a confident green (#1a/B3), because the
// proxy reached a pod but never confirmed the real-traffic path. That downgrades
// to unknown, and the headline and routes explain why. It is computed once over
// the internal verdict and coverage, then stored back into t.Verdict (in
// BuildTraceWithOptions and ApplyInClusterResults), so every surface (REST, UI,
// MCP) reads one answer. It is idempotent: re-running it on the stored value
// returns the same verdict.
func CoverageVerdict(t *Trace) string {
	if t == nil {
		return VerdictUnknown
	}
	// broken / degraded / unknown from the internal verdict are already honest,
	// EXCEPT: an intentional scale-to-0 reads as broken via the probe (no ready
	// endpoints), but it's deliberate dormancy, not an outage - soften
	// broken → degraded when every failed route is benign.
	if t.Verdict != VerdictHealthy {
		// Soften broken → degraded ONLY when the broken-ness is attributable to the
		// benign routes. allFailuresBenign inspects route outcomes alone, so an
		// unrelated static critical (e.g. no resolvable IngressClass) alongside one
		// benign scale-to-0 route would otherwise be under-reported as amber.
		if t.Verdict == VerdictBroken && allFailuresBenign(t.Routes) && !hasNonBenignCriticalFinding(t) {
			return VerdictDegraded
		}
		return t.Verdict
	}
	c := t.Coverage
	if c == nil {
		// No active probing was attempted (e.g. probe=false, or a config-only
		// shape like ExternalName) - the static config assessment stands.
		return VerdictHealthy
	}
	if c.Tested == 0 {
		// Probing happened but nothing was actually tested (every intended route
		// was skipped / unreachable from here) - not a confident green; the
		// "couldn't test any route" headline must not sit beside "healthy".
		return VerdictUnknown
	}
	if !anyRealPass(t.Routes) {
		// Every reachable route was reached ONLY via the apiserver proxy - the
		// real-traffic path was never confirmed (#1a/B3).
		return VerdictUnknown
	}
	if c.Failed > 0 {
		// A real pass exists, but other ports/routes failed. The internal verdict
		// can read healthy while a dead secondary port leaves Coverage.Failed>0 and
		// the headline says "1 of 2 ports reachable · 1 unreachable" - green here
		// would contradict the headline (the B3 contradiction this guard prevents).
		if c.Passed == 0 {
			return VerdictBroken
		}
		return VerdictDegraded
	}
	return VerdictHealthy
}

// anyRealPass reports whether at least one intended route was reached over the
// REAL-traffic path (direct dial / in-cluster data path) - not merely via the
// apiserver proxy. Indirect-only evidence never earns a confident healthy.
// allFailuresBenign reports whether there is at least one failed route and EVERY
// failed (unreachable/server-error) route is benign (intentional scale-to-0).
func allFailuresBenign(routes []RouteResult) bool {
	failed := 0
	for _, r := range routes {
		if r.Outcome == OutcomeUnreachable || r.Outcome == OutcomeServerError {
			failed++
			if !r.Benign {
				return false
			}
		}
	}
	return failed > 0
}

// hasNonBenignCriticalFinding reports whether any hop carries a critical finding
// that isn't a benign scale-to-0 marker - i.e. a real structural break that must
// not be softened away just because the failed ROUTES happen to be benign.
func hasNonBenignCriticalFinding(t *Trace) bool {
	for _, hop := range t.Downstream {
		if hopHasNonBenignCritical(hop.Findings) {
			return true
		}
	}
	// An upstream missing-ref critical is about a SIBLING backend route, not the
	// path into this subject (which exists as a backend) - scope it out exactly as
	// computeVerdict's nonMissingRefFindings does, so a broken sibling doesn't block
	// the broken→degraded softening for a benign scale-to-0 here.
	for _, hop := range t.Upstreams {
		if hopHasNonBenignCritical(nonMissingRefFindings(hop.Findings)) {
			return true
		}
	}
	return false
}

func hopHasNonBenignCritical(fs []Finding) bool {
	for _, f := range fs {
		if f.Severity == SeverityCritical && !isScaleZeroFinding(f) {
			return true
		}
	}
	return false
}

func anyRealPass(routes []RouteResult) bool {
	for _, r := range routes {
		if r.Confidence != ConfidenceReal {
			continue
		}
		if r.Outcome == OutcomeVerified || r.Outcome == OutcomeReached {
			return true
		}
	}
	return false
}

// buildRoutes derives one RouteResult per intended route. For a multi-backend
// entry it walks downstreamBranches; for a Service/single-chain subject it
// yields a single route over the whole downstream. Returns the routes plus the
// branches that were genuinely un-probed with no break (surfaced as NotTested)
// - a declared route must never silently vanish.
// externalNameHop returns the alias-host hop of an ExternalName Service path (a
// DNS CNAME to a host outside the cluster), or nil. That hop carries the real
// reachability probes; the Service hop above it has no ClusterIP/ports to dial.
func externalNameHop(hops []Hop) *Hop {
	for i := range hops {
		if hops[i].Resource.Kind == "ExternalName" {
			return &hops[i]
		}
	}
	return nil
}

// anyProbeRan reports whether any active probe actually executed on this trace. A
// STATIC (un-probed) trace still produces skipped routes (buildRoutes marks them
// "not actively tested"), which must NOT read as "Couldn't actively test any route
// from here" - that wording is for a trace that DID probe and found everything
// unprobeable from this vantage. No probes at all = "not tested yet", not "couldn't".
func anyProbeRan(t *Trace) bool {
	for _, h := range t.Downstream {
		if len(h.Probes) > 0 {
			return true
		}
	}
	for _, h := range t.Upstreams {
		if len(h.Probes) > 0 {
			return true
		}
	}
	return false
}

// probesHaveInClusterVantage reports whether any non-skipped probe actually ran
// from inside the cluster - the only vantage that proves real in-cluster reachability.
func probesHaveInClusterVantage(probes []probe.Result) bool {
	for _, p := range probes {
		if !p.Skipped && p.Vantage == probe.VantageInCluster {
			return true
		}
	}
	return false
}

func buildRoutes(t *Trace) ([]RouteResult, []RouteSkip) {
	if len(t.Downstream) == 0 {
		return nil, nil
	}
	entry := t.Downstream[0]
	branches := downstreamBranches(t.Downstream)
	var out []RouteResult
	var unprobed []RouteSkip

	if len(branches) == 0 {
		// ExternalName Service: the alias-host hop (below the Service) carries the
		// real reachability test - DNS-resolve + HTTP-reach the external host. The
		// Service hop itself has no ClusterIP/ports to dial, so its OWN probes are
		// empty; the route's outcome IS the external host's reachability.
		if ext := externalNameHop(t.Downstream); ext != nil && len(ext.Probes) > 0 {
			if r, ok := routeFromProbes(subjectRouteLabel(t.Subject, entry), ext.Resource.Name, ext.Probes); ok {
				// A laptop dials the external host from Radar's OWN network - that is
				// NOT proof of real in-cluster reachability (split-horizon DNS, egress
				// rules, and routing can all differ inside the cluster). Only an
				// in-cluster vantage earns ConfidenceReal; otherwise it's indirect, so
				// the verdict reads "reached" with a caveat, never a green "verified".
				if r.Confidence == ConfidenceReal && !probesHaveInClusterVantage(ext.Probes) {
					r.Confidence = ConfidenceIndirect
				}
				return []RouteResult{r}, nil
			}
		}
		// Single chain (Service/Pod subject). The Service hop's OWN probes are the
		// intended-route test, one route per Service port; the Pods-hop probes sit
		// behind the Service, so they're localization, never a separate route.
		podLoc := factsFromProbes(downstreamProbes(t.Downstream[1:]))
		routes := routesByPort(subjectRouteLabel(t.Subject, entry), entry.Resource.Name, subjectTarget(entry), entry.Probes, nil, podLoc)
		setTargetNamespace(routes, entry.Resource.Namespace)
		markBenignScaleZero(routes, entry)
		attachInClusterRequest(routes, "", "", entry.Config)
		return routes, nil
	}

	for _, b := range branches {
		backend := t.Downstream[b.start]
		// A Gateway's attached route is a parallel ENTRY path, traced as its own
		// subject - NOT a resolvable Service backend of this Gateway. It carries no
		// Config/probes here, so condemning it as an unreachable backend (the
		// Config==nil arm of branchKnownBreak) would false-condemn every healthy
		// attached route. Exclude it from routes; its own skipped probe surfaces as
		// a NotTested coverage gap instead.
		if strings.HasPrefix(backend.Edge, "Gateway->") {
			continue
		}
		labels := routeLabelsForBackend(entry, backend.Resource.Name, backend.Resource.Namespace)
		routeID := strings.Join(labels, ", ")
		if routeID == "" {
			routeID = backend.Resource.Name
		}
		// A drained (explicit weight-0) backend carries no traffic by design - it
		// was traced informationally and never probed. Record it as a benign skip
		// (no coverage lost) instead of a coverage gap or a failed route.
		if isDrainedBackendHop(backend) {
			unprobed = append(unprobed, RouteSkip{
				Route:       routeID,
				Reason:      "backend is weighted to 0 (drained / canary-cutover) - serves no traffic by design",
				ReasonClass: SkipClassBenign,
			})
			continue
		}
		target := backend.Resource.Name
		if backend.Config != nil && len(backend.Config.Ports) > 0 {
			target = fmt.Sprintf("%s:%d", backend.Resource.Name, backend.Config.Ports[0].Port)
		}
		// A KNOWN static break (missing backend, critical finding) is a FAILED
		// route REGARDLESS of whether the shared front door dialed OK - a working
		// front door doesn't make a route to a non-existent backend reachable.
		if ev, broken := branchKnownBreak(t, entry, b); broken {
			out = append(out, RouteResult{Route: routeID, Target: target, Outcome: OutcomeUnreachable, Evidence: ev})
			continue
		}
		// Front-door (entry) host dials are shared, port-agnostic context for this
		// backend's routes; the backend Service hop's probes carry the per-port
		// outcome; the Pods hop sits behind the Service → localization. Scope to
		// the port(s) the rules declare for this backend (an Ingress route targets
		// a specific port) - empty/unresolvable scope means all probed ports.
		end := b.end
		if end > len(t.Downstream) {
			end = len(t.Downstream)
		}
		shared := entryProbesForHosts(entry, hostsOf(labels))
		podLoc := factsFromProbes(downstreamProbes(t.Downstream[b.start+1 : end]))
		outcomeProbes := append(append([]probe.Result{}, shared...), backend.Probes...)
		scope := backendDeclaredPorts(entry, backend.Resource.Name, backend.Resource.Namespace, backend.Config)
		routes := routesByPort(routeID, backend.Resource.Name, target, outcomeProbes, scope, podLoc)
		if len(routes) > 0 {
			setTargetNamespace(routes, backend.Resource.Namespace)
			markBenignScaleZero(routes, backend)
			host, path := firstRuleHostPath(entry, backend.Resource.Name, backend.Resource.Namespace)
			attachInClusterRequest(routes, host, path, backend.Config)
			out = append(out, routes...)
			continue
		}
		// Not a known break and no probe result → a genuine coverage gap.
		unprobed = append(unprobed, RouteSkip{Route: routeID, Reason: "route not actively tested", ReasonClass: SkipClassCoverage})
	}
	// A Gateway subject's attached routes were all skipped above (each is its own
	// entry path). Surface the Gateway's OWN front-door reachability as the route
	// so its probe evidence isn't dropped and coverage doesn't read empty.
	if entry.Resource.Kind == "Gateway" && len(out) == 0 {
		gw := routesByPort(subjectRouteLabel(t.Subject, entry), entry.Resource.Name, subjectTarget(entry), entry.Probes, nil, nil)
		setTargetNamespace(gw, entry.Resource.Namespace)
		out = append(out, gw...)
	}
	return out, unprobed
}

// setTargetNamespace stamps the backend Service namespace on each route so the
// in-cluster probe can build an FQDN dial for cross-namespace backends.
func setTargetNamespace(routes []RouteResult, namespace string) {
	for i := range routes {
		routes[i].TargetNamespace = namespace
	}
}

// markBenignScaleZero flags an unreachable route as benign when a contributing
// hop carries the intentional-scale-to-0 finding - deliberate dormancy, not an
// outage. The Outcome stays unreachable (factually true); only the framing softens.
func markBenignScaleZero(routes []RouteResult, hops ...Hop) {
	if !hopsHaveScaleZero(hops) {
		return
	}
	for i := range routes {
		if routes[i].Outcome == OutcomeUnreachable {
			routes[i].Benign = true
			routes[i].Evidence = "no running backends (scaled to 0)"
		}
	}
}

func hopsHaveScaleZero(hops []Hop) bool {
	for _, h := range hops {
		for _, f := range h.Findings {
			// The detection carries a stable Fingerprint, but issue grouping
			// (RelatedIssues) does not preserve it on the grouped representative,
			// so the trace usually sees the "<source>:<reason>" code instead.
			// Match either form against the shared constants.
			if f.Code == k8s.ScaledToZeroFingerprint || strings.HasSuffix(f.Code, k8s.ScaledToZeroReason) {
				return true
			}
		}
	}
	return false
}

// routesByPort emits one RouteResult per (backend, port), the unit of coverage:
// a port is part of the intended-route identity (svc:80 = the app, svc:9090 =
// metrics - different listeners). Port-0 probes (host-level DNS / front-door
// dials) are shared context applied to every port. scope, when non-empty,
// restricts output to those ports (an Ingress route targets a declared port);
// empty scope means every probed port is an intended route (a Service subject's
// own ports). fallbackTarget labels the host-level route when no per-port probe
// ran. extraLoc (the behind-the-gate pod facts) is appended to every route.
func routesByPort(routeID, backendName, fallbackTarget string, probes []probe.Result, scope []int32, extraLoc []ProbeFact) []RouteResult {
	inScope := func(port int32) bool {
		if len(scope) == 0 {
			return true
		}
		for _, s := range scope {
			if s == port {
				return true
			}
		}
		return false
	}
	var shared []probe.Result
	byPort := map[int32][]probe.Result{}
	var order []int32
	for _, p := range probes {
		if p.Port == 0 {
			shared = append(shared, p)
			continue
		}
		if !inScope(p.Port) {
			continue
		}
		if _, ok := byPort[p.Port]; !ok {
			order = append(order, p.Port)
		}
		byPort[p.Port] = append(byPort[p.Port], p)
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })

	emit := func(rid, target string, ps []probe.Result) (RouteResult, bool) {
		r, ok := routeFromProbes(rid, target, ps)
		if !ok {
			return r, false
		}
		r.Localization = dedupeFacts(append(r.Localization, extraLoc...))
		return r, true
	}

	if len(order) == 0 {
		// No per-port probe ran - a single host-level route (DNS-only / front door).
		if r, ok := emit(routeID, fallbackTarget, shared); ok {
			return []RouteResult{r}
		}
		return nil
	}
	// A host-level (Port==0) front-door probe is port-agnostic CONTEXT: its "/" 2xx
	// says the front door is reachable, NOT that THIS backend port's declared
	// path/protocol is. So when combined with a specific port's probes it must not,
	// on its own, VERIFY that port - cap a front-door HTTP 2xx at "reached" here, so
	// a port whose own probes all skipped reads "reached, route not verified" instead
	// of a false green "verified". The port's OWN healthy probe still wins to verified.
	demotedShared := demoteSharedFrontDoor(shared)
	multi := len(order) > 1
	var out []RouteResult
	for _, port := range order {
		ps := append(append([]probe.Result{}, demotedShared...), byPort[port]...)
		target := fmt.Sprintf("%s:%d", backendName, port)
		rid := routeID
		if multi {
			rid = target // distinguish multiple ports of the same backend
		}
		if r, ok := emit(rid, target, ps); ok {
			out = append(out, r)
		}
	}
	return out
}

// demoteSharedFrontDoor caps host-level (port-agnostic) front-door probes so they
// can't, on their own, VERIFY a specific backend port route: an HTTP 2xx to the
// front door's "/" is reachability CONTEXT, not proof that this port's declared
// path/protocol serves. A healthy front-door HTTP probe is demoted to the "reached"
// tone (worstOutcome then yields at most OutcomeReached for a port whose own probes
// didn't independently verify); the port's OWN healthy probe still wins to verified.
// Non-HTTP and failing front-door probes are passed through unchanged.
func demoteSharedFrontDoor(shared []probe.Result) []probe.Result {
	if len(shared) == 0 {
		return shared
	}
	out := make([]probe.Result, len(shared))
	for i, p := range shared {
		if p.OK && !p.Skipped && p.Layer == probe.LayerHTTP && p.Tone == probe.ToneHealthy {
			p.Tone = probe.ToneReached
		}
		out[i] = p
	}
	return out
}

// downstreamProbes flattens the probes across a set of hops.
func downstreamProbes(hops []Hop) []probe.Result {
	var out []probe.Result
	for _, h := range hops {
		out = append(out, h.Probes...)
	}
	return out
}

// dedupeFacts removes exact-duplicate Localization facts (same layer, target,
// ok, tone, detail, path) - the pod-fanout and per-port projections can append
// the identical apiserver fact twice. It dedupes on EVERY field rather than
// normalizing the target, so a pod-level confirmation is never collapsed into a
// service-level one (that would hide which pod answered).
func dedupeFacts(facts []ProbeFact) []ProbeFact {
	if len(facts) <= 1 {
		return facts
	}
	seen := make(map[string]bool, len(facts))
	out := facts[:0:0]
	for _, f := range facts {
		key := f.Layer + "\x00" + f.Path + "\x00" + f.Target + "\x00" + strconv.FormatBool(f.OK) + "\x00" + f.Tone + "\x00" + f.Detail
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, f)
	}
	return out
}

// factsFromProbes projects non-skipped probes to behind-the-gate Localization facts.
func factsFromProbes(probes []probe.Result) []ProbeFact {
	var out []ProbeFact
	for _, p := range probes {
		if p.Skipped {
			continue
		}
		out = append(out, toFact(p))
	}
	return out
}

// backendDeclaredPorts returns the resolved Service ports the entry's rules
// declare for a backend (an Ingress/route backendRef names a specific port).
// Empty when no rule names a resolvable port - the caller then covers all
// probed ports.
func backendDeclaredPorts(entry Hop, backendName, backendNS string, cfg *HopConfig) []int32 {
	if entry.Config == nil || backendName == "" {
		return nil
	}
	seen := map[int32]bool{}
	var out []int32
	for _, rule := range entry.Config.Rules {
		for _, b := range rule.Backends {
			if !backendRefMatches(b, backendName, entry.Resource.Namespace, backendNS) {
				continue
			}
			if p := resolveBackendPort(b.Port, cfg); p > 0 && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// resolveBackendPort turns a backendRef port (numeric or a named Service port)
// into a port number, using the backend Service's port map for named ports.
func resolveBackendPort(portStr string, cfg *HopConfig) int32 {
	if portStr == "" {
		return 0
	}
	if n, err := strconv.ParseInt(portStr, 10, 32); err == nil {
		return int32(n)
	}
	if cfg != nil {
		for _, pm := range cfg.Ports {
			if pm.Name == portStr {
				return pm.Port
			}
		}
	}
	return 0
}

// branchKnownBreak reports whether a branch that produced no probe result is
// nonetheless a KNOWN static break, with evidence for the failed route. Signals:
// a missing-backend ref on the entry naming this backend (reuses the shared
// missingRefCodePrefix - no prose-sniffing), a critical finding on the branch,
// or a backend Service that didn't resolve (no Config).
func branchKnownBreak(t *Trace, entry Hop, b branchSpan) (string, bool) {
	backend := t.Downstream[b.start]
	for _, f := range entry.Findings {
		if strings.HasPrefix(f.Code, missingRefCodePrefix) && backend.Resource.Name != "" && missingRefMatchesBackend(f.Message, backend.Resource.Name, backend.Resource.Namespace) {
			return f.Message, true
		}
	}
	for i := b.start; i < b.end && i < len(t.Downstream); i++ {
		// A backend that still has ready endpoints is reachable - a per-pod crash
		// among serving replicas is a degradation, not a known break. Skip it so a
		// 1-of-2-ready Service isn't condemned unreachable (mirrors hopReachSeverity).
		if hopHasReadyEndpoints(t.Downstream[i]) {
			continue
		}
		for _, f := range t.Downstream[i].Findings {
			if f.Severity == SeverityCritical {
				return f.Message, true
			}
		}
	}
	if backend.Config == nil {
		// A backend we merely couldn't READ (RBAC-redacted cross-namespace, or a
		// transient API failure marked endpointSource=unknown) has no Config but is
		// NOT a confirmed break. Condemning it as unreachable would false-condemn a
		// route the caller can't see - fall through to the unprobed/NotTested path
		// so it reads as not-tested/unknown, matching the verdict layer.
		if src, _ := backend.Meta["endpointSource"].(string); src == "unknown" {
			return "", false
		}
		for _, f := range backend.Findings {
			if f.Code == "rbac:cross-namespace-redacted" {
				return "", false
			}
		}
		return fmt.Sprintf("backend %s %s could not be resolved", backend.Resource.Kind, backend.Resource.Name), true
	}
	return "", false
}

// missingRefMatchesBackend reports whether a missing-ref finding message names
// THIS backend (by name and, when the message carries a namespace qualifier,
// namespace). Gateway-API messages read "...references Service "api" in namespace
// "nsA" which does not exist..."; without the namespace check a missing nsA/api
// would condemn a healthy same-named nsB/api sibling.
func missingRefMatchesBackend(msg, name, namespace string) bool {
	if !containsResourceName(msg, name) {
		return false
	}
	if i := strings.Index(msg, "in namespace "); i >= 0 && namespace != "" {
		return containsResourceName(msg[i:], namespace)
	}
	return true
}

// MissingRefNamesSubject reports whether a missing-ref finding message names the
// given subject (by name and, when the message qualifies it, namespace). Exported
// so the MCP projection can keep a subject-relevant missing-ref (e.g. an upstream
// Ingress referencing the subject Service on a port it doesn't expose) while still
// dropping a sibling-route missing-ref that only condemns the upstream's other
// backends.
func MissingRefNamesSubject(msg, name, namespace string) bool {
	return missingRefMatchesBackend(msg, name, namespace)
}

// containsResourceName reports whether name appears in s as a whole Kubernetes
// resource name - bounded by characters that can't be part of a DNS-1123 name,
// so backend "api" does NOT match inside a missing-ref message about "api-v2" or
// "my-api". A raw substring match would condemn a healthy same-prefixed sibling.
func containsResourceName(s, name string) bool {
	if name == "" {
		return false
	}
	for from := 0; ; {
		i := strings.Index(s[from:], name)
		if i < 0 {
			return false
		}
		i += from
		var before, after byte = ' ', ' '
		if i > 0 {
			before = s[i-1]
		}
		if i+len(name) < len(s) {
			after = s[i+len(name)]
		}
		if !isNameByte(before) && !isNameByte(after) {
			return true
		}
		from = i + 1
	}
}

func isNameByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '-' || b == '.'
}

// routeFromProbes computes a route's outcome from its probe set. Returns ok=false
// when no non-skipped probe ran (the route is "not tested", handled elsewhere).
func routeFromProbes(routeID, target string, probes []probe.Result) (RouteResult, bool) {
	var real, indirect []probe.Result
	var localization []ProbeFact
	for _, p := range probes {
		if p.Skipped {
			continue
		}
		if p.Path == probe.PathAPIServer {
			// Behind-the-gate evidence: it confirms a component answers, but not
			// via real traffic. Localization-only - never the route's outcome.
			indirect = append(indirect, p)
			localization = append(localization, toFact(p))
		} else {
			real = append(real, p)
		}
	}
	if len(real) == 0 && len(indirect) == 0 {
		return RouteResult{}, false
	}
	r := RouteResult{Route: routeID, Target: target, Localization: localization}
	if len(real) > 0 {
		r.Outcome, r.Evidence, r.FailedLayer = worstOutcome(real)
		r.Confidence = ConfidenceReal
	} else {
		// Only the apiserver proxy reached it: indirect evidence. We record the
		// outcome it observed, but Confidence=indirect means it must NEVER be
		// read as a real-traffic pass/fail (the headline rule enforces that).
		r.Outcome, r.Evidence, r.FailedLayer = worstOutcome(indirect)
		r.Confidence = ConfidenceIndirect
	}
	return r, true
}

// worstOutcome reduces a probe set to one outcome. Precedence: any transport
// failure -> unreachable; else a degraded layer -> server-error; else an HTTP 2xx
// -> verified; else reached (3xx/4xx, or a transport-only TCP/TLS success that
// didn't verify an HTTP response). Evidence is the deciding probe's detail.
// failedLayer names WHICH layer failed on a non-reachable outcome ("tcp"/"tls"/
// "http" for unreachable; "tls" for a cert failure; "upstream" for a 502/504 where
// HTTP was reached but the gateway couldn't reach its backend) and is empty for a
// reachable outcome.
func worstOutcome(probes []probe.Result) (outcome, evidence, failedLayer string) {
	httpVerified := false
	transportReached := false // a non-DNS layer actually confirmed reachability
	for _, p := range probes {
		detail := probeDetail(p)
		if !p.OK || p.Tone == probe.ToneUnhealthy {
			// The failing layer names where the path broke: a TCP connect, a TLS
			// handshake, or an HTTP request that got no response back.
			return OutcomeUnreachable, detail, string(p.Layer)
		}
		if p.Tone == probe.ToneDegraded {
			// A degraded probe still reached the responder. Name the layer honestly.
			switch p.Layer {
			case probe.LayerTLS:
				// A cert verification failure (expired / wrong host). A valid cert that
				// only expires soon is NOT degraded - it stays reachable (probe.go).
				return OutcomeServerError, detail, "tls"
			case probe.LayerHTTP:
				// A 502/504: HTTP was reached (a response came back), whose meaning is
				// that this gateway couldn't reach its upstream - an upstream fault,
				// never an HTTP failure.
				return OutcomeServerError, detail, "upstream"
			default:
				// No other layer sets ToneDegraded today; name the layer rather than
				// silently mislabeling a future one as "upstream".
				return OutcomeServerError, detail, string(p.Layer)
			}
		}
		if p.Layer == probe.LayerDNS {
			// A name resolving is not transport reachability. Record it as evidence
			// but never let a DNS-only success read as "server reached" - that
			// overclaims reachability from a name lookup (the host may be internal /
			// split-horizon with TCP/TLS/HTTP skipped from this vantage).
			if evidence == "" {
				evidence = detail
			}
			continue
		}
		if p.Tone == probe.ToneHealthy && p.Layer == probe.LayerHTTP {
			httpVerified = true
		}
		transportReached = true
		if evidence == "" {
			evidence = detail
		}
	}
	if httpVerified {
		return OutcomeVerified, evidence, ""
	}
	if transportReached {
		// Reached the server (3xx/4xx) or only a transport layer (TCP/TLS)
		// succeeded: reachable, but the exact HTTP route wasn't verified.
		return OutcomeReached, evidence, ""
	}
	// Only DNS resolved (TCP/TLS/HTTP skipped for a vantage reason): name
	// resolution alone is not server reachability - report not-tested.
	return OutcomeNotTested, evidence, ""
}

// buildNotTested lists every distinct skip on the intended route (DOWNSTREAM
// only - upstreams are context, not the subject's routes), classified. A
// truncated fan-out is itself a coverage gap.
func buildNotTested(t *Trace) []RouteSkip {
	var out []RouteSkip
	seen := map[string]bool{}
	for _, h := range t.Downstream {
		for _, p := range h.Probes {
			if !p.Skipped || p.Reason == "" {
				continue
			}
			key := string(p.Layer) + "|" + p.Target + "|" + p.Reason
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, RouteSkip{
				Route:       p.Target,
				Reason:      p.Reason,
				ReasonClass: skipClassOf(p),
				Command:     p.Command,
			})
		}
	}
	if t.Truncated {
		out = append(out, RouteSkip{
			Reason:      "some backends/routes were not traced (fan-out exceeded the cap)",
			ReasonClass: SkipClassCoverage,
		})
	}
	return out
}

// classifySkip maps a skip reason to its coverage impact. Pod-sampling is the
// only benign case (the unsampled pods are identical replicas); vantage skips
// name an inability to reach FROM HERE; everything else is a real coverage gap.
// skipClassOf returns the coverage class of a skipped probe, preferring the
// structured SkipClass the probe stamped at its skip site. It falls back to
// matching the human Reason text only when the class is unset, so a reworded
// message no longer silently misclassifies a skip that carries the field.
func skipClassOf(p probe.Result) string {
	if p.SkipClass != "" {
		return p.SkipClass
	}
	return classifySkip(p.Reason)
}

func classifySkip(reason string) string {
	low := strings.ToLower(reason)
	switch {
	case strings.Contains(low, "sampled "):
		return SkipClassBenign
	case strings.Contains(low, "from your machine"),
		strings.Contains(low, "from here"),
		strings.Contains(low, "internal address"),
		strings.Contains(low, "run radar in-cluster"),
		strings.Contains(low, "run radar from in-cluster"):
		return SkipClassVantage
	default:
		return SkipClassCoverage
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func toFact(p probe.Result) ProbeFact {
	return ProbeFact{
		Layer:  string(p.Layer),
		Path:   string(p.Path),
		Target: p.Target,
		OK:     p.OK,
		Tone:   string(p.Tone),
		Detail: probeDetail(p),
	}
}

func probeDetail(p probe.Result) string {
	if p.Detail != "" {
		return p.Detail
	}
	return p.Error
}

// routeLabelsForBackend mirrors the TS backendRouteInfo (N4): the route
// identities (host+path, host included only when the entry serves >1 host) that
// select a given backend. Kept in sync with the UI so the matrix and the
// headline name routes the same way.
func routeLabelsForBackend(entry Hop, backendName, backendNS string) []string {
	if entry.Config == nil || backendName == "" {
		return nil
	}
	multiHost := len(entry.Config.Hostnames) > 1
	var labels []string
	seen := map[string]bool{}
	add := func(l string) {
		if l != "" && !seen[l] {
			seen[l] = true
			labels = append(labels, l)
		}
	}
	for _, rule := range entry.Config.Rules {
		hasBackend := false
		for _, b := range rule.Backends {
			if backendRefMatches(b, backendName, entry.Resource.Namespace, backendNS) {
				hasBackend = true
				break
			}
		}
		if !hasBackend {
			continue
		}
		paths := rule.Paths
		if len(paths) == 0 {
			paths = []string{"/"}
		}
		// Gateway-API routes keep hostnames at Config.Hostnames, not per-rule
		// (ingressConfig sets rule.Hosts; routeConfig does not). Fall back to the
		// entry's hostnames so a multi-host route still emits host-qualified
		// labels - otherwise hostsOf() reads empty and every front-door host dial
		// folds into each backend, cross-contaminating sibling hosts' outcomes.
		ruleHosts := rule.Hosts
		if len(ruleHosts) == 0 {
			ruleHosts = entry.Config.Hostnames
		}
		for _, p := range paths {
			if multiHost && len(ruleHosts) > 0 {
				for _, h := range ruleHosts {
					add(routeLabel(h, p))
				}
			} else {
				add(routeLabel("", p))
			}
		}
	}
	return labels
}

// attachInClusterRequest fills each route's best-guess in-cluster request from
// the route's declared host/path and the backend Service port (parsed back from
// the route Target so multi-port routes each get their own scheme).
func attachInClusterRequest(routes []RouteResult, host, path string, cfg *HopConfig) {
	for i := range routes {
		req := guessInClusterRequest(host, path, portFromTarget(routes[i].Target, cfg))
		routes[i].InClusterRequest = &req
	}
}

// guessInClusterRequest derives a concrete, runnable request from a declared
// route. Pattern paths (regex/wildcard) have no single faithful request, so it
// guesses the leading literal and flags PathGuessed - the UI surfaces that and
// lets the user correct it before running.
func guessInClusterRequest(host, path string, port PortMap) ProbeRequest {
	req := ProbeRequest{Scheme: schemeForPort(port), Host: concreteHost(host)}
	req.Path, req.PathGuessed = guessConcretePath(path)
	return req
}

// schemeForPort reads the L7 scheme off the backend Service port: the explicit
// appProtocol hint wins, then a conventional "https" port name, then the 443
// fallback; everything else is plain http.
func schemeForPort(port PortMap) string {
	switch strings.ToLower(port.AppProtocol) {
	case "https", "https2":
		return "https"
	}
	if strings.Contains(strings.ToLower(port.Name), "https") {
		return "https"
	}
	if port.Port == 443 {
		return "https"
	}
	return "http"
}

// concreteHost turns a declared host into one a request can actually send. A
// wildcard host (*.example.com) isn't a real hostname, so it's specialized to a
// plausible concrete subdomain the user can change.
func concreteHost(host string) string {
	host = strings.TrimSpace(host)
	if strings.HasPrefix(host, "*.") {
		return "www." + host[2:]
	}
	return host
}

// pathMetachars are the characters that turn a path into a pattern (Ingress
// ImplementationSpecific regex, nginx regex locations). Their presence means the
// declared path is not a single concrete request.
const pathMetachars = `.*+?()[]{}|^$\`

// guessConcretePath returns a concrete path to request plus whether it was a
// guess. A plain path is used verbatim; a pattern path is reduced to its leading
// literal (everything before the first regex metacharacter), which still matches
// the pattern, and flagged as a guess.
func guessConcretePath(path string) (string, bool) {
	path = strings.TrimSpace(path)
	// Gateway-API routes carry the match type as a display prefix
	// ("Exact:/foo", "RegularExpression:/foo.*"). Strip it so the request path is
	// the real URL, not "/Exact:/foo", and mark the result a guess - a typed
	// match (exact/regex) isn't a plain prefix the direct dial necessarily
	// exercises identically.
	typed := false
	if tag := leadingTypeTag(path); tag != "" {
		path = path[len(tag):]
		typed = true
	}
	if path == "" || path == "/" {
		return "/", typed
	}
	if i := strings.IndexAny(path, pathMetachars); i >= 0 {
		lit := path[:i]
		if lit == "" {
			return "/", true
		}
		return ensureLeadingSlash(lit), true
	}
	return ensureLeadingSlash(path), typed
}

// leadingTypeTag returns a leading "Word:" match-type tag (e.g. "Exact:") when
// the path carries one before the actual "/path", else "". Used to peel the
// Gateway-API display prefix off before building a runnable request path.
func leadingTypeTag(path string) string {
	i := strings.IndexByte(path, ':')
	if i <= 0 || i+1 >= len(path) || path[i+1] != '/' {
		return ""
	}
	for _, r := range path[:i] {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')) {
			return ""
		}
	}
	return path[:i+1]
}

func ensureLeadingSlash(p string) string {
	if !strings.HasPrefix(p, "/") {
		return "/" + p
	}
	return p
}

// portFromTarget parses the "name:port" route Target and returns the matching
// Service PortMap (for its scheme hints); a bare PortMap with just the number
// when the config doesn't carry it.
func portFromTarget(target string, cfg *HopConfig) PortMap {
	num := int32(0)
	if i := strings.LastIndexByte(target, ':'); i >= 0 {
		if n, err := strconv.ParseInt(target[i+1:], 10, 32); err == nil {
			num = int32(n)
		}
	}
	if cfg != nil {
		for _, p := range cfg.Ports {
			if p.Port == num {
				return p
			}
		}
	}
	return PortMap{Port: num}
}

// firstRuleHostPath returns the first declared host+path that selects a backend,
// the representative route for the in-cluster guess.
func firstRuleHostPath(entry Hop, backendName, backendNS string) (host, path string) {
	if entry.Config == nil {
		return "", ""
	}
	for _, rule := range entry.Config.Rules {
		for _, b := range rule.Backends {
			if !backendRefMatches(b, backendName, entry.Resource.Namespace, backendNS) {
				continue
			}
			if len(rule.Hosts) > 0 {
				host = rule.Hosts[0]
			} else if len(entry.Config.Hostnames) > 0 {
				// Gateway-API routes keep their hostnames at spec.hostnames
				// (Config.Hostnames), not on the per-rule match; without this the
				// in-cluster request omits the Host/SNI a route declares.
				host = entry.Config.Hostnames[0]
			}
			if len(rule.Paths) > 0 {
				path = rule.Paths[0]
			}
			return host, path
		}
	}
	return "", ""
}

// backendRefMatches reports whether a route BackendRef points at the given
// backend hop. Names must match; namespaces must match too once the backend's
// namespace is known - a BackendRef with no namespace defaults to the route's
// (entry's) namespace. Without the namespace guard two same-named Services in
// different namespaces (legal via a Gateway-API ReferenceGrant) would merge
// their labels/ports and could verify/condemn the wrong route. When either
// namespace is unknown it falls back to name-only (can't disprove).
func backendRefMatches(b BackendRef, backendName, entryNS, backendNS string) bool {
	if b.Name != backendName {
		return false
	}
	if backendNS == "" {
		return true
	}
	refNS := b.Namespace
	if refNS == "" {
		refNS = entryNS
	}
	if refNS == "" {
		return true
	}
	return refNS == backendNS
}

func routeLabel(host, path string) string {
	if path == "(default backend)" {
		if host != "" {
			return host + " (default backend)"
		}
		return "default backend"
	}
	if host != "" {
		return host + path
	}
	return path
}

// hostsOf extracts the host portion from route labels (the part before the
// first "/"), so entry front-door probes can be matched to a backend's routes.
func hostsOf(labels []string) map[string]bool {
	hosts := map[string]bool{}
	for _, l := range labels {
		if i := strings.IndexByte(l, '/'); i > 0 {
			hosts[l[:i]] = true
		}
	}
	return hosts
}

// entryProbesForHosts returns the entry hop's front-door probes whose target
// host is in the given set - the real-traffic dials that belong to a backend's
// routes. When the entry serves a single host (hosts empty), all entry probes
// apply.
func entryProbesForHosts(entry Hop, hosts map[string]bool) []probe.Result {
	if len(entry.Probes) == 0 {
		return nil
	}
	if len(hosts) == 0 {
		return entry.Probes
	}
	var out []probe.Result
	for _, p := range entry.Probes {
		if hosts[targetHost(p.Target)] {
			out = append(out, p)
		}
	}
	return out
}

// targetHost extracts the host from a probe target. HTTP probes carry a full URL
// (scheme://host[:port]/path) while DNS/TCP/TLS probes carry host[:port]; without
// stripping the scheme+path an HTTP target like "http://host/path" parses to
// "http" and every front-door HTTP probe is dropped from the backend outcome
// (a 5xx/2xx silently lost - a false-clear on multi-host entries).
func targetHost(target string) string {
	if i := strings.Index(target, "://"); i >= 0 {
		target = target[i+3:]
		if j := strings.IndexByte(target, '/'); j >= 0 {
			target = target[:j]
		}
	}
	if i := strings.LastIndexByte(target, ':'); i > 0 {
		// Only strip when the suffix is a port (no other ':' - i.e. not IPv6).
		if !strings.Contains(target[:i], ":") {
			return target[:i]
		}
	}
	return target
}

// routeHostKey reduces a route label or probe target to its bare host so the
// not-tested dedup compares like with like: it strips a scheme, a trailing path,
// and a port (leaving IPv6 colons intact). "http://shop.example.com/api" and
// "shop.example.com:443" both reduce to "shop.example.com".
// routeResultHostKey recovers the front-door host a route's probes target, for
// deduping a NotTested route against its own skipped probe rows (keyed by probe
// Target host). A single-host route's Route label is path-only ("/api") because
// routeLabelsForBackend omits the host when the entry serves one host, so
// reading the host off the label yields "" and the dedup misfires - counting the
// route AND its skip rows. The declared host lives on InClusterRequest (the same
// concretized host the front-door probe dialed), so fall back to it.
func routeResultHostKey(r RouteResult) string {
	if h := routeHostKey(r.Route); h != "" {
		return h
	}
	if r.InClusterRequest != nil {
		return routeHostKey(r.InClusterRequest.Host)
	}
	return ""
}

func routeHostKey(s string) string {
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndexByte(s, ':'); i > 0 && !strings.Contains(s[:i], ":") {
		s = s[:i]
	}
	return s
}

// subjectRouteLabel names the single route for a Service/Pod subject.
func subjectRouteLabel(subject ResourceRef, entry Hop) string {
	if entry.Config != nil && len(entry.Config.Hostnames) > 0 {
		return entry.Config.Hostnames[0]
	}
	if subject.Name != "" {
		return subject.Name
	}
	return entry.Resource.Name
}

func subjectTarget(entry Hop) string {
	if entry.Config != nil && len(entry.Config.Ports) > 0 {
		return fmt.Sprintf("%s:%d", entry.Resource.Name, entry.Config.Ports[0].Port)
	}
	return entry.Resource.Name
}

// CoverageHeadline renders the coverage-honest one-line summary from the
// computed Coverage + Routes. It is the agent/UI primary read and counts only
// INTENDED routes. Invariant: it NEVER claims "verified" for an indirect
// (apiserver) route - behind-the-gate evidence is reported as "reached via the
// management API", never as real-traffic verification.
func CoverageHeadline(t *Trace) string {
	if t == nil || t.Coverage == nil {
		return "Configuration only - not yet tested"
	}
	c := t.Coverage
	// A bare Service subject's intended routes ARE its ports, so the headline
	// speaks of "ports"; an Ingress/Gateway/Route entry speaks of "routes".
	noun := "routes"
	if t.Subject.Kind == "Service" {
		noun = "ports"
	}
	if c.Tested == 0 {
		// "Couldn't actively test" is only honest when a probe ACTUALLY ran and every
		// route skipped from this vantage. An un-probed/static trace (the drawer) has
		// skipped routes only because nothing was tried yet → "not tested yet".
		if c.Skipped > 0 && anyProbeRan(t) {
			return "Couldn't actively test any route from here"
		}
		return "Configuration only - not yet tested"
	}
	// Single intended route/port: speak in the singular, no fraction.
	if c.Tested == 1 && len(t.Routes) == 1 {
		return singleRouteHeadline(t.Routes[0], c.Skipped)
	}
	notTested := ""
	if c.Skipped > 0 {
		notTested = fmt.Sprintf(" · %d not tested", c.Skipped)
	}
	// A server-error route WAS reached (it answered with a 5xx); lumping it into
	// "unreachable" would wrongly imply a dead network path. Separate the two so
	// the headline never says "none reachable" about routes that did respond.
	errored, benignFailed := failureKinds(t.Routes)
	unreachable := c.Failed - errored - benignFailed
	if unreachable < 0 {
		unreachable = 0
	}
	// A proxy-only (indirect) unreachable never condemns the real path - qualify
	// the multi-route headline the same way singleRouteHeadline does, instead of
	// a bare "unreachable" that false-condemns a laptop-vantage failure.
	indirectUnreach := unreachable > 0 && allUnreachableIndirect(t.Routes)
	// When every passing route was reached ONLY via the apiserver proxy, the
	// real-traffic path was never confirmed - say so, mirroring singleRouteHeadline,
	// instead of a bare "reachable" that CoverageVerdict (gating on !anyRealPass)
	// would contradict with unknown (the B3 headline/verdict contradiction).
	proxyOnly := allPassesIndirect(t.Routes)
	switch {
	case c.Failed == 0 && c.Skipped == 0:
		if proxyOnly {
			return fmt.Sprintf("All %d %s reached - checked only via API server, real path not confirmed", c.Tested, noun)
		}
		return fmt.Sprintf("All %d %s reachable", c.Tested, noun)
	case c.Failed == 0:
		// All tested routes passed, but a real coverage gap exists (1A footnote-green).
		if proxyOnly {
			return fmt.Sprintf("All %d tested %s reached - checked only via API server, real path not confirmed%s", c.Tested, noun, notTested)
		}
		return fmt.Sprintf("All %d tested %s reachable%s", c.Tested, noun, notTested)
	case c.Passed == 0 && allFailuresBenign(t.Routes):
		// Every route is a deliberate scale-to-0, not an outage. "None reachable"
		// would frame intentional dormancy as a failure and contradict
		// CoverageVerdict, which softens this to amber degraded.
		return fmt.Sprintf("All %d %s intentionally scaled to 0 (no running backends)%s", c.Tested, noun, notTested)
	case c.Passed == 0 && errored > 0:
		// At least one route answered (5xx) - "none reachable" would be dishonest.
		return fmt.Sprintf("0 of %d %s reachable · %s%s", c.Tested, noun, failClause(unreachable, errored, indirectUnreach), notTested)
	case c.Passed == 0 && indirectUnreach:
		// Every unreachable route was seen only via the apiserver proxy - the real
		// path was never confirmed, so don't bare-condemn the whole entry.
		return fmt.Sprintf("None of %d %s confirmed reachable - checked only via API server, real path not confirmed%s", c.Tested, noun, notTested)
	case c.Passed == 0:
		return fmt.Sprintf("None of %d %s reachable%s", c.Tested, noun, notTested)
	default:
		// failClause covers unreachable + erroring; a mixed trace can also carry a
		// benign scale-to-0 route, which would otherwise be silently dropped from
		// both the reachable count and the failure clause (leaving a dangling
		// trailing "· "). Surface it and only append the clause when non-empty.
		clause := failClause(unreachable, errored, indirectUnreach)
		if benignFailed > 0 {
			benignClause := fmt.Sprintf("%d scaled to 0", benignFailed)
			if clause == "" {
				clause = benignClause
			} else {
				clause = clause + " · " + benignClause
			}
		}
		if clause == "" {
			return fmt.Sprintf("%d of %d %s reachable%s", c.Passed, c.Tested, noun, notTested)
		}
		return fmt.Sprintf("%d of %d %s reachable · %s%s", c.Passed, c.Tested, noun, clause, notTested)
	}
}

// failureKinds splits failed routes into the count that were REACHED but
// returned a server error and the count that are benign (intentional scale-0).
// The remaining failures (Coverage.Failed minus these) are genuine transport
// unreachability. Benign routes carry their own amber framing, so the headline
// neither calls them "unreachable" nor "erroring".
func failureKinds(routes []RouteResult) (errored, benign int) {
	for _, r := range routes {
		switch {
		case r.Benign:
			benign++
		case r.Outcome == OutcomeServerError:
			errored++
		}
	}
	return
}

// failClause renders the failure breakdown, omitting any zero clause: e.g.
// "1 unreachable · 2 reached but erroring", or just "2 reached but erroring".
func failClause(unreachable, errored int, indirectUnreach bool) string {
	parts := make([]string, 0, 2)
	if unreachable > 0 {
		u := fmt.Sprintf("%d unreachable", unreachable)
		if indirectUnreach {
			u += " via API server (real path not confirmed)"
		}
		parts = append(parts, u)
	}
	if errored > 0 {
		parts = append(parts, fmt.Sprintf("%d reached but erroring", errored))
	}
	return strings.Join(parts, " · ")
}

// allUnreachableIndirect reports whether every genuinely-unreachable route
// (non-benign, transport-unreachable) was observed ONLY via the apiserver proxy.
// When true the headline must qualify "unreachable" - a proxy-only failure never
// condemns the real path.
func allUnreachableIndirect(routes []RouteResult) bool {
	any := false
	for _, r := range routes {
		if r.Benign || r.Outcome != OutcomeUnreachable {
			continue
		}
		any = true
		if r.Confidence != ConfidenceIndirect {
			return false
		}
	}
	return any
}

func singleRouteHeadline(r RouteResult, skipped int) string {
	suffix := ""
	if skipped > 0 {
		suffix = fmt.Sprintf(" · %d not tested", skipped)
	}
	ev := ""
	if r.Evidence != "" {
		ev = " (" + r.Evidence + ")"
	}
	// Intentional scale-to-0: deliberate dormancy, not an outage - never "Unreachable".
	if r.Benign {
		return "No running backends (scaled to 0)" + suffix
	}
	switch r.Outcome {
	case OutcomeVerified, OutcomeReached:
		// A SUCCESS reached only via the apiserver proxy is not the live-traffic
		// path - never "verified". (Only successes get this prefix; a failure is a
		// failure regardless of which path observed it - see below.)
		if r.Confidence == ConfidenceIndirect {
			return "Reached " + VantageAPIServer + " - not live traffic" + ev + suffix
		}
		if r.Outcome == OutcomeVerified {
			return "Reachable - verified" + ev + suffix
		}
		return "Reachable - server reached, route not verified" + ev + suffix
	case OutcomeServerError:
		if r.Confidence == ConfidenceIndirect {
			return "Server error " + VantageAPIServer + " - not live traffic" + ev + suffix
		}
		return "Reached - server error" + ev + suffix
	case OutcomeUnreachable:
		// A failure observed ONLY through the apiserver proxy isolates the symptom
		// to that path, not the real-traffic path. Stating a bare "Unreachable"
		// would headline a condemnation from proxy-only evidence - never honest
		// about the live path. Qualify it symmetrically with the success case.
		if r.Confidence == ConfidenceIndirect {
			return "Unreachable " + VantageAPIServer + " - real path not confirmed" + ev + suffix
		}
		return "Unreachable" + ev + suffix
	default:
		return "Not tested" + suffix
	}
}
