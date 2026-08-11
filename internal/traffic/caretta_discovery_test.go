package traffic

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes/fake"
)

func metricsSvc(ns, name string, port int32, clusterIP string, labels map[string]string) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels},
		Spec: corev1.ServiceSpec{
			ClusterIP: clusterIP,
			Ports:     []corev1.ServicePort{{Name: "http", Port: port, TargetPort: intstr.FromString("http")}},
		},
	}
}

// carettaStoreSvc mirrors what the groundcover/caretta chart renders: the
// VictoriaMetrics subchart's name label, a headless service, port 8428.
func carettaStoreSvc(ns, name string) *corev1.Service {
	return metricsSvc(ns, name, 8428, "None", map[string]string{
		"app":                    "server",
		"app.kubernetes.io/name": "victoria-metrics-single",
	})
}

// kubePrometheusStackSvcs are the services a kube-prometheus-stack install puts
// in the well-known candidate list.
func kubePrometheusStackSvcs() []*corev1.Service {
	return []*corev1.Service{
		metricsSvc("monitoring", "prometheus-operated", 9090, "None", map[string]string{
			"operated-prometheus": "true",
		}),
		metricsSvc("monitoring", "kube-prometheus-stack-prometheus", 9090, "10.0.0.5", map[string]string{
			"app":                       "kube-prometheus-stack-prometheus",
			"app.kubernetes.io/part-of": "kube-prometheus-stack",
		}),
	}
}

func sourceWithServices(t *testing.T, detectedNS string, svcs ...*corev1.Service) *CarettaSource {
	t.Helper()
	cs := fake.NewSimpleClientset()
	for _, s := range svcs {
		if _, err := cs.CoreV1().Services(s.Namespace).Create(context.Background(), s, metav1.CreateOptions{}); err != nil {
			t.Fatalf("seeding service %s/%s: %v", s.Namespace, s.Name, err)
		}
	}
	return &CarettaSource{
		k8sClient:         cs,
		httpClient:        &http.Client{Timeout: 500 * time.Millisecond},
		detectedNamespace: detectedNS,
	}
}

func discover(t *testing.T, c *CarettaSource) []*metricsServiceInfo {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.discoverServiceLocked(context.Background())
}

// The store Caretta ships must outrank the cluster's general Prometheus. This is
// the shape the wizard installs and the one reported in #1264.
func TestCarettaPrefersOwnStoreOverGeneralPrometheus(t *testing.T) {
	c := sourceWithServices(t, "caretta", append(kubePrometheusStackSvcs(), carettaStoreSvc("caretta", "caretta-vm"))...)

	got := discover(t, c)
	if len(got) == 0 {
		t.Fatal("no candidates discovered")
	}
	if got[0].namespace != "caretta" || got[0].name != "caretta-vm" {
		t.Errorf("top candidate = %s/%s, want caretta/caretta-vm", got[0].namespace, got[0].name)
	}
	if !got[0].isCarettaStore {
		t.Error("top candidate not marked as Caretta's own store")
	}
}

// The chart pins the service name but not the namespace: `helm install caretta
// groundcover/caretta` with no -n puts everything in `default`. A namespace-blind
// lookup walks past it and lands on kube-prometheus-stack, which holds no Caretta
// series and answers every query successfully.
func TestCarettaFindsStoreOutsideCarettaNamespace(t *testing.T) {
	for _, ns := range []string{"default", "kube-system", "monitoring", "observability"} {
		t.Run(ns, func(t *testing.T) {
			c := sourceWithServices(t, ns, append(kubePrometheusStackSvcs(), carettaStoreSvc(ns, "caretta-vm"))...)

			got := discover(t, c)
			if len(got) == 0 {
				t.Fatal("no candidates discovered")
			}
			if got[0].namespace != ns || got[0].name != "caretta-vm" {
				t.Errorf("top candidate = %s/%s, want %s/caretta-vm", got[0].namespace, got[0].name, ns)
			}
		})
	}
}

// A store whose name isn't the pinned caretta-vm is still found, because the
// lookup keys on the VictoriaMetrics subchart label rather than the name.
func TestCarettaFindsRenamedStoreByLabel(t *testing.T) {
	c := sourceWithServices(t, "caretta",
		append(kubePrometheusStackSvcs(), carettaStoreSvc("caretta", "caretta-victoria-metrics-single-server"))...)

	got := discover(t, c)
	if len(got) == 0 {
		t.Fatal("no candidates discovered")
	}
	if got[0].name != "caretta-victoria-metrics-single-server" {
		t.Errorf("top candidate = %s/%s, want the labelled VM store", got[0].namespace, got[0].name)
	}
}

// Without its own store, the general Prometheus is still offered — it may be
// scraping Caretta — but it comes second and has to prove it holds the data.
func TestCarettaOffersGeneralPrometheusWhenNoStoreExists(t *testing.T) {
	c := sourceWithServices(t, "caretta", kubePrometheusStackSvcs()...)

	got := discover(t, c)
	if len(got) == 0 {
		t.Fatal("no candidates discovered")
	}
	for _, info := range got {
		if info.isCarettaStore {
			t.Errorf("%s/%s wrongly marked as Caretta's own store", info.namespace, info.name)
		}
	}
}

// promBackend describes what a stub Prometheus holds. A real backend returns an
// empty vector for a metric it never scraped while still answering `up`, which is
// exactly why the generic reachability probe can't tell backends apart.
type promBackend struct {
	links      bool // has caretta_links_observed series
	carettaJob bool // scrapes a target whose job name contains "caretta"
}

func promStub(t *testing.T, backend promBackend) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, err := url.QueryUnescape(r.URL.Query().Get("query"))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		var hasSeries bool
		switch {
		case strings.Contains(q, "caretta_links_observed"):
			hasSeries = backend.links
		case strings.Contains(q, "caretta"):
			hasSeries = backend.carettaJob
		default:
			hasSeries = true // plain `up` — every Prometheus answers this
		}

		result := []any{}
		if hasSeries {
			result = append(result, map[string]any{
				"metric": map[string]string{"client_name": "frontend", "server_name": "backend", "server_port": "80"},
				"value":  []any{1.0, "3"},
			})
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "success",
			"data":   map[string]any{"resultType": "vector", "result": result},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func accept(t *testing.T, c *CarettaSource, info *metricsServiceInfo, addr string) bool {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.acceptBackendLocked(context.Background(), info, addr) == backendAccepted
}

// The generic reachability probe cannot tell the two apart — that is what made
// the wrong-backend failure silent. Acceptance has to look at the content.
func TestAcceptBackendRejectsPrometheusWithoutCarettaData(t *testing.T) {
	general := promStub(t, promBackend{})
	c := &CarettaSource{httpClient: &http.Client{Timeout: 2 * time.Second}}

	c.mu.Lock()
	reachable := c.tryMetricsEndpointLocked(context.Background(), general.URL)
	c.mu.Unlock()
	if !reachable {
		t.Fatal("stub should pass the generic reachability probe")
	}

	if accept(t, c, &metricsServiceInfo{namespace: "monitoring", name: "prometheus-operated"}, general.URL) {
		t.Error("accepted a Prometheus that holds no Caretta metrics")
	}
}

// A general Prometheus that does scrape Caretta (ServiceMonitor deployments) is
// the correct backend and must not be rejected by an identity-based gate.
func TestAcceptBackendAcceptsPrometheusScrapingCaretta(t *testing.T) {
	scraping := promStub(t, promBackend{links: true})
	c := &CarettaSource{httpClient: &http.Client{Timeout: 2 * time.Second}}

	if !accept(t, c, &metricsServiceInfo{namespace: "monitoring", name: "kube-prometheus-stack-prometheus"}, scraping.URL) {
		t.Error("rejected a Prometheus that does hold Caretta metrics")
	}
}

// A Caretta install that hasn't observed a connection yet holds no
// caretta_links_observed. Its own store is accepted on identity so an idle
// cluster doesn't read as a misconfiguration.
func TestAcceptBackendAcceptsOwnStoreWithoutSeriesYet(t *testing.T) {
	fresh := promStub(t, promBackend{})
	c := &CarettaSource{httpClient: &http.Client{Timeout: 2 * time.Second}}

	if !accept(t, c, &metricsServiceInfo{namespace: "caretta", name: "caretta-vm", isCarettaStore: true}, fresh.URL) {
		t.Error("rejected Caretta's own store because it has no links yet")
	}
}

// The scrape-target signal covers a store that has targets but no links.
func TestCarettaMetricsPresentAcceptsScrapeTargetSignal(t *testing.T) {
	srv := promStub(t, promBackend{carettaJob: true})
	c := &CarettaSource{httpClient: &http.Client{Timeout: 2 * time.Second}}

	c.mu.Lock()
	got := c.carettaMetricsPresentLocked(context.Background(), srv.URL)
	c.mu.Unlock()
	if !got {
		t.Error("scrape-target signal not recognised")
	}
}

// The acceptance probe must carry the configured auth headers, or an
// auth-protected store reads as "holds no Caretta metrics".
func TestCarettaProbeCarriesHeaders(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer srv.Close()

	c := &CarettaSource{
		httpClient: &http.Client{Timeout: 2 * time.Second},
		headers:    map[string]string{"Authorization": "Bearer caretta-token"},
	}
	c.mu.Lock()
	c.carettaMetricsPresentLocked(context.Background(), srv.URL)
	c.mu.Unlock()

	if gotAuth != "Bearer caretta-token" {
		t.Errorf("probe Authorization = %q, want %q", gotAuth, "Bearer caretta-token")
	}
}

// Zero flows from a backend that never proved it holds Caretta data is
// indistinguishable from a quiet cluster unless the response says so.
func TestGetFlowsWarnsWhenBackendHasNoCarettaMetrics(t *testing.T) {
	general := promStub(t, promBackend{})

	c := &CarettaSource{
		httpClient:       &http.Client{Timeout: 2 * time.Second},
		prometheusAddr:   general.URL,
		metricsNamespace: "monitoring",
		metricsService:   "prometheus-operated",
		isConnected:      true,
	}

	resp, err := c.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("GetFlows: %v", err)
	}
	if len(resp.Flows) != 0 {
		t.Fatalf("expected 0 flows, got %d", len(resp.Flows))
	}
	if resp.Warning == "" {
		t.Fatal("zero flows from an unverified backend reported without a warning")
	}
	if !strings.Contains(resp.Warning, "monitoring/prometheus-operated") {
		t.Errorf("warning does not name the backend: %q", resp.Warning)
	}
}

// A verified backend that is simply quiet must not raise a false alarm.
func TestGetFlowsStaysSilentOnVerifiedBackend(t *testing.T) {
	store := promStub(t, promBackend{})

	c := &CarettaSource{
		httpClient:       &http.Client{Timeout: 2 * time.Second},
		prometheusAddr:   store.URL,
		metricsNamespace: "caretta",
		metricsService:   "caretta-vm",
		isConnected:      true,
		backendVerified:  true,
	}

	resp, err := c.GetFlows(context.Background(), FlowOptions{})
	if err != nil {
		t.Fatalf("GetFlows: %v", err)
	}
	if resp.Warning != "" {
		t.Errorf("verified quiet backend warned anyway: %q", resp.Warning)
	}
}

// Reached-but-wrong and never-reached are different problems: one means Radar is
// reading the wrong database, the other means it read nothing at all. Collapsing
// them sends the user to fix the wrong thing.
func TestNoBackendWarningDistinguishesRejectionReasons(t *testing.T) {
	tests := []struct {
		name        string
		noData      []string
		unreachable []string
		want        string
	}{
		{"holds no caretta data", []string{"monitoring/prometheus-operated"}, nil, "holds no Caretta metrics"},
		{"never reached", nil, []string{"caretta/caretta-vm"}, "could not reach it"},
		{"data problem wins", []string{"monitoring/prometheus-operated"}, []string{"caretta/caretta-vm"}, "holds no Caretta metrics"},
		{"nothing found", nil, nil, "service not found"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := noBackendWarning(tc.noData, tc.unreachable)
			if !strings.Contains(got, tc.want) {
				t.Errorf("noBackendWarning(%v, %v) = %q, want it to contain %q", tc.noData, tc.unreachable, got, tc.want)
			}
		})
	}
}

// The well-known list still carries caretta-vm for split installs. A store found
// that way must be treated the same as one found by label, or a Caretta with no
// links yet is admitted or rejected depending on which path happened to find it.
func TestWellKnownCarettaStoreIsMarkedAsOwnStore(t *testing.T) {
	// Detected in `default`, but the store lives in `caretta` — only the well-known
	// list can find it.
	c := sourceWithServices(t, "default", append(kubePrometheusStackSvcs(), carettaStoreSvc("caretta", "caretta-vm"))...)

	got := discover(t, c)
	if len(got) == 0 {
		t.Fatal("no candidates discovered")
	}
	if got[0].namespace != "caretta" || got[0].name != "caretta-vm" {
		t.Fatalf("top candidate = %s/%s, want caretta/caretta-vm", got[0].namespace, got[0].name)
	}
	if !got[0].isCarettaStore {
		t.Error("well-known caretta-vm not marked as Caretta's own store")
	}
}
