package trace

import (
	"strings"
	"testing"

	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/pkg/probe"
)

// TestVantageAPIServerName pins the ONE operator-facing name for the apiserver-
// proxy vantage and asserts the headline generator actually uses it. The TS side
// (reachVerdict.test.ts) pins the identical literal on VIA_API_SERVER — the two
// pins are the anti-drift gate that keeps the Go + TS headline generators from
// diverging on this term.
func TestVantageAPIServerName(t *testing.T) {
	if VantageAPIServer != "via API server" {
		t.Fatalf("VantageAPIServer = %q, want \"via API server\" (must stay identical to TS VIA_API_SERVER)", VantageAPIServer)
	}
	h := singleRouteHeadline(RouteResult{Outcome: OutcomeReached, Confidence: ConfidenceIndirect}, 0)
	if !strings.Contains(h, VantageAPIServer) {
		t.Errorf("indirect-route headline %q must name the vantage %q", h, VantageAPIServer)
	}
}

// A healthy Gateway with attached HTTPRoute/GRPCRoute must NOT false-condemn the
// attached routes as unreachable backends: those are parallel entry paths (each
// traced as its own subject), carry no Config/probes here, and the Gateway's own
// front-door reach is what coverage reports. Regression guard for the blocker
// where Gateway->Route branches with nil Config were marked OutcomeUnreachable.
func TestComputeCoverage_GatewayAttachedRoutesNotCondemned(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Group: "gateway.networking.k8s.io", Kind: "Gateway", Namespace: "prod", Name: "gw"},
		Verdict:  VerdictHealthy,
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Group: "gateway.networking.k8s.io", Kind: "Gateway", Namespace: "prod", Name: "gw"},
				Edge:   "entry:Gateway",
				Config: &HopConfig{Listeners: []GatewayListener{{Name: "http", Port: 80, Protocol: "HTTP"}}, Addresses: []string{"203.0.113.7"}},
				Probes: []probe.Result{{Layer: probe.LayerTCP, Path: probe.PathData, Port: 80, OK: true, Tone: probe.ToneHealthy, Detail: "TCP connect OK", Vantage: probe.VantageInCluster}}},
			{Resource: ResourceRef{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Namespace: "prod", Name: "web-route"},
				Edge:   "Gateway->HTTPRoute",
				Probes: []probe.Result{probe.Skipped(probe.LayerTCP, "", probe.VantageInCluster, "route has no own address; reachability lives on parent Gateway and backend Service")}},
			{Resource: ResourceRef{Group: "gateway.networking.k8s.io", Kind: "GRPCRoute", Namespace: "prod", Name: "grpc-route"},
				Edge:   "Gateway->GRPCRoute",
				Probes: []probe.Result{probe.Skipped(probe.LayerTCP, "", probe.VantageInCluster, "route has no own address; reachability lives on parent Gateway and backend Service")}},
		},
	}
	computeCoverage(tr)
	for _, r := range tr.Routes {
		if r.Outcome == OutcomeUnreachable {
			t.Errorf("attached-route handling must not condemn a route as unreachable; got %+v", r)
		}
	}
	if strings.HasPrefix(tr.Headline, "Unreachable") || strings.Contains(tr.Headline, "None of") || strings.Contains(tr.Headline, "0 of") {
		t.Errorf("headline must not be a false condemnation; got %q", tr.Headline)
	}
	if v := CoverageVerdict(tr); v == VerdictBroken {
		t.Errorf("a healthy Gateway must not read broken; got %q", v)
	}
}

// Test 1 — a single Service route verified over the real-traffic (data) path.
func TestComputeCoverage_SingleRouteVerifiedReal(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "api"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 {
		t.Fatalf("want 1 route, got %d (%+v)", len(tr.Routes), tr.Routes)
	}
	r := tr.Routes[0]
	if r.Outcome != OutcomeVerified || r.Confidence != ConfidenceReal {
		t.Errorf("route = %s/%s, want verified/real", r.Outcome, r.Confidence)
	}
	if r.Target != "api:80" {
		t.Errorf("target = %q, want api:80", r.Target)
	}
	if tr.Coverage == nil || tr.Coverage.Tested != 1 || tr.Coverage.Passed != 1 || tr.Coverage.Failed != 0 {
		t.Errorf("coverage = %+v, want tested 1 passed 1 failed 0", tr.Coverage)
	}
}

// A 0-ready-endpoints break is an authoritative cache fact, so a Service route
// that's only "unreachable via the apiserver proxy" (indirect) must be promoted
// to a DEFINITIVE (real) failure — it reads red, not the soft proxy-vantage amber.
func TestUpgradeDefinitiveBackendDown(t *testing.T) {
	svc := func(sev, code string, routes ...RouteResult) *Trace {
		return &Trace{
			Subject:    ResourceRef{Kind: "Service", Namespace: "p", Name: "s"},
			BrokenAt:   -1,
			Downstream: []Hop{{Resource: ResourceRef{Kind: "Service", Name: "s"}, Findings: []Finding{{Code: code, Severity: sev, Message: "no ready"}}}},
			Routes:     routes,
		}
	}
	ind := func(id string) RouteResult { return RouteResult{Route: id, Outcome: OutcomeUnreachable, Confidence: ConfidenceIndirect} }

	cases := []struct {
		name     string
		tr       *Trace
		mutate   func(*Trace)
		wantReal []bool // expected per-route: true = promoted to real
	}{
		{"critical problem:0/N promotes", svc(SeverityCritical, "problem:0/1 selected pods ready", ind("s")), nil, []bool{true}},
		{"fingerprint code promotes", svc(SeverityCritical, "svc:no-ready-endpoints", ind("s")), nil, []bool{true}},
		{"multi-port: every port promoted (same backend)", svc(SeverityCritical, "problem:0/2 selected pods ready", ind("80"), ind("9090")), nil, []bool{true, true}},
		{"uncertain WARNING stays soft (couldn't verify scale-to-0)", svc(SeverityWarning, "problem:0/1 selected pods ready", ind("s")), nil, []bool{false}},
		{"non-Service subject untouched", svc(SeverityCritical, "problem:0/1 selected pods ready", ind("s")), func(tr *Trace) { tr.Subject.Kind = "Ingress" }, []bool{false}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.mutate != nil {
				c.mutate(c.tr)
			}
			upgradeDefinitiveBackendDown(c.tr)
			for i, want := range c.wantReal {
				got := c.tr.Routes[i].Confidence == ConfidenceReal
				if got != want {
					t.Errorf("route[%d] promoted=%v, want %v (confidence=%q)", i, got, want, c.tr.Routes[i].Confidence)
				}
			}
		})
	}
}

// An ExternalName Service is honestly testable: the Service hop has no
// ClusterIP/ports (no own probes), but the alias-host hop carries the real
// DNS-resolve + HTTP-reach probes. Those must produce ONE verified route to the
// external host — not an empty "configuration only" coverage.
func TestComputeCoverage_ExternalNameRouteFromAliasHop(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "extname"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "extname"}, Edge: "entry:Service"},
			{Resource: ResourceRef{Kind: "ExternalName", Name: "example.com"}, Edge: "Service->ExternalName",
				Probes: []probe.Result{
					{Layer: probe.LayerDNS, Path: probe.PathData, Vantage: probe.VantageInCluster, OK: true, Tone: probe.ToneHealthy, Detail: "resolved to 93.184.216.34"},
					{Layer: probe.LayerHTTP, Path: probe.PathData, Vantage: probe.VantageInCluster, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"},
				}},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 {
		t.Fatalf("want 1 route, got %d (%+v)", len(tr.Routes), tr.Routes)
	}
	r := tr.Routes[0]
	// In-cluster vantage proves real reachability → verified/real.
	if r.Outcome != OutcomeVerified || r.Confidence != ConfidenceReal {
		t.Errorf("route = %s/%s, want verified/real", r.Outcome, r.Confidence)
	}
	if r.Target != "example.com" {
		t.Errorf("target = %q, want example.com", r.Target)
	}
	if tr.Coverage == nil || tr.Coverage.Tested != 1 || tr.Coverage.Passed != 1 {
		t.Errorf("coverage = %+v, want tested 1 passed 1", tr.Coverage)
	}
}

// A laptop dials the external host from Radar's own network — that is NOT proof of
// real in-cluster reachability, so the route must be INDIRECT (never a green "real").
func TestComputeCoverage_ExternalNameLocalVantageIsIndirect(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "extname"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "extname"}, Edge: "entry:Service"},
			{Resource: ResourceRef{Kind: "ExternalName", Name: "example.com"}, Edge: "Service->ExternalName",
				Probes: []probe.Result{
					{Layer: probe.LayerDNS, Path: probe.PathData, Vantage: probe.VantageLocal, OK: true, Tone: probe.ToneHealthy, Detail: "resolved"},
					{Layer: probe.LayerHTTP, Path: probe.PathData, Vantage: probe.VantageLocal, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"},
				}},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 {
		t.Fatalf("want 1 route, got %d", len(tr.Routes))
	}
	if r := tr.Routes[0]; r.Confidence != ConfidenceIndirect {
		t.Errorf("local-vantage ExternalName confidence = %q, want indirect (must not over-claim real in-cluster reachability)", r.Confidence)
	}
}

// An un-probed ExternalName stays config-only — no route fabricated without probes.
func TestComputeCoverage_ExternalNameUnprobedHasNoRoute(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "extname"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "extname"}, Edge: "entry:Service"},
			{Resource: ResourceRef{Kind: "ExternalName", Name: "example.com"}, Edge: "Service->ExternalName"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 0 {
		t.Fatalf("want 0 routes for un-probed ExternalName, got %d (%+v)", len(tr.Routes), tr.Routes)
	}
}

// Test 2 — multi-route Ingress, one route reachable, one unreachable.
func TestComputeCoverage_MultiRoutePartial(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Ingress", Name: "shop"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "shop"}, Edge: "entry:Ingress",
				Config: &HopConfig{Hostnames: []string{"shop.example.com"}, Rules: []RouteRule{
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/web"}, Backends: []BackendRef{{Kind: "Service", Name: "web"}}},
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/api"}, Backends: []BackendRef{{Kind: "Service", Name: "api"}}},
				}}},
			{Resource: ResourceRef{Kind: "Service", Name: "web"}, Edge: "Ingress->Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}}},
			{Resource: ResourceRef{Kind: "Service", Name: "api"}, Edge: "Ingress->Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 8080}}},
				Probes: []probe.Result{{Layer: probe.LayerTCP, Path: probe.PathData, OK: false, Tone: probe.ToneUnhealthy, Error: "connection refused"}}},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 2 {
		t.Fatalf("want 2 routes, got %d (%+v)", len(tr.Routes), tr.Routes)
	}
	byRoute := map[string]RouteResult{}
	for _, r := range tr.Routes {
		byRoute[r.Route] = r
	}
	if r := byRoute["/web"]; r.Outcome != OutcomeVerified {
		t.Errorf("/web = %q, want verified", r.Outcome)
	}
	if r := byRoute["/api"]; r.Outcome != OutcomeUnreachable {
		t.Errorf("/api = %q, want unreachable", r.Outcome)
	}
	if tr.Coverage.Tested != 2 || tr.Coverage.Passed != 1 || tr.Coverage.Failed != 1 {
		t.Errorf("coverage = %+v, want tested 2 passed 1 failed 1", tr.Coverage)
	}
}

// Test 3 — apiserver-only success must read INDIRECT, never real-traffic verified.
func TestComputeCoverage_ApiserverOnlyIsIndirect(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Name: "api"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "api"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathAPIServer, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 {
		t.Fatalf("want 1 route, got %d", len(tr.Routes))
	}
	r := tr.Routes[0]
	if r.Confidence != ConfidenceIndirect {
		t.Errorf("apiserver-only confidence = %q, want indirect (must NOT be real)", r.Confidence)
	}
	if r.Confidence == ConfidenceReal {
		t.Errorf("apiserver-only must never render as real-traffic verified")
	}
	if len(r.Localization) == 0 {
		t.Errorf("apiserver probe should be recorded as localization, got none")
	}
}

// Test 4 — skips are listed and classified: coverage gap vs benign vs vantage.
func TestComputeCoverage_NotTestedClassification(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Ingress", Name: "x"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "x"}, Edge: "entry:Ingress", Probes: []probe.Result{
				{Layer: probe.LayerDNS, Target: "*.example.com", Skipped: true, Reason: "wildcard host — test a concrete hostname to check reachability", Command: "curl https://YOUR-SUB.example.com/"},
			}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods", Probes: []probe.Result{
				{Layer: probe.LayerTCP, Skipped: true, Reason: "sampled 2 of 5 ready pods"},
				{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Skipped: true, Reason: `"shop.internal" resolves to an internal address your machine can't reach`},
			}},
		},
	}
	computeCoverage(tr)
	byReason := map[string]string{} // class keyed by a reason substring
	for _, s := range tr.NotTested {
		switch {
		case strings.Contains(s.Reason, "wildcard"):
			byReason["wildcard"] = s.ReasonClass
		case strings.Contains(s.Reason, "sampled"):
			byReason["sampled"] = s.ReasonClass
		case strings.Contains(s.Reason, "internal address"):
			byReason["internal"] = s.ReasonClass
		}
	}
	if byReason["wildcard"] != SkipClassCoverage {
		t.Errorf("wildcard skip class = %q, want coverage", byReason["wildcard"])
	}
	if byReason["sampled"] != SkipClassBenign {
		t.Errorf("pod-sampling skip class = %q, want benign", byReason["sampled"])
	}
	if byReason["internal"] != SkipClassVantage {
		t.Errorf("internal-address skip class = %q, want vantage", byReason["internal"])
	}
	// Benign skips (the "sampled 2 of 5 ready pods" row) lose no coverage, so they
	// are excluded from the Skipped gap tally — only the coverage + vantage skips
	// count. Otherwise a fully-tested route would be downgraded to footnote-green.
	if tr.Coverage == nil || tr.Coverage.Skipped != 2 {
		t.Errorf("coverage.skipped = %v, want 2 (benign excluded)", tr.Coverage)
	}
}

// CoverageHeadline — the agent/UI primary read. Invariant: indirect never "verified".
func TestCoverageHeadline(t *testing.T) {
	cases := []struct {
		name    string
		tr      *Trace
		want    string
		notWant string
	}{
		{"single verified real", &Trace{Coverage: &Coverage{Tested: 1, Passed: 1}, Routes: []RouteResult{{Outcome: OutcomeVerified, Confidence: ConfidenceReal, Evidence: "HTTP 200"}}}, "Reachable — verified", ""},
		{"single indirect is NOT verified", &Trace{Coverage: &Coverage{Tested: 1, Passed: 1}, Routes: []RouteResult{{Outcome: OutcomeVerified, Confidence: ConfidenceIndirect, Evidence: "HTTP 200"}}}, "API server", "verified"},
		{"single unreachable", &Trace{Coverage: &Coverage{Tested: 1, Failed: 1}, Routes: []RouteResult{{Outcome: OutcomeUnreachable, Confidence: ConfidenceReal, Evidence: "connection refused"}}}, "Unreachable", ""},
		{"multi all pass", &Trace{Coverage: &Coverage{Tested: 3, Passed: 3}, Routes: make([]RouteResult, 3)}, "All 3 routes reachable", ""},
		{"multi footnote green", &Trace{Coverage: &Coverage{Tested: 3, Passed: 3, Skipped: 2}, Routes: make([]RouteResult, 3)}, "All 3 tested routes reachable · 2 not tested", ""},
		{"multi partial", &Trace{Coverage: &Coverage{Tested: 4, Passed: 3, Failed: 1}, Routes: make([]RouteResult, 4)}, "3 of 4 routes reachable · 1 unreachable", ""},
		{"multi none pass", &Trace{Coverage: &Coverage{Tested: 2, Failed: 2}, Routes: make([]RouteResult, 2)}, "None of 2 routes reachable", ""},
		// A multi-route trace where every route ANSWERED with a 5xx: they were
		// reached, so "none reachable" would be dishonest about a live-but-erroring app.
		{"multi all server-error reached", &Trace{Coverage: &Coverage{Tested: 2, Failed: 2}, Routes: []RouteResult{{Outcome: OutcomeServerError}, {Outcome: OutcomeServerError}}}, "2 reached but erroring", "None of 2"},
		{"multi mixed unreachable + erroring", &Trace{Coverage: &Coverage{Tested: 3, Passed: 1, Failed: 2}, Routes: []RouteResult{{Outcome: OutcomeVerified}, {Outcome: OutcomeUnreachable}, {Outcome: OutcomeServerError}}}, "1 unreachable · 1 reached but erroring", ""},
		// One route reachable, the other a deliberate scale-to-0 (benign). The benign
		// route must be surfaced as "scaled to 0", never dropped to leave a dangling
		// trailing separator ("... reachable · ").
		{"multi mixed pass + benign scaled-to-0", &Trace{Coverage: &Coverage{Tested: 2, Passed: 1, Failed: 1}, Routes: []RouteResult{{Outcome: OutcomeVerified}, {Benign: true, Outcome: OutcomeUnreachable}}}, "1 of 2 routes reachable · 1 scaled to 0", ""},
		{"zero tested with skips AFTER probing (all skipped from this vantage)", &Trace{Coverage: &Coverage{Tested: 0, Skipped: 2}, Downstream: []Hop{{Probes: []probe.Result{{Layer: probe.LayerHTTP, Skipped: true}}}}}, "Couldn't actively test any route from here", ""},
		{"zero tested with skips but UN-PROBED (static drawer) reads not-yet-tested, never couldn't-test", &Trace{Coverage: &Coverage{Tested: 0, Skipped: 1}}, "Configuration only — not yet tested", ""},
		{"not probed", &Trace{}, "not yet tested", ""},
	}
	for _, c := range cases {
		got := CoverageHeadline(c.tr)
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: got %q, want substring %q", c.name, got, c.want)
		}
		if c.notWant != "" && strings.Contains(got, c.notWant) {
			t.Errorf("%s: got %q, must NOT contain %q (indirect must never read as verified)", c.name, got, c.notWant)
		}
	}
}

// Test 5 — computeCoverage is ADDITIVE: Verdict + BrokenAt are byte-identical
// after it runs, and a broken hop is named in BrokenRoute.
func TestComputeCoverage_AdditiveNoVerdictChange(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Ingress", Name: "shop"},
		Verdict:  VerdictDegraded,
		BrokenAt: 1,
		Reason:   "1 of 2 routes broken",
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "shop"}, Edge: "entry:Ingress"},
			{Resource: ResourceRef{Kind: "Service", Name: "ghost"}, Edge: "Ingress->Service"},
		},
	}
	wantV, wantB, wantR := tr.Verdict, tr.BrokenAt, tr.Reason
	computeCoverage(tr)
	if tr.Verdict != wantV || tr.BrokenAt != wantB || tr.Reason != wantR {
		t.Errorf("computeCoverage mutated the verdict: %q/%d/%q, want %q/%d/%q",
			tr.Verdict, tr.BrokenAt, tr.Reason, wantV, wantB, wantR)
	}
	if tr.BrokenRoute == nil || tr.BrokenRoute.Name != "ghost" {
		t.Errorf("BrokenRoute = %+v, want the named broken hop (ghost)", tr.BrokenRoute)
	}
}

// B1 — a declared route whose backend is MISSING must appear as a FAILED route
// (counted in Coverage.Failed, honest headline), never vanish into a green-ish summary.
func TestComputeCoverage_MissingBackendIsFailedRoute(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Ingress", Name: "multi"},
		BrokenAt: 2,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "multi"}, Edge: "entry:Ingress",
				Findings: []Finding{{Code: missingRefCodePrefix + "Missing backend Service", Severity: SeverityCritical, Message: "/api references ghost which does not exist"}},
				Config: &HopConfig{Hostnames: []string{"shop.example.com"}, Rules: []RouteRule{
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/web"}, Backends: []BackendRef{{Kind: "Service", Name: "web"}}},
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/api"}, Backends: []BackendRef{{Kind: "Service", Name: "ghost"}}},
				}}},
			{Resource: ResourceRef{Kind: "Service", Name: "web"}, Edge: "Ingress->Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}}},
			{Resource: ResourceRef{Kind: "Service", Name: "ghost"}, Edge: "Ingress->Service"}, // missing: no Config, no probes
		},
	}
	computeCoverage(tr)
	var ghost *RouteResult
	for i := range tr.Routes {
		if tr.Routes[i].Target == "ghost" || strings.Contains(tr.Routes[i].Route, "/api") {
			ghost = &tr.Routes[i]
		}
	}
	if ghost == nil {
		t.Fatalf("missing-backend route vanished; routes=%+v", tr.Routes)
	}
	if ghost.Outcome != OutcomeUnreachable {
		t.Errorf("ghost outcome = %q, want unreachable", ghost.Outcome)
	}
	if tr.Coverage == nil || tr.Coverage.Failed < 1 {
		t.Errorf("coverage = %+v, want failed >= 1", tr.Coverage)
	}
	if h := CoverageHeadline(tr); strings.HasPrefix(h, "All ") || !strings.Contains(h, "unreachable") {
		t.Errorf("headline = %q, want honest 'N of M reachable · K unreachable', not green-ish", h)
	}
}

// B4 — a Service subject's NotTested must list ONLY its intended-route (downstream)
// skips; upstream-context skips (the Ingresses pointing AT it) must be excluded.
func TestComputeCoverage_UpstreamSkipsExcludedFromNotTested(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Name: "echo"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "echo"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
		Upstreams: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "shop"}, Edge: "Ingress->Service",
				Probes: []probe.Result{{Layer: probe.LayerDNS, Target: "shop.example.com", Skipped: true, Reason: "wildcard host — test a concrete hostname"}}},
		},
	}
	computeCoverage(tr)
	for _, s := range tr.NotTested {
		if strings.Contains(s.Route, "shop.example.com") || strings.Contains(s.Reason, "wildcard") {
			t.Errorf("upstream-context skip leaked into NotTested: %+v", s)
		}
	}
}

// Test 6 — a multiport Service reports EACH port honestly, not a collapsed
// total failure. :80 works, :9090 (nothing listening) is dead → 2 routes, 2/1/1,
// and a "1 of 2 ports reachable" headline rather than "unreachable".
func TestComputeCoverage_MultiportServicePerPort(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "payments"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "payments"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}, {Port: 9090}}},
				Probes: []probe.Result{
					{Layer: probe.LayerHTTP, Path: probe.PathData, Port: 80, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"},
					{Layer: probe.LayerTCP, Path: probe.PathData, Port: 9090, OK: false, Tone: probe.ToneUnhealthy, Error: "connection refused"},
				}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 2 {
		t.Fatalf("want 2 per-port routes, got %d (%+v)", len(tr.Routes), tr.Routes)
	}
	byTarget := map[string]RouteResult{}
	for _, r := range tr.Routes {
		byTarget[r.Target] = r
	}
	if byTarget["payments:80"].Outcome != OutcomeVerified {
		t.Errorf(":80 = %q, want verified", byTarget["payments:80"].Outcome)
	}
	if byTarget["payments:9090"].Outcome != OutcomeUnreachable {
		t.Errorf(":9090 = %q, want unreachable", byTarget["payments:9090"].Outcome)
	}
	if tr.Coverage.Tested != 2 || tr.Coverage.Passed != 1 || tr.Coverage.Failed != 1 {
		t.Errorf("coverage = %+v, want tested 2 passed 1 failed 1", tr.Coverage)
	}
	if hl := CoverageHeadline(tr); hl != "1 of 2 ports reachable · 1 unreachable" {
		t.Errorf("headline = %q, want '1 of 2 ports reachable · 1 unreachable'", hl)
	}
}

// Test 7 — an Ingress route to a specific backend port must NOT read off a
// healthy/dead sibling port. /api → checkout:8080 (ok); checkout also serves
// :9090 (dead) — the route reflects only :8080.
func TestComputeCoverage_IngressRouteScopedToDeclaredPort(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Ingress", Name: "shop"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "shop"}, Edge: "entry:Ingress",
				Config: &HopConfig{Hostnames: []string{"shop.example.com"}, Rules: []RouteRule{
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/api"}, Backends: []BackendRef{{Kind: "Service", Name: "checkout", Port: "8080"}}},
				}}},
			{Resource: ResourceRef{Kind: "Service", Name: "checkout"}, Edge: "Ingress->Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 8080}, {Port: 9090}}},
				Probes: []probe.Result{
					{Layer: probe.LayerHTTP, Path: probe.PathData, Port: 8080, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"},
					{Layer: probe.LayerTCP, Path: probe.PathData, Port: 9090, OK: false, Tone: probe.ToneUnhealthy, Error: "connection refused"},
				}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 {
		t.Fatalf("want 1 route scoped to the declared port, got %d (%+v)", len(tr.Routes), tr.Routes)
	}
	r := tr.Routes[0]
	if r.Outcome != OutcomeVerified || r.Target != "checkout:8080" {
		t.Errorf("route = %s/%s, want verified/checkout:8080 (the :9090 sibling must not leak)", r.Outcome, r.Target)
	}
	if tr.Coverage.Failed != 0 {
		t.Errorf("coverage.failed = %d, want 0 — the dead :9090 is not this route's declared port", tr.Coverage.Failed)
	}
}

// CoverageVerdict reconciles the agent-facing tier with coverage (bug B3):
// broken/degraded/unknown pass through the internal verdict; only a HEALTHY that
// was reached ONLY via the apiserver proxy (indirect) downgrades — indirect is
// never a confident green.
func TestCoverageVerdict_RealVerifiedIsHealthy(t *testing.T) {
	tr := &Trace{Verdict: VerdictHealthy, Coverage: &Coverage{Tested: 1, Passed: 1},
		Routes: []RouteResult{{Outcome: OutcomeVerified, Confidence: ConfidenceReal}}}
	if v := CoverageVerdict(tr); v != VerdictHealthy {
		t.Errorf("real-verified all-pass = %q, want healthy", v)
	}
}

func TestCoverageVerdict_IndirectOnlyIsNotHealthy(t *testing.T) {
	tr := &Trace{Verdict: VerdictHealthy, Coverage: &Coverage{Tested: 1, Passed: 1},
		Routes: []RouteResult{{Outcome: OutcomeVerified, Confidence: ConfidenceIndirect}}}
	if v := CoverageVerdict(tr); v != VerdictUnknown {
		t.Errorf("indirect-only all-pass = %q, want unknown (must NOT read confident healthy — B3/#1a)", v)
	}
}

func TestCoverageVerdict_PartialAndNonePassThrough(t *testing.T) {
	deg := &Trace{Verdict: VerdictDegraded, Coverage: &Coverage{Tested: 2, Passed: 1, Failed: 1},
		Routes: []RouteResult{{Outcome: OutcomeVerified, Confidence: ConfidenceReal}, {Outcome: OutcomeUnreachable}}}
	if v := CoverageVerdict(deg); v != VerdictDegraded {
		t.Errorf("partial = %q, want degraded (pass-through)", v)
	}
	brk := &Trace{Verdict: VerdictBroken, Coverage: &Coverage{Tested: 1, Failed: 1},
		Routes: []RouteResult{{Outcome: OutcomeUnreachable}}}
	if v := CoverageVerdict(brk); v != VerdictBroken {
		t.Errorf("none-reachable = %q, want broken (pass-through)", v)
	}
}

func TestCoverageVerdict_SpecialShapeUnknownPreserved(t *testing.T) {
	tr := &Trace{Verdict: VerdictUnknown, Reason: "Service has no selector"}
	if v := CoverageVerdict(tr); v != VerdictUnknown {
		t.Errorf("special-shape unknown = %q, want unknown preserved", v)
	}
}

func TestCoverageVerdict_ZeroTestedIsNotHealthy(t *testing.T) {
	// Healthy internal verdict but nothing actually tested (all skipped) — the
	// "couldn't test any route" headline must not sit beside a confident healthy.
	tr := &Trace{Verdict: VerdictHealthy, Coverage: &Coverage{Tested: 0, Skipped: 2}}
	if v := CoverageVerdict(tr); v != VerdictUnknown {
		t.Errorf("zero-tested = %q, want unknown", v)
	}
}

func TestSingleRouteHeadline_IndirectFailureIsNotReached(t *testing.T) {
	// An UNREACHABLE route observed via the apiserver proxy must NOT read
	// "Reached via API server" — that contradicts the failure.
	h := singleRouteHeadline(RouteResult{Outcome: OutcomeUnreachable, Confidence: ConfidenceIndirect, Evidence: "Connection refused"}, 0)
	if strings.Contains(h, "Reached") {
		t.Errorf("indirect unreachable headline = %q, must not say 'Reached'", h)
	}
	if !strings.Contains(h, "Unreachable") {
		t.Errorf("indirect unreachable headline = %q, want 'Unreachable'", h)
	}
}

// An intentionally scaled-to-0 Service is unreachable by DESIGN (deliberate
// dormancy) — the route is flagged benign, the verdict softens broken→degraded,
// and the headline reads "scaled to 0", not a red "Unreachable".
func TestComputeCoverage_ScaledToZeroIsBenign(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Name: "scaledzero"},
		Verdict:  VerdictBroken, // the probe found no endpoints
		BrokenAt: 0,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "scaledzero"}, Edge: "entry:Service",
				Config:   &HopConfig{Ports: []PortMap{{Port: 80}}},
				Findings: []Finding{{Code: k8s.ScaledToZeroFingerprint, Severity: SeverityWarning, Message: "Backing workload scaled to 0"}},
				Probes:   []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathAPIServer, OK: false, Tone: probe.ToneUnhealthy, Detail: "No ready backend endpoints"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 || !tr.Routes[0].Benign {
		t.Fatalf("route should be benign, got %+v", tr.Routes)
	}
	if tr.Routes[0].Outcome != OutcomeUnreachable {
		t.Errorf("outcome must stay factually unreachable, got %q", tr.Routes[0].Outcome)
	}
	if v := CoverageVerdict(tr); v != VerdictDegraded {
		t.Errorf("benign scale-0 verdict = %q, want degraded (not broken/red)", v)
	}
	if !strings.Contains(tr.Headline, "scaled to 0") {
		t.Errorf("headline = %q, want it to mention 'scaled to 0'", tr.Headline)
	}
}

// A Service at replicas>0 with 0 ready (crashloop) is a REAL break — no scale-0
// finding → not benign, verdict stays broken/red.
func TestComputeCoverage_CrashloopStaysRed(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Name: "crash"},
		Verdict:  VerdictBroken,
		BrokenAt: 0,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "crash"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathAPIServer, OK: false, Tone: probe.ToneUnhealthy, Detail: "No ready backend endpoints"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 || tr.Routes[0].Benign {
		t.Fatalf("crashloop route must NOT be benign, got %+v", tr.Routes)
	}
	if v := CoverageVerdict(tr); v != VerdictBroken {
		t.Errorf("crashloop verdict = %q, want broken (stays red)", v)
	}
}

// ── Diagnosis: the hoisted cause/culprit/next-action (PROMOTED, never synthesized) ──

// A crashloop pod is the culprit: the Diagnosis must name the actual Pod, carry
// the honest prose Summary, and the logs --previous command — but it must NOT
// emit a structured cause code (the pod-state code would mislabel the cause).
func TestDiagnosis_CrashloopProseNotCoded(t *testing.T) {
	pod := ResourceRef{Kind: "Pod", Namespace: "prod", Name: "app-xyz"}
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "crash"},
		Verdict:  VerdictBroken,
		BrokenAt: 1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "crash"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathAPIServer, OK: false, Tone: probe.ToneUnhealthy, Detail: "No ready backend endpoints"}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods",
				Findings: []Finding{{
					Code: "problem:CrashLoopBackOff", Severity: SeverityCritical,
					Message:  "CrashLoopBackOff - back-off restarting failed container",
					Cause:    "Container 'app' keeps crashing (exit code 1)",
					Action:   "Inspect the previous container's logs for the panic",
					Command:  "kubectl logs app-xyz -n prod --previous",
					Resource: &pod,
				}}},
		},
	}
	computeCoverage(tr)
	d := tr.Diagnosis
	if d == nil {
		t.Fatal("Diagnosis must be set for a crashloop break")
	}
	if d.CauseCode != "" {
		t.Errorf("Cause = %q, want EMPTY — a pod-state code must not be promoted as a structured cause", d.CauseCode)
	}
	if d.Summary != "Container 'app' keeps crashing (exit code 1)" {
		t.Errorf("Summary = %q, want the finding's honest Cause prose", d.Summary)
	}
	if d.CulpritResource == nil || d.CulpritResource.Kind != "Pod" || d.CulpritResource.Name != "app-xyz" {
		t.Errorf("CulpritResource = %+v, want the actual Pod app-xyz (not the coarse Service/Pods)", d.CulpritResource)
	}
	if !strings.Contains(d.Command, "logs") || !strings.Contains(d.Command, "--previous") {
		t.Errorf("Command = %q, want the pod-targeted logs --previous reproducer", d.Command)
	}
	if d.NextAction != "Inspect the previous container's logs for the panic" {
		t.Errorf("NextAction = %q, want the finding's Action", d.NextAction)
	}
}

// A missing backend IS safe to code: missing-ref is a structural fingerprint.
// The culprit is the named broken route (the backend that doesn't exist).
func TestDiagnosis_MissingBackendCoded(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Ingress", Name: "multi"},
		BrokenAt: 2,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "multi"}, Edge: "entry:Ingress",
				Findings: []Finding{{Code: missingRefCodePrefix + "Missing backend Service", Severity: SeverityCritical, Message: "/api references ghost which does not exist"}},
				Config: &HopConfig{Hostnames: []string{"shop.example.com"}, Rules: []RouteRule{
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/web"}, Backends: []BackendRef{{Kind: "Service", Name: "web"}}},
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/api"}, Backends: []BackendRef{{Kind: "Service", Name: "ghost"}}},
				}}},
			{Resource: ResourceRef{Kind: "Service", Name: "web"}, Edge: "Ingress->Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}}},
			{Resource: ResourceRef{Kind: "Service", Name: "ghost"}, Edge: "Ingress->Service"},
		},
	}
	computeCoverage(tr)
	d := tr.Diagnosis
	if d == nil {
		t.Fatal("Diagnosis must be set for a missing backend")
	}
	if !strings.HasPrefix(d.CauseCode, missingRefCodePrefix) {
		t.Errorf("Cause = %q, want the missing-ref structural code", d.CauseCode)
	}
	if d.CulpritResource == nil || d.CulpritResource.Name != "ghost" {
		t.Errorf("CulpritResource = %+v, want the named broken route 'ghost'", d.CulpritResource)
	}
	if !strings.Contains(d.Summary, "ghost") {
		t.Errorf("Summary = %q, want it to name the missing backend", d.Summary)
	}
}

// A targetPort mismatch is structural (svc:*) → safe to code. Its Action is the
// next step.
func TestDiagnosis_TargetportCoded(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "mismatch"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Findings: []Finding{{
					Code: "svc:targetport-no-listener", Severity: SeverityWarning,
					Message: "Service targetPort :9999 matches no port the ready pods declare",
					Cause:   "Service targetPort likely wrong",
					Action:  "Confirm the Service targetPort matches the port the container listens on",
					Command: "kubectl get svc mismatch -n prod -o yaml",
				}},
				Probes: []probe.Result{{Layer: probe.LayerTCP, Path: probe.PathData, Port: 80, OK: true, Tone: probe.ToneHealthy, Detail: "tcp ok"}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	d := tr.Diagnosis
	if d == nil {
		t.Fatal("Diagnosis must be set for a targetPort mismatch")
	}
	if d.CauseCode != "svc:targetport-no-listener" {
		t.Errorf("Cause = %q, want svc:targetport-no-listener", d.CauseCode)
	}
	if d.NextAction != "Confirm the Service targetPort matches the port the container listens on" {
		t.Errorf("NextAction = %q, want the finding's Action", d.NextAction)
	}
}

// Reachable only via the apiserver proxy → the Diagnosis points at the
// in-cluster runner, and the verdict stays unknown (never over-claims healthy).
func TestDiagnosis_IndirectReachReRunInCluster(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Name: "apionly"},
		Verdict:  VerdictHealthy, // the apiserver probe escalates to healthy; CoverageVerdict downgrades indirect→unknown
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "apionly"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathAPIServer, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200 (via apiserver proxy)"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	d := tr.Diagnosis
	if d == nil {
		t.Fatal("Diagnosis must describe the indirect-only state")
	}
	if !strings.Contains(d.Summary, "API server") {
		t.Errorf("Summary = %q, want it to name the management-API (indirect) path", d.Summary)
	}
	if !strings.Contains(d.NextAction, "in-cluster") {
		t.Errorf("NextAction = %q, want the in-cluster re-run hint", d.NextAction)
	}
	if v := CoverageVerdict(tr); v != VerdictUnknown {
		t.Errorf("verdict = %q, want unknown (indirect must never read healthy)", v)
	}
}

// HONESTY INVARIANT: every promoted field traces to a real finding — the
// Summary is byte-equal to the finding's own Cause/Message, never invented.
func TestDiagnosis_SummaryIsPromotedNeverSynthesized(t *testing.T) {
	const cause = "Container 'app' keeps crashing (exit code 1)"
	pod := ResourceRef{Kind: "Pod", Namespace: "prod", Name: "app-xyz"}
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "crash"},
		BrokenAt: 1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "crash"}, Edge: "entry:Service", Config: &HopConfig{Ports: []PortMap{{Port: 80}}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods",
				Findings: []Finding{{Code: "problem:CrashLoopBackOff", Severity: SeverityCritical, Message: "m", Cause: cause, Resource: &pod}}},
		},
	}
	computeCoverage(tr)
	if tr.Diagnosis == nil || tr.Diagnosis.Summary != cause {
		t.Errorf("Summary = %+v, want it byte-equal to the finding's Cause (promoted, not synthesized)", tr.Diagnosis)
	}
}

// Nothing to diagnose when every route verified over real traffic.
func TestDiagnosis_AllVerifiedRealIsNil(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Name: "api"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "api"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if tr.Diagnosis != nil {
		t.Errorf("Diagnosis = %+v, want nil — a fully-verified real path has nothing to diagnose", tr.Diagnosis)
	}
}

// Benign intentional scale-to-0 is not a problem to diagnose.
func TestDiagnosis_BenignScaleZeroIsNil(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Name: "scaledzero"},
		Verdict:  VerdictBroken,
		BrokenAt: 0,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "scaledzero"}, Edge: "entry:Service",
				Config:   &HopConfig{Ports: []PortMap{{Port: 80}}},
				Findings: []Finding{{Code: k8s.ScaledToZeroFingerprint, Severity: SeverityWarning, Message: "Backing workload scaled to 0"}},
				Probes:   []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathAPIServer, OK: false, Tone: probe.ToneUnhealthy, Detail: "No ready backend endpoints"}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if tr.Diagnosis != nil {
		t.Errorf("Diagnosis = %+v, want nil — benign scale-to-0 reads via its route, not a diagnosis", tr.Diagnosis)
	}
}

func TestDedupeFacts_CollapsesExactDuplicates(t *testing.T) {
	in := []ProbeFact{
		{Layer: "http", Path: "apiserver", Target: "svc:80", OK: true, Tone: "healthy", Detail: "200"},
		{Layer: "http", Path: "apiserver", Target: "svc:80", OK: true, Tone: "healthy", Detail: "200"},
		{Layer: "tcp", Path: "data", Target: "pod-x:80", OK: true, Tone: "healthy", Detail: "ok"},
	}
	out := dedupeFacts(in)
	if len(out) != 2 {
		t.Errorf("dedupeFacts kept %d, want 2 (exact dup collapsed, distinct pod fact kept)", len(out))
	}
}

// The live crashloop shape: BrokenAt=0 is the Service's "no ready endpoints"
// SYMPTOM (critical, no Resource); the real root cause is the crashloop Pod
// finding on the deeper Pods hop. The Diagnosis must name the POD (with
// logs --previous), not the Service symptom.
func TestDiagnosis_PrefersPodRootCauseOverServiceSymptom(t *testing.T) {
	pod := ResourceRef{Kind: "Pod", Namespace: "prod", Name: "crash-xyz"}
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "crash"},
		Verdict:  VerdictBroken,
		BrokenAt: 0,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Namespace: "prod", Name: "crash"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 80}}},
				Findings: []Finding{{Code: "svc:no-ready-endpoints", Severity: SeverityCritical, Message: "0/1 selected pods ready",
					Command: "kubectl describe service crash -n prod"}}},
			{Resource: ResourceRef{Kind: "Pods", Namespace: "prod"}, Edge: "Service->Pods",
				Findings: []Finding{{Code: "problem:CrashLoopBackOff", Severity: SeverityCritical,
					Message: "back-off restarting failed container", Cause: "Container 'app' keeps crashing (exit code 1)",
					Command: "kubectl logs crash-xyz -n prod --previous", Resource: &pod}}},
		},
	}
	computeCoverage(tr)
	d := tr.Diagnosis
	if d == nil {
		t.Fatal("Diagnosis must be set")
	}
	if d.CulpritResource == nil || d.CulpritResource.Kind != "Pod" || d.CulpritResource.Name != "crash-xyz" {
		t.Errorf("CulpritResource = %+v, want the crashloop Pod (root cause), not the Service symptom", d.CulpritResource)
	}
	if !strings.Contains(d.Command, "--previous") {
		t.Errorf("Command = %q, want the pod logs --previous reproducer", d.Command)
	}
	if d.CauseCode != "" {
		t.Errorf("Cause = %q, want empty (pod-state code not promoted)", d.CauseCode)
	}
}

// TestApplyInClusterResults_UpgradesIndirectToReal: an in-cluster probe (the real
// dataplane) folded into a route the apiserver proxy could only reach INDIRECTLY
// upgrades it to confidence:real and re-derives the counts/headline.
func TestApplyInClusterResults_UpgradesIndirectToReal(t *testing.T) {
	tr := &Trace{
		Subject: ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"},
		Routes: []RouteResult{{
			Route: "api", Target: "api:80", Outcome: OutcomeReached, Confidence: ConfidenceIndirect,
			Evidence: "HTTP 404 · reached via proxy", InClusterRequest: &ProbeRequest{Scheme: "http", Path: "/"},
		}},
		Coverage: &Coverage{Tested: 1, Passed: 1},
	}
	results := map[string][]probe.Result{
		InClusterResultKey("api", "api:80", ""): {{Layer: probe.LayerHTTP, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}},
	}
	ApplyInClusterResults(tr, results)

	r := tr.Routes[0]
	if r.Confidence != ConfidenceReal {
		t.Errorf("confidence = %q, want real (the in-cluster data path IS real traffic)", r.Confidence)
	}
	if r.Outcome != OutcomeVerified {
		t.Errorf("outcome = %q, want verified (HTTP 200 from inside)", r.Outcome)
	}
	if r.InClusterRequest == nil {
		t.Error("the route's InClusterRequest guess must be preserved through the fold")
	}
	if !anyRealPass(tr.Routes) {
		t.Error("a real-traffic pass should now register (the honesty upgrade the proxy couldn't make)")
	}
}

// TestApplyInClusterResults_LeavesBenignUntouched: a deliberately scaled-to-0
// route is dormant by design, not a path to confirm — the fold must skip it.
func TestApplyInClusterResults_LeavesBenignUntouched(t *testing.T) {
	tr := &Trace{
		Routes: []RouteResult{{
			Route: "api", Target: "api:80", Outcome: OutcomeUnreachable, Benign: true,
			InClusterRequest: &ProbeRequest{Scheme: "http", Path: "/"},
		}},
		Coverage: &Coverage{Tested: 1, Failed: 1},
	}
	results := map[string][]probe.Result{
		"api:80": {{Layer: probe.LayerHTTP, OK: true, Tone: probe.ToneHealthy, Detail: "HTTP 200"}},
	}
	ApplyInClusterResults(tr, results)
	if tr.Routes[0].Outcome != OutcomeUnreachable || !tr.Routes[0].Benign {
		t.Errorf("benign scale-to-0 route must be left untouched, got %+v", tr.Routes[0])
	}
}
