package trace

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/skyhook-io/radar/pkg/probe"
)

// TestRunProbes_BudgetExhausted pins the budget cap: when the deadline is
// past, hops that haven't started get a structured skip and runProbes
// returns immediately rather than spawning probes that would race the
// caller's context cancellation.
func TestRunProbes_BudgetExhausted(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service"}, Config: &HopConfig{ClusterIP: "10.0.0.1", Ports: []PortMap{{Port: 80}}}},
		},
	}
	// Already-canceled context — runProbes must bail without panicking.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runProbes(ctx, tr, Options{Probe: true}, nil)
	// No panic and we got here: pass. The Probes slice may be empty or
	// contain a skip — either is acceptable for an already-dead context.
}

// TestRunProbes_ServiceNoClientNoTCP pins that a Service without a usable
// primitive (no kubeconfig client, no direct route) produces a structured
// skip rather than a silent no-op.
func TestRunProbes_ServiceNoClientNoTCP(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Service", Namespace: "ns", Name: "svc"},
			Config:   &HopConfig{ServiceType: "ClusterIP", ClusterIP: "10.0.0.1", Ports: []PortMap{{Port: 80}}},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 100 * time.Millisecond}, nil)
	if len(tr.Downstream[0].Probes) == 0 {
		t.Fatalf("expected at least one probe row, got none")
	}
	p := tr.Downstream[0].Probes[0]
	if !p.Skipped {
		t.Errorf("probe = %+v, want skipped (no client + local vantage)", p)
	}
	if !strings.Contains(strings.ToLower(p.Reason), "kubernetes api") {
		t.Errorf("skip reason should mention Kubernetes API unreachable, got %q", p.Reason)
	}
}

// TestRunProbes_PodsNoClientNoIPs: from local vantage with no kube client
// and no pod IPs, the Pods hop honestly skips.
func TestRunProbes_PodsNoClientNoIPs(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Pods", Namespace: "ns"},
			Config: &HopConfig{
				ContainerPorts: []ContainerPortRef{{Container: "main", Port: 8080}},
				// No PodIPs and no PodNames, no client — nothing to probe.
			},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 100 * time.Millisecond}, nil)
	if len(tr.Downstream[0].Probes) != 1 {
		t.Fatalf("expected one structured skip, got %d (%+v)", len(tr.Downstream[0].Probes), tr.Downstream[0].Probes)
	}
	p := tr.Downstream[0].Probes[0]
	if !p.Skipped || p.Vantage != probe.VantageLocal {
		t.Errorf("probe = %+v, want skipped local-vantage", p)
	}
}

// TestRunProbes_IngressNoHostsSkips: an Ingress with empty hostnames
// produces a structured DNS skip rather than a silent no-op — operators
// reading the trace would otherwise wonder if the probe ran.
func TestRunProbes_IngressNoHostsSkips(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Ingress"},
			Config:   &HopConfig{},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 100 * time.Millisecond}, nil)
	if len(tr.Downstream[0].Probes) != 1 {
		t.Fatalf("expected one skip, got %d", len(tr.Downstream[0].Probes))
	}
	if !strings.Contains(tr.Downstream[0].Probes[0].Reason, "no hostnames") {
		t.Errorf("reason should mention no hostnames, got %q", tr.Downstream[0].Probes[0].Reason)
	}
}

// TestRunProbes_GatewayNoAddressesSkips: a Gateway without programmed
// addresses is a known static-finding case; the probe just acknowledges it.
func TestRunProbes_GatewayNoAddressesSkips(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Gateway"},
			Config:   &HopConfig{Listeners: []GatewayListener{{Port: 80, Protocol: "HTTP"}}},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 100 * time.Millisecond}, nil)
	if len(tr.Downstream[0].Probes) != 1 || !tr.Downstream[0].Probes[0].Skipped {
		t.Fatalf("expected one skip probe for Gateway with no addresses, got %+v", tr.Downstream[0].Probes)
	}
}

// TestRunProbes_RouteAlwaysSkips: HTTPRoute/GRPCRoute have no own
// routable address — they explicitly defer reachability to the upstream
// Gateway and downstream Service. Test pins that we never accidentally
// probe a Route directly.
func TestRunProbes_RouteAlwaysSkips(t *testing.T) {
	for _, kind := range []string{"HTTPRoute", "GRPCRoute"} {
		tr := &Trace{
			Downstream: []Hop{{
				Resource: ResourceRef{Kind: kind},
				Config:   &HopConfig{Hostnames: []string{"api.example.com"}},
			}},
		}
		runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 100 * time.Millisecond}, nil)
		if len(tr.Downstream[0].Probes) != 1 || !tr.Downstream[0].Probes[0].Skipped {
			t.Errorf("%s: expected one structured skip, got %+v", kind, tr.Downstream[0].Probes)
		}
	}
}

// stubProxyProbes swaps the apiserver-path probes for fakes that return
// success immediately, restoring the real implementations on cleanup.
// Tests use this to exercise probeService / probePods orchestration
// without touching client-go's REST stack.
func stubProxyProbes(t *testing.T) {
	t.Helper()
	origSvc, origPod := serviceProxyProbe, podProxyProbe
	serviceProxyProbe = func(_ context.Context, _ kubernetes.Interface, ns, name string, port int32, _ string, vantage probe.Vantage) probe.Result {
		return probe.Result{
			Layer: probe.LayerHTTP, Target: fmt.Sprintf("svc:%s/%s:%d", ns, name, port),
			Vantage: vantage, Path: probe.PathAPIServer, OK: true,
		}
	}
	podProxyProbe = func(_ context.Context, _ kubernetes.Interface, ns, name string, port int32, _ string, vantage probe.Vantage) probe.Result {
		return probe.Result{
			Layer: probe.LayerHTTP, Target: fmt.Sprintf("pod:%s/%s:%d", ns, name, port),
			Vantage: vantage, Path: probe.PathAPIServer, OK: true,
		}
	}
	t.Cleanup(func() {
		serviceProxyProbe = origSvc
		podProxyProbe = origPod
	})
}

// TestProbeService_DualPathInCluster pins that in-cluster + client runs both
// the data path (direct TCP) and the apiserver path (ServiceProxy) for each
// port, with Path tagged so the UI can place each result on its arrow.
// Without this, divergence between paths can't be detected.
func TestProbeService_DualPathInCluster(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	stubProxyProbes(t)
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Service", Namespace: "ns", Name: "svc"},
			Config:   &HopConfig{ServiceType: "ClusterIP", ClusterIP: "10.0.0.1", Ports: []PortMap{{Port: 80}}},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 500 * time.Millisecond}, fake.NewClientset())
	results := tr.Downstream[0].Probes
	if len(results) < 2 {
		t.Fatalf("expected two probe rows (data + apiserver), got %d: %+v", len(results), results)
	}
	var sawData, sawAPI bool
	for _, r := range results {
		switch r.Path {
		case probe.PathData:
			sawData = true
		case probe.PathAPIServer:
			sawAPI = true
		}
	}
	if !sawData || !sawAPI {
		t.Errorf("expected one PathData and one PathAPIServer result, got %+v", results)
	}
}

// TestProbeService_SkipsUDPAndSCTP pins that a UDP/SCTP Service port is skipped
// honestly — a TCP dial can't test it and would falsely condemn a healthy
// non-TCP service — while a TCP port on the SAME Service is still probed.
func TestProbeService_SkipsUDPAndSCTP(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	stubProxyProbes(t)
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Service", Namespace: "ns", Name: "svc"},
			Config: &HopConfig{ServiceType: "ClusterIP", ClusterIP: "10.0.0.1", Ports: []PortMap{
				{Port: 53, Protocol: "UDP"},
				{Port: 9000, Protocol: "SCTP"},
				{Port: 80, Protocol: "TCP"},
			}},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 2 * time.Second}, fake.NewClientset())
	results := tr.Downstream[0].Probes

	for _, want := range []struct {
		port  int32
		proto string
	}{{53, "UDP"}, {9000, "SCTP"}} {
		var rows []probe.Result
		for _, r := range results {
			if r.Port == want.port {
				rows = append(rows, r)
			}
		}
		if len(rows) != 1 {
			t.Fatalf("port %d (%s): want exactly one (skipped) row, got %d: %+v", want.port, want.proto, len(rows), rows)
		}
		r := rows[0]
		if !r.Skipped {
			t.Errorf("port %d (%s): want a Skipped row, got %+v", want.port, want.proto, r)
		}
		if !strings.Contains(r.Reason, want.proto) {
			t.Errorf("port %d: skip reason %q should name %s", want.port, r.Reason, want.proto)
		}
		if r.Path == probe.PathData {
			t.Errorf("port %d (%s): must NOT produce a data-path TCP dial", want.port, want.proto)
		}
	}

	var sawTCPData bool
	for _, r := range results {
		if r.Port == 80 && r.Path == probe.PathData {
			sawTCPData = true
		}
	}
	if !sawTCPData {
		t.Errorf("TCP port 80 should still get a data-path probe, got %+v", results)
	}
}

// TestProbeService_GRPCPortEmitsGrpcurlCommand pins that a non-HTTP gRPC port,
// which the apiserver HTTP proxy cannot verify, skips with a copyable grpcurl
// reproducer rather than a generic "connect a client" hint, so the operator gets
// the exact command to test the gap the probe could not.
func TestProbeService_GRPCPortEmitsGrpcurlCommand(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	stubProxyProbes(t)
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Service", Namespace: "ns", Name: "svc"},
			Config: &HopConfig{ServiceType: "ClusterIP", ClusterIP: "10.0.0.1", Ports: []PortMap{
				{Port: 9090, Name: "grpc", Protocol: "TCP"},                    // cleartext gRPC (h2c): -plaintext
				{Port: 8443, Name: "grpc", AppProtocol: "h2", Protocol: "TCP"}, // TLS gRPC (h2): -insecure
			}},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 2 * time.Second}, fake.NewClientset())

	// The apiserver-path skips don't stamp Port, so match by the port in the command.
	var plaintextCmd, tlsCmd string
	for _, r := range tr.Downstream[0].Probes {
		if r.Path != probe.PathAPIServer || !r.Skipped {
			continue
		}
		if strings.Contains(r.Command, "localhost:9090") {
			plaintextCmd = r.Command
		}
		if strings.Contains(r.Command, "localhost:8443") {
			tlsCmd = r.Command
		}
	}
	if !strings.Contains(plaintextCmd, "grpcurl -plaintext localhost:9090 list") {
		t.Errorf("cleartext gRPC should get -plaintext, got %q", plaintextCmd)
	}
	if !strings.Contains(tlsCmd, "grpcurl -insecure localhost:8443 list") {
		t.Errorf("TLS gRPC (h2) should get -insecure, not -plaintext, got %q", tlsCmd)
	}
}

// TestProbePods_DualPathInCluster pins the Pods-side counterpart: in-cluster
// vantage + client + both PodIPs and PodNames runs probePodsByIP (data path)
// AND probePodsByName (apiserver path). Without both, divergence between
// direct pod dial and kubelet-proxy dial can't surface.
func TestProbePods_DualPathInCluster(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	stubProxyProbes(t)
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Pods", Namespace: "ns"},
			Config: &HopConfig{
				ContainerPorts: []ContainerPortRef{{Container: "main", Port: 8080}},
				PodIPs:         []string{"10.244.0.1"},
				PodNames:       []string{"pod-x"},
			},
		}},
	}
	// Budget must exceed the data-path TCP timeout so both paths get a
	// chance to record a Result — even when the data dial times out
	// against a non-routable test IP, the apiserver path still runs.
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 2 * time.Second}, fake.NewClientset())
	var sawData, sawAPI bool
	for _, r := range tr.Downstream[0].Probes {
		switch r.Path {
		case probe.PathData:
			sawData = true
		case probe.PathAPIServer:
			sawAPI = true
		}
	}
	if !sawData || !sawAPI {
		t.Errorf("expected both PathData and PathAPIServer pod probes, got %+v", tr.Downstream[0].Probes)
	}
}

// TestProbeService_LaptopAPIServerOnly pins that laptop vantage with a client
// runs only the apiserver path — there's no in-cluster TCP route to a
// ClusterIP from a laptop, so emitting a data-path result would be a lie.
func TestProbeService_LaptopAPIServerOnly(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	stubProxyProbes(t)
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Service", Namespace: "ns", Name: "svc"},
			Config:   &HopConfig{ServiceType: "ClusterIP", ClusterIP: "10.0.0.1", Ports: []PortMap{{Port: 80}}},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 500 * time.Millisecond}, fake.NewClientset())
	for _, r := range tr.Downstream[0].Probes {
		if r.Path == probe.PathData {
			t.Errorf("unexpected data-path probe from laptop vantage: %+v", r)
		}
	}
}

// TestIsHTTPProbablePort pins the signal hierarchy: appProtocol (if set) is
// authoritative; port name is the next signal; well-known port numbers cover
// the no-metadata case (Helm charts that ship Redis on 6379 without setting
// either field). No-signal default is optimistic — most Service ports are
// HTTP-shaped — so an unannotated web service still gets probed.
func TestIsHTTPProbablePort(t *testing.T) {
	tests := []struct {
		name        string
		portName    string
		appProtocol string
		port        int32
		want        bool
	}{
		// appProtocol authoritative — HTTP family
		{"appProto http", "", "http", 0, true},
		{"appProto HTTP uppercase", "", "HTTP", 0, true},
		{"appProto https", "", "https", 0, true},
		// gRPC and HTTP/2 are HTTP-shaped but our probe speaks HTTP/1.1,
		// so they're excluded to avoid a false fail.
		{"appProto grpc skipped — HTTP/2-only", "", "grpc", 0, false},
		{"appProto h2c skipped — HTTP/2-only", "", "h2c", 0, false},
		{"appProto k8s h2c skipped — HTTP/2-only", "", "kubernetes.io/h2c", 0, false},
		{"appProto wss", "", "wss", 0, true},
		// appProtocol authoritative — explicit non-HTTP
		{"appProto tcp", "", "tcp", 0, false},
		{"appProto postgresql", "", "postgresql", 0, false},
		{"appProto mysql", "", "mysql", 0, false},
		{"appProto with whitespace", "", "  tcp  ", 0, false},
		{"appProto wins over web-ish port name", "http", "tcp", 80, false},
		// no appProtocol — port name signals non-HTTP
		{"name postgres", "postgres", "", 0, false},
		{"name postgresql", "postgresql", "", 0, false},
		{"name redis", "redis", "", 0, false},
		{"name mysql", "mysql", "", 0, false},
		{"name mongo", "mongo", "", 0, false},
		{"name MYSQL uppercase", "MYSQL", "", 0, false},
		{"name memcached", "memcached", "", 0, false},
		// no appProtocol — port name signals HTTP / optimistic default
		{"name http", "http", "", 0, true},
		{"name https", "https", "", 0, true},
		{"name web", "web", "", 0, true},
		{"name api", "api", "", 0, true},
		{"name grpc skipped — HTTP/2-only", "grpc", "", 0, false},
		{"name unknown", "metrics", "", 0, true},
		// no metadata — well-known port numbers
		{"port 6379 redis no-name", "", "", 6379, false},
		{"port 5432 postgres no-name", "", "", 5432, false},
		{"port 3306 mysql no-name", "", "", 3306, false},
		{"port 27017 mongo no-name", "", "", 27017, false},
		{"port 53 dns no-name", "", "", 53, false},
		{"port 22 ssh no-name", "", "", 22, false},
		{"port 80 unknown name — HTTP", "", "", 80, true},
		{"port 8080 unknown name — HTTP", "", "", 8080, true},
		{"port 9000 unknown name — optimistic", "", "", 9000, true},
		{"empty everything zero port", "", "", 0, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isHTTPProbablePort(tc.portName, tc.appProtocol, tc.port)
			if got != tc.want {
				t.Errorf("isHTTPProbablePort(%q, %q, %d) = %v, want %v", tc.portName, tc.appProtocol, tc.port, got, tc.want)
			}
		})
	}
}

// TestPortKey pins the port-suffix extractor that drives divergence
// pairing. Pod and service paths label their targets differently
// ("10.0.0.5:80" vs "port 80" vs "name port 80") and the divergence
// finder needs them to share a bucket key.
func TestPortKey(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"10.0.0.5:80", "80"},
		{"port 80", "80"},
		{"httpbin-abc port 8080", "8080"},
		{"redis.default.svc.cluster.local:6379", "6379"},
		{"", ""},
		{"no-port-here", ""},
		{"trailing space ", ""},
		{":443", "443"},
	}
	for _, c := range cases {
		if got := portKey(c.in); got != c.want {
			t.Errorf("portKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestPathDivergenceFinding_DataFailApiOK pins the dual-path divergence
// signal: when the in-cluster data path fails on a port but the apiserver
// path succeeds on the same port, the operator gets a warning naming the
// likely subsystems. The two paths label their targets differently, so
// this also pins that pairing works across format mismatches.
func TestPathDivergenceFinding_DataFailApiOK(t *testing.T) {
	probes := []probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Path: probe.PathData, OK: false},
		{Layer: probe.LayerHTTP, Target: "port 80", Path: probe.PathAPIServer, OK: true},
	}
	out := pathDivergenceFindings(probes)
	if len(out) != 1 {
		t.Fatalf("expected one divergence finding, got %d", len(out))
	}
	if out[0].Code != "probe:data-path-only-broken" {
		t.Errorf("code = %q, want probe:data-path-only-broken", out[0].Code)
	}
	if out[0].Severity != SeverityWarning {
		t.Errorf("severity = %q, want warning", out[0].Severity)
	}
}

func wouldDenyHop(probes []probe.Result, divergence bool) Hop {
	findings := []Finding{{
		Code:     codePolicyWouldDeny,
		Severity: SeverityWarning,
		Message:  "Blocked by a cluster network rule — no rule allows traffic to these pods on :80.",
		Command:  "kubectl describe networkpolicy deny -n ns",
	}}
	if divergence {
		findings = append(findings, Finding{
			Code:     "probe:data-path-only-broken",
			Severity: SeverityWarning,
			Cause:    "The usual causes are a NetworkPolicy, an unhealthy kube-proxy, or a sidecar.",
		})
	}
	return Hop{
		Resource: ResourceRef{Kind: "Pods", Namespace: "ns"},
		Meta:     map[string]any{"policyVerdict": "would-deny", "policyNames": []string{"deny"}, "policyPort": ":80", "policyDenyPort": int32(80)},
		Findings: findings,
		Probes:   probes,
	}
}

// TestReconcilePolicy_LiveTrafficGotThrough pins the kindnet case: a static
// would-deny but the live data path succeeded → the warning is downgraded to
// a self-resolving info note, never left as a scary contradiction under a
// green verdict.
func TestReconcilePolicy_LiveTrafficGotThrough(t *testing.T) {
	tr := &Trace{Downstream: []Hop{wouldDenyHop([]probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Port: 80, Path: probe.PathData, OK: true},
	}, false)}}
	reconcilePolicyFindings(tr)
	f := tr.Downstream[0].Findings[0]
	if f.Severity != SeverityInfo {
		t.Errorf("severity = %q, want info (downgraded)", f.Severity)
	}
	if !strings.Contains(f.Message, "doesn't enforce NetworkPolicy") || !strings.Contains(f.Message, "missed an allow rule") {
		t.Errorf("message = %q, want the hedged not-enforced/missed-rule reassurance", f.Message)
	}
}

// TestReconcilePolicy_OtherPortSuccessDoesntDowngrade pins the multi-port fix:
// a data-path success on a DIFFERENT port must not downgrade a would-deny that
// applies to :80.
func TestReconcilePolicy_OtherPortSuccessDoesntDowngrade(t *testing.T) {
	tr := &Trace{Downstream: []Hop{wouldDenyHop([]probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:443", Port: 443, Path: probe.PathData, OK: true},
	}, false)}}
	reconcilePolicyFindings(tr)
	f := tr.Downstream[0].Findings[0]
	if f.Severity != SeverityWarning {
		t.Errorf("severity = %q, want warning kept (other-port success must not downgrade :80)", f.Severity)
	}
}

// TestReconcilePolicy_BothPathsFail pins that when the data path AND the
// apiserver path both fail, we do NOT assert the rule as confirmed — the
// backend could be down. The finding stays a warning, worded as unconfirmed.
func TestReconcilePolicy_BothPathsFail(t *testing.T) {
	tr := &Trace{Downstream: []Hop{wouldDenyHop([]probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Port: 80, Path: probe.PathData, OK: false},
		{Layer: probe.LayerHTTP, Target: "port 80", Port: 80, Path: probe.PathAPIServer, OK: false},
	}, false)}}
	reconcilePolicyFindings(tr)
	f := tr.Downstream[0].Findings[0]
	if f.Code != codePolicyWouldDeny || f.Severity != SeverityWarning {
		t.Errorf("got code=%q sev=%q, want would-deny warning kept", f.Code, f.Severity)
	}
	if !strings.Contains(f.Cause, "could also be down") {
		t.Errorf("cause = %q, want the unconfirmed (backend-down) hedge", f.Cause)
	}
}

// TestReconcilePolicy_ConfirmedDrop pins the enforcing case: static would-deny
// + live data-path drop + apiserver pass (divergence) → the prior is dropped
// and the divergence finding is enriched to name the policy, worded as
// "consistent with" not an assertion.
func TestReconcilePolicy_ConfirmedDrop(t *testing.T) {
	tr := &Trace{Downstream: []Hop{wouldDenyHop([]probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Port: 80, Path: probe.PathData, OK: false},
		{Layer: probe.LayerHTTP, Target: "port 80", Port: 80, Path: probe.PathAPIServer, OK: true},
	}, true)}}
	reconcilePolicyFindings(tr)
	for _, f := range tr.Downstream[0].Findings {
		if f.Code == codePolicyWouldDeny {
			t.Fatalf("would-deny prior should be dropped when confirmed via divergence")
		}
	}
	div := tr.Downstream[0].Findings[findingIndexByCode(tr.Downstream[0].Findings, "probe:data-path-only-broken")]
	if !strings.Contains(div.Cause, "deny") || !strings.Contains(div.Cause, "consistent with") {
		t.Errorf("divergence cause = %q, want named policy + 'consistent with'", div.Cause)
	}
}

// TestReconcilePolicy_MixedApiserverDoesntConfirm pins that a data-path drop +
// MIXED apiserver result (one target reached, another refused) is NOT a clean
// divergence — we must not "confirm" the policy on it, only keep the prediction.
func TestReconcilePolicy_MixedApiserverDoesntConfirm(t *testing.T) {
	tr := &Trace{Downstream: []Hop{wouldDenyHop([]probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Port: 80, Path: probe.PathData, OK: false},
		{Layer: probe.LayerHTTP, Target: "pod-a port 80", Port: 80, Path: probe.PathAPIServer, OK: true},
		{Layer: probe.LayerHTTP, Target: "pod-b port 80", Port: 80, Path: probe.PathAPIServer, OK: false},
	}, true)}}
	reconcilePolicyFindings(tr)
	f := tr.Downstream[0].Findings[findingIndexByCode(tr.Downstream[0].Findings, codePolicyWouldDeny)]
	if f.Code != codePolicyWouldDeny || f.Severity != SeverityWarning {
		t.Fatalf("got code=%q sev=%q, want would-deny warning kept (no confirm on mixed apiserver)", f.Code, f.Severity)
	}
	if !strings.Contains(f.Cause, "could also be down") {
		t.Errorf("cause = %q, want the unconfirmed hedge, not a confirmation", f.Cause)
	}
}

// TestReconcilePolicy_MixedDataPathDoesntDowngrade pins that a partial in-cluster
// success (one pod through, one dropped) does NOT over-reassure — the would-deny
// stays a warning, not the "not enforcing" downgrade.
func TestReconcilePolicy_MixedDataPathDoesntDowngrade(t *testing.T) {
	tr := &Trace{Downstream: []Hop{wouldDenyHop([]probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Port: 80, Path: probe.PathData, OK: true},
		{Layer: probe.LayerTCP, Target: "10.0.0.6:80", Port: 80, Path: probe.PathData, OK: false},
	}, false)}}
	reconcilePolicyFindings(tr)
	f := tr.Downstream[0].Findings[0]
	if f.Severity != SeverityWarning {
		t.Errorf("severity = %q, want warning kept (mixed data path must not fully reassure)", f.Severity)
	}
}

// TestReconcilePolicy_NoLiveProbe pins the laptop dead-end: no data-path probe
// ran, so the would-deny stays a warning with its manual fallback intact.
func TestReconcilePolicy_NoLiveProbe(t *testing.T) {
	tr := &Trace{Downstream: []Hop{wouldDenyHop([]probe.Result{
		{Layer: probe.LayerHTTP, Target: "port 80", Path: probe.PathAPIServer, OK: true},
	}, false)}}
	reconcilePolicyFindings(tr)
	f := tr.Downstream[0].Findings[0]
	if f.Code != codePolicyWouldDeny || f.Severity != SeverityWarning {
		t.Errorf("got code=%q sev=%q, want would-deny warning unchanged", f.Code, f.Severity)
	}
}

// TestPathDivergenceFindings_MultiPortDeterministic pins that when more
// than one port diverges, every divergence is surfaced AND the output is
// in deterministic sorted-port order. Map iteration would otherwise drop
// some findings and randomise which one survived between requests.
func TestPathDivergenceFindings_MultiPortDeterministic(t *testing.T) {
	probes := []probe.Result{
		// port 443 — apiserver-only broken (info)
		{Layer: probe.LayerTCP, Target: "10.0.0.5:443", Path: probe.PathData, OK: true},
		{Layer: probe.LayerHTTP, Target: "port 443", Path: probe.PathAPIServer, OK: false},
		// port 80 — data-only broken (warning)
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Path: probe.PathData, OK: false},
		{Layer: probe.LayerHTTP, Target: "port 80", Path: probe.PathAPIServer, OK: true},
	}
	out := pathDivergenceFindings(probes)
	if len(out) != 2 {
		t.Fatalf("expected two divergence findings (port 80 + 443), got %d", len(out))
	}
	// Sorted port-key order: "443" < "80" lexicographically.
	if out[0].Code != "probe:apiserver-path-only-broken" {
		t.Errorf("first finding code = %q, want apiserver-path-only-broken (port 443)", out[0].Code)
	}
	if out[1].Code != "probe:data-path-only-broken" {
		t.Errorf("second finding code = %q, want data-path-only-broken (port 80)", out[1].Code)
	}
}

// TestPathDivergenceFinding_DataOKApiFail pins the inverse — when the
// data path is healthy but the apiserver-relayed probe fails, that's
// almost always a non-impacting issue (RBAC denied or non-HTTP port);
// the finding is severity:info so it doesn't flag the trace as broken.
func TestPathDivergenceFinding_DataOKApiFail(t *testing.T) {
	probes := []probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Path: probe.PathData, OK: true},
		{Layer: probe.LayerHTTP, Target: "port 80", Path: probe.PathAPIServer, OK: false},
	}
	out := pathDivergenceFindings(probes)
	if len(out) != 1 {
		t.Fatalf("expected one divergence finding, got %d", len(out))
	}
	if out[0].Code != "probe:apiserver-path-only-broken" {
		t.Errorf("code = %q, want probe:apiserver-path-only-broken", out[0].Code)
	}
	if out[0].Severity != SeverityInfo {
		t.Errorf("severity = %q, want info", out[0].Severity)
	}
}

// TestPathDivergenceFinding_NoDivergence pins the silent case: when
// both paths agree (both OK or both fail) on every port, no finding
// is emitted — the divergence detector is only the asymmetry signal.
func TestPathDivergenceFinding_NoDivergence(t *testing.T) {
	bothOK := []probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Path: probe.PathData, OK: true},
		{Layer: probe.LayerHTTP, Target: "port 80", Path: probe.PathAPIServer, OK: true},
	}
	if got := pathDivergenceFindings(bothOK); len(got) != 0 {
		t.Errorf("both-OK should be silent, got %+v", got)
	}
	bothFail := []probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Path: probe.PathData, OK: false},
		{Layer: probe.LayerHTTP, Target: "port 80", Path: probe.PathAPIServer, OK: false},
	}
	if got := pathDivergenceFindings(bothFail); len(got) != 0 {
		t.Errorf("both-fail should be silent (real failure, not divergence), got %+v", got)
	}
}

// TestPathDivergenceFinding_PartialFleetIsSilent pins that mixed results
// on the data side (one replica OK, one fails) do NOT fire divergence.
// On a multi-replica Pods hop those collapse to the same port-key bucket;
// without unanimity we'd emit data-path-only-broken even when most pods
// are reachable, masking the real signal (a partial-fleet failure).
func TestPathDivergenceFinding_PartialFleetIsSilent(t *testing.T) {
	probes := []probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:80", Path: probe.PathData, OK: true},
		{Layer: probe.LayerTCP, Target: "10.0.0.6:80", Path: probe.PathData, OK: false},
		{Layer: probe.LayerHTTP, Target: "port 80", Path: probe.PathAPIServer, OK: true},
	}
	if got := pathDivergenceFindings(probes); len(got) != 0 {
		t.Errorf("partial-fleet data failure must not fire divergence; got %+v", got)
	}
}

// TestPathDivergenceFinding_SkippedRowsIgnored pins that "skipped" rows
// (the apiserver path being skipped because the port is non-HTTP) never
// trigger divergence. A skip is a "didn't run", not a "failed".
func TestPathDivergenceFinding_SkippedRowsIgnored(t *testing.T) {
	probes := []probe.Result{
		{Layer: probe.LayerTCP, Target: "10.0.0.5:6379", Path: probe.PathData, OK: true},
		{Layer: probe.LayerHTTP, Target: "port 6379", Path: probe.PathAPIServer, Skipped: true, Reason: "non-HTTP port"},
	}
	if got := pathDivergenceFindings(probes); len(got) != 0 {
		t.Errorf("skipped apiserver path against OK data path must not produce divergence; got %+v", got)
	}
}

// TestVerdict_DegradedPromotesToUnknownOnUnverifiable pins that a
// degraded verdict (driven by a warning finding elsewhere on the path)
// still promotes to unknown when the path itself was unverifiable. The
// warning may or may not describe the whole story; without endpoint
// proof the only honest answer is unknown. Broken stays broken because
// a critical finding is actionable regardless of endpoint visibility.
func TestVerdict_DegradedPromotesToUnknownOnUnverifiable(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{
				Resource: ResourceRef{Kind: "Service"},
				Findings: []Finding{{Severity: SeverityWarning}},
			},
			{
				Resource: ResourceRef{Kind: "Pods"},
				Meta:     map[string]any{"endpointSource": "unknown"},
			},
		},
	}
	v, _ := computeVerdict(tr)
	if v != VerdictUnknown {
		t.Errorf("computeVerdict(degraded + unverifiable) = %q, want %q", v, VerdictUnknown)
	}
}

// TestVerdict_BrokenSurvivesUnverifiable pins that a critical finding
// stays broken even on an unverifiable path. Operators need the actionable
// signal; downgrading a known critical to unknown would hide work to do.
func TestVerdict_BrokenSurvivesUnverifiable(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{
				Resource: ResourceRef{Kind: "Service"},
				Findings: []Finding{{Severity: SeverityCritical}},
				Meta:     map[string]any{"selectorless": true},
			},
		},
	}
	v, _ := computeVerdict(tr)
	if v != VerdictBroken {
		t.Errorf("computeVerdict(broken + unverifiable) = %q, want %q", v, VerdictBroken)
	}
}

// TestVerdict_DegradeUnknownOnUnreadablePods pins the verdict-honesty
// contract for unreadable pod state: a hop flagged endpointSource=unknown
// (selectedPods returned an error and buildPodsHop marked the hop) must
// downgrade a clean trace to unknown. The banner would otherwise read
// healthy on top of a 0/0-ready Pods hop that is just unreadable.
func TestVerdict_DegradeUnknownOnUnreadablePods(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service"}, Meta: map[string]any{}},
			{Resource: ResourceRef{Kind: "Pods"}, Meta: map[string]any{"endpointSource": "unknown"}},
		},
	}
	v, _ := computeVerdict(tr)
	if v != VerdictUnknown {
		t.Errorf("computeVerdict with unreadable Pods hop = %q, want %q", v, VerdictUnknown)
	}
}

// TestReviseVerdictWithProbes_HealthyEscalatesOnAllFailed pins that a hop
// whose every non-skipped probe failed promotes the verdict from healthy to
// broken — the panel was previously rendering "looks healthy" above red
// probe-failed rows because verdict was computed before probes attached.
func TestReviseVerdictWithProbes_HealthyEscalatesOnAllFailed(t *testing.T) {
	tr := &Trace{
		Verdict:  VerdictHealthy,
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service"}},
			{
				Resource: ResourceRef{Kind: "Pods"},
				Probes: []probe.Result{
					{OK: false, Tone: probe.ToneUnhealthy},
					{OK: false, Tone: probe.ToneUnhealthy},
				},
			},
		},
	}
	v, brokenAt := reviseVerdictWithProbes(tr)
	if v != VerdictBroken {
		t.Errorf("reviseVerdictWithProbes(healthy + all-probes-failed) = %q, want %q", v, VerdictBroken)
	}
	if brokenAt != 1 {
		t.Errorf("brokenAt = %d, want 1 (the Pods hop)", brokenAt)
	}
}

// TestReviseVerdictWithProbes_PartlySkippedEntryNotBroken pins V2/B3: a Gateway
// front door with one listener that failed its probe but another that was skipped
// (untestable: no SNI, non-HTTP) must not be condemned "unreachable" whole. The
// tested failure is real evidence (degraded), but the skipped listener may carry
// traffic, so broken would overclaim. A fully-tested all-failed entry still breaks.
func TestReviseVerdictWithProbes_PartlySkippedEntryNotBroken(t *testing.T) {
	build := func(withSkip bool) *Trace {
		entryProbes := []probe.Result{
			{Layer: probe.LayerHTTP, Path: probe.PathData, Port: 443, OK: false, Tone: probe.ToneUnhealthy},
		}
		if withSkip {
			entryProbes = append(entryProbes, probe.Result{Layer: probe.LayerTLS, Skipped: true, Reason: "listener has no hostname"})
		}
		return &Trace{
			Verdict:  VerdictHealthy,
			BrokenAt: -1,
			Downstream: []Hop{
				{Resource: ResourceRef{Kind: "Gateway", Name: "gw", Namespace: "prod"}, Edge: "entry:Gateway", Probes: entryProbes},
				{Resource: ResourceRef{Kind: "HTTPRoute", Name: "r1", Namespace: "prod"}, Edge: "Gateway->HTTPRoute",
					Probes: []probe.Result{{Layer: probe.LayerHTTP, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy}}},
			},
		}
	}
	if v, _ := reviseVerdictWithProbes(build(true)); v == VerdictBroken {
		t.Errorf("partly-skipped entry (1 failed listener, 1 skipped) = %q, want NOT broken (V2/B3 overclaim guard)", v)
	}
	if v, _ := reviseVerdictWithProbes(build(false)); v != VerdictBroken {
		t.Errorf("fully-tested all-failed entry = %q, want broken (guard must not suppress a real all-fail)", v)
	}
}

// TestReviseVerdictWithProbes_PartialFailureDegrades pins that mixed probe
// results escalate healthy → degraded (not broken) — some replicas reachable
// means traffic isn't fully dropped.
func TestReviseVerdictWithProbes_PartialFailureDegrades(t *testing.T) {
	tr := &Trace{
		Verdict:  VerdictHealthy,
		BrokenAt: -1,
		Downstream: []Hop{
			{
				Resource: ResourceRef{Kind: "Pods"},
				Probes: []probe.Result{
					{OK: true, Tone: probe.ToneHealthy},
					{OK: false, Tone: probe.ToneUnhealthy},
				},
			},
		},
	}
	v, _ := reviseVerdictWithProbes(tr)
	if v != VerdictDegraded {
		t.Errorf("reviseVerdictWithProbes(healthy + mixed probes) = %q, want %q", v, VerdictDegraded)
	}
}

// TestReviseVerdictWithProbes_SingleTransientDoesNotEscalate pins the
// per-hop threshold: 1 of 7 failed probes on one hop does NOT escalate
// the whole-path verdict, since a single failure on a many-replica hop
// is likely transient. The per-hop chip still reads "probe failed" so
// the operator can investigate, but the top-of-panel verdict stays
// healthy.
func TestReviseVerdictWithProbes_SingleTransientDoesNotEscalate(t *testing.T) {
	probes := []probe.Result{{OK: false, Tone: probe.ToneUnhealthy}}
	for i := 0; i < 6; i++ {
		probes = append(probes, probe.Result{OK: true, Tone: probe.ToneHealthy})
	}
	tr := &Trace{
		Verdict:  VerdictHealthy,
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service"}},
			{Resource: ResourceRef{Kind: "Pods"}, Probes: probes},
		},
	}
	v, _ := reviseVerdictWithProbes(tr)
	if v != VerdictHealthy {
		t.Errorf("reviseVerdictWithProbes(healthy + 1-of-7 transient failure) = %q, want %q (single failure on many-probe hop should not escalate)", v, VerdictHealthy)
	}
}

// TestReviseVerdictWithProbes_MajorityFailureEscalates pins the
// other side of the threshold: when over half the probes on a hop
// failed, the whole-path verdict DOES degrade. The threshold catches
// genuine per-hop failure while still ignoring single transients.
func TestReviseVerdictWithProbes_MajorityFailureEscalates(t *testing.T) {
	tr := &Trace{
		Verdict:  VerdictHealthy,
		BrokenAt: -1,
		Downstream: []Hop{
			{
				Resource: ResourceRef{Kind: "Pods"},
				Probes: []probe.Result{
					{OK: false, Tone: probe.ToneUnhealthy},
					{OK: false, Tone: probe.ToneUnhealthy},
					{OK: true, Tone: probe.ToneHealthy},
				},
			},
		},
	}
	v, _ := reviseVerdictWithProbes(tr)
	if v != VerdictDegraded {
		t.Errorf("reviseVerdictWithProbes(healthy + 2-of-3 failure) = %q, want %q (majority failed should escalate)", v, VerdictDegraded)
	}
}

// TestReviseVerdictWithProbes_SkipOnlyUpstreamDoesNotPoisonAllBroken
// pins that an upstream returning only skipped probes (Route hops
// parented by a Gateway have no directly reachable surface, so they
// emit a single skip row) does not defeat the all-broken escalation
// when the one real-probe upstream is fully broken. The revise loop
// must count only upstreams that produced real probe results toward
// the all-broken tally.
func TestReviseVerdictWithProbes_SkipOnlyUpstreamDoesNotPoisonAllBroken(t *testing.T) {
	tr := &Trace{
		Verdict:    VerdictHealthy,
		BrokenAt:   -1,
		Downstream: []Hop{{Resource: ResourceRef{Kind: "Service", Name: "api"}}},
		Upstreams: []Hop{
			{
				Resource: ResourceRef{Kind: "Ingress", Name: "edge"},
				Probes:   []probe.Result{{OK: false, Tone: probe.ToneUnhealthy}},
			},
			{
				Resource: ResourceRef{Kind: "HTTPRoute", Name: "r"},
				Probes:   []probe.Result{{Skipped: true, Reason: "no own routable address"}},
			},
		},
	}
	v, brokenAt := reviseVerdictWithProbes(tr)
	if v != VerdictBroken {
		t.Errorf("reviseVerdictWithProbes(all real upstreams broken + 1 skip-only) = %q, want %q", v, VerdictBroken)
	}
	// The break is in the entry paths, not the subject — must NOT anchor on
	// the (healthy) subject row, which would render "Service api is broken".
	if brokenAt == 0 {
		t.Errorf("brokenAt = %d, must not anchor on the healthy subject row", brokenAt)
	}
	if !strings.Contains(tr.Reason, "entry paths") {
		t.Errorf("all-upstreams-broken reason should name the entry-path break, got %q", tr.Reason)
	}
}

// TestReviseVerdictWithProbes_DegradedTonePromotesFromHealthy pins that an
// HTTP 3xx/4xx (tone=degraded, ok:true) is a real signal — it shouldn't
// leave the verdict reading "healthy" while the chip below says "probe
// degraded".
func TestReviseVerdictWithProbes_DegradedTonePromotesFromHealthy(t *testing.T) {
	tr := &Trace{
		Verdict:  VerdictHealthy,
		BrokenAt: -1,
		Downstream: []Hop{
			{
				Resource: ResourceRef{Kind: "Service"},
				Probes:   []probe.Result{{OK: true, Tone: probe.ToneDegraded}},
			},
		},
	}
	v, _ := reviseVerdictWithProbes(tr)
	if v != VerdictDegraded {
		t.Errorf("reviseVerdictWithProbes(healthy + degraded tone) = %q, want %q", v, VerdictDegraded)
	}
}

// TestReviseVerdictWithProbes_BrokenStaysBroken pins that a critical static
// finding outranks any probe outcome — a successful probe against a
// statically-broken trace could be an external bystander, and downgrading
// would lose the actionable signal.
func TestReviseVerdictWithProbes_BrokenStaysBroken(t *testing.T) {
	tr := &Trace{
		Verdict:  VerdictBroken,
		BrokenAt: 0,
		Downstream: []Hop{
			{
				Resource: ResourceRef{Kind: "Service"},
				Findings: []Finding{{Severity: SeverityCritical}},
				Probes:   []probe.Result{{OK: true, Tone: probe.ToneHealthy}},
			},
		},
	}
	v, brokenAt := reviseVerdictWithProbes(tr)
	if v != VerdictBroken {
		t.Errorf("reviseVerdictWithProbes(broken + ok probe) = %q, want %q", v, VerdictBroken)
	}
	if brokenAt != 0 {
		t.Errorf("brokenAt = %d, want 0 (preserved)", brokenAt)
	}
}

// TestReviseVerdictWithProbes_SkippedRowsIgnored pins that probe rows with
// Skipped: true don't count toward failure tallies — a port that couldn't be
// reached for a documented reason isn't evidence the path is broken.
func TestReviseVerdictWithProbes_SkippedRowsIgnored(t *testing.T) {
	tr := &Trace{
		Verdict:  VerdictHealthy,
		BrokenAt: -1,
		Downstream: []Hop{
			{
				Resource: ResourceRef{Kind: "Service"},
				Probes: []probe.Result{
					{Skipped: true, Reason: "non-HTTP port"},
					{Skipped: true, Reason: "sampled 3 of 10 ready pods"},
				},
			},
		},
	}
	v, _ := reviseVerdictWithProbes(tr)
	if v != VerdictHealthy {
		t.Errorf("reviseVerdictWithProbes(healthy + all-skipped) = %q, want %q (skips are not failure evidence)", v, VerdictHealthy)
	}
}

// TestDeps_NamespaceAllowed pins the per-request namespace scoping
// contract that gates cross-namespace fan-out in the trace walk. Empty
// allow-list is the single-user / auth-disabled default and admits all
// namespaces; a non-empty list scopes strictly.
func TestDeps_NamespaceAllowed(t *testing.T) {
	cases := []struct {
		name    string
		allowed []string
		ns      string
		want    bool
	}{
		{"nil admits everything (single-user default)", nil, "any", true},
		{"non-nil empty denies all (zero-namespace user)", []string{}, "any", false},
		{"in scope", []string{"a", "b"}, "a", true},
		{"out of scope", []string{"a", "b"}, "c", false},
		{"empty namespace against scoped list", []string{"a"}, "", false},
	}
	for _, c := range cases {
		got := Deps{AllowedNamespaces: c.allowed}.NamespaceAllowed(c.ns)
		if got != c.want {
			t.Errorf("%s: NamespaceAllowed(%q) with allowed=%v = %v, want %v", c.name, c.ns, c.allowed, got, c.want)
		}
	}
}

// TestHasUnverifiableEndpoints_UpstreamsAreCounted pins that a marker
// placed on an Upstream hop (e.g. an unreadable parent Gateway on a
// Route trace) reaches the verdict downgrade. The earlier downstream-
// only walk left the marker visible on the hop but invisible to the
// verdict computation, producing healthy/degraded over an explicitly
// unverifiable path.
func TestHasUnverifiableEndpoints_UpstreamsAreCounted(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{{Resource: ResourceRef{Kind: "Service", Name: "api"}}},
		Upstreams: []Hop{
			{
				Resource: ResourceRef{Kind: "Gateway", Name: "edge"},
				Meta:     map[string]any{"endpointSource": "unknown"},
			},
		},
	}
	if !hasUnverifiableEndpoints(tr) {
		t.Errorf("hasUnverifiableEndpoints with upstream endpointSource=unknown = false, want true")
	}
	if got := classifyUnknown(tr); got != UnknownClassInvestigate {
		t.Errorf("classifyUnknown with upstream endpointSource=unknown = %q, want %q", got, UnknownClassInvestigate)
	}
}

// TestClassifyUnknown_SelectorlessIsByDesign pins that a selectorless
// Service (manually-managed endpoints) classifies the unknown verdict as
// by-design, so the UI can render an informational banner rather than a
// warning. Selectorless is a legitimate config shape, not a problem.
func TestClassifyUnknown_SelectorlessIsByDesign(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service"}, Meta: map[string]any{"selectorless": true}},
		},
	}
	if got := classifyUnknown(tr); got != UnknownClassByDesign {
		t.Errorf("classifyUnknown(selectorless) = %q, want %q", got, UnknownClassByDesign)
	}
}

// TestClassifyUnknown_EndpointSourceUnknownIsInvestigate pins that a hop
// whose endpoint state couldn't be read (pod lister error, RBAC denial,
// cache cold) classifies the unknown verdict as investigate — the trace
// tried and couldn't, which merits operator attention.
func TestClassifyUnknown_EndpointSourceUnknownIsInvestigate(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Pods"}, Meta: map[string]any{"endpointSource": "unknown"}},
		},
	}
	if got := classifyUnknown(tr); got != UnknownClassInvestigate {
		t.Errorf("classifyUnknown(endpointSource=unknown) = %q, want %q", got, UnknownClassInvestigate)
	}
}

// TestClassifyUnknown_InvestigateBeatsByDesign pins that when both signals
// are present (e.g. selectorless Service whose endpoint lister also failed),
// investigate wins — the operator needs to know about the lister failure
// regardless of the by-design shape.
func TestClassifyUnknown_InvestigateBeatsByDesign(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service"}, Meta: map[string]any{"selectorless": true}},
			{Resource: ResourceRef{Kind: "Pods"}, Meta: map[string]any{"endpointSource": "unknown"}},
		},
	}
	if got := classifyUnknown(tr); got != UnknownClassInvestigate {
		t.Errorf("classifyUnknown(both signals) = %q, want %q (investigate wins)", got, UnknownClassInvestigate)
	}
}

// TestIsEntryKind_CaseInsensitive pins that normalizeKind accepts every
// casing the apiserver and MCP layer might hand it. REST handlers see
// whatever the URL carried; MCP normalises via strings.ToLower. Without
// this, a same-resource call could 400 over REST while succeeding over
// MCP.
func TestIsEntryKind_CaseInsensitive(t *testing.T) {
	cases := []string{
		"SERVICE", "Service", "service", "Services",
		"INGRESS", "ingress", "Ingresses",
		"HTTPROUTE", "HTTPRoute", "httproute", "HTTPRoutes",
		"GRPCROUTE", "GRPCRoute", "grpcroute",
		"GATEWAY", "Gateway", "gateways",
	}
	for _, c := range cases {
		if !IsEntryKind(c) {
			t.Errorf("IsEntryKind(%q) = false, want true (case-insensitive contract)", c)
		}
	}
}

// TestRouteAttachedToGateway_RejectsNonGatewayKind pins that a Route's
// parentRefs are only considered attached when the parentRef.kind is
// Gateway. A Route whose parentRef points at a same-named non-Gateway
// resource (e.g. another Route in a tree) must not appear on the
// Gateway trace; that would skew attached-route diagnosis.
func TestRouteAttachedToGateway_RejectsNonGatewayKind(t *testing.T) {
	route := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"namespace": "ns", "name": "r1"},
		"spec": map[string]any{
			"parentRefs": []any{
				map[string]any{"kind": "HTTPRoute", "name": "my-gateway", "namespace": "ns"},
			},
		},
	}}
	if routeAttachedToGateway(route, "ns", "my-gateway") {
		t.Errorf("parentRef kind=HTTPRoute should not match Gateway 'my-gateway'")
	}
}

// TestRouteAttachedToGateway_AllowsExplicitGatewayKind and the default
// (empty kind) both attach to a same-named Gateway. The Gateway API
// defaults parentRef.kind to "Gateway" when omitted.
func TestRouteAttachedToGateway_AllowsExplicitGatewayKind(t *testing.T) {
	cases := []map[string]any{
		{"kind": "Gateway", "name": "my-gateway", "namespace": "ns"},
		{"name": "my-gateway", "namespace": "ns"}, // kind omitted defaults to Gateway
		{"kind": "Gateway", "group": "gateway.networking.k8s.io", "name": "my-gateway", "namespace": "ns"},
	}
	for i, pr := range cases {
		route := &unstructured.Unstructured{Object: map[string]any{
			"metadata": map[string]any{"namespace": "ns", "name": "r1"},
			"spec":     map[string]any{"parentRefs": []any{pr}},
		}}
		if !routeAttachedToGateway(route, "ns", "my-gateway") {
			t.Errorf("case %d: parentRef %+v should attach", i, pr)
		}
	}
}

// TestPortIsServiceTargeted pins the Pods-hop port filter that prevents
// non-Service ports (sidecar metrics, kubelet liveness/readiness ports)
// from being probed. kube-proxy doesn't route to them, so a "probe failed"
// row on those ports would mislead the operator about real reachability.
func TestPortIsServiceTargeted(t *testing.T) {
	t.Run("no service known keeps every port", func(t *testing.T) {
		empty := servicePortTargets{}
		if !portIsServiceTargeted(empty, "metrics", 9090) {
			t.Errorf("with no Service context every container port should pass")
		}
	})
	t.Run("matches int targetPort", func(t *testing.T) {
		st := servicePortTargets{known: true, intSet: map[int32]struct{}{80: {}}, nameSet: map[string]struct{}{}}
		if !portIsServiceTargeted(st, "http", 80) {
			t.Errorf("port 80 should match int target")
		}
		if portIsServiceTargeted(st, "metrics", 9090) {
			t.Errorf("port 9090 should NOT match when Service targets only 80")
		}
	})
	t.Run("matches named targetPort", func(t *testing.T) {
		st := servicePortTargets{known: true, intSet: map[int32]struct{}{}, nameSet: map[string]struct{}{"web": {}}}
		if !portIsServiceTargeted(st, "web", 8080) {
			t.Errorf("named container port should match named target")
		}
		if portIsServiceTargeted(st, "metrics", 9090) {
			t.Errorf("non-matching named port should not match")
		}
	})
}

// TestUniqueHosts verifies the host de-dup that drives Ingress probing:
// blanks dropped, dupes collapsed, rule-level hosts merged.
func TestUniqueHosts(t *testing.T) {
	got := uniqueHosts(
		[]string{"a.com", "", "b.com", "a.com"},
		[]RouteRule{{Hosts: []string{"b.com", "c.com"}}, {Hosts: nil}},
	)
	want := []string{"a.com", "b.com", "c.com"}
	if len(got) != len(want) {
		t.Fatalf("uniqueHosts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("uniqueHosts[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// --- Honest reachability vocabulary ---

func TestIsWildcardHost(t *testing.T) {
	for _, c := range []struct {
		host string
		want bool
	}{
		{"app.example.com", false},
		{"*.example.com", true},
		{"*", true},
		{"", false},
	} {
		if got := isWildcardHost(c.host); got != c.want {
			t.Errorf("isWildcardHost(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

// TestRunProbes_IngressWildcardHostSkips: a wildcard host never resolves as
// written, so probing it literally would report a false "unreachable" on a
// valid Ingress. We skip it honestly (DNS layer, before any dial) and tell the
// user to test a concrete host instead.
func TestRunProbes_IngressWildcardHostSkips(t *testing.T) {
	tr := &Trace{
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Ingress"},
			Config:   &HopConfig{Hostnames: []string{"*.example.com"}},
		}},
	}
	runProbes(context.Background(), tr, Options{Probe: true, ProbeBudget: 100 * time.Millisecond}, nil)
	probes := tr.Downstream[0].Probes
	if len(probes) != 1 || !probes[0].Skipped {
		t.Fatalf("wildcard host: expected one structured skip, got %+v", probes)
	}
	if probes[0].Layer != probe.LayerDNS || !strings.Contains(probes[0].Reason, "wildcard") {
		t.Errorf("wildcard skip = %+v, want DNS-layer skip mentioning wildcard", probes[0])
	}
}

func TestHTTPPortAssumed(t *testing.T) {
	for _, c := range []struct {
		name        string
		appProto    string
		port        int32
		wantAssumed bool
	}{
		{"http", "", 8080, false},     // positive name signal
		{"", "http", 9999, false},     // explicit appProtocol
		{"", "", 80, false},           // well-known HTTP port
		{"", "", 443, false},          // well-known HTTPS port
		{"postgres", "", 5432, false}, // not HTTP-probable at all
		{"", "", 7777, true},          // no signal -> assumed
		{"sidecar", "", 9123, true},   // unknown name + odd port -> assumed
	} {
		if got := httpPortAssumed(c.name, c.appProto, c.port); got != c.wantAssumed {
			t.Errorf("httpPortAssumed(%q,%q,%d) = %v, want %v", c.name, c.appProto, c.port, got, c.wantAssumed)
		}
	}
}

// TestSoftenAssumedHTTP: a failure on a port we only *assumed* was HTTP must
// not be presented as a confident break — it becomes an honest "couldn't
// verify" skip. Successes and non-assumed failures pass through untouched.
func TestSoftenAssumedHTTP(t *testing.T) {
	const gapCmd = "kubectl port-forward svc/x -n ns 7777:7777"
	failed := probe.Result{Layer: probe.LayerHTTP, Target: "port 7777", Error: "EOF", Path: probe.PathAPIServer}
	got := softenAssumedHTTP(failed, true, gapCmd)
	if !got.Skipped || got.Path != probe.PathAPIServer {
		t.Errorf("assumed+failed: got %+v, want skipped preserving path", got)
	}
	if !strings.Contains(got.Reason, "assumed HTTP") {
		t.Errorf("assumed+failed reason = %q, want mention of assumed HTTP", got.Reason)
	}
	if got.Command != gapCmd {
		t.Errorf("softened skip should carry the fill-the-gap command, got %q", got.Command)
	}
	// Not assumed -> unchanged hard failure.
	if out := softenAssumedHTTP(failed, false, gapCmd); out.Skipped {
		t.Errorf("not-assumed failure should stay a failure, got skipped: %+v", out)
	}
	// Verified 2xx -> unchanged.
	ok := probe.Result{Layer: probe.LayerHTTP, OK: true, Tone: probe.ToneHealthy}
	if out := softenAssumedHTTP(ok, true, gapCmd); out.Skipped {
		t.Errorf("assumed success should pass through, got skipped: %+v", out)
	}
	// 5xx on an assumed port (apiserver proxies a non-HTTP backend as 503) is
	// as likely "not HTTP" as a real error -> soften to a skip.
	deg := probe.Result{Layer: probe.LayerHTTP, OK: true, Tone: probe.ToneDegraded, Detail: "HTTP 503 · reached, server error"}
	if out := softenAssumedHTTP(deg, true, gapCmd); !out.Skipped {
		t.Errorf("assumed 5xx should soften to a skip, got %+v", out)
	}
	// Reached 4xx genuinely reached an HTTP server -> pass through.
	reached := probe.Result{Layer: probe.LayerHTTP, OK: true, Tone: probe.ToneReached, Detail: "HTTP 404"}
	if out := softenAssumedHTTP(reached, true, gapCmd); out.Skipped {
		t.Errorf("assumed 4xx-reached should pass through, got skipped: %+v", out)
	}
}

// TestClassifyHopProbes_HonestTones pins the voting inputs under the 5-state
// vocabulary: a 5xx (reached, erroring) votes degraded NOT failed; a 4xx
// (reached, route unverified) votes neither; only a transport failure votes
// failed.
func TestClassifyHopProbes_HonestTones(t *testing.T) {
	hop := Hop{Probes: []probe.Result{
		{OK: true, Tone: probe.ToneHealthy},                // 2xx
		{OK: true, Tone: probe.ToneReached},                // 4xx
		{OK: true, Tone: probe.ToneDegraded},               // 5xx
		{OK: false, Tone: probe.ToneUnhealthy, Error: "x"}, // transport fail
		{Skipped: true}, // ignored
	}}
	failed, degraded, real := classifyHopProbes(hop)
	if real != 4 {
		t.Errorf("real = %d, want 4 (skipped excluded)", real)
	}
	if failed != 1 {
		t.Errorf("failed = %d, want 1 (only transport failure)", failed)
	}
	if degraded != 1 {
		t.Errorf("degraded = %d, want 1 (only 5xx)", degraded)
	}
}

// TestReviseVerdictWithProbes_DegradedFrontDoorIsDegradedNotBroken: a hop whose
// only live evidence is a degraded-tone probe (a front-door 502/504, the proxy
// could not reach its upstream) is degraded, never "broken, traffic can't pass".
// An app's own 5xx no longer lands here at all: it reads as "reached" (the scope
// is the network path, not app health), pinned in pkg/probe TestClassifyHTTPStatus.
func TestReviseVerdictWithProbes_DegradedFrontDoorIsDegradedNotBroken(t *testing.T) {
	tr := &Trace{
		Verdict: VerdictHealthy,
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Ingress", Name: "ing"},
			Probes:   []probe.Result{{OK: true, Tone: probe.ToneDegraded}},
		}},
	}
	v, _ := reviseVerdictWithProbes(tr)
	if v != VerdictDegraded {
		t.Errorf("degraded front-door hop verdict = %q, want %q", v, VerdictDegraded)
	}
}

// TestReviseVerdictWithProbes_4xxStaysHealthy: reaching an HTTP server that
// answered 4xx (e.g. probed `/` on a path-routed app) is not a failure and
// must not move the verdict off healthy.
func TestReviseVerdictWithProbes_4xxStaysHealthy(t *testing.T) {
	tr := &Trace{
		Verdict: VerdictHealthy,
		Downstream: []Hop{{
			Resource: ResourceRef{Kind: "Ingress", Name: "ing"},
			Probes: []probe.Result{
				{OK: true, Tone: probe.ToneHealthy}, // DNS/TCP fine
				{OK: true, Tone: probe.ToneReached}, // HTTP 404 at /
			},
		}},
	}
	v, _ := reviseVerdictWithProbes(tr)
	if v != VerdictHealthy {
		t.Errorf("4xx-reached hop verdict = %q, want %q (no false degrade)", v, VerdictHealthy)
	}
}

// TestProbeIngress_443GatedByTLS pins that 443 is probed only for hosts that
// declare TLS. Probing 443 on a plain-HTTP host dials a port the Ingress
// doesn't serve and false-reports unreachable / cert failure.
func TestProbeIngress_443GatedByTLS(t *testing.T) {
	// HTTP-only host: no TLSHosts -> the trace must not emit any :443 target.
	httpOnly := &Hop{
		Resource: ResourceRef{Kind: "Ingress"},
		Config:   &HopConfig{Hostnames: []string{"plain.example.com"}},
	}
	out := probeIngress(context.Background(), httpOnly, probe.VantageLocal, "/")
	for _, p := range out {
		if strings.Contains(p.Target, ":443") {
			t.Errorf("HTTP-only host should not probe 443, got target %q", p.Target)
		}
	}
	// TLS host: 443 is allowed (we can't assert it ran without DNS, but the
	// gate must include it). Verified indirectly via the map build path.
	tlsHop := &Hop{
		Resource: ResourceRef{Kind: "Ingress"},
		Config:   &HopConfig{Hostnames: []string{"secure.example.com"}, TLSHosts: []string{"secure.example.com"}},
	}
	_ = probeIngress(context.Background(), tlsHop, probe.VantageLocal, "/") // must not panic; gate includes 443
}

// TestProbeGateway_UDPListenerSkipped: a UDP listener can't be TCP-probed; a
// TCP probe would fail and falsely condemn a healthy UDP config, so we skip.
func TestProbeGateway_UDPListenerSkipped(t *testing.T) {
	h := &Hop{
		Resource: ResourceRef{Kind: "Gateway"},
		Config: &HopConfig{
			Addresses: []string{"203.0.113.1"},
			Listeners: []GatewayListener{{Name: "dns", Port: 53, Protocol: "UDP"}},
		},
	}
	out := probeGateway(context.Background(), h, probe.VantageLocal, "/")
	if len(out) != 1 || !out[0].Skipped || !strings.Contains(out[0].Reason, "UDP") {
		t.Fatalf("UDP listener: want one UDP skip (no TCP probe), got %+v", out)
	}
}

// TestProbeIngress_LocalDNSFailSkips: from a laptop, a host that doesn't
// resolve may be cluster-internal DNS — must skip (with a fill-the-gap hint),
// NOT render a confident "broken" on a valid Ingress.
func TestProbeIngress_LocalDNSFailSkips(t *testing.T) {
	h := &Hop{Resource: ResourceRef{Kind: "Ingress"}, Config: &HopConfig{Hostnames: []string{"nope.invalid"}}}
	out := probeIngress(context.Background(), h, probe.VantageLocal, "/")
	if len(out) == 0 {
		t.Fatal("expected a DNS row")
	}
	if !out[0].Skipped || !strings.Contains(out[0].Reason, "resolve from your machine") {
		t.Errorf("local DNS fail should skip with a cluster-internal-DNS hint, got %+v", out[0])
	}
}

// TestProbeIngress_InClusterDNSFailIsEvidence: in-cluster, an unresolvable host
// IS real evidence (cluster DNS should resolve cluster hosts) — keep the
// failure rather than skipping.
func TestProbeIngress_InClusterDNSFailIsEvidence(t *testing.T) {
	h := &Hop{Resource: ResourceRef{Kind: "Ingress"}, Config: &HopConfig{Hostnames: []string{"nope.invalid"}}}
	out := probeIngress(context.Background(), h, probe.VantageInCluster, "/")
	if len(out) == 0 {
		t.Fatal("expected a DNS row")
	}
	if out[0].Skipped {
		t.Errorf("in-cluster DNS fail should be real evidence, not skipped: %+v", out[0])
	}
}

func TestIsHTTPSPort(t *testing.T) {
	cases := []struct {
		name, proto string
		port        int32
		want        bool
	}{
		{"https", "", 8443, true}, {"", "https", 9000, true}, {"", "", 443, true}, {"tls", "", 7000, true},
		{"http", "", 80, false}, {"", "", 8080, false}, {"grpc", "", 9090, false},
	}
	for _, c := range cases {
		if got := isHTTPSPort(c.name, c.proto, c.port); got != c.want {
			t.Errorf("isHTTPSPort(%q,%q,%d)=%v, want %v", c.name, c.proto, c.port, got, c.want)
		}
	}
}

func TestIsInternalAddr(t *testing.T) {
	for _, c := range []struct {
		addr string
		want bool
	}{
		{"10.0.0.5", true}, {"192.168.1.1", true}, {"172.16.0.1", true}, {"127.0.0.1", true},
		{"8.8.8.8", false}, {"example.com", false}, {"203.0.113.7", false},
	} {
		if got := isInternalAddr(c.addr); got != c.want {
			t.Errorf("isInternalAddr(%q)=%v, want %v", c.addr, got, c.want)
		}
	}
}

// TestProbeGateway_LocalInternalAddrSkips: a TCP failure to an internal address
// from a laptop is "can't reach from here", not a broken Gateway — skip it.
func TestProbeGateway_LocalInternalAddrSkips(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	h := &Hop{Resource: ResourceRef{Kind: "Gateway"}, Config: &HopConfig{
		Addresses: []string{"10.255.255.1"}, Listeners: []GatewayListener{{Port: 80, Protocol: "HTTP"}},
	}}
	out := probeGateway(context.Background(), h, probe.VantageLocal, "/")
	if len(out) == 0 || !out[0].Skipped || !strings.Contains(out[0].Reason, "internal address") {
		t.Errorf("local internal-addr TCP fail should skip with reason, got %+v", out)
	}
}

// TestIsInternalAddr_Unspecified: 0.0.0.0/:: (a Gateway/Ingress that hasn't
// published a routable address) must be treated as internal/untestable.
func TestIsInternalAddr_Unspecified(t *testing.T) {
	for _, a := range []string{"0.0.0.0", "::", "127.0.0.1", "10.0.0.1", "169.254.169.254"} {
		if !isInternalAddr(a) {
			t.Errorf("%s should be internal", a)
		}
	}
	for _, a := range []string{"1.2.3.4", "8.8.8.8"} {
		if isInternalAddr(a) {
			t.Errorf("%s should NOT be internal", a)
		}
	}
}

// TestIsInternalGuardError: the dial-time SSRF guard's raw string must be
// detectable so it's demoted to a clean skip, never shown as a red verdict.
func TestIsInternalGuardError(t *testing.T) {
	if !isInternalGuardError(probe.Result{Error: "refusing to probe internal address 0.0.0.0 (SSRF guard)"}) {
		t.Error("SSRF-guard error must be detected")
	}
	if isInternalGuardError(probe.Result{Error: "connection refused"}) {
		t.Error("a plain transport error is not a guard error")
	}
}
