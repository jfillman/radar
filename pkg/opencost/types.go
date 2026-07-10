package opencost

// Unavailability reasons — returned in the "reason" field when available=false
// so the frontend can show contextual guidance to the user.
const (
	ReasonNoPrometheus = "no_prometheus" // Prometheus/VictoriaMetrics not found in cluster
	ReasonNoMetrics    = "no_metrics"    // Prometheus found but OpenCost metrics not present
	ReasonQueryError   = "query_error"   // Prometheus found but cost queries failed
)

// CostSummary is the response for the /api/opencost/summary endpoint.
type CostSummary struct {
	Available         bool            `json:"available"`
	Reason            string          `json:"reason,omitempty"` // Set when available=false: no_prometheus, no_metrics, query_error
	Currency          string          `json:"currency,omitempty"`
	Window            string          `json:"window,omitempty"`
	TotalHourlyCost   float64         `json:"totalHourlyCost,omitempty"`
	TotalStorageCost  float64         `json:"totalStorageCost,omitempty"`
	TotalNetworkCost  float64         `json:"totalNetworkCost,omitempty"`
	TotalIdleCost     float64         `json:"totalIdleCost,omitempty"`
	ClusterEfficiency float64         `json:"clusterEfficiency,omitempty"` // 0-100
	Namespaces        []NamespaceCost `json:"namespaces,omitempty"`
}

// NamespaceCost holds per-row cost breakdown. The name reflects the
// default aggregation; the struct is also used for controller and pod
// rows — Kind disambiguates (empty = namespace).
type NamespaceCost struct {
	Name            string  `json:"name"`
	Kind            string  `json:"kind,omitempty"`      // "namespace" (default if empty) | "controller" | "pod"
	Namespace       string  `json:"namespace,omitempty"` // populated for controller/pod rows
	HourlyCost      float64 `json:"hourlyCost"`
	CPUCost         float64 `json:"cpuCost"`
	MemoryCost      float64 `json:"memoryCost"`
	StorageCost     float64 `json:"storageCost,omitempty"`
	NetworkCost     float64 `json:"networkCost,omitempty"`
	CPUUsageCost    float64 `json:"cpuUsageCost,omitempty"`
	MemoryUsageCost float64 `json:"memoryUsageCost,omitempty"`
	Efficiency      float64 `json:"efficiency,omitempty"` // 0-100
	IdleCost        float64 `json:"idleCost,omitempty"`
}

// WorkloadCostResponse is the response for the /api/opencost/workloads endpoint.
type WorkloadCostResponse struct {
	Available bool           `json:"available"`
	Reason    string         `json:"reason,omitempty"`
	Namespace string         `json:"namespace"`
	Workloads []WorkloadCost `json:"workloads"`
}

// WorkloadCostDetailResponse is the focused current-cost response for one workload.
type WorkloadCostDetailResponse struct {
	Available bool          `json:"available"`
	Reason    string        `json:"reason,omitempty"`
	Namespace string        `json:"namespace"`
	Kind      string        `json:"kind"`
	Name      string        `json:"name"`
	Current   *WorkloadCost `json:"current,omitempty"`
}

// WorkloadCost holds per-workload cost breakdown within a namespace.
type WorkloadCost struct {
	Name            string  `json:"name"`
	Kind            string  `json:"kind"` // Deployment, StatefulSet, DaemonSet, Job, standalone
	HourlyCost      float64 `json:"hourlyCost"`
	CPUCost         float64 `json:"cpuCost"`
	MemoryCost      float64 `json:"memoryCost"`
	Replicas        int     `json:"replicas"`
	CPUUsageCost    float64 `json:"cpuUsageCost,omitempty"`
	MemoryUsageCost float64 `json:"memoryUsageCost,omitempty"`
	Efficiency      float64 `json:"efficiency,omitempty"` // 0-100
	IdleCost        float64 `json:"idleCost,omitempty"`
}

// CostTrendResponse is the response for the /api/opencost/trend endpoint.
type CostTrendResponse struct {
	Available bool              `json:"available"`
	Reason    string            `json:"reason,omitempty"`
	Range     string            `json:"range"`
	Series    []CostTrendSeries `json:"series,omitempty"`
}

// WorkloadCostTrendResponse is the focused historical cost response for one workload.
type WorkloadCostTrendResponse struct {
	Available       bool            `json:"available"`
	Reason          string          `json:"reason,omitempty"`
	Namespace       string          `json:"namespace"`
	Kind            string          `json:"kind"`
	Name            string          `json:"name"`
	Range           string          `json:"range"`
	WindowTotalCost float64         `json:"windowTotalCost,omitempty"`
	DataPoints      []CostDataPoint `json:"dataPoints,omitempty"`
}

// ApplicationWorkloadRef identifies one workload included in an application
// cost request.
type ApplicationWorkloadRef struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// ApplicationWorkloadCostInput carries server-validated metadata used to
// aggregate current app cost.
type ApplicationWorkloadCostInput struct {
	ApplicationWorkloadRef
	DesiredReplicas int `json:"desiredReplicas,omitempty"`
}

// ApplicationCostCoverage describes how much of an app's workload set was
// included in a cost response.
type ApplicationCostCoverage struct {
	Total       int                         `json:"total"`
	Included    int                         `json:"included"`
	Unavailable []ApplicationWorkloadStatus `json:"unavailable,omitempty"`
	Unsupported []ApplicationWorkloadRef    `json:"unsupported,omitempty"`
}

// ApplicationWorkloadStatus describes a workload that could not be included in
// the app cost total.
type ApplicationWorkloadStatus struct {
	ApplicationWorkloadRef
	Reason       string `json:"reason"`
	ScaledToZero bool   `json:"scaledToZero,omitempty"`
}

// ApplicationCostTotals holds summed current cost values for included app
// workloads.
type ApplicationCostTotals struct {
	HourlyCost      float64 `json:"hourlyCost"`
	CPUCost         float64 `json:"cpuCost"`
	MemoryCost      float64 `json:"memoryCost"`
	Replicas        int     `json:"replicas"`
	CPUUsageCost    float64 `json:"cpuUsageCost,omitempty"`
	MemoryUsageCost float64 `json:"memoryUsageCost,omitempty"`
	Efficiency      float64 `json:"efficiency,omitempty"`
	IdleCost        float64 `json:"idleCost,omitempty"`
}

// ApplicationWorkloadCost is a current-cost row for one app workload.
type ApplicationWorkloadCost struct {
	ApplicationWorkloadRef
	Available    bool          `json:"available"`
	Reason       string        `json:"reason,omitempty"`
	ScaledToZero bool          `json:"scaledToZero,omitempty"`
	Current      *WorkloadCost `json:"current,omitempty"`
}

// ApplicationCostResponse is the focused current-cost response for an app's
// steady-state workloads.
type ApplicationCostResponse struct {
	Available bool                      `json:"available"`
	Reason    string                    `json:"reason,omitempty"`
	Partial   bool                      `json:"partial,omitempty"`
	Totals    ApplicationCostTotals     `json:"totals"`
	Coverage  ApplicationCostCoverage   `json:"coverage"`
	Workloads []ApplicationWorkloadCost `json:"workloads,omitempty"`
}

// ApplicationCostTrendSeries is one workload's historical cost series.
type ApplicationCostTrendSeries struct {
	ApplicationWorkloadRef
	WindowTotalCost float64         `json:"windowTotalCost,omitempty"`
	DataPoints      []CostDataPoint `json:"dataPoints,omitempty"`
}

// ApplicationCostTrendResponse is the historical cost response for an app's
// steady-state workloads.
type ApplicationCostTrendResponse struct {
	Available       bool                         `json:"available"`
	Reason          string                       `json:"reason,omitempty"`
	Range           string                       `json:"range"`
	Partial         bool                         `json:"partial,omitempty"`
	WindowTotalCost float64                      `json:"windowTotalCost,omitempty"`
	DataPoints      []CostDataPoint              `json:"dataPoints,omitempty"`
	Series          []ApplicationCostTrendSeries `json:"series,omitempty"`
	Coverage        ApplicationCostCoverage      `json:"coverage"`
}

// CostTrendSeries holds cost data points for a single namespace.
type CostTrendSeries struct {
	Namespace  string          `json:"namespace"`
	DataPoints []CostDataPoint `json:"dataPoints"`
}

// CostDataPoint is a single (timestamp, value) pair for cost trends.
type CostDataPoint struct {
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
}

// NodeCostResponse is the response for the /api/opencost/nodes endpoint.
type NodeCostResponse struct {
	Available bool       `json:"available"`
	Reason    string     `json:"reason,omitempty"`
	Nodes     []NodeCost `json:"nodes,omitempty"`
}

// NodeCost holds per-node cost breakdown.
type NodeCost struct {
	Name         string  `json:"name"`
	InstanceType string  `json:"instanceType,omitempty"`
	Region       string  `json:"region,omitempty"`
	HourlyCost   float64 `json:"hourlyCost"`
	CPUCost      float64 `json:"cpuCost"`
	MemoryCost   float64 `json:"memoryCost"`
}
