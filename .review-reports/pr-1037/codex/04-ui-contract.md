# PR #1037 review: UI, package contract, and cross-layer seams

## Scope

- Base: `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- PR head: `d1face5b31572eb94afcd29920b93684f42281d3`
- Primary areas: `web/src/components/workload/WorkloadView.tsx`, `web/src/api/client.ts`, `web/package.json`, and the new `packages/k8s-ui/src/components/trace/` surface.
- Cross-layer seams checked where needed: trace REST routes, capability responses, in-cluster consent identity, and probe-path projection into the topology graph.
- Reference contracts read first: `DESIGN.md`, `web/src/index.ts`, `web/src/RadarApp.tsx`, `web/src/api/config.ts`, and both package manifests.
- Review was read-only against the exact Git objects. No source or test changes were made.

## Altitude assessment

The UI direction is useful: one resource-focused Reachability tab, a path diagram, explicit vantage labels, and a deliberate confirmation before creating a probe Job. The problem is that the frontend currently treats a completed probe response as a replacement resource snapshot rather than timestamped evidence layered onto the current resource state. That breaks the core product promise during the most common workflow: leave the tab open while fixing the cluster.

There are also two library/embedding problems that matter because `web/` is the published `@skyhook-io/radar-app` package and Radar Hub is a known consumer. The PR compiles in this monorepo because the workspace supplies the matching `k8s-ui` source, but its declared peer range permits an older package that has none of the new trace exports. Separately, the “per-cluster” consent key uses a value that is literally identical across all in-cluster/Cloud Radar instances.

The graph code has the same evidence-model leak as the backend reducers: route-level logic correctly treats an API-server-only failure as indirect, then raw hop probes bypass that guard and recolor the node red.

## Findings

### 1. High: the first probe result permanently masks all subsequently polled static state

Locations:

- `web/src/components/workload/WorkloadView.tsx:963-1013`
- `web/src/components/workload/WorkloadView.tsx:1023-1049`
- `web/src/components/workload/WorkloadView.tsx:1082-1088`
- `web/src/components/workload/WorkloadView.tsx:1123-1140`
- `web/src/api/client.ts:408-419`

`useTrace` deliberately polls the static trace every five seconds. Opening the Reachability tab also auto-runs the one-shot proxy probe. Once that response arrives, `probeTrace` remains set until the resource identity changes or the operator changes the tested path. `baseTrace = probeTrace ?? staticTrace` therefore hides every later static poll for the same resource.

This is the normal incident workflow, not an edge case:

1. Open Reachability while a Service has zero endpoints or a route is misconfigured.
2. The auto-run stores that broken snapshot in `probeTrace`.
3. Fix the Deployment, selector, Service port, Gateway attachment, or NetworkPolicy.
4. The static query sees the new state every five seconds, but the screen continues to show the old topology, findings, readiness, routes, and verdict indefinitely.

The inverse is equally dangerous: a previously green probed snapshot can hide a new zero-ready outage or config regression. The comment at lines 963-966 says the static trace remains the source of truth, but the selection order makes the probe snapshot the source of truth. The `useInClusterTest` reset is based on `base`; while `probeTrace` is present, a changed `staticTrace` does not change `base`, so the final in-cluster snapshot can mask updates as well.

Concrete fix:

- Model probe observations as timestamped evidence separate from the latest static trace; never replace the resource/topology snapshot with the response that happened to carry the observations.
- Give the trace a stable subject identity/generation (UID/resourceVersion or an equivalent server generation) and only overlay probe evidence onto the generation it tested.
- At minimum, invalidate the probed/in-cluster snapshot when a materially different static trace arrives and show “cluster state changed; rerun to refresh live evidence.”
- Add an integration test that delivers static A, probed A, then static B for the same resource and asserts that B's routes/readiness/findings become visible without navigation or a manual rerun.

### 2. High for the published package: `radar-app` still accepts `k8s-ui` versions that do not export any of the new symbols it imports

Locations:

- `web/package.json:41-43`
- `web/src/components/workload/WorkloadView.tsx:41`
- `web/src/api/client.ts:406`
- `packages/k8s-ui/src/index.ts:43-46`
- `packages/k8s-ui/src/components/trace/index.ts:1-9`

The PR adds and immediately imports `ReachabilityView`, `TraceSummary`, `InClusterConsentDialog`, `Trace`, `InClusterRunner`, `InClusterCapability`, and `inClusterConsentGiven` from `@skyhook-io/k8s-ui`. None exists at the base commit. Yet `@skyhook-io/radar-app` still declares `"@skyhook-io/k8s-ui": ">=1.7.3"`.

The monorepo hides the incompatibility because its dev dependency is `"*"` and Vite aliases directly to the workspace source. A downstream source-package consumer can legally resolve the published Radar app with any existing `k8s-ui >=1.7.3`; TypeScript then cannot resolve the named exports (or the browser gets missing ESM exports). This directly affects the documented Radar Hub embedding contract.

Concrete fix:

- Publish the `k8s-ui` version containing the trace surface first.
- Raise `web/package.json`'s minimum peer dependency to that exact first compatible version, then publish `radar-app`.
- Verify the packed packages in a clean consumer fixture using the minimum declared peer version, not workspace aliases.
- Treat the added `WorkloadTabType` member as a public type change in release notes; exhaustive downstream `Record<WorkloadTabType, ...>` mappings will need an entry.

### 3. Medium: an API-server-only failure can still paint a resource red through `nodeOwnStatus`

Locations:

- `packages/k8s-ui/src/components/trace/traceToSubgraph.ts:4-27`
- `packages/k8s-ui/src/components/trace/traceToSubgraph.ts:103-130`
- `packages/k8s-ui/src/components/trace/traceToSubgraph.ts:257-321`
- `pkg/probe/probe.go:565-664`

The route projection explicitly says an `unreachable` result with `confidence === 'indirect'` must be unknown, and the router reduction excludes those results from hard failures. However, `nodeOwnStatus` ignores both `confidence` and `ProbeResult.path`. Any non-skipped failed probe is bad; if it is the only live probe the node becomes `unhealthy`.

That reintroduces the exact false alarm the surrounding code tries to prevent. `proxyResult` can produce a non-skipped failure when the API-server proxy could not relay to a backend. The route remains correctly indirect/unknown, but the same raw `path: 'apiserver'` result is attached to the hop. For a subject hop, `ownFloor` then overrides the route-derived unknown with red; downstream hops are colored red directly.

The existing tests cover proxy-only success and an indirect-unreachable route without a failed hop probe, so they do not exercise this seam.

Concrete fix:

- Reduce node status with the same evidence hierarchy as the route: a proxy-only failure is localization/unknown, not proof of the resource's own failed health.
- A non-proxy failure may condemn; a proxy success may prove the resource answered; mixed vantages need an explicit deterministic reducer.
- Add a regression test whose only hop probe is `{path: 'apiserver', ok: false, skipped: false}` and whose route is `unreachable/indirect`; both subject and downstream nodes must remain unknown unless an independent own-health finding exists.

### 4. Medium safety regression: “don't ask again for this cluster” is global across all in-cluster/Cloud clusters

Locations:

- `packages/k8s-ui/src/utils/inClusterConsent.ts:1-20`
- `packages/k8s-ui/src/components/ui/InClusterConsentDialog.tsx:13-50`
- `internal/server/reachability_run.go:38-52`
- `internal/k8s/client.go:135-140`
- `internal/k8s/client.go:630-635`

The consent helper stores `radar.inClusterConsent.${cluster}` and the dialog promises “Don't ask again for this cluster.” The server supplies `cluster: k8s.GetContextName()`. Every true in-cluster bootstrap sets that context name to the literal `"in-cluster"`.

For Radar Hub or another same-origin host embedding more than one cluster, accepting the warning once suppresses it for every in-cluster/Cloud Radar backend on that origin. The UI can then create a Job in a different production cluster without the cluster-specific confirmation that this feature explicitly introduced as its safety rail. Ordinary kubeconfig context names can collide too; they are labels, not globally stable cluster identities.

This is not an authorization bypass—the POST still enforces Cloud role and Kubernetes RBAC—but it invalidates the user-facing cluster safety promise.

Concrete fix:

- Scope consent by the host's stable cluster identity (for Hub: organization/cluster ID), not kubeconfig context display name.
- If the shared component cannot know that identity, make a `consentScope`/stable cluster ID an explicit host-provided prop and include the API-base identity as a safe fallback.
- Never persist “don't ask again” under the ambiguous `current` or `in-cluster` sentinel; fail toward asking.
- Test two same-origin embedded Radar instances whose capability labels both say `in-cluster` and assert that consent does not cross between them.

### 5. Low/design: the PR ships an unused second mutating API and public runner contract

Locations:

- `internal/server/server.go:333-338`
- `internal/server/reachability_run.go:24-36`
- `internal/server/reachability_run.go:109-177`
- `web/src/api/client.ts:440-449`
- `web/src/components/workload/WorkloadView.tsx:1016-1020`
- `packages/k8s-ui/src/components/trace/TracePanel.tsx:39-47`
- `packages/k8s-ui/src/components/trace/TracePanel.tsx:65-83`
- `packages/k8s-ui/src/components/trace/ReachabilityView.tsx:19-79`

There are two mutating flows:

1. single arbitrary target: `POST .../probe-in-cluster`, `runInCluster`, and `InClusterRunner.run`;
2. whole subject: `POST .../in-cluster`, which is the only flow the Reachability UI invokes.

`ReachabilityView` receives the whole `TracePanelProps` object but never reads `inClusterRunner`. `useInClusterTest` uses only `runner.capability()` and calls `runInClusterMerged` directly; `runner.run` is unused. `inClusterOutcome` and `inClusterEligible` are exported and unit-tested but have no production caller.

The single-target handler is hardened and is not an obvious privilege escalation—a caller permitted to create Jobs could already generate arbitrary egress—but it still adds an arbitrary-destination mutating endpoint, API types, package surface, tests, and review burden to an already very large PR without serving the shipped journey.

Concrete fix:

- Remove the single-target POST, `runInCluster`, `InClusterRunner.run`, and unused reducers from this PR unless a concrete consumer is identified.
- Keep one capability endpoint plus the whole-subject operation. If per-route testing is a later feature, add it with that UI and a narrower server-derived target contract rather than accepting an arbitrary dial target.

## Product/contract questions to resolve before merge

1. How long is probe evidence valid, and what visible timestamp/staleness policy should apply when the Kubernetes snapshot changes underneath it?
2. Is opening the tab itself the explicit consent to generate observable network probes? The copy calls probes “operator-triggered,” while the implementation auto-runs them on tab entry. This is non-mutating but visible to applications and observability systems.
3. Does a green node mean “the resource answered from at least one vantage” or “its real data path is healthy”? The edge/banner caveats are thoughtful, but raw hop status currently applies a third rule.
4. What stable cluster ID does the embedded package receive? Context name is suitable display text, not identity for persisted safety decisions.

## Investigated and not raised

- Resource navigation does not retain a prior resource's `probePath`: the host keys `DiagnoseTabContent` by kind/namespace/name, so it remounts.
- Probe and in-cluster fetches use the runtime API-base/auth helpers (`fetchJSON`, `apiFetch`, `getApiBase`) required by embedded consumers.
- The new tab is host-opt-in through `renderDiagnoseTab` and kind/group checks; a library consumer that does not wire the callback does not get a broken empty tab.
- `ReachabilityView` keeps selected topology detail synchronized by storing node ID and re-deriving the node from the current topology.
- The single-target endpoint's arbitrary destination is not presented as an RBAC escalation finding because its capability requires the same Job-creation power that could already originate traffic. The recommendation is attack-surface and scope reduction.
