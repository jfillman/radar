package prometheus

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/skyhook-io/radar/pkg/prom"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

type fakeRightsizingQuerier func(string) (*prom.QueryResult, error)

func (f fakeRightsizingQuerier) Query(_ context.Context, query string) (*prom.QueryResult, error) {
	return f(query)
}

func containerResult(values map[string]float64) *prom.QueryResult {
	result := &prom.QueryResult{ResultType: "vector"}
	for container, value := range values {
		result.Series = append(result.Series, prom.Series{
			Labels:     map[string]string{"container": container},
			DataPoints: []prom.DataPoint{{Value: value}},
		})
	}
	return result
}

func mustQuantity(t *testing.T, s string) *resource.Quantity {
	t.Helper()
	q := resource.MustParse(s)
	return &q
}

func TestClassifyRequestFit(t *testing.T) {
	q := func(s string) *resource.Quantity { return mustQuantity(t, s) }

	tests := []struct {
		name                       string
		observed                   float64
		req, lim                   *resource.Quantity
		resource                   string
		hpa, oom                   bool
		wantFit                    RequestFit
		wantRec, wantLimitConflict bool
		wantReason                 string
	}{
		{"balanced inside 30 percent band", 0.08, q("100m"), q("1"), "cpu", false, false, FitBalanced, false, false, "request_within_fit_range"},
		{"oversized at 30 percent reduction", 0.06, q("100m"), q("1"), "cpu", false, false, FitOversized, true, false, ""},
		{"under requested includes headroom", 0.09, q("100m"), q("1"), "cpu", false, false, FitUnderRequested, true, false, ""},
		{"missing request", 0.2, nil, q("1"), "cpu", false, false, FitMissingRequest, true, false, ""},
		{"zero request is missing", 0.2, q("0"), q("1"), "cpu", false, false, FitMissingRequest, true, false, ""},
		{"HPA suppresses only its resource", 0.05, q("200m"), q("1"), "cpu", true, false, FitOversized, false, false, "hpa_managed"},
		{"memory OOM suppresses shrink", 50 * 1024 * 1024, q("256Mi"), q("1Gi"), "memory", false, true, FitOversized, false, false, "oom_evidence"},
		{"memory OOM permits increase", 300 * 1024 * 1024, q("128Mi"), q("1Gi"), "memory", false, true, FitUnderRequested, true, false, ""},
		{"recommended request above limit is withheld", 0.95, q("100m"), q("1"), "cpu", false, false, FitUnderRequested, false, true, "recommended_request_exceeds_limit"},
		{"rounded CPU request above limit is withheld", 0.095, q("50m"), q("105m"), "cpu", false, false, FitUnderRequested, false, true, "recommended_request_exceeds_limit"},
		{"rounded memory request above limit is withheld", 100 * 1024 * 1024, q("64Mi"), q("120Mi"), "memory", false, false, FitUnderRequested, false, true, "recommended_request_exceeds_limit"},
		{"rounded target equal to request is in range", 0, q("1m"), nil, "cpu", false, false, FitBalanced, false, false, "request_within_fit_range"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			row := RightsizingRow{HPAManaged: tc.hpa, HPAEvidenceAvailable: true, CurrentPodOOM: tc.oom, OOMEvidenceAvailable: true}
			classifyRequestFit(&row, tc.observed, tc.req, tc.lim, tc.resource)
			if row.Fit != tc.wantFit {
				t.Errorf("fit = %s, want %s", row.Fit, tc.wantFit)
			}
			if row.RecommendationReason != tc.wantReason {
				t.Errorf("reason = %q, want %q", row.RecommendationReason, tc.wantReason)
			}
			if tc.wantRec && row.RecommendedReq == nil {
				t.Errorf("expected RecommendedReq populated, got nil")
			}
			if !tc.wantRec && row.RecommendedReq != nil {
				t.Errorf("expected no RecommendedReq, got %q", *row.RecommendedReq)
			}
			if row.LimitConflict != tc.wantLimitConflict {
				t.Errorf("limitConflict = %t, want %t", row.LimitConflict, tc.wantLimitConflict)
			}
		})
	}
}

func TestRecommendRequest(t *testing.T) {
	tests := []struct {
		name    string
		p95     float64
		resKind string
		want    string
	}{
		// CPU — 15% headroom, rounded up so the displayed target never drops
		// below the protected demand estimate.
		{"cpu sub-milli rounds to 1m", 0.0001, "cpu", "1m"},
		{"cpu 100m → 115m → clean 120m step", 0.100, "cpu", "120m"},
		{"cpu 1 core → 1150m → 1.2 cores", 1.0, "cpu", "1.2"},
		{"cpu crossing one core uses 100m steps", 0.870, "cpu", "1.1"},
		{"cpu low usage keeps milli precision", 0.001, "cpu", "2m"},

		// Memory — 15% headroom, round up to next 16Mi, floor at 16Mi.
		{"memory tiny floors at 16Mi", 1024, "memory", "16Mi"},
		{"memory 100Mi → 115Mi → next 16Mi step", 100 * 1024 * 1024, "memory", "128Mi"},
		{"memory 1Gi exact boundary", 1024 * 1024 * 1024, "memory", "1.1Gi"},
		{"memory just under 1Gi crosses Gi", 900 * 1024 * 1024, "memory", "1.0Gi"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := recommendRequest(tc.p95, tc.resKind)
			if got != tc.want {
				t.Errorf("recommendRequest(%g, %q) = %q, want %q", tc.p95, tc.resKind, got, tc.want)
			}
		})
	}
}

func TestComputeRightsizingUsesGroupedEvidence(t *testing.T) {
	workload := rightsizingWorkload{
		containers: []containerSpec{{
			name: "server", cpuReq: mustQuantity(t, "500m"), cpuLim: mustQuantity(t, "1"),
			memReq: mustQuantity(t, "512Mi"), memLim: mustQuantity(t, "1Gi"),
		}},
		currentPodOOM: map[string]bool{},
		hpaManaged:    map[string]bool{},
		hpaAvailable:  true,
	}
	querier := fakeRightsizingQuerier(func(query string) (*prom.QueryResult, error) {
		switch {
		case strings.HasPrefix(query, "sum(count_over_time"):
			return &prom.QueryResult{Series: []prom.Series{{DataPoints: []prom.DataPoint{{Value: 1}}}}}, nil
		case strings.HasPrefix(query, "quantile_over_time(0.95"):
			return containerResult(map[string]float64{"server": 0.1}), nil
		case strings.HasPrefix(query, "quantile_over_time(0.99"):
			return containerResult(map[string]float64{"server": 100 * 1024 * 1024}), nil
		case strings.HasPrefix(query, "count_over_time"):
			return containerResult(map[string]float64{"server": 2016}), nil
		case strings.HasPrefix(query, "max_over_time"):
			return containerResult(map[string]float64{"server": 0.2}), nil
		case strings.Contains(query, "last_terminated_timestamp"):
			return containerResult(nil), nil
		default:
			return nil, errors.New("unexpected query")
		}
	})

	response := computeRightsizing(context.Background(), querier, "Deployment", "argocd", "argocd-server", workload)
	if response.OwnerCoverage != OwnerCoverageKSMHistory || !response.SampleAvailable {
		t.Fatalf("unexpected response coverage/availability: %+v", response)
	}
	if len(response.Rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(response.Rows))
	}
	cpu := response.Rows[0]
	if cpu.Fit != FitOversized || cpu.Confidence != ConfidenceHigh || cpu.RecommendedReq == nil {
		t.Errorf("CPU row = %+v", cpu)
	}
	if cpu.ThrottleRatio == nil || *cpu.ThrottleRatio != 0.2 || response.Summary.Throttled != 1 {
		t.Errorf("throttle evidence not preserved: row=%+v summary=%+v", cpu, response.Summary)
	}
	memory := response.Rows[1]
	if memory.Observed == nil || memory.Observed.Name != "P99" || memory.Fit != FitOversized {
		t.Errorf("memory row = %+v", memory)
	}
}

func TestWorkloadSelectionFallsBackToExactCurrentPods(t *testing.T) {
	var mu sync.Mutex
	var queries []string
	querier := fakeRightsizingQuerier(func(query string) (*prom.QueryResult, error) {
		mu.Lock()
		queries = append(queries, query)
		mu.Unlock()
		return &prom.QueryResult{}, nil
	})
	selection, coverage := workloadSelection(context.Background(), querier, "Deployment", "prod", "api", []string{"api-6ccf7b8d9-x1"})
	if coverage != OwnerCoverageCurrentPods {
		t.Fatalf("coverage = %q, want current_pods", coverage)
	}
	if selection.podPattern != `^(api-6ccf7b8d9-x1)$` {
		t.Errorf("selection is not exact: %+v", selection)
	}
	if strings.Contains(selection.podPattern, "api-worker") || strings.Contains(selection.podPattern, `api-.*`) {
		t.Errorf("selection can collide with sibling workloads: %+v", selection)
	}
	if got := confidenceFor(2016, 1, coverage); got != ConfidenceMedium {
		t.Errorf("current-pod confidence = %q, want medium", got)
	}
	if got := confidenceFor(72, 72.0/2016.0, coverage); got != ConfidenceLow {
		t.Errorf("sparse current-pod confidence = %q, want low", got)
	}
	for key, query := range buildRightsizingQueries("prod", selection) {
		if key != "oom" && !strings.Contains(query, `pod=~"^(api-6ccf7b8d9-x1)$"`) {
			t.Errorf("%s does not apply exact pods directly to its metric selector: %s", key, query)
		}
		if strings.Contains(query, `and on (namespace,pod) {`) {
			t.Errorf("%s uses an unbounded bare selector: %s", key, query)
		}
	}
	if len(queries) != 1 || !strings.Contains(queries[0], `owner_name="api"`) {
		t.Errorf("KSM ownership probe must use exact owner identity: %v", queries)
	}
}

func TestQueryErrorsHaveTheirOwnSummaryBucket(t *testing.T) {
	summary := RightsizingSummary{}
	addFitSummary(&summary, RightsizingRow{Fit: FitInsufficientHistory, QueryError: "usage query failed"})
	if summary.QueryErrors != 1 || summary.InsufficientHistory != 0 {
		t.Errorf("summary = %+v, want one query error and no insufficient-history result", summary)
	}
}

func TestAuxiliaryQueryFailureDoesNotMaskMissingUsageSamples(t *testing.T) {
	workload := rightsizingWorkload{
		containers:    []containerSpec{{name: "server"}},
		podNames:      []string{"api-6ccf7b8d9-x1"},
		currentPodOOM: map[string]bool{},
		hpaManaged:    map[string]bool{},
	}
	querier := fakeRightsizingQuerier(func(query string) (*prom.QueryResult, error) {
		if strings.Contains(query, "container_cpu_cfs_throttled") {
			return nil, errors.New("throttle metrics unavailable")
		}
		return &prom.QueryResult{}, nil
	})

	response := computeRightsizing(context.Background(), querier, "Deployment", "prod", "api", workload)
	if response.Reason != "No workload usage samples are available in the last 7d." {
		t.Errorf("reason = %q, want missing usage samples", response.Reason)
	}
}

func TestOwnerSelectionDeduplicatesKSMTargets(t *testing.T) {
	query := ownerSelection("Deployment", "prod", "api")
	for _, want := range []string{
		"max by (namespace,pod,owner_name)",
		"max by (namespace,replicaset)",
		`owner_name="api"`,
	} {
		if !strings.Contains(query, want) {
			t.Errorf("owner query missing %q: %s", want, query)
		}
	}
}

func TestExtractRuntimeContainers(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	onFailure := corev1.ContainerRestartPolicy("OnFailure")

	tests := []struct {
		name      string
		spec      *corev1.PodSpec
		wantNames []string
	}{
		{"regular containers only", &corev1.PodSpec{
			Containers: []corev1.Container{{Name: "app"}, {Name: "proxy"}},
		}, []string{"app", "proxy"}},

		{"pure init excluded", &corev1.PodSpec{
			Containers:     []corev1.Container{{Name: "app"}},
			InitContainers: []corev1.Container{{Name: "migrate"}},
		}, []string{"app"}},

		// Load-bearing native-sidecar behavior — without this the request/limit
		// overlay misses the sidecar's contribution.
		{"native sidecar included", &corev1.PodSpec{
			Containers:     []corev1.Container{{Name: "app"}},
			InitContainers: []corev1.Container{{Name: "envoy", RestartPolicy: &always}},
		}, []string{"app", "envoy"}},

		{"non-Always init excluded even with restart policy set", &corev1.PodSpec{
			Containers:     []corev1.Container{{Name: "app"}},
			InitContainers: []corev1.Container{{Name: "boot", RestartPolicy: &onFailure}},
		}, []string{"app"}},

		{"init-only pod returns empty runtime", &corev1.PodSpec{
			InitContainers: []corev1.Container{{Name: "job"}},
		}, []string{}},

		{"regular + sidecar + pure init mix", &corev1.PodSpec{
			Containers: []corev1.Container{{Name: "app"}},
			InitContainers: []corev1.Container{
				{Name: "wait-db"},
				{Name: "envoy", RestartPolicy: &always},
			},
		}, []string{"app", "envoy"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractRuntimeContainers(tc.spec)
			gotNames := make([]string, len(got))
			for i, c := range got {
				gotNames[i] = c.name
			}
			if !slicesEqual(gotNames, tc.wantNames) {
				t.Errorf("names = %v, want %v", gotNames, tc.wantNames)
			}
		})
	}
}

func TestFormatRightsizingValue(t *testing.T) {
	tests := []struct {
		v       float64
		resKind string
		want    string
	}{
		{0.0005, "cpu", "1m"},
		{2.0, "cpu", "2"},
		{1.5, "cpu", "1.5"},
		{1024, "memory", "16Mi"},
		{0, "memory", "16Mi"},
		{float64(2 * 1024 * 1024 * 1024), "memory", "2.0Gi"},
		{1.0, "disk", ""},
	}
	for _, tc := range tests {
		t.Run(tc.want, func(t *testing.T) {
			got := formatRightsizingValue(tc.v, tc.resKind)
			if got != tc.want {
				t.Errorf("formatRightsizingValue(%g, %q) = %q, want %q", tc.v, tc.resKind, got, tc.want)
			}
		})
	}
}

func TestFormatObservedValueDoesNotRoundLikeARecommendation(t *testing.T) {
	if got := formatObservedValue(0.0022, "cpu"); got != "2m" {
		t.Errorf("CPU observed = %q, want 2m", got)
	}
	if got := formatObservedValue(39.4*1024*1024, "memory"); got != "39Mi" {
		t.Errorf("memory observed = %q, want 39Mi", got)
	}
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
