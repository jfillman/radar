# PR 1037 — Consolidated Claude Review (READ-ONLY)

**Feature:** "Reachability" — honest, DevOps-grade network-path diagnosis for Service / Ingress / HTTPRoute / GRPCRoute / Gateway, with a static trace, an apiserver-proxy/local probe, and an opt-in in-cluster Job probe. Surfaced via REST, MCP (`diagnose`), a React Reachability tab, and a topology overlay.

## 1. Scope & coverage

- **Base:** `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- **Head:** `d1face5b31572eb94afcd29920b93684f42281d3`
- **Diff:** ~23k added lines, 81 files. Inspected via `git diff <base>..<head>` and `git show <head>:<path>`. The checked-out worktree is `main` with unrelated local edits (`.gitignore`, `.design-sync`) — ignored throughout.

Four independent subreviews (each self-contained, linked in §8), plus my own independent read of the security envelope (`internal/reachability/*`, `internal/server/reachability_run.go`, `cmd/explorer/probe_cmd.go`), the honesty core (`internal/trace/trace.go` + `coverage.go` `CoverageVerdict`/`worstOutcome`/`InClusterResultKey`), and the MCP wiring. I re-verified the load-bearing findings against source rather than accepting subagent claims:

| Verified claim | Result |
|---|---|
| No `ReferenceGrant` / `allowedRoutes` / `status.parents` code in `internal/trace` | **Confirmed** — only 2 comments + a `kubectl … jsonpath='{.status.parents}'` repro string; nothing consumed |
| `text-theme-accent` is an undefined token | **Confirmed** — theme defines `--color-accent`/`--color-accent-text`, no `--color-theme-accent` |
| `readyCount` counts terminating (`DeletionTimestamp`) pods | **Confirmed** — `selectedPods` returns raw selector matches; `readyCount` checks only the Ready condition, unlike `livePods` |
| `reached`-only real route → `verdict=healthy` | **Confirmed** — `anyRealPass` counts `OutcomeReached`; `CoverageVerdict` returns healthy when `c.Failed==0` |
| `worstOutcome` returns first-hit, not worst | **Confirmed** — returns on first failing/degraded probe in slice order |

## 2. High-level architecture / product verdict

**This is a strong, ship-worthy PR built by someone who understands both Kubernetes networking and the honesty trap that makes most "connectivity checkers" untrustworthy.** The core design is right:

- **Three-axis verdict model** (Outcome × Confidence × Coverage) that most tools conflate. The apiserver-proxy path is *structurally* quarantined as `indirect` and can never set the shipped verdict, which defuses the "a local success blesses in-cluster reachability" lie at the type level. Unverifiable/RBAC/cache states resolve to `unknown`, not to a fake OK or a fake FAIL.
- **Security envelope for the one mutating action is genuinely tight.** The in-cluster probe is a restricted-PSA Job (non-root/65532, `drop: [ALL]`, no SA token, read-only rootfs, seccomp RuntimeDefault, `backoffLimit:0`, `activeDeadlineSeconds:25`, `ttlSecondsAfterFinished:60`), exec-form command (no shell → no injection), operator-controlled image only, run under the **caller's impersonated RBAC** (apiserver-enforced, SSAR is only a pre-flight), additively gated on Cloud `RoleMember` on **both** REST and MCP, namespace-scoped, and SSRF-guarded (`denyInternalControl` blocks IMDS/loopback/link-local on the resolved IP). It grants no capability a `create jobs` caller doesn't already have.
- **Fail-toward-silence discipline is consistent:** a throwaway-pod probe failure is recorded as a *skip* (source-scoped NetworkPolicy / mesh mTLS legitimately deny it), never escalated to a confident "broken."

**The one systemic weakness is one-directional and worth the team's attention:** reachability is derived from **spec references + pod readiness**, and the model skips the authoritative Kubernetes signals that say whether a reference actually *took effect* — specifically Gateway-API `ReferenceGrant`, listener `allowedRoutes`, and route `status.parents[].conditions`. For cross-namespace Gateway paths the static verdict over-claims "reachable," and because the in-cluster probe dials the backend Service FQDN **directly (bypassing the Gateway)**, the live probe *confirms* the wrong answer instead of catching it. That is the sharpest miss against the feature's own promise.

The second-order tension is that the four-value `verdict` word (`healthy/degraded/broken/unknown`) flattens a real `reached` (bare TCP-open, or a blanket 404) into `healthy`, so the loudest signal (banner color, and the `verdict` field MCP agents branch on) is slightly more confident than the route-level truth beneath it.

Neither is a blocker. Both are honesty gaps in a feature whose entire pitch is honesty, so they deserve an explicit decision (fix or documented disclaimer) rather than shipping silently.

## 3. Prioritized findings

Severity is my own triage, not the subagents'. Line numbers are at PR head.

### F1 — [Medium] Gateway API cross-namespace refs ignore ReferenceGrant / allowedRoutes / route status → false "reachable", and the in-cluster probe confirms the wrong answer
`internal/trace/entries.go:1114-1146, 1736-1773, 1775-1869, 1997-2066` (+ `findings.go:255`). Cross-namespace `backendRef` and route↔Gateway attachment are resolved by name/namespace only; no `ReferenceGrant` lookup, no listener `allowedRoutes` check, and route `status.parents[].conditions` (`Accepted`/`ResolvedRefs`) is never read. A grant-less cross-ns backendRef is refused by the controller (`ResolvedRefs=False`, HTTP 500) but the trace shows a live path. **Cross-area seam:** the in-cluster runner (`internal/reachability/incluster.go` `fqdnDialTarget`) dials `name.ns.svc:port` **directly**, bypassing the Gateway, so the live probe *confirms* reachable — the static prior is wrong and ground-truth can't correct it. **Fix:** consult `route.status.parents` conditions (cheap, subsumes most cases) and/or look up `ReferenceGrant` in the target namespace; when unresolved, emit a `gateway:ref-not-permitted` finding and mark the hop unverifiable instead of tracing it live.

### F2 — [Medium / Discuss] A real `reached`-only route ships `verdict = healthy`
`internal/trace/coverage.go:867-882` (`CoverageVerdict`), `:933-943` (`anyRealPass`), `:1470-1527` (`worstOutcome`). A real dial that only TCP-connected, or got a 3xx/4xx (e.g. a blanket 404 on every route, or a port open with nothing serving HTTP), yields `OutcomeReached`, which `anyRealPass` counts as a pass → `verdict=healthy` when `Failed==0`. The `Headline` honestly says *"Reachable — server reached, route not verified,"* and the frontend `reachVerdict.ts` tones it as ✓-with-caveat, **but** the raw `verdict` field consumed by MCP agents (and the drawer banner tone) reads green. No test pins the intended verdict for a real `reached`. **Seam:** the honesty gap concentrates on the MCP surface, which has no `reachVerdict`-style re-derivation. **Fix / decision:** either introduce a distinct amber `reachable/caution` tier when the best real evidence is `reached` (reserve `healthy` for ≥1 real HTTP 2xx), or consciously accept it and pin it with a test + reconcile the "never overclaims" copy.

### F3 — [Low-Med] Static-probe route identity: a `host/path` route can read `verified`/`reached` on evidence that never exercised that path
`internal/trace/probes.go:1017-1024, 1129` (front door probes a single path per host), `coverage.go:1616, 1872-1886` (host+path routes folded to one `RouteResult`, attributed by host only). A route labeled `a.com/api` can show verified from a backend `ClusterIP:port/` dial that never requested `/api`. Mitigated by `demoteSharedFrontDoor` (caps shared-`/` 2xx to `reached`) and by the in-cluster fold dialing the declared path with `PathGuessed` non-folding — so the exposure is the **static** path. **Fix:** probe each rule's declared path at the front door, or cap the route at `reached` + annotate "tested `/`, not `<declared path>`" (the `attachPathDivergenceFindings` hook is the natural place).

### F4 — [Low-Med] `ingress:no-controller` warning is suppressed exactly when the cluster has zero IngressClasses
`internal/trace/ingress_controller.go:107-114, 281-307`. `len(classes)==0` forces `couldRead=false`, and the positive no-controller finding only fires when `classReadable==true` (≥1 class exists but none resolves). So the most common truly-broken case — an Ingress on a cluster with **no controller installed at all** — never triggers the headline warning. **Fix:** distinguish cold from empty via `DynamicResourceCache.IsSynced(gvr)` for the IngressClass GVR — the exact technique `detect.go`'s scale-to-zero path adopts in this same PR (`detect.go:1846-1855`).

### F5 — [Low-Med / Info-disclosure] Reverse cross-namespace walk discloses name + namespace of routes in namespaces the caller can't read
`internal/trace/entries.go:1092-1104` (`routeUpstreamsForService`), `:1910-1926` (gateway reverse attach). Findings are redacted, but the message names the referrer: *"Upstream HTTPRoute "secret-route" is in namespace "B" …"* — revealing existence/name/namespace of an object the user has no RBAC to enumerate. Distinct from the safe *downstream* redaction (there the referrer is the subject the user is already reading). **Fix:** for reverse hops where `!NamespaceAllowed(referrerNs)`, omit the object identity ("an upstream in another namespace references this Service (redacted)"), or make it a deliberate, documented product exception.

### F6 — [Low] `internalTrafficPolicy: Local` / `externalTrafficPolicy: Local` / topology hints unmodeled → over-claim
`internal/trace/entries.go:942-968` (no reference to these fields anywhere in `internal/trace`). A ClusterIP Service with `internalTrafficPolicy: Local` only serves endpoints co-located with the client node; the trace enumerates all ready pods and reads reachable. **Fix:** at minimum an info finding when either policy is `Local` ("reachability is node-dependent").

### F7 — [Low] `worstOutcome` returns first-hit, not worst — outcome is order-dependent
`internal/trace/coverage.go:1470-1527`. A degraded probe ordered before a transport failure yields `server-error`, hiding the `unreachable`; contradicts the function's documented precedence. In practice the fixed layer order (dns→tcp→tls→http) usually puts a transport failure first, so it rarely bites today — but it's latent the moment a new degraded-tone layer or reordering lands. **Fix:** scan all probes and pick by precedence (`unreachable > server-error > verified > reached`).

### F8 — [Low] Terminating (`DeletionTimestamp`) pods with `Ready=True` are counted as live endpoints
`internal/trace/entries.go:984-998` (`readyCount`) vs `:973-982` (`livePods`, which filters correctly but isn't used here); `selectedPods` returns raw selector matches. During a rollout, old terminating-but-Ready pods inflate the ready count and can suppress the "0 ready endpoints" finding even though kube-proxy has already dropped them. Transient. **Fix:** exclude `DeletionTimestamp != nil` on the main endpoint path (reuse `livePods`).

### F9 — [Low] DNS-gap heuristic treats TCP-only port 53 as covering DNS
`internal/trace/egress.go:301-324` (`rulePort53`). Matches port 53 regardless of protocol, so an egress policy allowing only TCP/53 (resolvers use UDP/53 first) silently clears a real DNS gap. **Fix:** require UDP/53 (or unspecified protocol) coverage before `dnsCovered`.

### F10 — [Low] A static (`probe=false`) drawer trace ships `verdict = healthy`
`internal/trace/coverage.go:855-860` (`c==nil` → healthy) with `Headline="Configuration only - not yet tested"`. The verdict word says healthy for a path nothing verified — the config-layer mirror of F2. **Fix (optional):** return neutral/unknown for the no-probe case, letting the headline carry "configuration only"; or confirm the UI renders `healthy + "not yet tested"` as neutral, not green.

### F11 — [Low / DESIGN] `text-theme-accent` is an undefined token — accent links render colorless
`packages/k8s-ui/src/components/trace/TracePanel.tsx:450`, `ReachabilityView.tsx:367`. No `--color-theme-accent` exists; the "Open ↗" links fall back to inherited text color. Siblings correctly use `text-accent-text`. **Fix:** `text-theme-accent` → `text-accent-text`.

### F12 — [Low / Accessibility] Route edges encode works-vs-broken by hue only, with raw hex outside the theme
`packages/k8s-ui/src/components/topology/TopologyGraph.tsx` (`REACH_COLORS`/`reachEdgeStyle`). `verified` (green) and `unreachable` (red) differ only in color (same width/dash) on the carrier the design elevates as "per-route truth"; colors are literal hex, not `var(--color-success|error)`, so they don't retune for light mode. **Fix:** add a non-color differentiator for `unreachable` and reference theme status tokens.

### F13 — [Low / hardening] `handleProbeInCluster` accepts arbitrary `Target`/`Scheme` unbound to the named subject; `Scheme` unvalidated
`internal/server/reachability_run.go` (`handleProbeInCluster`). `Target` is validated only as `host:port` and is not tied to `{name}`'s config, making the endpoint a generic namespace-scoped in-cluster probe primitive. Bounded by RBAC + `RoleMember` + in-pod SSRF guard (no escalation — the caller could build the same pod), so Low. **Fix:** validate `Scheme ∈ {http,https}`; optionally verify `Target` resolves to the subject, or document the endpoint as an intentional general probe.

### F14 — [Low / operability] No operator kill-switch to disable in-cluster Job creation
`cmd/explorer/main.go`. There's `--reachability-image` but no `--no-reachability` analogue to `--no-mcp`; a strictly-read-only deployment can't centrally forbid probe-Job creation. **Fix:** add a config/flag kill-switch checked before any Job creation on REST + MCP paths.

### F15 — [Low] `not-tested` skip dedup keys on host only → undercount
`internal/trace/coverage.go:199-243` (`recountCoverage`). Two not-tested routes to the same host count as one skip. Cosmetic count drift; never inflates Passed/Failed. **Fix:** key dedup on host+path.

### F16 — [Info / Cleanup] Dead single-target in-cluster path skips the `response.ok` check
`web/src/api/client.ts` (`runInCluster` / `InClusterRunner.run`). The merged whole-subject path is what runs; `runInCluster` is wired but never invoked and returns `response.json()` without checking `response.ok`. **Fix:** remove the dead `.run`/`runInCluster` or align its error handling. (Keep the `probe-in-cluster` server handler — MCP/CLI use it.)

### Accepted-by-design (flagged, no change required)
- **In-cluster probe is agent-triggerable with no human confirm via MCP/REST.** The `InClusterConsentDialog` is client-only (localStorage per cluster). Real guardrails are RBAC + `RoleMember` + self-deleting pods, correctly mirrored REST↔MCP. Consciously accept, or move the gate server-side (a flag, not the dialog).
- **Reachability tab auto-emits real proxy traffic on open** (once per resource). Read-only, caller-RBAC, no objects. Opening a *drawer* or a *workload* does not probe. Reasonable UX; note it for observability.
- **Dead `broken` branch in `CoverageVerdict`** (`coverage.go:877`) is unreachable after the `!anyRealPass` early return. Nit.

## 4. Finding → source map

| # | Finding | Source |
|---|---------|--------|
| F1 | Gateway API ReferenceGrant/allowedRoutes/status ignored (+ probe bypasses gateway) | Sub1 F1/F2 × **seam** with Sub2 `fqdnDialTarget` |
| F2 | `reached`-only route → verdict=healthy | Sub3 F1 × **seam** with Sub4 (MCP verdict field) |
| F3 | Static route-identity host/path over-attribution | Sub3 F2 |
| F4 | `ingress:no-controller` suppressed on zero-class clusters | Sub1 F6 |
| F5 | Reverse cross-ns walk discloses route name/namespace | Sub1 F3 |
| F6 | internal/externalTrafficPolicy Local unmodeled | Sub1 F4 |
| F7 | `worstOutcome` first-hit vs worst | Sub3 F3 |
| F8 | Terminating-Ready pods counted | Sub1 F5 |
| F9 | DNS-gap: TCP-only 53 clears UDP/53 block | Sub1 F7 |
| F10 | Static probe=false → verdict=healthy | Sub3 F4 |
| F11 | `text-theme-accent` undefined token | Sub4 F1 |
| F12 | Edge works/broken hue-only + raw hex | Sub4 F2 |
| F13 | `handleProbeInCluster` Target/Scheme unbound | Sub2 F1 |
| F14 | No in-cluster kill-switch | Sub2 F2 |
| F15 | not-tested skip dedup undercount | Sub3 F5 |
| F16 | Dead `runInCluster` skips `response.ok` | Sub4 F5 |
| Accepted | MCP no-consent, tab autoprobe, dead branch | Sub2/Sub3/Sub4 |

## 5. Triage of disputed / rejected claims

**Fix (recommended this PR or fast-follow):** F1 (at least consume `route.status.parents`), F4 (`IsSynced` gate — the technique already exists in the PR), F11 (one-line token fix).

**Discuss (product/honesty decision, not obviously a bug):** F2 (is a real `reached` intended to be green `healthy`? — the load-bearing honesty call, currently incidental/untested), F5 (should a Service owner learn who routes to them across an RBAC boundary?), the MCP no-consent design.

**Skip (verified non-issues — do not "fix"):**
- **Cross-namespace `name.ns.svc` DNS parsing** — correct; `ndots:5` appends `cluster.local`. (Sub2 adjudicated)
- **Path traversal in the probe path** — handled; `path.Clean("/"+p)` on the mutating endpoint and `httpPath()` on the trace path. (Sub2 adjudicated)
- **HTTP redirect SSRF** — redirects captured, never followed (`http.ErrUseLastResponse`). (Sub2)
- **Command injection in the Job** — exec-form `Command`, no shell; `FallbackCommand` shell-quotes. (Sub2)
- **Attacker-controlled probe image** — image sources are operator-only; `selfPodImage` refuses to guess in multi-container pods. (Sub2)
- **`InClusterResultKey` collisions** — `route\x00target\x00targetNamespace` keyed identically by producer/consumer; multi-port and cross-ns siblings stay distinct. (Sub3, re-verified)
- **apiserver-proxy blessing in-cluster reachability** — `classifyHopProbes` returns `real=0` for proxy-only hops; `!anyRealPass → unknown`. (Sub3, re-verified)
- **Scale-to-zero false-condemnation** — stays `warning` (→ degraded) even in the uncertain/RBAC/cache case; benign end-to-end. (Sub3, re-verified)
- **NetworkPolicy unevaluated → overclaim; probe-skipped-as-failure; cache/RBAC-unknown reported as OK; sibling cross-condemnation** — all structurally guarded. (Sub3)
- **`Capability` omits `delete jobs`** — not a leak; TTL controller + `activeDeadlineSeconds` guarantee cleanup. (Sub2, downgraded)
- **Local RFC1918 probes from Radar's in-cluster identity** — GET-only, no creds, IMDS blocked, response only to operator; Radar's normal capability. Worth a docs note, not a fix. (Sub2, downgraded)
- **Two-place verdict (Go + `reachVerdict.ts`) is two engines that can flip healthy↔broken** — downgraded: TS floors tone on `trace.verdict` and defers to `trace.headline`; shared constants are CI-pinned. Real residual is drawer(`coverageBannerTone`)-vs-tab(`reachVerdict`) tone/headline having no cross-check test. (Sub4, downgraded)
- **Public `@skyhook-io/k8s-ui` export break; CRD kind-collision misfire; stale-probe-against-wrong-resource race** — all verified safe/additive/guarded. (Sub4)
- **NetworkPolicy engine correctness** (policyTypes defaulting, named-port semantics, additive union, `isZeroCIDR`, `nonNilPods` aliasing) — adversarially traced, held up. (Sub1 §4)

## 6. Cross-area risks a directory-scoped reviewer would miss

1. **F1 is only fully visible across two areas.** Path-semantics (Sub1) sees the static over-claim; probe-security (Sub2) sees that `fqdnDialTarget` dials the Service directly. Neither alone shows that the live probe *confirms* the static lie because it never traverses the Gateway. That combination is what makes it Medium rather than a documented simplification.
2. **F2's blast radius is on the MCP surface, not the UI.** Sub3 found `reached→healthy`; Sub4 found the frontend `reachVerdict` re-tones `reached` as ✓-with-caveat. The seam: MCP agents consume the raw `verdict` field with **no** such re-derivation, so the overclaim lands squarely on the agent-facing contract the drawer/tab partly mask.
3. **Two tone/headline sources with no cross-check test.** Drawer (Go `trace.headline` + `coverageBannerTone`) vs tab (`reachVerdict.ts`) can phrase/tone the same `Trace` differently. Bounded today (drawer doesn't probe), but there is no test asserting they agree for a probed trace — a latent divergence as either side evolves.
4. **Consent is UX-only; authz is server-side.** REST/MCP/CLI all reach the mutating probe without the dialog. Correct as designed, but the security story lives entirely in `requireCloudRole` + impersonation + RBAC — if any of those regress, there is no second gate.

## 7. Open questions & recommended verification

1. **Gateway API (F1):** is the intent to lean on the live probe? If so, note it can't catch a Gateway-level refusal (it bypasses the Gateway). Recommend consuming `route.status.parents` conditions at minimum.
2. **F2:** decide and test whether a real `reached` ships `healthy`; reconcile with the "never overclaims" copy and the MCP `verdict` contract.
3. **Verification (needs a cluster — not run here):** (a) `make gitops-demo`-style fixture with a cross-namespace grant-less HTTPRoute → confirm the trace over-claims and the in-cluster probe confirms it; (b) an app returning 404 on all routes → observe `verdict=healthy` in the MCP `diagnose` output; (c) an Ingress on a controller-less kind cluster → confirm no `ingress:no-controller` warning; (d) light-mode render of the reachability edges + accent links (F11/F12).
4. **F5:** product call on cross-namespace referrer disclosure.
5. Confirm released binaries always carry a published image tag so the default probe image resolves (else first-run `ImagePullBackOff`, handled but poor UX). (Sub2 Q2)

## 8. Subordinate reports

- [01 — Kubernetes path semantics](01-path-semantics.md)
- [02 — Probe correctness & mutation security](02-probe-security.md)
- [03 — Honesty & verdict model](03-honesty-model.md)
- [04 — UI, API, MCP & product contract](04-ui-contract.md)

## 9. Scoreboard

**By severity (consolidated):**

| Severity | Count | IDs |
|---|---|---|
| Critical / High | 0 | — |
| Medium | 2 | F1, F2 |
| Low-Medium | 3 | F3, F4, F5 |
| Low | 8 | F6, F7, F8, F9, F10, F11, F13, F15 |
| Low (design/a11y/UI) | 2 | F12, F14 |
| Info / Cleanup / Accepted | 4+ | F16, MCP-no-consent, tab-autoprobe, dead-branch |

**By triage outcome:**

| Outcome | Count | IDs |
|---|---|---|
| Fix | 3 | F1 (partial), F4, F11 |
| Discuss | 3 | F2, F5, MCP-no-consent |
| Fix-or-accept (low) | 10 | F3, F6, F7, F8, F9, F10, F12, F13, F14, F15, F16 |
| Skip (verified non-issues) | ~18 | see §5 |

**Overall:** no blocking defects. Approve with the Gateway-API honesty gap (F1) and the `reached→healthy` verdict decision (F2) raised to the author as the two items that most undercut the feature's stated thesis; the rest are low-severity hardening and polish.
