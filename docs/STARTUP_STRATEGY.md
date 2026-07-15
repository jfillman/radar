# Radar Startup Strategy

How Radar connects to a Kubernetes cluster and populates its caches, from "user opens the app" to "UI is fully interactive."

## Overview

Radar uses Kubernetes [SharedInformers](https://pkg.go.dev/k8s.io/client-go/tools/cache#SharedInformer) to maintain an in-memory mirror of cluster state. Each informer issues an initial `LIST` (fetches all existing objects) followed by a long-running `WATCH` (streams incremental changes). On large clusters, the initial LISTs are the dominant startup cost — each LIST can transfer megabytes of paginated JSON over a single HTTP/2 connection, and all informers share one TCP socket, causing head-of-line blocking.

The startup strategy is designed to:
1. Get the UI rendering as fast as possible (show topology, dashboard)
2. Minimize concurrent API server pressure (stagger informer starts)
3. Degrade gracefully on slow clusters (timeout + partial data)
4. Load CRDs intelligently (eager for known integrations, lazy for the rest)

## Startup Phases

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Server Bootstrap                                                             │
│ K8s client init · MCP server (14 tools) · Version check (async)             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Phase 0: Pre-cache                                                          │
│ RBAC checks + API discovery (parallel)                                      │
│ ~1-2s                                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ Phase 1: Critical informers (BLOCKS UI)                                     │
│ Pods, Deployments, Services, StatefulSets, DaemonSets, Nodes,              │
│ Namespaces, Ingresses, Jobs, CronJobs                                      │
│ ~10 concurrent LISTs → WaitForCacheSync (up to 60s timeout)                │
├──────────────────────────────────────────────────────────────────────────────┤
│ ── UI can render (dashboard, topology) ──                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                   ALL THREE RUN CONCURRENTLY                                │
│                                                                             │
│  Phase 2: Deferred      Phase 3→4: CRDs        Phase 5: Remaining          │
│  ─────────────────      ────────────────        ────────────────            │
│  Secrets, Events*,      3: Warmup known         Metrics, Helm,             │
│  ConfigMaps, PVCs,         integrations          Traffic, Prometheus        │
│  PVs, StorageClasses,      (up to ~80 CRDs;      auto-discovery (30s)      │
│  PDBs, ReplicaSets,        only installed ones                             │
│  HPAs                       activate)                                      │
│                         4: Discover rest,                                   │
│  Started after Phase 1     probe counts,                                   │
│                            ≤100 → eager,                                   │
│  *Events sync              >100 → on-demand                                │
│  *Events sync independently                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### Server Bootstrap

Before cluster connection begins, the HTTP server initializes several components:

1. **K8s client init** — Parses kubeconfig, resolves the active context, creates the `*rest.Config` and `kubernetes.Clientset`. Exec credential plugins (e.g., `gke-gcloud-auth-plugin`, `aws-iam-authenticator`) run here and can add 1-3s on first call. Location: `internal/k8s/client.go` → `initClient()`.

2. **MCP server** — Registers 14 tools and 3 resources for AI tool integration (Claude, etc.). This is purely in-process setup — no network calls. Location: `internal/mcp/server.go`.

3. **Version check** — Async goroutine checks GitHub for newer Radar releases. Non-blocking, fires and forgets. Location: `internal/server/server.go` → `checkForUpdate()`.

### Prometheus Auto-Discovery

After `InitAllSubsystems()` completes, a background goroutine probes for Prometheus/VictoriaMetrics inside the cluster (looks for well-known service names and ports). Has a 30-second timeout. When found, enables dashboard cost/metrics features. Can be bypassed with `--prometheus-url`. Location: `internal/k8s/subsystems.go` → `discoverPrometheus()`.

### Critical vs Deferred Resources

Resources are split into two tiers based on what the dashboard and topology need for first render:

| Tier | Resources | Purpose |
|------|-----------|---------|
| **Critical** | Pods, Deployments, Services, StatefulSets, DaemonSets, Nodes, Namespaces, Ingresses, Jobs, CronJobs | Dashboard counts, topology graph, health status |
| **Deferred** | Secrets, Events, ConfigMaps, PVCs, PVs, StorageClasses, PDBs, ReplicaSets, HPAs | Config relationships, event timeline, storage details, scaling |

The split is defined in `internal/k8s/cache.go` → `deferredResources` map and passed to `pkg/k8score` via `CacheConfig.DeferredTypes`.

### Staggered Start

Critical informers are `Run()` individually (not via `factory.Start()`) so deferred informers can be started later:

1. All critical informers start immediately → ~10 concurrent LISTs
2. Phase 1 blocks until all critical informers sync (or timeout)
3. Only then are deferred informers started → reduces peak API server load

The factory is still created (it serves as the informer registry and provides `Shutdown()`), but `factory.Start()` is never called. Each informer is registered when its factory getter is called during setup (e.g., `factory.Core().V1().Pods().Informer()` registers internally), so `factory.Shutdown()` still works correctly.

### Events as Background Informers

Events are a special case — they can take 60+ seconds to sync on large clusters (many events) and don't affect topology or the dashboard. They sync independently and don't block `deferredDone`, meaning:

- The `deferred_ready` SSE event fires when non-Event deferred informers sync
- Events continue syncing in the background
- Event sync status is tracked separately in `backgroundSyncFuncs`

### Sync Timeout (60s)

If critical informers haven't synced within `CacheConfig.SyncTimeout` (60s), unsynced informers are **promoted to deferred**:

- Their informers are already running (started in Phase 1) — they continue syncing in the background
- The UI renders with whatever data is available
- Promoted kinds are tracked in `ResourceCache.promotedKinds` and exposed via `DashboardResponse.PartialData`
- The dashboard can display a banner telling the user which resources are still loading

### SSE Warmup Debounce

During the warmup phase (before deferred informers finish), topology broadcasts are debounced at 3 seconds instead of the normal 500ms. This prevents a storm of topology rebuilds as CRD informers sync one by one. The SSE broadcaster also skips the expensive full-topology cache build during warmup (marks it dirty for lazy rebuild instead).

After `deferredDone` fires, the debounce drops to normal (500ms, or 5s for clusters with >5000 resources).

### Smart CRD Discovery

After the typed cache and known CRD warmup complete, `DiscoverAllCRDs()` runs in the background:

1. Gets all API resources via `ResourceDiscovery.GetAPIResources()`
2. Filters to CRDs that support `list` + `watch`
3. Skips GVRs already watched from Phase 3 warmup
4. For each remaining CRD, runs `probeCount()` — a `LIST` with `Limit: 1` that returns approximate count
5. CRDs with ≤100 resources are watched eagerly (cheap, gives full timeline)
6. CRDs with >100 resources are deferred to on-demand (`EnsureWatching()` when user browses)

This avoids starting 77+ informers for things like Calico policies or Cilium endpoints that nobody is looking at.

## Key Files and Functions

### Orchestration

| Location | What |
|----------|------|
| `internal/k8s/subsystems.go` → `InitAllSubsystems()` | Top-level orchestrator. Calls timeline → resource cache → dynamic cache → remaining subsystems. Runs API discovery in parallel. |
| `internal/k8s/subsystems.go` → `ResetAllSubsystems()` | Tears down everything in reverse order (for context switch). |
| `internal/k8s/cache.go` → `InitResourceCache()` | Singleton init. RBAC checks, builds `CacheConfig`, calls `k8score.NewResourceCache()`. Sets `SyncTimeout: 60s`. |
| `internal/k8s/cache.go` → `deferredResources` | Map defining which resource types are deferred. |
| `internal/k8s/dynamic_cache.go` → `InitDynamicResourceCache()` | Singleton init for dynamic/CRD cache. Wires Radar callbacks. |
| `internal/k8s/dynamic_cache.go` → `WarmupCommonCRDs()` | Phase 3: starts watching known CRD integrations (Argo, Istio, Knative, etc.). |
| `internal/k8s/client.go` → `initClient()` | K8s client init. Parses kubeconfig, exec credential plugins. |
| `internal/mcp/server.go` | MCP server setup. Registers 14 tools + 3 resources for AI integration. |
| `internal/server/server.go` → `checkForUpdate()` | Async version check against GitHub releases. |

### Core Cache (pkg/k8score)

| Location | What |
|----------|------|
| `pkg/k8score/cache.go` → `NewResourceCache()` | Creates factory, registers informers, runs Phase 1 + Phase 2 sync. The main startup function. |
| `pkg/k8score/cache.go` → `ResourceCache` struct | Holds factory, changes channel, per-informer sync tracking, promoted kinds. |
| `pkg/k8score/cache.go` → `InformerSyncStatus` | Per-informer tracking: kind, key, deferred flag, synced state, timestamp, item count. |
| `pkg/k8score/cache.go` → `CacheSyncStatus` | Aggregate status exposed via `GetSyncStatus()`. Includes phase, counters, pending lists, promoted kinds. |
| `pkg/k8score/cache.go` → `SyncPhase` | State machine: `not_started` → `syncing_critical` → `syncing_deferred` → `complete`. |
| `pkg/k8score/cache.go` → `buildInformerSetups()` | Table-driven list of all 21 typed informers with their factory getter functions. |
| `pkg/k8score/types.go` → `CacheConfig` | Configuration struct. Key fields: `ResourceTypes`, `DeferredTypes`, `SyncTimeout`, all callbacks. |
| `pkg/k8score/types.go` → `DynamicCacheConfig` | Configuration for the dynamic/CRD cache. |
| `pkg/k8score/dynamic_cache.go` → `DynamicResourceCache` | Dynamic cache: on-demand informers for CRDs. |
| `pkg/k8score/dynamic_cache.go` → `DiscoverAllCRDs()` | Phase 4: probes all CRDs, watches small ones eagerly, defers large ones. |
| `pkg/k8score/dynamic_cache.go` → `EnsureWatching()` | Lazy informer start: probes access, starts watching, returns. |
| `pkg/k8score/dynamic_cache.go` → `probeCount()` | Quick `LIST Limit=1` to estimate resource count for a GVR. |

### SSE / Real-time Updates

| Location | What |
|----------|------|
| `internal/server/sse.go` → `SSEBroadcaster` | Manages SSE clients, watches resource changes channel, broadcasts topology. |
| `internal/server/sse.go` → `warmupDone` channel | Closed when deferred sync completes. Controls debounce duration and topology cache build strategy. |
| `internal/server/sse.go` → `watchResourceChanges()` | Main loop: reads from `cache.Changes()`, debounces, broadcasts topology. Warmup debounce = 3s. |
| `internal/server/sse.go` → `watchDeferredSync()` | Waits for `cache.DeferredDone()`, then broadcasts `deferred_ready` + topology update, closes `warmupDone`. |
| `internal/server/sse.go` → `broadcastTopologyUpdate()` | Builds topology for each client group. During warmup, skips full-topology cache build (marks dirty). |

### Dashboard

| Location | What |
|----------|------|
| `internal/server/dashboard.go` → `DashboardResponse` | Has `DeferredLoading` bool and `PartialData []string` for communicating sync state to frontend. |

## Diagnostics

### Startup Timing Logs

Enable with `--dev` flag. Produces `[startup-timing]` lines:

```
[startup-timing]     RBAC permission checks: 1.2s
[startup-timing]     Informer synced: Pod                          45.3s (critical)
[startup-timing]     Informer synced: Service                      2.1s (critical)
[startup-timing]     Phase 1 sync (10 critical informers): 45.3s
[startup-timing]     Phase 2 sync (9 deferred informers): 12.7s
[startup-timing]     CRD warmup: 8.2s (background)
[startup-timing]     CRD full discovery: 15.4s (background)
```

### Progress Logging

During Phase 1 and Phase 2, progress is logged every 5 seconds showing which informers are still pending and their current item counts:

```
Critical sync progress: 7/10 synced (20s elapsed) — pending: Pod(1847), ReplicaSet(423), Node(364)
```

### Debug API

`GET /api/debug/informers` returns `CacheSyncStatus` with per-informer details:
- Phase, elapsed time, critical/deferred counts
- Per-informer: kind, synced state, timestamp, item count, deferred flag
- Pending lists, promoted kinds

### Sync Timeout Warning

When the 60s timeout fires:
```
WARNING: Critical sync timed out after 1m30s — promoting 2 informers to deferred: Pod, Node
UI will render with partial data; promoted informers continue syncing in background
```

## Context Switch Behavior

When the user switches Kubernetes context:

1. `ResetAllSubsystems()` tears down everything in reverse order
2. SSE broadcaster resets `warmupDone` (new channel for new context)
3. `watchResourceChanges()` and `watchDeferredSync()` are restarted
4. `InitAllSubsystems()` runs the full startup sequence for the new context
5. Clients receive `context_changed` SSE event, then fresh topology

The `watchStopCh` pattern ensures old goroutines exit cleanly when the context switches.

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Critical sync timeout (60s) | Unsynced informers promoted to deferred. UI renders partial data. `PartialData` exposed to frontend. |
| Deferred sync failure (stopCh closed) | `deferredFailed` flag set. `IsDeferredSynced()` returns false. `deferredDone` channel still closes (to unblock waiters). |
| CRD probe access denied | CRD skipped (no informer started). Counted in `noAccessCount`. |
| CRD probe timeout/error | CRD deferred to on-demand. Informer starts when user browses. |
| No RBAC for any resource | Cache created with 0 informers. Warning logged. UI shows empty state. |
