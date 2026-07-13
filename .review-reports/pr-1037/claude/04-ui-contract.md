# PR 1037 — Subreview 4: UI, API, MCP, Product Contract

**Reviewed SHAs**
- base: `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- head: `d1face5b31572eb94afcd29920b93684f42281d3`

**Files inspected at PR head (read in full unless noted)**
- Frontend trace: `packages/k8s-ui/src/components/trace/reachVerdict.ts`, `TracePanel.tsx`, `TraceSummary.tsx`, `ReachabilityView.tsx`, `traceToSubgraph.ts`, `probe-display.ts`, `index.ts` (ReachabilityExplainer.tsx skimmed)
- Topology: `packages/k8s-ui/src/components/topology/TopologyGraph.tsx`, `K8sResourceNode.tsx` (diffs)
- Wiring: `web/src/components/workload/WorkloadView.tsx`, `packages/k8s-ui/src/components/workload/WorkloadView.tsx` (`isDiagnoseKind`, tab), `web/src/api/client.ts`
- Consent: `packages/k8s-ui/src/components/ui/InClusterConsentDialog.tsx`, `utils/inClusterConsent.ts` (+ test)
- Public surface: `packages/k8s-ui/src/index.ts`, `types/core.ts`, `components/trace/index.ts`, `components/ui/index.ts`, `utils/index.ts`, `theme/components.css`, `theme/tailwind-theme.css`
- Server: `internal/server/trace_handlers.go`, `reachability_run.go`, `server.go` (diff)
- MCP: `internal/mcp/tools.go`, `tools_diagnose.go`, `tools_catalog_test.go`, `web/src/components/home/mcpToolCatalog.ts`
- Go parity anchors: `internal/trace/coverage.go` (VantageAPIServer), `predicate_sync_test.go`
- `DESIGN.md`

---

## Altitude / Design Assessment

**This is the right feature, and the UX shape is sound.** The operator journey — open a failing workload → a "Diagnose network path" hint pointing at the fronting Service (or the inline glance on a Service/Ingress) → "Open Reachability" → auto-run proxy probe → optional, gated in-cluster real-traffic test — is coherent and matches how a DevOps engineer actually debugs "traffic isn't reaching my service." The relentless honesty discipline (neutral, never green, for apiserver-proxy-only reaches; "front door confirmed from outside" only on a real 2xx; benign scale-to-0 amber not red; transitional 0-ready pods amber "may be starting" not red) is genuinely well thought through and is the product's differentiator. DESIGN.md compliance is high: theme tokens throughout, `StatusDot`/`AlertBanner`/`Badge`/`.btn-brand*`/`.card`-style surfaces, `StatusTone` vocabulary reused rather than reinvented.

**The one architectural question worth naming (Finding 3): the verdict is derived in two places** — Go `internal/trace` (authoritative: `trace.verdict`, `routes[].outcome/confidence`, `coverage`, `trace.headline`, findings) and TS `reachVerdict.ts` (596 lines re-deriving tone + headline text). My conclusion: this is *acceptable but carries real maintenance risk*, because the split is disciplined — Go owns the data verdict, TS is presentation and (a) floors its tone on `trace.verdict` so it can never read healthier than Go's `broken`/`degraded`, (b) defers to `trace.headline` via `|| fallback` in most branches, and (c) the only hard-coupled constants (`VantageAPIServer` / `IsEntryKind`) have CI parity tests on both sides. It is not two independent verdict engines that can flip healthy↔broken. But it is a large parallel surface and it *does* independently author headlines Go never emits (front-door / backend-down), which creates a bounded drawer-vs-tab inconsistency (Finding 3).

Auth parity (REST ↔ MCP), stale-state race handling, and public-package additivity are all handled correctly — see rejected claims.

---

## Findings (ordered by severity)

### 1. [Low / DESIGN] `text-theme-accent` is a non-existent token — accent links render colorless

**Files:** `packages/k8s-ui/src/components/trace/TracePanel.tsx:450`, `packages/k8s-ui/src/components/trace/ReachabilityView.tsx:367`

Both "Open ↗" / "Open {kind} {name} ↗" links use `className="... text-theme-accent hover:underline"`. The theme defines `--color-accent` (→ `text-accent`) and `--color-accent-text` (→ `text-accent-text`) in `tailwind-theme.css`, but there is **no `--color-theme-accent`**, so `text-theme-accent` generates no utility and the link falls back to inherited text color (`text-theme-text-primary`/`secondary`). Confirmed: the token appears nowhere in the base ref and has no definition anywhere in the tree.

```tsx
// ReachabilityView.tsx:367
<button ... className="text-theme-accent hover:underline">Open ↗</button>
// TracePanel.tsx:450
<button ... className="... text-[11px] text-theme-accent hover:underline">Open {culprit.kind} ...</button>
```

The sibling `DiagnoseFromWorkloadHint` uses the correct `text-accent-text` and `JustTestedNote` uses `text-accent-text`, so the intent is clearly accent-blue. **Fix:** replace `text-theme-accent` → `text-accent-text` (or `text-accent`) at both sites. Low severity (links still work, just not visually distinguished as accent), but it's a straight DESIGN-token bug and easy to fix.

### 2. [Low / Accessibility] Route edges encode the primary works/broken signal by hue only, with raw hex outside the theme

**File:** `packages/k8s-ui/src/components/topology/TopologyGraph.tsx` (`REACH_COLORS`/`REACH_DASH`/`reachEdgeStyle`), legend in `ReachabilityView.tsx` (`DiagramLegend`)

`verified` (green `#22c55e`, solid) and `unreachable` (red `#ef4444`, solid) differ **only in color** — same width, no dash. The design deliberately puts "per-route truth on the EDGES," so the single most important distinction (route works vs route breaks) is color-only on that carrier. `reached`/`blocked`/`not-tested` are disambiguated by dash pattern; verified-vs-unreachable are not. Colorblind operators lose the primary signal on the edge itself (mitigated but not resolved by the node status dots + detail panel).

Separately, the stroke colors are raw hex constants rather than the theme status tokens (`--color-success`/`--color-error`), so they won't retune with the palette and aren't tuned for light mode (DESIGN.md status colors are `#22C55E`/`#EF4444` — close, but the coupling is by luck). ReactFlow needs a color *string*, so `var(--color-success)` would be the theme-correct choice.

**Fix (optional/low):** give `unreachable` a distinguishing marker or heavier/interrupted stroke, and reference `var(--color-success|error|warning)` instead of literal hex so the edges track the theme. Not a blocker.

### 3. [Info / Architecture] Drawer and tab can surface different headline text/tone for the same trace

**Files:** `TraceSummary.tsx` (`summarizeTrace` → `trace.headline` + `coverageBannerTone`) vs `ReachabilityView.tsx`/`reachVerdict.ts` (`reachVerdict().text`/`.tone`)

The drawer glance headlines with Go's `trace.headline` and a tone from `coverageBannerTone(coverage, routes)`. The full tab headlines with TS `reachVerdict().text`/`.tone`, which for Ingress/Gateway subjects (`frontDoorStatus`) and backend-down subjects authors sentences Go's `trace.headline` never produces ("Front door confirmed from outside", "No healthy backend — …"). So the *same* `Trace` can read one way in the drawer and another on the tab.

In practice the exposure is small: the drawer never runs active probes (`useTrace` excludes `probe`), so `coverage.tested === 0` almost always → the drawer shows the neutral "minimal" invite, not a probed glance, while the tab auto-runs the proxy probe. The two rarely display a probed verdict simultaneously. I could not construct a case where they *contradict on a broken/healthy conclusion* (TS floors on `trace.verdict`; `coverageBannerTone` and `reachVerdict` share the same "indirect is never red/green" rules). Recording as a maintainability/consistency risk, not a bug: the two derivations must be kept in lockstep by hand, and there is no cross-check test that the drawer tone and tab tone agree for a given probed trace (there are separate unit tests for each). **Suggestion:** if feasible, have the tab reuse `coverageBannerTone` for the top-line tone (as the drawer does) so there's one tone source, and treat `reachVerdict` as headline-phrasing only.

### 4. [Info / Product] In-cluster mutating probe has a human-in-the-loop confirm in the UI but **not** via MCP or raw REST

**Files:** `InClusterConsentDialog.tsx` + `utils/inClusterConsent.ts` (UI only); `internal/mcp/tools_diagnose.go` (`handleNetworkTraceDiagnose`, `inCluster`); `internal/server/reachability_run.go`

The consent dialog ("This creates a short-lived, self-deleting Job…") is a **client-side safety confirm**, persisted in `localStorage` per cluster (`radar.inClusterConsent.<context>`), remembered forever once "don't ask again" is checked, re-prompting on context switch. The server enforces nothing about consent — it gates on RBAC (impersonation) + Cloud-role `Member` + namespace scope. That means:
- `diagnose(inCluster=true)` over **MCP** creates up to 5 probe pods with **no human confirm** — an AI agent can trigger it directly. It is annotated `destructiveHint=false` + non-`readOnly`, gated on `RoleMember` (`tools_diagnose.go:849`), pods self-delete in ~60s.
- Direct `POST /trace/.../in-cluster` bypasses the dialog identically.

This is a **deliberate and defensible** design (consent is UX, not authz; the real guardrails are RBAC + role + self-deleting pods), and the auth gates are correctly mirrored across REST and MCP. I'm flagging it only so the team consciously accepts that "spawns pods" happens agent-initiated without a confirm. If that's not intended, the annotation/gating is the lever, not the dialog. **No code change required** unless product wants MCP to be probe-only-without-inCluster by default.

Consent breadth itself (per-cluster, forever, incl. prod) is reasonable given the pods self-delete; re-prompt-on-context-switch is the right boundary. Not a finding.

### 5. [Info / Cleanup] Dead single-target in-cluster path; `runInCluster` skips the `response.ok` check the merged path has

**Files:** `web/src/api/client.ts` (`runInCluster`, `InClusterRunner.run` wiring in `useInClusterRunner`), `ReachabilityView.tsx` (unused `inClusterRunner` prop)

The whole-subject flow (`runInClusterMerged` → `POST .../in-cluster`) is what actually runs. The single-target `runInCluster` (`POST .../probe-in-cluster`) is wired into `InClusterRunner.run` and passed down as `inClusterRunner`, but `useInClusterTest` calls `runInClusterMerged` directly and never invokes `runner.run`; `ReachabilityView` receives `inClusterRunner` but only ever uses `.capability()`. So `runInCluster` + `InClusterRunner.run` are effectively dead in this PR. Latent inconsistency if ever revived: `runInCluster` returns `response.json()` without checking `response.ok` (unlike `runInClusterMerged`, which throws on `!ok || body.error`). Minor — recommend either removing the unused `.run`/`runInCluster` or aligning its error handling. (The `probe-in-cluster` REST endpoint itself is still used by MCP/CLI, so keep the server handler.)

### 6. [Info / Product] Opening the Reachability tab auto-emits real proxy traffic without a click

**File:** `web/src/components/workload/WorkloadView.tsx` (`DiagnoseTabContent` autorun effect), `client.ts:fetchTraceWithProbes`

Navigating to the Reachability tab auto-runs the proxy probe once per resource (`runProbes()` in the autorun effect) — real DNS/TCP/TLS/HTTP requests via the apiserver proxy to the workload, simply by viewing the tab. This is read-only, runs as the caller's RBAC, creates no objects, and is documented in `client.ts`. It's the right call for UX (a blank "click Run" page is worse), but it means observability systems will see probe traffic on tab open. Recording as an accepted product decision. **Confirmed the opposite for the drawer and the static path:** opening a Service/Ingress *drawer* fires only `GET /trace` (no `probe=true`) → no network traffic, no objects. Merely opening a workload does **not** probe. Good.

---

## Investigated Claims — Rejected / Downgraded

- **"Frontend re-derives the verdict and can disagree with the Go verdict" (major risk in brief) → downgraded to Finding 3.** Go is authoritative for `verdict`/`routes`/`coverage`/`headline`; `reachVerdict` floors its tone on `trace.verdict` (`REACH_TONE_RANK`, never downgrades a Go `broken`/`degraded`) and defers to `trace.headline` in the route-based branches. The drift-prone shared constants are pinned by tests on both sides (`VantageAPIServer` = `VIA_API_SERVER`; `IsEntryKind` = `isDiagnoseKind` via `predicate_sync_test.go`). Real divergence is bounded to headline *phrasing* and the drawer/tab tone-source split, not a healthy↔broken flip.

- **"Stale probe state renders against the wrong resource on navigation" → not found; handled well.** `DiagnoseTabContent` is keyed `key={kind/ns/name}` so it *remounts* on A→B. Both `useProbeRun` and `useInClusterTest` guard every async resolution with a per-resource `tokenRef` bumped on resource/base change **and** on unmount; late `.then/.catch` bail when the token no longer matches. `runningRef` mirrors `running` so the synchronous `resetProbe()→runProbes()` in `applyProbePath` isn't blocked by a stale closure. The selected node is tracked by **id** (re-derived from current topology each render) so a mid-run probe refreshes the open detail panel in place. This is careful, correct work.

- **"A failed in-cluster probe looks like a reachability FAIL (false condemnation)" → not found; explicitly guarded.** `stampInClusterProbes` records a probe that didn't get through from the throwaway pod as a **SKIP**, not a confirmed failure, with a reason naming source-scoped NetworkPolicy / mesh mTLS as why it differs from real client traffic. A run that couldn't execute at all (Job couldn't start / RBAC / timeout) comes back HTTP 200 with a `fallbackCommand`; `useInClusterTest` surfaces it via a separate **warning** `AlertBanner` ("In-cluster test couldn't run") with a copyable command — not a red verdict. Node coloring (`nodeOwnStatus`) and edge coloring (`edgeReach`) both exclude proxy-only/indirect and netpol-predicted failures from red.

- **"Consent remembered too broadly" → acceptable.** Per-cluster key, re-prompts on context switch, self-deleting pods. See Finding 4.

- **"New/renamed exports break @skyhook-io/k8s-ui consumers (Radar Hub)" → no; purely additive.** `index.ts` adds `export * from './components/trace'`; `components/trace/index.ts`, `components/ui/index.ts` (+`InClusterConsentDialog`), `utils/index.ts` (+`inClusterConsent`) only add. `types/core.ts` adds optional `labelTitle?` and `reachOutcome?` to `TopologyEdge` (additive, optional). No removals/renames of `apiBase`/`basename`/`navSlots` or existing props. `WorkloadView` gains an optional `renderDiagnoseTab` + a new hidden-by-default "Reachability" tab; existing consumers that don't pass it get the tab hidden (`hidden: !(renderDiagnoseTab && isDiagnoseKind(...))`).

- **"MCP and REST enforce different auth" → no; parity is correct.** Both gate the mutating in-cluster path on `CloudRole >= Member` (REST `requireCloudRole` in `reachability_run.go`; MCP `pkgauth.CloudRoleFromContext(ctx).AtLeast(RoleMember)` in `tools_diagnose.go:849`), both scope to the caller's allowed namespaces (`parseNamespacesForUser` / `checkNamespaceAccess` + `filterNamespacesForUser`), both impersonate the caller (`ClientFromContext`) so the apiserver enforces RBAC on the probe verbs, and the whole-subject merge is server-authoritative in both (`trace.ApplyInClusterResults`) so neither client reimplements a divergent fold. Read-only `/trace` correctly returns an unknown-verdict trace (no existence leak) when namespace access is denied.

- **"CRD kind collision fires a trace against the wrong core object" → guarded.** `isDiagnoseKind(kind, group)` requires the API group to match when known (`service`→`['']`, `ingress`→`['','networking.k8s.io']`, routes/gateway→`['gateway.networking.k8s.io']`); Knative Service / Istio Gateway are excluded. The web wrapper threads `group={rest.group || resourceGroup || undefined}` and falls back to the fetched resource's group so a URL without `?apiGroup` doesn't misfire. `group===undefined` keeps a kind-only fallback (documented trade-off).

---

## Questions & Coverage Gaps

1. **Tone-source split (Finding 3):** is there an intended single tone source, or is the drawer-`coverageBannerTone` / tab-`reachVerdict` split deliberate? No test asserts the two agree for a given probed trace. Consider a shared-fixture test that feeds one `Trace` to both and asserts compatible tone/severity.
2. **MCP-initiated pod creation (Finding 4):** confirm product intends `diagnose(inCluster=true)` to be agent-triggerable with no human confirm. If not, gate it behind an explicit opt-in flag on the server, not the client dialog.
3. **Edge accessibility (Finding 2):** verified-vs-unreachable is hue-only on the edge carrier the design elevates as "per-route truth." Worth a deliberate accept or a non-color differentiator.
4. **Dead `runInCluster`/`InClusterRunner.run` (Finding 5):** intended future use, or removable now?
5. I did **not** deep-read `ReachabilityExplainer.tsx` line-by-line or the Go `internal/trace/*` verdict internals (out of this subreview's UI/contract scope — covered by the Go-focused subreviews); my parity assessment relied on the pinned constants + the TS floor/deferral structure, not a full behavioral diff of the two verdict engines.
