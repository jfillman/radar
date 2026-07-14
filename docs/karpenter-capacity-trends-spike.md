# Karpenter capacity trends feasibility

Status: converged recommendation, 2026-07-14

## Decision

Build Radar-native history for provisioned capacity, configured limits, and fleet size. Do not build Prometheus-backed posture or full utilization trends yet.

The native surface is available on supported Karpenter NodePool APIs whenever NodePools are readable and gives Radar Cloud a normalized fleet-history contract. It must be described as **provisioned capacity and configured-limit history**, not actual utilization. Values from NodePool status are exact copies of controller-reported state at the time Radar observed them; they are not claims about the instant physical state of the fleet.

| Option | Trustworthiness | Availability | Effort | Decision |
| --- | --- | --- | --- | --- |
| Radar-native posture history | High: exact controller-reported configuration/status with UID epochs | Supported NodePool APIs when NodePools are readable | M | Build next |
| Prometheus posture trends | Medium: version and identity caveats | No query backend on any test cluster | M–L | Defer |
| Reservation and actual-usage trends | Low-to-medium portability | Requires nonstandard joins and scrape configuration | L | Do not pursue locally now |
| Radar Cloud normalized history | High when fed native snapshots | Commercial fleet service | Follow-up | Build on the native contract |

## Evidence

Read-only inspection covered `radar-test-management`, `radar-test-prod`, and `radar-test-nonprod`.

- All three clusters run Karpenter 1.9.0, metrics-server, kube-state-metrics, and ADOT.
- None exposes a queryable Prometheus or VictoriaMetrics backend, Prometheus Operator CRDs, Karpenter scrape annotations, or an enabled ServiceMonitor.
- ADOT is configured for CloudWatch Container Insights rather than a Prometheus query service.
- `radar-test-nonprod` contains six varied NodePools, seven Karpenter nodes, and seven NodeClaims, including healthy, broken, and empty configurations.
- Live `karpenter_nodepools_usage` values matched NodePool `status.resources`; `karpenter_nodepools_limit` matched `spec.limits`.

Radar's existing history paths cannot reconstruct these series:

- `pkg/k8score/metrics_history.go` retains one hour in memory, keys samples by node name, and removes vanished-node buffers after five minutes.
- Generic timeline diffs record ordinary numeric CRD changes as `changed`; they do not retain the old and new quantities or an initial baseline.
- Timeline identity can help correlate resource lifecycles, but it is not a numeric time-series store.

Prometheus has additional correctness constraints:

- In the inspected Karpenter 1.9.0 deployment, state gauges were exported only by the leader. A future implementation must verify this for each supported version and deduplicate controller replicas with `max by (...)`, never sum them.
- Karpenter v0.37 used singular metric names such as `karpenter_nodepool_usage`; v1 uses plural names such as `karpenter_nodepools_usage`.
- `karpenter_nodes_total_pod_requests` changed semantics across the v1 boundary: older versions excluded DaemonSets and emitted them separately, while current versions include them. A metric-name union would not normalize reservation history.
- Prometheus labels NodePools by name rather than UID, so delete-and-recreate under one name appears as a continuous series.
- The inspected kube-state-metrics deployment did not expose the `karpenter.sh/nodepool` node label because no metric-label allowlist was configured, preventing a reliable Node-to-NodePool join there.
- Node exporter and cAdvisor identity labels depend on deployment-specific relabeling, so actual-usage joins are not portable.
- The live Karpenter leader endpoint exposed roughly 60,000 samples and 8 MB per scrape, while only about 146 observed series were relevant to Capacity. A 15-second unfiltered scrape would process roughly 345 million sample observations per day.
- Current Karpenter NodePool usage and limit metrics are Alpha, so their names and semantics are not a durable Radar contract.
- Without a live query backend, latency, retention, staleness, and gap behavior could not be benchmarked.

The native decision is scoped to releases for which Radar discovers the NodePool and NodeClaim APIs; it does not add support for the older Provisioner API. Implementation fixtures must pin the source paths and semantics of `spec.limits`, `status.resources`, UID, generation, and readiness conditions on Karpenter v0.37, v1.0, and the current supported release. A mismatch narrows the advertised version range; it must not be papered over with a guessed legacy fallback.

Upstream references:

- [Current Karpenter metrics](https://karpenter.sh/docs/reference/metrics/)
- [Karpenter v1 metric migration](https://karpenter.sh/v1.0/upgrading/v1-migration/)
- [Karpenter 0.37 metrics](https://github.com/aws/karpenter-provider-aws/blob/v0.37.7/website/content/en/docs/reference/metrics.md)
- [kube-state-metrics node-label allowlisting](https://github.com/kubernetes/kube-state-metrics/blob/main/docs/metrics/cluster/node-metrics.md)
- [Prometheus stale-series semantics](https://prometheus.io/docs/prometheus/2.55/querying/basics/#staleness)

## Native data model

Add a dedicated `capacityhistory.Store`; do not encode snapshots as timeline events. Its API types belong in `pkg/capacityapi` and reuse the existing `ResponseMeta`, `ResourceIdentity`, `QuantityObservation`, `Certainty`, `Granularity`, and `CoverageBySource` vocabulary rather than introducing a parallel envelope.

Authoritative sources:

- Configured ceiling: NodePool `spec.limits`
- Provisioned capacity: NodePool `status.resources`
- Controller-reported fleet size: the `nodes` entry in NodePool `status.resources`, when present, exposed as `controllerReportedNodes`
- Configuration and readiness annotations: UID, generation, Ready condition, and spec fingerprint

Coverage-dependent derived sources:

- Discovered fleet size: the existing Node-to-NodePool resolver, exposed as `observedAssignedNodes` with Node source coverage
- Claim count: the existing NodeClaim-to-NodePool resolver, exposed as `observedClaims` with NodeClaim source coverage

`controllerReportedNodes` and `observedAssignedNodes` are intentionally distinct. They may disagree because they describe different observers; neither may silently replace the other. Actual CPU or memory usage, pod reservations, cost, and Prometheus data are outside this store.

Persistent rows use a stable `cluster_key`, not a kubeconfig context name. For local Radar, derive it consistently from a non-exported hash of the canonical API server URL and CA material available in the cluster connection; a context rename therefore keeps its history, while repointing the context starts a new history. When readable, retain the `kube-system` Namespace UID as a mismatch detector rather than switching identity strategies. `ResponseMeta.ClusterContext` remains the display context. Radar Cloud replaces the local key with its registered cluster ID.

Collection semantics:

1. Capture an initial baseline only after the relevant caches synchronize.
2. Recompute affected pools after NodePool, NodeClaim, or assigned-Node changes, with a short debounce.
3. Persist a snapshot only when its semantic fingerprint changes within one continuous observation segment. Always write a new baseline after a process restart, source-coverage transition, or observation gap, even when the value matches the preceding snapshot.
4. Treat NodePool UID as the epoch identity. Recreating a name with a new UID starts a new epoch.
5. Persist an observed deletion tombstone. It closes the epoch at Radar's observation time. If deletion occurred while Radar was down, keep the old epoch's end time unknown and mark it `unknown_after_gap`; do not infer a deletion timestamp from the replacement object's creation time.
6. Maintain lightweight observation-segment heartbeats so an unchanged series can be distinguished from Radar downtime. Close a segment and start another whenever source coverage changes.
7. `asOf` means the time Radar observed the object or derived aggregate. Kubernetes objects do not provide the historical instant at which an arbitrary status quantity changed. Initial baselines must not be backdated, and recomputes across independently watched sources are not atomic.
8. Carry a value forward only inside a continuous observation segment. Represent process downtime and source loss as explicit gaps, never as zero, interpolation, or evidence that the value stayed unchanged.
9. Preserve exact Kubernetes quantity strings. A normalized floating-point value may be included for charting but is never authoritative.

Suggested persistent schema:

```text
capacity_pool_epochs(
  cluster_key,
  pool_uid,
  pool_name,
  api_version,
  first_observed_at,
  deletion_observed_at,
  end_reason
)

capacity_pool_snapshots(
  cluster_key,
  pool_uid,
  collector_session_id,
  observed_at,
  fingerprint,
  payload_json
)

capacity_observation_segments(
  cluster_key,
  segment_id,
  collector_session_id,
  started_at,
  last_heartbeat_at,
  ended_at,
  coverage_json
)
```

Use primary keys on `(cluster_key, pool_uid)` for epochs and `(cluster_key, pool_uid, observed_at)` for snapshots. Index epochs by `(cluster_key, pool_name)` and snapshots by `(cluster_key, pool_uid, observed_at)`.

The default memory implementation is session-only and retains at most 10,000 capacity-history records across snapshots, tombstones, and observation segments. It prunes records from oldest closed epochs first and then oldest active-epoch snapshots while retaining a valid anchor. SQLite uses separate tables when persistent timeline storage is enabled and participates in the configured timeline retention and database-size budgets: seven days and 1 GiB by default. Age and size pruning must include capacity rows, retain one pre-cutoff anchor per surviving series when it is inside the same observation segment, and remove orphaned epochs and segments. A long-running or flapping pool therefore cannot grow either store without bound.

## API contract

Use one bounded batch endpoint rather than per-pool frontend requests:

```http
GET /api/capacity/trends?range=24h
GET /api/capacity/trends?range=7d&pool=spot-flex
GET /api/capacity/trends?range=24h&poolUID=pool-uid
```

The first release accepts `1h`, `6h`, `24h`, and `7d`. `pool=<name>` intentionally returns every UID epoch observed under that name. `poolUID=<uid>` selects one exact epoch and is the filter for a current-pool detail page. When both are present they must identify the same pool or the server returns `400`.

The response embeds the existing `capacityapi.ResponseMeta` fields at the top level. `state` retains the existing `IntegrationState` vocabulary; source partiality belongs in `ResponseMeta.Coverage`, series certainty, and gaps rather than a second integration-state enum.

Radar does not backfill data from before collection began. `window.complete` is true only when all requested, currently authorized series were observed across the complete requested window. `coveredStart` and `coveredEnd` are nullable when no history exists. Clients must show “Observed by Radar since …” whenever the requested window is incomplete.

Proposed response:

```json
{
  "schemaVersion": "v1alpha1",
  "generatedAt": "2026-07-14T16:00:00Z",
  "clusterContext": {
    "contextName": "radar-test-nonprod",
    "clusterName": "radar-test-nonprod"
  },
  "provider": {
    "type": "karpenter",
    "controllerMode": "self_managed",
    "apiVersionsByKind": {
      "NodePool": ["v1"]
    },
    "nodeClassKinds": [],
    "features": {}
  },
  "coverage": {
    "nodePools": {
      "status": "available",
      "scope": "cluster",
      "observedAt": "2026-07-14T16:00:00Z",
      "observationStart": "2026-07-14T10:00:00Z",
      "impactFields": ["configuredLimit", "provisioned", "controllerReportedNodes"]
    },
    "nodes": {
      "status": "available",
      "scope": "cluster",
      "observedAt": "2026-07-14T16:00:00Z",
      "observationStart": "2026-07-14T10:00:00Z",
      "impactFields": ["observedAssignedNodes"]
    }
  },
  "state": "available",
  "source": {
    "type": "radar_native",
    "observationMode": "transition",
    "observationStart": "2026-07-14T10:00:00Z",
    "retention": {
      "mode": "memory",
      "oldestAt": "2026-07-14T10:00:00Z"
    }
  },
  "window": {
    "requestedStart": "2026-07-13T16:00:00Z",
    "requestedEnd": "2026-07-14T16:00:00Z",
    "coveredStart": "2026-07-14T10:00:00Z",
    "coveredEnd": "2026-07-14T16:00:00Z",
    "complete": false
  },
  "epochs": [
    {
      "pool": {
        "ref": {
          "group": "karpenter.sh",
          "kind": "NodePool",
          "name": "spot-flex"
        },
        "apiVersion": "karpenter.sh/v1",
        "uid": "pool-uid"
      },
      "firstObservedAt": "2026-07-14T10:00:00Z",
      "endState": "active",
      "endedAt": null,
      "series": [
        {
          "metric": "provisioned",
          "resource": "cpu",
          "unit": "cores",
          "semantics": "controller_reported_provisioned",
          "sourcePaths": ["nodepool.status.resources"],
          "granularity": "aggregate",
          "points": [
            {
              "asOf": "2026-07-14T10:00:00Z",
              "state": "value",
              "quantity": "3500m",
              "normalizedValue": 3.5,
              "certainty": "exact",
              "sources": ["nodepool.status.resources"]
            }
          ]
        }
      ],
      "annotations": [
        {
          "at": "2026-07-14T12:00:00Z",
          "type": "configuration_change",
          "generation": 2
        }
      ]
    }
  ],
  "gaps": [
    {
      "scope": "collector",
      "source": "nodePools",
      "start": "2026-07-13T16:00:00Z",
      "end": "2026-07-14T10:00:00Z",
      "reasonCode": "not_observed_before_radar_start"
    },
    {
      "scope": "collector",
      "start": "2026-07-14T13:00:00Z",
      "end": "2026-07-14T13:10:00Z",
      "reasonCode": "collector_not_observing"
    }
  ],
  "resolution": {
    "maxPointsPerSeries": 2000,
    "downsampled": false
  }
}
```

Each series and trend point reuse the semantics of `QuantityObservation`: `asOf`, exact Kubernetes quantity strings, `certainty`, `sources`, and `granularity`. Granularity is fixed at the series level. A point adds `state` and an optional chart value:

- `value`: the source was observed and the metric has a value. Zero is represented as `state: "value"` with `quantity: "0"`.
- `absent`: the source was observed and a structurally optional value was not configured. In the first release this is used for a missing `spec.limits` resource key and means no ceiling was configured; it is not zero.
- `unknown`: the source was denied, syncing, unavailable, or outside an observation segment. It has no quantity and carries a `reasonCode`; its certainty is `unknown`.

An absent configured limit carries `exact` certainty because the complete NodePool spec was observed. For provisioned capacity, an absent `status.resources` field is `unknown`; when the field is present, a missing resource key follows Kubernetes `ResourceList` arithmetic and is a known zero. A fully observed empty Node or NodeClaim set is likewise a known zero count.

`quantity` is authoritative. `normalizedValue` is an optional floating-point chart projection in the series unit and must not be used to reconstruct the Kubernetes value. Coverage-dependent counts use `exact`, `lower_bound`, or `unknown` according to the existing Capacity certainty rules; a later permission or coverage improvement must not upgrade an older point retroactively.

Contract requirements:

- Return multiple epochs for same-name recreation. `endState` is `active`, `deleted`, or `unknown_after_gap`; `endedAt` is present only for an observed deletion.
- Include current source coverage in `ResponseMeta.Coverage` and historical source certainty on every point.
- Return explicit gaps for time before Radar began observing, collector downtime, and source-specific loss. Do not carry values across them.
- Cap responses at 2,000 points per series. Above the cap, retain gap boundaries and bucket first/min/max/last values, set `resolution.downsampled`, and never imply that omitted transitions did not occur.
- Return all requested pools in one response; no per-pool fan-out is permitted.

RBAC is evaluated against the current active cluster before reading stored rows:

- Current permission to list NodePools gates the endpoint, matching the existing Capacity capability check. When denied, return `state: "denied"`, denied NodePool coverage, and no epochs.
- Without current permission to list Nodes, omit all `observedAssignedNodes` series and mark Node coverage denied. Do not return previously stored Node-derived values.
- Without current permission to list NodeClaims, omit all `observedClaims` series and mark NodeClaim coverage denied. Do not return previously stored claim-derived values.
- If a source is currently authorized but was partial or unavailable historically, return only the permitted historical series with their original lower-bound or unknown certainty and source gaps.
- Deleted pools are authorized at the current resource-type level because no live object remains on which to perform an object lookup. A request may read only rows whose `cluster_key` matches the active cluster.

## OSS and Radar Cloud placement

Radar OSS owns the normalized collector, bounded memory store, optional local SQLite persistence, per-cluster API, and single-cluster visualization. It is honest about process-local observation, cold starts, retention, coverage, and gaps; it does not require Prometheus and it does not deliberately degrade local history to create a commercial boundary.

Radar Cloud builds on the same `pkg/capacityapi` contract but owns the fleet-level value:

- Registered cluster identity and an always-on collection or ingestion path
- Longer product retention, such as 30- or 90-day windows
- Cross-cluster and organization-wide pool comparisons and rollups
- Correlation of configuration changes, readiness changes, and fleet movement across clusters
- Organization RBAC, auditability, and fleet-level operational signals

The Cloud ingestion transport, durable multi-tenant store, retention policy, and fleet APIs are a separately estimated follow-up. They are not hidden inside the native M estimate. Cloud should ingest normalized posture transitions, not raw Karpenter or Prometheus series.

## Delivery estimate and gate

A thin OSS end-to-end implementation is approximately 2.5 to 3.5 engineering weeks when performed sequentially:

- Store, collection lifecycle, and retention: 6–8 days
- API, RBAC, gap and epoch semantics, and tests: 3–5 days
- Thin chart integration: 3–5 days

Acceptance tests must cover:

- Karpenter v0.37, v1.0, and current supported NodePool source shapes
- Initial sync, no-backfill cold start, unchanged observation segments, process downtime, and source loss
- Explicit value, zero, absent, and unknown point states
- Observed deletion, deletion during downtime, and recreation under one name with a new UID
- Stable cluster identity when a display context is renamed or repointed
- Distinct controller-reported and resolver-observed Node counts
- Age and size pruning while preserving valid anchors and gap boundaries
- Current RBAC revocation and source-by-source omission of Node and NodeClaim history
- A seven-day fixture with at least 1,000 pools, bounded to 2,000 points per series and returned in under ten seconds without frontend fan-out

This spike approves the native architecture as the next scoped implementation; it does not silently expand the current Capacity change set or include the Radar Cloud follow-up. Prometheus remains an optional enrichment only after real Prometheus fixtures establish availability, bounded-query performance, UID behavior, and version-normalization rules. Full actual-usage history should not be promised in local Radar in the near term.
