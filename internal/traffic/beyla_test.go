package traffic

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/skyhook-io/radar/pkg/prom"
)

func TestBeylaSource_Detect_MetricProbe(t *testing.T) {
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{}, 42)), nil
		}
		if strings.Contains(query, "beyla_build_info") {
			return promResult("vector", promSeries(map[string]string{"version": "1.0.0"}, 1)), nil
		}
		return emptyResult(), nil
	}

	result, err := src.Detect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Available {
		t.Fatal("expected available=true")
	}
	if result.Native {
		t.Error("expected Native=false")
	}
	if result.Version != "1.0.0" {
		t.Errorf("version = %q, want %q", result.Version, "1.0.0")
	}
}

func TestBeylaSource_Detect_OBIMetricPrefix(t *testing.T) {
	// Grafana's Beyla renames the flow metric to beyla_*; upstream OBI emits
	// obi_*. Both distributions are current, so either name means available, and
	// the one that answered is what GetFlows must go on to query.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "obi_network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{}, 7)), nil
		}
		return emptyResult(), nil
	}

	result, err := src.Detect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Available {
		t.Fatal("expected available=true for the obi_ prefix")
	}
	assertEq(t, "resolved flow metric", src.flowMetricName(), obiFlowMetric)
}

func TestBeylaSource_Detect_AlloyPodsAloneAreNotAvailable(t *testing.T) {
	// app.kubernetes.io/name=alloy matches every Alloy install, and most carry no
	// Beyla. Claiming availability on that basis wins the source priority order
	// and then renders a permanently empty graph, so pods must not imply
	// availability — the message should point at the scrape instead.
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "alloy-abc",
			Namespace: "monitoring",
			Labels:    map[string]string{"app.kubernetes.io/name": "alloy"},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset(pod)}
	src.queryFn = func(_ context.Context, _ string) (*prom.QueryResult, error) {
		return nil, fmt.Errorf("prometheus not available")
	}

	result, err := src.Detect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Available {
		t.Fatal("expected available=false: running Alloy pods are not evidence of Beyla metrics")
	}
	if !strings.Contains(result.Message, "Prometheus holds no Beyla metrics") {
		t.Errorf("message should name the actual problem, got: %q", result.Message)
	}
}

func TestBeylaSource_Detect_BuildInfoWithoutNetworkFeature(t *testing.T) {
	// The network feature is opt-in and off by default, so a stock Beyla install
	// exposes build_info but no flow metric at all. That has to read as "installed
	// but not watching the network", not as "no traffic yet".
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_build_info") {
			return promResult("vector", promSeries(map[string]string{"version": "v3.25.0"}, 1)), nil
		}
		return emptyResult(), nil
	}

	result, err := src.Detect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Available {
		t.Fatal("expected available=false: no network flow metric means no flows to draw")
	}
	assertEq(t, "version", result.Version, "v3.25.0")
	if !strings.Contains(result.Message, "OTEL_EBPF_METRICS_FEATURES") {
		t.Errorf("message should tell the operator how to enable network metrics, got: %q", result.Message)
	}
	// An idle cluster with the feature already on produces the same evidence, so
	// the message must offer that too rather than assert the cause it cannot see.
	if !strings.Contains(result.Message, "no traffic has been observed") {
		t.Errorf("message must not assert the feature is off when idleness looks identical, got: %q", result.Message)
	}
}

func TestBeylaSource_Detect_NotAvailable(t *testing.T) {
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, _ string) (*prom.QueryResult, error) {
		return nil, fmt.Errorf("prometheus not available")
	}

	result, err := src.Detect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Available {
		t.Fatal("expected available=false")
	}
}

func TestBeylaSource_GetFlows_OwnerLevel(t *testing.T) {
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{
				"k8s_src_owner_name": "frontend", "k8s_src_namespace": "web",
				"k8s_src_owner_type": "Deployment",
				"k8s_dst_owner_name": "backend", "k8s_dst_namespace": "api",
				"k8s_dst_owner_type": "Deployment",
				"dst_port":           "8080", "transport": "TCP",
			}, 15.5)), nil
		}
		return emptyResult(), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 1 {
		t.Fatalf("expected 1 flow, got %d", len(resp.Flows))
	}
	f := resp.Flows[0]
	assertEq(t, "source name", f.Source.Name, "frontend")
	assertEq(t, "source namespace", f.Source.Namespace, "web")
	assertEq(t, "source kind", f.Source.Kind, "Workload")
	assertEq(t, "dest name", f.Destination.Name, "backend")
	assertEq(t, "dest kind", f.Destination.Kind, "Workload")
	assertEq(t, "port", fmt.Sprintf("%d", f.Port), "8080")
	assertEq(t, "protocol", f.Protocol, "tcp")
	assertEq(t, "verdict", f.Verdict, "forwarded")
	if f.Connections == 0 {
		t.Error("expected non-zero connections")
	}
}

func TestBeylaSource_GetFlows_L7OnlyDroppedWithoutL4Match(t *testing.T) {
	// http_server_request_duration_seconds has no source labels, so an L7
	// series with no matching L4 destination can't be drawn as an edge and
	// must be dropped rather than emitted as a sourceless flow.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return emptyResult(), nil
		}
		return promResult("vector", promSeries(map[string]string{
			"k8s_namespace_name": "api", "k8s_owner_name": "backend",
			"http_request_method": "GET", "http_route": "/api/users", "http_response_status_code": "200",
		}, 8.0)), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 0 {
		t.Fatalf("expected 0 flows (no L4 match to attach HTTP metadata to), got %d", len(resp.Flows))
	}
}

func TestBeylaSource_GetFlows_L4PlusL7(t *testing.T) {
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{
				"k8s_src_owner_name": "frontend", "k8s_src_namespace": "web",
				"k8s_dst_owner_name": "backend", "k8s_dst_namespace": "api",
				"dst_port": "8080", "transport": "TCP",
			}, 10.0)), nil
		}
		return promResult("vector", promSeries(map[string]string{
			"k8s_namespace_name": "api", "k8s_owner_name": "backend", "server_port": "8080",
			"http_request_method": "POST", "http_route": "/api/orders", "http_response_status_code": "201",
		}, 5.0)), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 1 {
		t.Fatalf("expected 1 merged flow, got %d", len(resp.Flows))
	}
	f := resp.Flows[0]
	assertEq(t, "httpMethod", f.HTTPMethod, "POST")
	assertEq(t, "httpPath", f.HTTPPath, "/api/orders")
	assertEq(t, "httpStatus", fmt.Sprintf("%d", f.HTTPStatus), "201")
	assertEq(t, "l7Protocol", f.L7Protocol, "HTTP")
	assertEq(t, "port", fmt.Sprintf("%d", f.Port), "8080")
	assertEq(t, "source name", f.Source.Name, "frontend")
}

func TestBeylaSource_GetFlows_L7LandsOnTheServedPortOnly(t *testing.T) {
	// http_server_request_duration_seconds carries server_port, so a destination
	// serving HTTP on 8080 alongside raw TCP on 5432 gets its HTTP metadata on the
	// 8080 edge and nothing on the 5432 edge. No inference, no all-or-nothing
	// guard.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector",
				promSeries(map[string]string{
					"k8s_src_owner_name": "frontend", "k8s_src_namespace": "web",
					"k8s_dst_owner_name": "backend", "k8s_dst_namespace": "api",
					"dst_port": "8080", "transport": "TCP",
				}, 10.0),
				promSeries(map[string]string{
					"k8s_src_owner_name": "frontend", "k8s_src_namespace": "web",
					"k8s_dst_owner_name": "backend", "k8s_dst_namespace": "api",
					"dst_port": "5432", "transport": "TCP",
				}, 3.0),
			), nil
		}
		return promResult("vector", promSeries(map[string]string{
			"k8s_namespace_name": "api", "k8s_owner_name": "backend", "server_port": "8080",
			"http_request_method": "POST", "http_route": "/api/orders", "http_response_status_code": "201",
		}, 5.0)), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 2 {
		t.Fatalf("expected 2 flows, got %d", len(resp.Flows))
	}
	for _, f := range resp.Flows {
		switch f.Port {
		case 8080:
			assertEq(t, "8080 l7Protocol", f.L7Protocol, "HTTP")
			assertEq(t, "8080 httpPath", f.HTTPPath, "/api/orders")
			if f.RequestRate != 5.0 {
				t.Errorf("8080 requestRate = %v, want 5 (sole caller on this port takes the whole rate)", f.RequestRate)
			}
		case 5432:
			if f.L7Protocol != "" {
				t.Errorf("5432 should carry no HTTP metadata, got L7Protocol=%q path=%q", f.L7Protocol, f.HTTPPath)
			}
		default:
			t.Errorf("unexpected port %d", f.Port)
		}
	}
}

func TestBeylaSource_ParseL4Flows_TransportSeparatesOtherwiseIdenticalSeries(t *testing.T) {
	// Same src/dst/port, different transport (DNS on 53) must not collide: the raw
	// transport label is part of l4Key.
	//
	// Deliberately a parser-level test rather than a GetFlows one. The L4 query
	// filters direction="request", and Beyla labels UDP "unknown", so real UDP
	// never reaches the parser through that path — asserting it end to end would
	// only prove the stub ignores the query it was handed.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	result := promResult("vector",
		promSeries(map[string]string{
			"k8s_src_owner_name": "app", "k8s_src_namespace": "web",
			"k8s_dst_owner_name": "coredns", "k8s_dst_namespace": "kube-system",
			"dst_port": "53", "transport": "TCP",
		}, 4.0),
		promSeries(map[string]string{
			"k8s_src_owner_name": "app", "k8s_src_namespace": "web",
			"k8s_dst_owner_name": "coredns", "k8s_dst_namespace": "kube-system",
			"dst_port": "53", "transport": "UDP",
		}, 20.0),
	)

	flows, presence := src.parseL4Flows(result)
	if len(flows) != 2 {
		t.Fatalf("expected 2 flows (TCP and UDP kept apart), got %d", len(flows))
	}
	protocols := map[string]bool{}
	for _, f := range flows {
		protocols[f.Protocol] = true
	}
	if !protocols["tcp"] || !protocols["udp"] {
		t.Errorf("expected both tcp and udp to survive, got %v", protocols)
	}
	if !presence.port || !presence.transport {
		t.Errorf("both attributes were present in the fixture, got port=%v transport=%v", presence.port, presence.transport)
	}
}

func TestBeylaSource_GetFlows_WarningKindSeparatesRetryableFromPermanent(t *testing.T) {
	// The client retries a transient warning and must not retry a permanent one:
	// a source that cannot export a port will not start exporting it on a refetch,
	// and a 2s retry loop against Prometheus is the cost of getting this wrong.
	t.Run("partial data is permanent", func(t *testing.T) {
		src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
		src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
			if strings.Contains(query, `direction="unknown"`) {
				return emptyResult(), nil
			}
			if strings.Contains(query, "beyla_network_flow_bytes_total") {
				return promResult("vector", promSeries(map[string]string{
					"k8s_src_owner_name": "client", "k8s_src_namespace": "demo",
					"k8s_dst_owner_name": "web", "k8s_dst_namespace": "demo",
				}, 9.0)), nil
			}
			return emptyResult(), nil
		}

		resp, err := src.GetFlows(context.Background(), FlowOptions{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp.Warning == "" {
			t.Fatal("expected a warning about the missing attributes")
		}
		assertEq(t, "warningKind", resp.WarningKind, WarningPartial)
	})

	t.Run("query failure is transient", func(t *testing.T) {
		src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
		src.queryFn = func(_ context.Context, _ string) (*prom.QueryResult, error) {
			return nil, fmt.Errorf("connection refused")
		}

		resp, err := src.GetFlows(context.Background(), FlowOptions{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp.Warning == "" {
			t.Fatal("expected a warning about the failed query")
		}
		assertEq(t, "warningKind", resp.WarningKind, WarningTransient)
	})
}

func TestBeylaSource_DiagnosticsProbe_SkippedOnTheStreamPath(t *testing.T) {
	// StreamFlows has nowhere to put a warning, so it must not pay for one. That
	// skip is also what makes the probe affordable uncached: the REST path is a
	// user-triggered snapshot, not a poll.
	var probes int
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, `direction="unknown"`) {
			probes++
			return promResult("vector", promSeries(map[string]string{}, 2)), nil
		}
		return emptyResult(), nil
	}

	if _, _, err := src.getFlowsInternal(context.Background(), FlowOptions{}, false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if probes != 0 {
		t.Fatalf("the stream path must not run the diagnostics probe, ran it %d time(s)", probes)
	}

	if _, err := src.GetFlows(context.Background(), FlowOptions{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if probes != 1 {
		t.Errorf("the REST path must run it, ran it %d time(s)", probes)
	}
}

func TestBeylaSource_DiagnosticsProbe_NotCachedAcrossCalls(t *testing.T) {
	// The probe reports on current traffic, not on how Beyla is configured, so a
	// cached answer goes stale as soon as such traffic starts. It was cached once,
	// which meant traffic appearing after the first call stayed unmentioned.
	var probes int
	hidden := false
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, `direction="unknown"`) {
			probes++
			if hidden {
				return promResult("vector", promSeries(map[string]string{}, 2)), nil
			}
			return emptyResult(), nil
		}
		return emptyResult(), nil
	}

	first, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(first.Warning, "direction=unknown") {
		t.Fatal("nothing was hidden yet, so nothing should have been claimed")
	}

	hidden = true
	second, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(second.Warning, "direction=unknown") {
		t.Error("traffic that started after the first call must still be reported")
	}
	if probes != 2 {
		t.Errorf("expected a probe per request, got %d", probes)
	}
}

func TestBeylaSource_DiagnosticsProbe_FailureStaysSilentThenRecovers(t *testing.T) {
	// A failed probe is not an answer: say nothing rather than assert an absence,
	// and report normally once it succeeds.
	var probes int
	failing := true
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, `direction="unknown"`) {
			probes++
			if failing {
				return nil, fmt.Errorf("connection refused")
			}
			return promResult("vector", promSeries(map[string]string{}, 2)), nil
		}
		return emptyResult(), nil
	}

	if _, err := src.GetFlows(context.Background(), FlowOptions{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	failing = false
	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if probes != 2 {
		t.Errorf("expected the probe to be retried after a failure, ran it %d times", probes)
	}
	if !strings.Contains(resp.Warning, "direction=unknown") {
		t.Errorf("once the probe succeeds the warning must appear, got: %q", resp.Warning)
	}
}

func TestBeylaSource_GetFlows_L7NotAttachedWhenItsPortHasNoNamedCaller(t *testing.T) {
	// The destination serves HTTP on 8080, but its only caller there is an
	// external one Beyla can't name, so that edge is dropped. Unrelated TCP
	// traffic on 5432 survives. The HTTP metadata belongs to 8080 and must not
	// land on 5432 just because 5432 is what's left.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector",
				promSeries(map[string]string{
					// no k8s_src_owner_name/k8s_src_name: unresolved external caller
					"k8s_dst_owner_name": "backend", "k8s_dst_namespace": "api",
					"dst_port": "8080", "transport": "TCP",
				}, 10.0),
				promSeries(map[string]string{
					"k8s_src_owner_name": "worker", "k8s_src_namespace": "jobs",
					"k8s_dst_owner_name": "backend", "k8s_dst_namespace": "api",
					"dst_port": "5432", "transport": "TCP",
				}, 3.0),
			), nil
		}
		return promResult("vector", promSeries(map[string]string{
			"k8s_namespace_name": "api", "k8s_owner_name": "backend", "server_port": "8080",
			"http_request_method": "GET", "http_route": "/health", "http_response_status_code": "200",
		}, 5.0)), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 1 {
		t.Fatalf("expected 1 flow (only port 5432 survives naming), got %d", len(resp.Flows))
	}
	if resp.Flows[0].L7Protocol != "" {
		t.Errorf("port %d: expected no HTTP metadata attached to the non-HTTP port, got L7Protocol=%q",
			resp.Flows[0].Port, resp.Flows[0].L7Protocol)
	}
}

func TestBeylaSource_QueryL4_KeepsOnlyTheRequestDirection(t *testing.T) {
	// Beyla emits both directions of every conversation with src and dst swapped,
	// so an unfiltered query gives every edge a mirror twin pointing the wrong
	// way. UDP is worse: it is labelled "unknown" on both sides, and once dst.port
	// is selected the reverse half carries the client's ephemeral port, so a
	// single DNS conversation becomes hundreds of edges. Only "request" is
	// orientable.
	var rateQuery string
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "network_flow_bytes_total") && strings.Contains(query, "rate(") {
			rateQuery = query
		}
		return emptyResult(), nil
	}

	if _, err := src.GetFlows(context.Background(), FlowOptions{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(rateQuery, `direction="request"`) {
		t.Errorf("L4 query must keep only the request direction, got: %s", rateQuery)
	}
	if strings.Contains(beylaL4GroupBy, "direction") {
		t.Error("direction must stay out of the group-by so it cannot split one conversation across two keys")
	}
}

func TestBeylaSource_GetFlows_SaysSoWhenUDPIsHidden(t *testing.T) {
	// The direction filter drops UDP entirely. An empty or partial graph with no
	// explanation reads as "there is no traffic", which is not what happened.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, `direction="unknown"`) {
			return promResult("vector", promSeries(map[string]string{}, 4)), nil
		}
		return emptyResult(), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 0 {
		t.Fatalf("expected 0 flows, got %d", len(resp.Flows))
	}
	if !strings.Contains(resp.Warning, "UDP") {
		t.Errorf("an empty graph with UDP present must explain itself, got: %q", resp.Warning)
	}
}

func TestBeylaSource_GetFlows_ServiceAndWorkloadDuplicateCollapsesToWorkload(t *testing.T) {
	// A Service-routed conversation is reported twice with byte-identical values,
	// once attributed to the destination workload and once to the Service in front
	// of it. Emitting both would double the traffic on most edges; letting result
	// order decide would make the rendered Kind arbitrary. The workload wins.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector",
				promSeries(map[string]string{
					"k8s_src_owner_name": "client", "k8s_src_namespace": "demo",
					"k8s_src_owner_type": "Deployment",
					"k8s_dst_owner_name": "db", "k8s_dst_namespace": "demo",
					"k8s_dst_owner_type": "Service",
					"dst_port":           "6379", "transport": "TCP",
				}, 7.0),
				promSeries(map[string]string{
					"k8s_src_owner_name": "client", "k8s_src_namespace": "demo",
					"k8s_src_owner_type": "Deployment",
					"k8s_dst_owner_name": "db", "k8s_dst_namespace": "demo",
					"k8s_dst_owner_type": "Deployment",
					"dst_port":           "6379", "transport": "TCP",
				}, 7.0),
			), nil
		}
		return emptyResult(), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 1 {
		t.Fatalf("expected the duplicate pair to collapse to 1 flow, got %d (traffic would be double counted)", len(resp.Flows))
	}
	assertEq(t, "dest kind", resp.Flows[0].Destination.Kind, "Workload")
}

func TestBeylaSource_GetFlows_WarnsWhenPortAndTransportAreNotExported(t *testing.T) {
	// dst.port and transport are Default:false in Beyla's attribute registry, so a
	// stock install exports neither and every edge arrives with no port and no
	// protocol. Rendering port 0 over TCP without saying so is the dishonest part.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{
				"k8s_src_owner_name": "client", "k8s_src_namespace": "demo",
				"k8s_dst_owner_name": "web", "k8s_dst_namespace": "demo",
				// no dst_port, no transport: the default install
			}, 12.0)), nil
		}
		return emptyResult(), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 1 {
		t.Fatalf("expected 1 flow, got %d", len(resp.Flows))
	}
	if resp.Warning == "" {
		t.Fatal("expected a warning naming the missing attributes")
	}
	for _, want := range []string{"dst.port", "transport", "attributes.select"} {
		if !strings.Contains(resp.Warning, want) {
			t.Errorf("warning should mention %q so the operator can act on it, got: %q", want, resp.Warning)
		}
	}
}

func TestBeylaSource_GetFlows_NoWarningWhenAttributesArePresent(t *testing.T) {
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{
				"k8s_src_owner_name": "client", "k8s_src_namespace": "demo",
				"k8s_dst_owner_name": "web", "k8s_dst_namespace": "demo",
				"dst_port": "80", "transport": "TCP",
			}, 12.0)), nil
		}
		return emptyResult(), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Warning != "" {
		t.Errorf("expected no warning when both attributes are exported, got: %q", resp.Warning)
	}
}

func TestBeylaSource_ParseL7Flows_OwnerFallback(t *testing.T) {
	tests := []struct {
		name     string
		labels   map[string]string
		wantName string
		wantKind string
	}{
		{"owner name", map[string]string{"k8s_owner_name": "backend"}, "backend", "Workload"},
		{"pod fallback", map[string]string{"k8s_pod_name": "backend-abc123"}, "backend-abc123", "Pod"},
	}
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			labels := map[string]string{
				"k8s_namespace_name": "api", "http_request_method": "GET",
				"http_route": "/x", "http_response_status_code": "200",
			}
			for k, v := range tt.labels {
				labels[k] = v
			}
			flows := src.parseL7Flows(promResult("vector", promSeries(labels, 1.0)))
			if len(flows) != 1 {
				t.Fatalf("expected 1 flow, got %d", len(flows))
			}
			assertEq(t, "dest name", flows[0].Destination.Name, tt.wantName)
			assertEq(t, "dest kind", flows[0].Destination.Kind, tt.wantKind)
		})
	}
}

func TestBeylaSource_GetFlows_NamespaceFilter(t *testing.T) {
	var capturedQuery string
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		capturedQuery = query
		return emptyResult(), nil
	}

	_, err := src.GetFlows(context.Background(), FlowOptions{Namespace: "test-ns"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(capturedQuery, "test-ns") {
		t.Errorf("expected namespace filter in query, got: %s", capturedQuery)
	}
}

func TestBeylaSource_GetFlows_FallbackToOwner(t *testing.T) {
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// The diagnostics probe shares the metric name with the L4 query, so a stub
		// that matched on the name alone would answer it with flow data and set a
		// partial-data warning this test never asked for.
		if strings.Contains(query, `direction="unknown"`) {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{
				"k8s_src_owner_name": "api", "k8s_src_namespace": "backend",
				"k8s_dst_owner_name": "db", "k8s_dst_namespace": "data",
				"k8s_src_owner_type": "Deployment", "k8s_dst_owner_type": "StatefulSet",
				"dst_port": "5432", "transport": "TCP",
			}, 3.0)), nil
		}
		return emptyResult(), nil
	}

	resp, err := src.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Flows) != 1 {
		t.Fatalf("expected 1 flow, got %d", len(resp.Flows))
	}
	f := resp.Flows[0]
	assertEq(t, "source kind", f.Source.Kind, "Workload")
	assertEq(t, "dest kind", f.Destination.Kind, "Workload")
	assertEq(t, "port", fmt.Sprintf("%d", f.Port), "5432")
}

func TestBeylaSource_MapBeylaKind(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"Pod", "Pod"}, {"Deployment", "Workload"}, {"ReplicaSet", "Workload"},
		{"StatefulSet", "Workload"}, {"DaemonSet", "Workload"}, {"Service", "Service"},
		{"Unknown", "Pod"}, {"pod", "Pod"}, {"deployment", "Workload"},
	}
	for _, tt := range tests {
		if got := mapBeylaKind(tt.input); got != tt.want {
			t.Errorf("mapBeylaKind(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestBeylaSource_MapBeylaTransport(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"TCP", "tcp"}, {"UDP", "udp"}, {"tcp", "tcp"}, {"Tcp", "tcp"}, {"", "tcp"},
	}
	for _, tt := range tests {
		if got := mapBeylaTransport(tt.input); got != tt.want {
			t.Errorf("mapBeylaTransport(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestManager_DetectSources_IncludesBeyla(t *testing.T) {
	m := &Manager{sources: make(map[string]TrafficSource)}
	m.sources["beyla"] = NewBeylaSource(fake.NewSimpleClientset())
	if _, ok := m.sources["beyla"]; !ok {
		t.Fatal("expected 'beyla' in sources map")
	}
}

func TestBeylaSource_QueryL4_NamespaceFilterIsValidPromQL(t *testing.T) {
	q := beylaRateQuery(beylaL4GroupBy, beylaFlowMetric, "test-ns", beylaL4DirectionFilter)
	if !strings.Contains(q, `k8s_src_namespace="test-ns"}`) || !strings.Contains(q, `k8s_dst_namespace="test-ns"}`) {
		t.Errorf("namespace matchers must live inside the label selector, got: %s", q)
	}
	if strings.Contains(q, " and (") {
		t.Errorf("bare label matchers after `and` are not valid PromQL, got: %s", q)
	}
}

func TestBeylaSource_QueryL7_UsesCorrectMetricAndLabels(t *testing.T) {
	q := beylaL7RateQuery("test-ns")
	if !strings.Contains(q, "http_server_request_duration_seconds_count") {
		t.Errorf("expected the OTel-aligned Beyla HTTP server metric, got: %s", q)
	}
	if !strings.Contains(q, `k8s_namespace_name="test-ns"}`) {
		t.Errorf("expected a single k8s_namespace_name matcher inside the label selector, got: %s", q)
	}
	if strings.Contains(q, "k8s_src_owner_name") || strings.Contains(q, "k8s_dst_owner_name") {
		t.Errorf("L7 query must not reference network-flow-only owner labels, got: %s", q)
	}
}

// --- test helpers ---

func promResult(resultType string, series ...prom.Series) *prom.QueryResult {
	return &prom.QueryResult{ResultType: resultType, Series: series}
}

func promSeries(labels map[string]string, value float64) prom.Series {
	return prom.Series{
		Labels:     labels,
		DataPoints: []prom.DataPoint{{Value: value}},
	}
}

func emptyResult() *prom.QueryResult {
	return &prom.QueryResult{ResultType: "vector", Series: []prom.Series{}}
}

func assertEq(t *testing.T, label, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %q, want %q", label, got, want)
	}
}

func TestBeylaSource_DetectAndPollConcurrently(t *testing.T) {
	// Manager releases its own lock before calling into a source, so a
	// re-detection can land while a StreamFlows goroutine is mid-poll. Detect
	// resolves the metric name and the pollers read it. Meaningful under -race.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, "network_flow_bytes_total") {
			return promResult("vector", promSeries(map[string]string{}, 1)), nil
		}
		return emptyResult(), nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := src.Detect(context.Background()); err != nil {
				t.Errorf("Detect: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := src.GetFlows(context.Background(), FlowOptions{}); err != nil {
				t.Errorf("GetFlows: %v", err)
			}
		}()
	}
	wg.Wait()
}

func TestBeylaSource_Detect_JobSelectorMismatchIsNotReportedAsFeatureOff(t *testing.T) {
	// Beyla is installed, scraped, and emitting network metrics — under a job name
	// the selector does not match. Both that and "network feature off" look like
	// "no flow metric", and they need opposite fixes, so the two must not collapse
	// into the same advice.
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		// Anything scoped to the job selector finds nothing.
		if strings.Contains(query, "job=~") {
			return emptyResult(), nil
		}
		if strings.Contains(query, "beyla_build_info") {
			return promResult("vector", promSeries(map[string]string{"version": "v3.25.0"}, 1)), nil
		}
		return emptyResult(), nil
	}

	result, err := src.Detect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Available {
		t.Fatal("expected available=false: nothing the flow queries can read")
	}
	if !result.Present {
		t.Error("Beyla is demonstrably running, so Present must be set for the reason to surface")
	}
	if !strings.Contains(result.Message, "beyla-job-selector") {
		t.Errorf("message should point at the job selector, got: %q", result.Message)
	}
	if strings.Contains(result.Message, "OTEL_EBPF_METRICS_FEATURES") {
		t.Errorf("this is not a feature-flag problem and must not be reported as one, got: %q", result.Message)
	}
}

func TestBeylaSource_DiagnosticsProbe_ScopesNamespaceOnEitherEnd(t *testing.T) {
	// beylaRateQuery treats a namespace filter as "either end of the conversation",
	// so the probe behind the warning has to match. Filtering on the source alone
	// would miss inbound UDP and would report UDP from namespaces the user is not
	// looking at.
	var probe string
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, `direction="unknown"`) {
			probe = query
		}
		return emptyResult(), nil
	}

	if _, err := src.GetFlows(context.Background(), FlowOptions{Namespace: "demo"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(probe, `k8s_src_namespace="demo"`) || !strings.Contains(probe, `k8s_dst_namespace="demo"`) {
		t.Errorf("probe must scope on either end, got: %s", probe)
	}
}

func TestBeylaSource_DiagnosticsProbe_IgnoresSeriesWithNoTraffic(t *testing.T) {
	// Beyla keeps emitting a series after its traffic stops, and a zero-rate
	// unknown-direction series was observed live for plain TCP. Counting series
	// rather than rates would announce hidden traffic on a cluster that has none.
	var probe string
	src := &BeylaSource{k8sClient: fake.NewSimpleClientset()}
	src.queryFn = func(_ context.Context, query string) (*prom.QueryResult, error) {
		if strings.Contains(query, `direction="unknown"`) {
			probe = query
		}
		return emptyResult(), nil
	}

	if _, err := src.GetFlows(context.Background(), FlowOptions{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(probe, "rate(") || !strings.Contains(probe, "> 0") {
		t.Errorf("probe must count series carrying traffic, not series that exist, got: %s", probe)
	}
}
