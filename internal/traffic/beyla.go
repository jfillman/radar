package traffic

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/skyhook-io/radar/internal/portforward"
	promclient "github.com/skyhook-io/radar/internal/prometheus"
	"github.com/skyhook-io/radar/pkg/prom"
)

const (
	// defaultBeylaJobSelector is used unless overridden via SetBeylaJobSelector
	// (wired to --beyla-job-selector) for clusters running Alloy/Beyla under a
	// non-default Prometheus job name.
	defaultBeylaJobSelector = `job=~".*beyla.*|.*alloy.*"`
	// Rate window in the PromQL queries; used to turn per-second rates back
	// into absolute counts for the window.
	beylaRateWindowSeconds = 300

	// Grafana's Beyla vendors upstream OBI and renames the flow metric back to
	// beyla_*; OBI itself emits obi_*. Both distributions are current, so the
	// prefix is resolved once in Detect rather than assumed.
	beylaFlowMetric = "beyla_network_flow_bytes_total"
	obiFlowMetric   = "obi_network_flow_bytes_total"
)

// beylaJobSelector returns the PromQL job-label matcher fragment (e.g.
// `job=~".*beyla.*"`) used to scope Beyla queries, honoring any operator
// override.
func beylaJobSelector() string {
	if selector := BeylaJobSelector(); selector != "" {
		return selector
	}
	return defaultBeylaJobSelector
}

type promQueryFunc func(ctx context.Context, query string) (*prom.QueryResult, error)

// BeylaSource implements TrafficSource for Grafana Beyla via Prometheus metrics.
type BeylaSource struct {
	k8sClient kubernetes.Interface
	queryFn   promQueryFunc

	// mu guards the fields Detect resolves and the pollers read. Manager releases
	// its own lock before calling into a source, so a re-detection can land while
	// a StreamFlows goroutine is mid-poll.
	mu sync.RWMutex
	// flowMetric is the network-flow metric name this cluster actually exposes,
	// resolved by Detect. Empty until then; flowMetricName falls back to the
	// Beyla spelling so a GetFlows before Detect still queries something valid.
	flowMetric string
	// unorientable caches whether the cluster has traffic the direction filter
	// excludes. It answers a question about how Beyla is configured, which does
	// not change between polls, so it is probed at most once per TTL rather than
	// on every request.
	unorientable     map[string]bool
	unorientableAsOf map[string]time.Time
}

// beylaUnorientableTTL bounds how stale the "UDP is hidden" answer may be. It
// tracks a Beyla configuration change, not traffic, so minutes are fine and the
// alternative is a third query on every poll of every streaming client.
const beylaUnorientableTTL = 5 * time.Minute

// NewBeylaSource creates a new Beyla traffic source wired to the shared Prometheus client.
func NewBeylaSource(client kubernetes.Interface) *BeylaSource {
	s := &BeylaSource{k8sClient: client}
	s.queryFn = s.defaultQuery
	return s
}

func (s *BeylaSource) Name() string { return "beyla" }

func (s *BeylaSource) flowMetricName() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.flowMetric != "" {
		return s.flowMetric
	}
	return beylaFlowMetric
}

func (s *BeylaSource) setFlowMetric(metric string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flowMetric = metric
}

func (s *BeylaSource) defaultQuery(ctx context.Context, query string) (*prom.QueryResult, error) {
	client := promclient.GetClient()
	if client == nil {
		return nil, fmt.Errorf("prometheus client not initialized")
	}
	return client.Query(ctx, query)
}

func (s *BeylaSource) query(ctx context.Context, query string) (*prom.QueryResult, error) {
	return s.queryFn(ctx, query)
}

// Connect delegates to the shared Prometheus client's EnsureConnected.
func (s *BeylaSource) Connect(ctx context.Context, contextName string) (*portforward.ConnectionInfo, error) {
	client := promclient.GetClient()
	if client == nil {
		return &portforward.ConnectionInfo{Connected: false, Error: "Prometheus client not initialized"}, nil
	}
	_, _, err := client.EnsureConnected(ctx)
	if err != nil {
		return &portforward.ConnectionInfo{Connected: false, Error: fmt.Sprintf("Failed to connect to Prometheus: %v", err)}, nil
	}
	status := client.GetStatus()
	info := &portforward.ConnectionInfo{Connected: true, Address: status.Address, ContextName: contextName}
	if status.Service != nil {
		info.Namespace = status.Service.Namespace
		info.ServiceName = status.Service.Name
	}
	return info, nil
}

func (s *BeylaSource) Close() error { return nil }

func (s *BeylaSource) Detect(ctx context.Context) (*DetectionResult, error) {
	result := &DetectionResult{Available: false}

	// Probe each prefix in turn and remember which answered. Deliberately not a
	// single regex union of the two names: a cluster part-way through migrating
	// from Beyla to OBI would run both, and summing them would double every edge.
	for _, metric := range []string{beylaFlowMetric, obiFlowMetric} {
		qr, err := s.query(ctx, fmt.Sprintf(`count(%s{%s})`, metric, beylaJobSelector()))
		if err != nil || qr == nil || len(qr.Series) == 0 {
			continue
		}
		s.setFlowMetric(metric)
		result.Available = true
		result.Native = false
		result.Message = fmt.Sprintf("Beyla detected via Prometheus metrics (%s)", metric)
		result.Version = s.detectVersion(ctx)
		return result, nil
	}

	// No flow metric anywhere. build_info survives when the network feature is
	// off — it is opt-in via OTEL_EBPF_METRICS_FEATURES and off by default — so
	// it is what separates "Beyla is here but not watching the network" from
	// "Beyla is not installed". Pod labels cannot make that distinction:
	// app.kubernetes.io/name=alloy matches every Alloy install, and most Alloy
	// installs carry no Beyla at all. Reporting Available on that basis wins the
	// source priority order in manager.go and then renders a permanently empty
	// graph with nothing to explain it, which is why availability now requires
	// data, the same way the Caretta source validates its backend really holds
	// Caretta metrics before claiming it.
	if version := s.detectVersion(ctx); version != "" {
		result.Version = version
		result.Present = true
		result.Message = "Beyla is running but exposes no network flow metrics. " +
			`Add "network" to OTEL_EBPF_METRICS_FEATURES to enable them.`
		return result, nil
	}

	// Nothing under the selector at all. If Beyla is in Prometheus under some other
	// job name, the selector is the problem and telling the operator to enable a
	// feature they have already enabled sends them the wrong way.
	if version := s.buildInfoVersion(ctx, false); version != "" {
		result.Version = version
		result.Present = true
		result.Message = fmt.Sprintf("Beyla %s is in Prometheus, but none of its metrics match %s. "+
			"Point --beyla-job-selector at the job Beyla is scraped under.", version, beylaJobSelector())
		return result, nil
	}

	// Pods are a diagnostic only, never a reason to claim availability: if
	// something Beyla-shaped is running but Prometheus holds nothing for it, the
	// useful thing to say is that the scrape or the job selector is the problem.
	if pods := s.countBeylaPods(ctx); pods > 0 {
		result.Present = true
		result.Message = fmt.Sprintf("Found %d running Alloy or Beyla pod(s), but Prometheus holds no Beyla metrics. "+
			"Check that Prometheus scrapes Beyla, and that --beyla-job-selector matches its job label.", pods)
		return result, nil
	}

	result.Message = "Beyla not detected. Install Alloy + Beyla for L7 traffic visibility."
	return result, nil
}

// detectVersion reads the version out of build_info, which is present whenever
// Beyla is running regardless of which metric features are enabled. Scoped to the
// same jobs the flow queries read, so it cannot report a version for an instance
// GetFlows will never see.
func (s *BeylaSource) detectVersion(ctx context.Context) string {
	return s.buildInfoVersion(ctx, true)
}

// buildInfoVersion reads the version from build_info, optionally without the job
// selector. The unscoped form exists only to tell two failures apart: Beyla
// installed with the network feature off, versus Beyla installed and emitting
// fine but under a job name the selector does not match. Both look like "no flow
// metric", and they need opposite fixes.
//
// obi_build_info is inferred from the flow-metric prefix rather than observed —
// upstream OBI was not available to scrape. A wrong guess is harmless: the query
// returns no series and the next candidate is tried.
func (s *BeylaSource) buildInfoVersion(ctx context.Context, scoped bool) string {
	for _, metric := range []string{"beyla_build_info", "obi_build_info"} {
		query := metric
		if scoped {
			query = fmt.Sprintf(`%s{%s}`, metric, beylaJobSelector())
		}
		qr, err := s.query(ctx, query)
		if err != nil || qr == nil {
			continue
		}
		for _, series := range qr.Series {
			if v := series.Labels["version"]; v != "" {
				return v
			}
			if v := series.Labels["beyla_version"]; v != "" {
				return v
			}
		}
	}
	return ""
}

func (s *BeylaSource) countBeylaPods(ctx context.Context) int {
	count := 0
	for _, label := range []string{"app.kubernetes.io/name=alloy", "app.kubernetes.io/name=beyla"} {
		pods, err := s.k8sClient.CoreV1().Pods("").List(ctx, metav1.ListOptions{LabelSelector: label})
		if err != nil {
			log.Printf("[beyla] Failed to list pods matching %s: %v", label, err)
			continue
		}
		for i := range pods.Items {
			if pods.Items[i].Status.Phase == corev1.PodRunning {
				count++
			}
		}
	}
	return count
}

// l4Key identifies one conversation for dedup. It covers every label
// beylaL4GroupBy groups by except the two owner types, which are excluded
// deliberately — see preferL4. transport is the raw label rather than the mapped
// protocol, since mapBeylaTransport collapses everything that is not TCP or UDP
// into "tcp" and would merge genuinely distinct series.
type l4Key struct {
	srcNs, srcName string
	dstNs, dstName string
	dstPort        int
	transport      string
}

// dstPortKey identifies a destination workload and the port it was served on.
// The HTTP server-duration metric carries server_port, so L7 results join to the
// exact L4 port rather than being matched by destination and guessed at.
type dstPortKey struct {
	dstNs, dstName string
	port           int
}

// l4LabelPresence records which of the optional network attributes the scrape
// actually carried. dst_port and transport are Default:false in Beyla's
// attribute registry, so a stock install exports neither and every flow arrives
// with no port and no protocol. That is worth telling the user about rather than
// silently rendering port 0 and calling everything TCP.
type l4LabelPresence struct {
	port      bool
	transport bool
	// hiddenUDP is set when the cluster has traffic Beyla could not orient — UDP,
	// which it reports as direction="unknown" in both directions and which the
	// direction filter therefore drops. Recorded so the graph can say the traffic
	// exists but is not shown, rather than appearing to be complete.
	hiddenUDP bool
}

func (s *BeylaSource) GetFlows(ctx context.Context, opts FlowOptions) (*FlowsResponse, error) {
	flows, presence, err := s.getFlowsInternal(ctx, opts, true)
	if err != nil {
		log.Printf("[beyla] Error fetching flows: %v", err)
		return &FlowsResponse{Source: "beyla", Timestamp: time.Now(), Flows: []Flow{},
			Warning:     fmt.Sprintf("Failed to query Beyla metrics: %v", err),
			WarningKind: WarningTransient}, nil
	}
	response := &FlowsResponse{Source: "beyla", Timestamp: time.Now(), Flows: flows}
	if warning := presence.warning(len(flows)); warning != "" {
		response.Warning = warning
		// Describes how Beyla is configured, not a hiccup. Marked so the client
		// shows it beside the flows instead of retrying for a better answer that
		// is never coming.
		response.WarningKind = WarningPartial
	}
	return response, nil
}

// warning explains missing optional attributes in the terms an operator can act
// on. Only raised once there are flows to qualify: with no flows at all the
// absent labels are not the interesting fact.
func (p l4LabelPresence) warning(flowCount int) string {
	var parts []string

	if flowCount > 0 {
		var missing []string
		if !p.port {
			missing = append(missing, "dst.port")
		}
		if !p.transport {
			missing = append(missing, "transport")
		}
		if len(missing) > 0 {
			parts = append(parts, fmt.Sprintf("Beyla is not exporting %s, so these edges have no port or "+
				"protocol detail (they are shown as port 0 over TCP). Both are opt-in attributes: add them "+
				"to attributes.select for beyla_network_flow_bytes to see per-port edges.",
				strings.Join(missing, " and ")))
		}
	}

	// Stated whether or not there are flows: with no TCP traffic at all, "Beyla
	// sees UDP but cannot place it" is the only honest explanation for an empty
	// graph.
	if p.hiddenUDP {
		parts = append(parts, "Some traffic is not shown: Beyla reports it as direction=unknown on both "+
			"sides of the conversation — which is where UDP such as DNS lands — so which end initiated it "+
			"cannot be determined, and drawing it would invent an arrow.")
	}

	return strings.Join(parts, " ")
}

// getFlowsInternal fetches and merges the flows. withDiagnostics controls the
// extra probe behind the partial-data warning: callers that discard the warning
// must pass false rather than pay for an answer they throw away.
func (s *BeylaSource) getFlowsInternal(ctx context.Context, opts FlowOptions, withDiagnostics bool) ([]Flow, l4LabelPresence, error) {
	l4Map, presence, err := s.queryL4(ctx, opts, withDiagnostics)
	if err != nil {
		return nil, presence, fmt.Errorf("L4 query: %w", err)
	}

	l7Flows, err := s.queryL7(ctx, opts)
	if err != nil {
		log.Printf("[beyla] L7 query failed (continuing with L4 only): %v", err)
		l7Flows = nil
	}

	byDstPort := make(map[dstPortKey][]*Flow, len(l4Map))
	for _, f := range l4Map {
		key := dstPortKey{f.Destination.Namespace, f.Destination.Name, f.Port}
		byDstPort[key] = append(byDstPort[key], f)
	}

	// Merge L7 into L4 on destination and port. server_port on the HTTP metric
	// names the port the requests were served on, so there is no need to work out
	// which of a destination's ports is the HTTP one.
	for _, l7 := range busiestL7PerDstPort(l7Flows) {
		dst := dstPortKey{l7.Destination.Namespace, l7.Destination.Name, l7.Port}
		edges := byDstPort[dst]
		if len(edges) == 0 {
			// dst_port is opt-in and absent by default, in which case every L4
			// edge carries port 0 and a destination's whole conversation with a
			// given caller has already collapsed into one edge. Attaching the
			// destination's HTTP metadata to that bucket is unambiguous, because
			// there is only one port's worth of edges to attach it to. When
			// dst_port is selected the exact match above applies instead.
			edges = byDstPort[dstPortKey{l7.Destination.Namespace, l7.Destination.Name, 0}]
		}
		if len(edges) == 0 {
			continue
		}
		// The HTTP metric is recorded server-side and carries no source labels at
		// all, so a destination's request rate still has to be divided across the
		// callers that reached it on this port rather than copied onto each one.
		// Weight by L4 byte volume as the best available proxy for each caller's
		// share; server_port fixes which port, not which caller.
		var totalBytes int64
		for _, f := range edges {
			totalBytes += f.BytesSent + f.BytesRecv
		}
		for _, f := range edges {
			f.L7Protocol = l7.L7Protocol
			f.HTTPMethod = l7.HTTPMethod
			f.HTTPPath = l7.HTTPPath
			f.HTTPStatus = l7.HTTPStatus
			if totalBytes > 0 {
				share := float64(f.BytesSent+f.BytesRecv) / float64(totalBytes)
				f.RequestRate = l7.RequestRate * share
			} else {
				f.RequestRate = l7.RequestRate / float64(len(edges))
			}
		}
	}

	result := make([]Flow, 0, len(l4Map))
	for _, f := range l4Map {
		result = append(result, *f)
	}
	return result, presence, nil
}

// busiestL7PerDstPort collapses the HTTP series for one destination and port into
// a single record: rates summed, and the route, method and status taken from the
// busiest individual series so the edge label describes real traffic.
func busiestL7PerDstPort(l7Flows []Flow) []Flow {
	best := make(map[dstPortKey]Flow, len(l7Flows))
	topRate := make(map[dstPortKey]float64, len(l7Flows))
	for _, f := range l7Flows {
		dst := dstPortKey{f.Destination.Namespace, f.Destination.Name, f.Port}
		cur, ok := best[dst]
		if !ok {
			best[dst], topRate[dst] = f, f.RequestRate
			continue
		}
		if f.RequestRate > topRate[dst] {
			topRate[dst] = f.RequestRate
			cur.HTTPMethod, cur.HTTPPath, cur.HTTPStatus = f.HTTPMethod, f.HTTPPath, f.HTTPStatus
		}
		cur.RequestRate += f.RequestRate
		best[dst] = cur
	}
	out := make([]Flow, 0, len(best))
	for _, f := range best {
		out = append(out, f)
	}
	return out
}

// preferL4 chooses between two series that describe the same conversation.
//
// Beyla reports a Service-routed conversation twice — once attributed to the
// destination workload and once to the Service in front of it — with byte
// identical values. Both carry the same source, destination name, port and
// transport, so they land on the same l4Key and one has to win. Keeping both
// would double the traffic on every Service-routed edge, which is most of them;
// letting Prometheus result order decide makes the rendered Kind arbitrary.
// Radar's graph navigates to workloads, so the workload attribution wins.
func preferL4(incumbent, candidate *Flow) *Flow {
	if serviceEndpoints(candidate) < serviceEndpoints(incumbent) {
		return candidate
	}
	return incumbent
}

func serviceEndpoints(f *Flow) int {
	count := 0
	if f.Source.Kind == "Service" {
		count++
	}
	if f.Destination.Kind == "Service" {
		count++
	}
	return count
}

const (
	beylaL4GroupBy = `k8s_src_owner_name, k8s_src_namespace, k8s_src_owner_type, k8s_dst_owner_name, k8s_dst_namespace, k8s_dst_owner_type, dst_port, transport`
	// beylaL4DirectionFilter drops the response half of every conversation.
	// Beyla emits both directions with source and destination swapped, so without
	// this each edge gains a mirror twin pointing the wrong way — and once
	// dst.port is selected each response series carries the client's ephemeral
	// port, turning one conversation into hundreds of series.
	//
	// It requires "request" rather than merely excluding "response" because there
	// is a third value, "unknown", which is where UDP lands — and Beyla labels
	// *both* directions of a UDP conversation "unknown". Keeping them means every
	// DNS conversation draws a mirrored pair, and once dst.port is selected the
	// reverse half carries the client's ephemeral port: on a 4-pod cluster that
	// alone produced 287 spurious coredns edges out of 289 flows. Nothing in the
	// labels can orient an "unknown" pair, since after filtering it is
	// indistinguishable from two services genuinely calling each other.
	//
	// The cost is that UDP traffic does not appear in the graph at all. That is
	// surfaced to the user rather than left implicit — see l4LabelPresence.
	beylaL4DirectionFilter = `, direction="request"`
	// beylaUnknownDirectionProbe counts the series excluded by the filter above,
	// so the absence of UDP can be stated instead of silently rendering nothing.
	beylaUnknownDirectionProbe = `, direction="unknown"`
	// beylaL7Metric is Beyla's OTel-aligned HTTP server histogram; there is no
	// millisecond variant.
	beylaL7Metric = "http_server_request_duration_seconds_count"
	// beylaL7GroupBy labels come from http_server_request_duration_seconds, which
	// is recorded server-side only. k8s_owner_name is Beyla's own resolved owner,
	// the same concept as k8s_dst_owner_name on the L4 metric, so destinations
	// from both metrics line up. server_port names the port the requests were
	// served on, which is what lets L7 join to a specific L4 edge. No caller or
	// source labels exist on this metric at all.
	beylaL7GroupBy = `k8s_namespace_name, k8s_owner_name, k8s_pod_name, server_port, http_request_method, http_route, http_response_status_code`
)

// beylaRateQuery builds `sum by (groupBy) (rate(metric{job=~...,extra}[5m]))`. A
// namespace filter has to become two OR'd selectors: PromQL cannot express
// "src OR dst namespace matches" inside a single label selector.
func beylaRateQuery(groupBy, metric, namespace, extra string) string {
	sum := func(more string) string {
		return fmt.Sprintf(`sum by (%s) (rate(%s{%s%s%s}[5m]))`, groupBy, metric, beylaJobSelector(), extra, more)
	}
	if namespace == "" {
		return sum("")
	}
	return sum(fmt.Sprintf(`, k8s_src_namespace=%q`, namespace)) + " or " +
		sum(fmt.Sprintf(`, k8s_dst_namespace=%q`, namespace))
}

// beylaL7RateQuery builds the L7 query. Unlike beylaRateQuery, there's only
// one namespace label to filter on (k8s_namespace_name) since the metric has
// no source side.
func beylaL7RateQuery(namespace string) string {
	extra := ""
	if namespace != "" {
		extra = fmt.Sprintf(`, k8s_namespace_name=%q`, namespace)
	}
	return fmt.Sprintf(`sum by (%s) (rate(%s{%s%s}[5m]))`, beylaL7GroupBy, beylaL7Metric, beylaJobSelector(), extra)
}

func (s *BeylaSource) queryL4(ctx context.Context, opts FlowOptions, withDiagnostics bool) (map[l4Key]*Flow, l4LabelPresence, error) {
	query := beylaRateQuery(beylaL4GroupBy, s.flowMetricName(), opts.Namespace, beylaL4DirectionFilter)
	result, err := s.query(ctx, query)
	if err != nil {
		return nil, l4LabelPresence{}, err
	}
	flows, presence := s.parseL4Flows(result)
	if withDiagnostics {
		presence.hiddenUDP = s.hasUnorientableTraffic(ctx, opts)
	}
	return flows, presence, nil
}

// hasUnorientableTraffic reports whether the cluster has traffic the direction
// filter excluded. A cheap instant count, not a rate: it only decides whether to
// explain an absence, so a failed probe stays silent rather than guessing.
//
// The answer describes Beyla's configuration rather than current traffic, so it
// is cached per (metric, job selector, namespace) for beylaUnorientableTTL. Without
// that, every poll of every streaming client would pay for it.
func (s *BeylaSource) hasUnorientableTraffic(ctx context.Context, opts FlowOptions) bool {
	metric := s.flowMetricName()
	base := beylaJobSelector() + beylaUnknownDirectionProbe

	// Rate-filtered, not a bare series count. Beyla keeps emitting a series after
	// its traffic stops, and a zero-rate unknown-direction series was observed for
	// plain TCP — counting series would announce hidden traffic on a cluster that
	// has none. `> 0` is the same bar parseL4Flows applies to a flow.
	//
	// Scoped the way beylaRateQuery scopes flows — either end of the conversation
	// inside the namespace — so the warning describes the traffic the user is
	// actually looking at. Filtering on the source alone would both miss inbound
	// traffic and report traffic the user cannot see.
	rated := func(extra string) string {
		return fmt.Sprintf(`count(rate(%s{%s%s}[5m]) > 0)`, metric, base, extra)
	}
	query := rated("")
	if opts.Namespace != "" {
		query = rated(fmt.Sprintf(`, k8s_src_namespace=%q`, opts.Namespace)) + " or " +
			rated(fmt.Sprintf(`, k8s_dst_namespace=%q`, opts.Namespace))
	}
	key := metric + "|" + base + "|" + opts.Namespace

	if cached, ok := s.cachedUnorientable(key); ok {
		return cached
	}

	found := false
	qr, err := s.query(ctx, query)
	if err != nil {
		// Not cached: a failed probe is not an answer, and the next poll may get one.
		return false
	}
	if qr != nil {
		for _, series := range qr.Series {
			for _, point := range series.DataPoints {
				if point.Value > 0 {
					found = true
				}
			}
		}
	}
	s.storeUnorientable(key, found)
	return found
}

func (s *BeylaSource) cachedUnorientable(key string) (bool, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	asOf, ok := s.unorientableAsOf[key]
	if !ok || time.Since(asOf) > beylaUnorientableTTL {
		return false, false
	}
	return s.unorientable[key], true
}

func (s *BeylaSource) storeUnorientable(key string, found bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unorientable == nil {
		s.unorientable = make(map[string]bool)
		s.unorientableAsOf = make(map[string]time.Time)
	}
	// The key includes the namespace, so a user browsing namespace by namespace
	// adds an entry each time. Dropping the expired ones on write keeps that
	// bounded by what is actually in use rather than by everything ever asked for.
	for k, asOf := range s.unorientableAsOf {
		if time.Since(asOf) > beylaUnorientableTTL {
			delete(s.unorientableAsOf, k)
			delete(s.unorientable, k)
		}
	}
	s.unorientable[key] = found
	s.unorientableAsOf[key] = time.Now()
}

func (s *BeylaSource) queryL7(ctx context.Context, opts FlowOptions) ([]Flow, error) {
	query := beylaL7RateQuery(opts.Namespace)
	result, err := s.query(ctx, query)
	if err != nil {
		return nil, err
	}
	return s.parseL7Flows(result), nil
}

// parseL4Flows turns network-flow series into deduplicated flows, keyed while the
// labels are still in hand — the raw transport value and the owner types needed
// to resolve a collision are not carried on Flow. It also reports which optional
// attributes the scrape included.
func (s *BeylaSource) parseL4Flows(result *prom.QueryResult) (map[l4Key]*Flow, l4LabelPresence) {
	flows := make(map[l4Key]*Flow)
	var presence l4LabelPresence
	if result == nil {
		return flows, presence
	}
	for _, series := range result.Series {
		labels := series.Labels
		if len(series.DataPoints) == 0 {
			continue
		}
		val := series.DataPoints[0].Value
		if val <= 0 {
			continue
		}

		if labels["dst_port"] != "" {
			presence.port = true
		}
		if labels["transport"] != "" {
			presence.transport = true
		}

		srcName := pickLabel(labels, "k8s_src_owner_name", "k8s_src_name")
		srcNs := labels["k8s_src_namespace"]
		srcType := pickLabel(labels, "k8s_src_owner_type", "k8s_src_type")
		dstName := pickLabel(labels, "k8s_dst_owner_name", "k8s_dst_name")
		dstNs := labels["k8s_dst_namespace"]
		dstType := pickLabel(labels, "k8s_dst_owner_type", "k8s_dst_type")
		port := parseIntLabel(labels["dst_port"])

		// A nameless endpoint renders as an anonymous node the UI can't resolve
		// or navigate to, so drop the series rather than emit a phantom.
		if srcName == "" || dstName == "" {
			continue
		}

		flow := &Flow{
			Source:      Endpoint{Name: srcName, Namespace: srcNs, Kind: mapBeylaKind(srcType), Workload: srcName},
			Destination: Endpoint{Name: dstName, Namespace: dstNs, Kind: mapBeylaKind(dstType), Workload: dstName, Port: port},
			Protocol:    mapBeylaTransport(labels["transport"]),
			Port:        port,
			Verdict:     "forwarded",
			LastSeen:    time.Now(),
			BytesSent:   int64(val * beylaRateWindowSeconds),
			Connections: 1,
		}

		if flow.Source.Namespace == "" && flow.Source.Name != "" {
			flow.Source.Kind = "External"
		}
		if flow.Destination.Namespace == "" && flow.Destination.Name != "" {
			flow.Destination.Kind = "External"
		}

		key := l4Key{
			srcNs: srcNs, srcName: srcName,
			dstNs: dstNs, dstName: dstName,
			dstPort: port, transport: labels["transport"],
		}
		if existing, ok := flows[key]; ok {
			flows[key] = preferL4(existing, flow)
			continue
		}
		flows[key] = flow
	}
	return flows, presence
}

// parseL7Flows reads http_server_request_duration_seconds_count series. The
// metric is server-side only, so Source is left empty here — getFlowsInternal
// attaches the caller identity from the matching L4 flow(s) instead. Port comes
// from server_port and is what the join keys on.
func (s *BeylaSource) parseL7Flows(result *prom.QueryResult) []Flow {
	if result == nil {
		return nil
	}
	flows := make([]Flow, 0, len(result.Series))
	for _, series := range result.Series {
		labels := series.Labels
		if len(series.DataPoints) == 0 {
			continue
		}
		val := series.DataPoints[0].Value
		if val <= 0 {
			continue
		}

		dstNs := labels["k8s_namespace_name"]
		dstName, dstKind := pickBeylaOwner(labels)
		if dstName == "" {
			continue
		}
		port := parseIntLabel(labels["server_port"])

		flow := Flow{
			Destination: Endpoint{Name: dstName, Namespace: dstNs, Kind: dstKind, Workload: dstName, Port: port},
			Port:        port,
			L7Protocol:  "HTTP",
			HTTPMethod:  labels["http_request_method"],
			HTTPPath:    labels["http_route"],
			HTTPStatus:  parseIntLabel(labels["http_response_status_code"]),
			Verdict:     "forwarded",
			LastSeen:    time.Now(),
			// val is a per-second request rate over a 5m window, not a
			// connection count; Connections here is only a non-zero weight for
			// downstream aggregation.
			RequestRate: val,
			Connections: max(int64(val*beylaRateWindowSeconds), 1),
		}

		flows = append(flows, flow)
	}
	return flows
}

// pickBeylaOwner resolves the destination workload name Beyla attached to an
// HTTP server-duration series. k8s_owner_name is Beyla's own resolved owner —
// the same value the network-flow metric exposes as k8s_dst_owner_name — so L7
// results line up with L4 destinations for the same workload; a bare Pod (no
// owner) falls back to its pod name.
func pickBeylaOwner(labels map[string]string) (name, kind string) {
	switch {
	case labels["k8s_owner_name"] != "":
		return labels["k8s_owner_name"], "Workload"
	case labels["k8s_pod_name"] != "":
		return labels["k8s_pod_name"], "Pod"
	default:
		return "", ""
	}
}

func pickLabel(labels map[string]string, keys ...string) string {
	for _, k := range keys {
		if v, ok := labels[k]; ok && v != "" {
			return v
		}
	}
	return ""
}

func parseIntLabel(s string) int {
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return v
}

func mapBeylaKind(beylaType string) string {
	switch strings.ToLower(beylaType) {
	case "pod":
		return "Pod"
	case "deployment", "replicaset", "statefulset", "daemonset":
		return "Workload"
	case "service":
		return "Service"
	default:
		return "Pod"
	}
}

func mapBeylaTransport(transport string) string {
	switch strings.ToUpper(transport) {
	case "TCP":
		return "tcp"
	case "UDP":
		return "udp"
	default:
		return "tcp"
	}
}

func (s *BeylaSource) StreamFlows(ctx context.Context, opts FlowOptions) (<-chan Flow, error) {
	flowCh := make(chan Flow, 100)
	go func() {
		defer close(flowCh)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Streams carry flows only — there is nowhere to put a warning on
				// this channel — so skip the diagnostics probe rather than run it
				// every tick and discard the result. The REST poll behind the same
				// view reports it.
				flows, _, err := s.getFlowsInternal(ctx, opts, false)
				if err != nil {
					log.Printf("[beyla] Error fetching flows: %v", err)
					continue
				}
				response := &FlowsResponse{Flows: flows}
				for _, flow := range response.Flows {
					select {
					case flowCh <- flow:
					case <-ctx.Done():
						return
					default:
					}
				}
			}
		}
	}()
	return flowCh, nil
}
