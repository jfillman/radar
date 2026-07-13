# PR 1037 — Subreview 3: Honesty & Verdict Model (adversarial)

## Scope & SHAs

- **Base:** `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- **Head (inspected):** `d1face5b31572eb94afcd29920b93684f42281d3`
- Read-only; no source/test/config touched. Only this file written.

### Files inspected at head
- `internal/trace/trace.go` (verdict assembly, `computeVerdict`, `reviseVerdictWithProbes`, `classifyHopProbes`, unknown classification)
- `internal/trace/coverage.go` (coverage projection, `CoverageVerdict`, `CoverageHeadline`, `computeDiagnosis`, route identity, in-cluster fold, `worstOutcome`, `recountCoverage`)
- `internal/trace/entries.go` (hop construction, scale-to-zero / selectorless / endpointSource markers, Ingress/Route fan-out, `buildPodsHop`)
- `internal/trace/probes.go` (`probeIngress`, `probeService`, path handling, vantage skips)
- `internal/reachability/incluster.go` + `internal/server/reachability_run.go` + `internal/server/trace_handlers.go` (producers/callers, key parity, probe defaults)
- `internal/k8s/detect.go` §540–645 (scaled-to-zero detection severity)
- Tests: `trace_test.go`, `coverage_test.go`, `incluster_request_test.go`, `incluster_results_test.go`, `perpod_test.go`, `predicate_sync_test.go`, `trace_speed_test.go`

---

## 1. Altitude / design assessment — is the verdict model honest-by-construction?

**Mostly yes, and unusually so.** The model separates three axes that most tools conflate, and that separation is the source of its honesty:

1. **Outcome** (`verified` / `reached` / `server-error` / `unreachable` / `not-tested`) — what a probe observed.
2. **Confidence** (`real` vs `indirect`) — *how* it was learned. The apiserver-proxy path is structurally quarantined: `routeFromProbes` (coverage.go:1429) files apiserver probes as `indirect` + `Localization` only, and `classifyHopProbes` (trace.go:815–823) returns `real=0` for a proxy-only hop so it can **never** set the internal verdict. This directly defuses the "local probe blesses in-cluster reachability" attack.
3. **Coverage** (`Tested/Passed/Failed/Skipped`) with a skip taxonomy (`coverage` / `vantage` / `benign`).

The shipped `verdict` is deliberately re-collapsed through `CoverageVerdict` (coverage.go:837) in **both** entry points (`BuildTraceWithOptions` trace.go:522, `ApplyInClusterResults` coverage.go:358), so REST / UI / MCP read one value. The two genuinely honest corrections are:
- `!anyRealPass → unknown` (a proxy-only "reach" is not a green), and
- `c.Tested==0 → unknown` (probed but nothing testable is not a green).

The unknown verdict is further split (`by-design` vs `investigate`, trace.go:1064) so "I couldn't check" reads as attention-worthy, and endpoint-unverifiability (`selectorless`, `endpointSource==unknown`) **downgrades even a degraded verdict to unknown** (trace.go:1049). RBAC-redacted and cache-unknown backends are explicitly *not* condemned (`branchKnownBreak`, coverage.go:1351–1366). Scale-to-zero is carried as a first-class benign state end-to-end. Sibling independence (one broken Ingress/route does not condemn the others) is implemented in both the static path (`computeVerdict` multi-branch, trace.go:913) and the probe path (`reviseVerdictWithProbes`, trace.go:615). This is a strong, defensible design.

**Where the model is *not* expressive enough to be fully honest** — the verdict word has only four values (`healthy/degraded/broken/unknown`), so two real distinctions get flattened into `healthy`:

- **`reached` (TCP-only / 3xx / 4xx) collapses into `healthy`** even though "a port opened / the server 404'd" is not "the route works." (Finding 1.)
- **`healthy` is emitted for a never-probed static trace** — the verdict word outruns the evidence, mitigated only by subtext. (Finding 4.)

Both are the *sharpest* tensions with the PR's stated thesis ("never overclaims"). They are the loudest signal (banner color / the `verdict` field MCP agents key on), while the honest nuance lives one level down in `Headline`/`Routes`. That is an altitude problem: the model is honest at the route level and slightly over-confident at the verdict level. Findings below are ordered by how much they undercut the honesty claim.

---

## 2. Findings (severity order)

### F1 — MEDIUM (OVERCLAIM): a real `reached` route (TCP-only / 3xx / 4xx) ships `verdict = healthy`

**Where:** `anyRealPass` (coverage.go:933–943) counts `OutcomeReached` as a pass; `CoverageVerdict` (coverage.go:867–882) returns `VerdictHealthy` whenever a real pass exists and `c.Failed==0`. `worstOutcome` (coverage.go:1519–1522) yields `OutcomeReached` for a bare TCP/TLS success or a 3xx/4xx.

**Scenario:** Laptop or in-cluster, direct dial to an Ingress host that returns **HTTP 404** (misrouted path, wrong backend), or a Service port where **only TCP connected** and HTTP was skipped/unverified.

**Resulting verdict:** `verdict = "healthy"`. `Headline`/`singleRouteHeadline` (coverage.go:2134) honestly says *"Reachable - server reached, route not verified"*, but the top `verdict` field — the value the UI colors the banner from and the value MCP agents branch on — is green `healthy`. A 404-on-every-route app, or an app where nothing listens on HTTP but the TCP port is open, reads as healthy.

**Evidence:**
```go
// coverage.go:933
func anyRealPass(routes []RouteResult) bool {
    for _, r := range routes {
        if r.Confidence != ConfidenceReal { continue }
        if r.Outcome == OutcomeVerified || r.Outcome == OutcomeReached { return true } // ← reached counts
    }
    ...
}
// coverage.go:872 (t.Verdict==healthy, anyRealPass true, no failures)
    return VerdictHealthy
```
The tests pin only `OutcomeVerified → healthy` (`TestCoverageVerdict_RealVerifiedIsHealthy`, coverage_test.go:524); no test asserts what a *real* `OutcomeReached` produces — the gap is unguarded.

**Why it matters for honesty:** the whole feature promises "one honest verdict." A 404 or bare-open-port is exactly the "the path looks up but doesn't actually serve" case an operator most needs distinguished from green. The route detail is honest; the headline verdict is not.

**Fix:** introduce a `reachable`/`caution` tier (amber) distinct from `healthy` when the best real evidence is `reached` rather than `verified`, i.e. in `CoverageVerdict`, when `c.Failed==0 && anyRealPass && !anyRealVerified(t.Routes)` return `VerdictDegraded` (or a new tier) instead of `VerdictHealthy`. Reserve `healthy` for at least one real HTTP 2xx. At minimum, add a test pinning the intended verdict for a real `reached`-only trace so the decision is explicit rather than incidental.

---

### F2 — MEDIUM (route-identity / mild overclaim): a route labeled `host/path` can read `verified`/`reached` on evidence that never exercised that path

**Where:** `probeIngress` (probes.go:1017–1024, 1129) probes each host with a **single** `path` (`opts.ProbePath`, default `"/"`) — it does *not* iterate the rules' declared paths. `entryProbesForHosts` (coverage.go:1872–1886) attributes a host's probes to a backend's routes by **host only**. Ingress fan-out emits **one hop per *unique backend Service*** (entries.go:1155 comment "every unique backend Service … one Service + Pods hop pair for each"), so `routeLabelsForBackend` (coverage.go:1616) folds every host+path that selects that backend into **one** `RouteResult`.

**Scenario A (label vs evidence):** Ingress `a.com/api → api-svc`. The front-door probe dials `http://a.com/` (not `/api`), and the backend Service hop is dialed on ClusterIP with path `/`. The `RouteResult.Route` is `"a.com/api"` but no probe ever requested `/api` end-to-end through the ingress. In-cluster the backend Service `/` dial can be a real HTTP 2xx → the route `"a.com/api"` reads **`verified`** though only `ClusterIP:port/` was verified, bypassing both the ingress and `/api`.

**Scenario B (path collapse):** Two rules `a.com/x → svc` and `b.com/y → svc` share one backend hop → one route `"a.com/x, b.com/y"` with one outcome. Distinct paths are neither probed nor separately reported.

**Mitigations already present (why this is MEDIUM not HIGH):** `demoteSharedFrontDoor` (coverage.go:1226) caps a front-door `/` 2xx to `reached`, so the shared `/` result cannot *alone* verify a specific-path route — the `verified` can only come from the backend Service's own probe. And the **in-cluster fold** (`RunInClusterTests`, incluster.go) dials `InClusterRequest.Path` (the declared `/api`) and marks `PathGuessed` routes non-folding. So the static-probe path is where the label out-runs the evidence.

**Evidence:**
```go
// probes.go:1129 — one path for the whole host, regardless of declared rule paths
out = append(out, budgetSkipIfExhausted(ctx, probe.HTTP(hctx,
    fmt.Sprintf("%s://%s%s", scheme, host, path), host, vantage), vantage))
// coverage.go:1877 — a backend inherits ALL of its host's front-door probes
if len(hosts) == 0 { return entry.Probes }
```

**Why it matters:** the route matrix presents `host/path` identities as if each was tested. For a shared backend serving different apps per path, a `verified`/`reached` on the label is a claim about a path that was never requested (statically). It is honest about reachability of the *backend*, dishonest about the *route*.

**Fix:** either (a) probe each rule's declared path at the front door (not just `opts.ProbePath`), or (b) when the front-door probe path ≠ the route's declared path, cap that route's static outcome at `reached` and annotate "tested `/`, not `<declared path>`" — mirroring the `demoteSharedFrontDoor` honesty guard. The existing `attachPathDivergenceFindings` (probes.go:290) hook is the natural place.

---

### F3 — LOW/MEDIUM (order-dependence): `worstOutcome` returns on the first failing/degraded probe, not the worst

**Where:** `worstOutcome` (coverage.go:1470–1527).

**Scenario:** A route's probe set contains both a **degraded** probe (HTTP 5xx, `ToneDegraded`) and a **transport failure** (TCP refused, `!OK`). The loop returns `OutcomeServerError` the instant it sees the degraded probe and `OutcomeUnreachable` the instant it sees the failure — whichever appears **first in slice order** wins. A degraded ordered before a failure yields `server-error` (reached), hiding the `unreachable`.

**Evidence:**
```go
// coverage.go:1473
for _, p := range probes {
    if !p.OK || p.Tone == probe.ToneUnhealthy { return OutcomeUnreachable, ... }
    if p.Tone == probe.ToneDegraded            { return OutcomeServerError, ... }
    ...
}
```
The doc comment claims a precedence ("any transport failure → unreachable; else a degraded layer → server-error"), but the code implements *first-hit*, not *worst*. Outcome is therefore non-idempotent under probe reordering.

**Practical impact (why LOW):** the realistic co-occurrence in one route set is a front-door 5xx + a backend TCP-refused, which is a coherent 502/`upstream` story, so the mislabel is usually semantically benign. But it is a latent honesty bug the moment probe append order changes or a new degraded layer is added, and it contradicts the stated precedence.

**Fix:** scan all probes and pick by precedence (`unreachable` > `server-error` > `verified` > `reached` > `not-tested`) instead of returning on first hit.

---

### F4 — LOW (verdict word outruns evidence): a static (`probe=false`) trace ships `verdict = healthy`

**Where:** `BuildTraceWithOptions` computes the internal verdict as `healthy` when the static walk finds no findings (trace.go:456–461); with no probing `t.Coverage == nil`, and `CoverageVerdict` returns `VerdictHealthy` for the `c == nil` case (coverage.go:855–860). The drawer calls with `Probe: queryTrue(r, "probe")` (trace_handlers.go), i.e. `false` by default.

**Scenario:** Open the trace drawer on a well-configured Service that was never probed.

**Resulting output:** `verdict = "healthy"` while `Headline = "Configuration only - not yet tested"` (coverage.go:1968). The banner is (presumably) green even though nothing was actively verified — the one place the verdict word says "healthy" for an unverified path. This is the mirror of F1 at the config layer.

**Assessment:** defensible (the static checks *did* pass) but in direct tension with the "never bless an unverified path" thesis; the honest read would be `unknown`/neutral with the same headline. LOW because it is the explicit static mode and the subtext is unambiguous.

**Fix (optional):** return a neutral/unknown verdict (not `healthy`) when `c == nil` (no probe attempted), letting `Headline` carry "configuration only." Alternatively confirm the UI renders `healthy + "not yet tested"` as neutral, not green.

---

### F5 — LOW (count): not-tested skip dedup keys on host only → undercount

**Where:** `recountCoverage` (coverage.go:199–243). `skippedRouteKeys` is keyed by bare host (`routeHostKey`), and an `OutcomeNotTested` route is suppressed from the `skipped++` tally when its host matches any skip key.

**Scenario:** Two distinct not-tested routes to the **same host** (e.g. `shop.example.com/a` and `shop.example.com/b`, both DNS-only) with one host-level skip row → `Coverage.Skipped` counts **1**, not 2. The "N not tested" footnote under-reports the coverage gap.

**Impact:** cosmetic count drift; never inflates `Passed`/`Failed`, so it can't produce a false green. LOW.

**Fix:** key the dedup on `host+path` (route identity) rather than host alone, or count routes and skip-rows in disjoint spaces.

---

### F6 — NIT (dead code): unreachable `broken` branch in `CoverageVerdict`

`CoverageVerdict` (coverage.go:877) has `if c.Passed == 0 { return VerdictBroken }` inside the `c.Failed > 0` block, but that block is reached only after `!anyRealPass` returned early (coverage.go:867). `anyRealPass == true` implies at least one `verified`/`reached` route, which `recountCoverage` counts into `c.Passed`, so `c.Passed == 0` cannot hold here. Harmless, but the dead branch invites a future misreading that a real-pass trace can still return `broken` from this path. Consider removing or commenting.

---

## 3. Investigated claims — rejected / downgraded (with evidence)

- **Scale-to-zero false-condemnation — REJECTED (robust).** The honesty hinges on the finding being a **warning**, and it is: `detect.go` §568–636 emits `ScaledToZeroReason`/`ScaledToZeroFingerprint` at `Severity: warning` for a confirmed 0-replica backing workload, and the **uncertain** case (Rollout CRD unreadable / RBAC / cache) *also* stays warning rather than escalating (detect.go §625+). So `computeVerdict` sees a warning → degraded, never broken. `markBenignScaleZero`/`isScaleZeroFinding` match **both** the fingerprint and the `problem:<reason>` grouped form (coverage.go:765, 1134), closing the issue-grouping gap. `CoverageVerdict` softens broken→degraded when `allFailuresBenign && !hasNonBenignCriticalFinding` (coverage.go:850), and the headline reads "intentionally scaled to 0" (coverage.go:2027). End-to-end honest.

- **`InClusterResultKey` collisions — REJECTED (sound).** Key = `route \x00 target \x00 targetNamespace` (coverage.go:252); producer (incluster.go:112) and consumer (coverage.go:272) key identically. Multi-port routes get distinct `Target` (`svc:80` vs `svc:9090`); same-named Services across namespaces are separated by `targetNamespace` (defended by `backendRefMatches`, coverage.go:1826, and `passedBackends` name+ns keying, coverage.go:470). No clean probe of one route can vouch for a sibling.

- **apiserver-proxy blessing in-cluster reachability — REJECTED (structurally guarded).** `classifyHopProbes` returns `real=0` for proxy-only hops (trace.go:815); `routeFromProbes` files proxy probes as `indirect`/localization (coverage.go:1436); `CoverageVerdict` returns `unknown` on `!anyRealPass` (coverage.go:867). ExternalName from a laptop is explicitly downgraded to `indirect` (coverage.go:1013, pinned by `TestComputeCoverage_ExternalNameLocalVantageIsIndirect`).

- **NetworkPolicy unevaluated → overclaim — REJECTED.** A `would-deny` is a **warning** on the Pods hop → degraded, not healthy, until *real* in-cluster traffic contradicts it (`reconcileInClusterPolicy`, coverage.go:366, port-scoped via `realPassCoversDenyPort`). An apiserver-proxy reach does not clear it (proxy path is `indirect`, never a real pass). Honest.

- **Probe-skipped treated as failure — REJECTED.** `classifyHopProbes`/`branchProbeVerdict` ignore skipped rows; the entry-unreachable escalation guards on `!hopHasSkippedProbe` (trace.go:627) so a partly-testable front door is not condemned whole; `anyProbeReached` requires `!Skipped && OK` (trace.go:535).

- **Cache-cold / RBAC-denied reported as OK — REJECTED.** `cacheReady` gate → `unknown`/`investigate` (trace.go:391); `endpointSource==unknown` and `selectorless` downgrade even degraded → `unknown` (trace.go:1049); cross-namespace-redacted and `endpointSource==unknown` backends are *not* condemned as broken (coverage.go:1351). "Couldn't check" reads as unknown, not OK and not FAIL.

- **Sibling one-broken-condemns-whole / one-working-blesses-whole — REJECTED.** Multi-branch verdict reserves `broken` for entry-failure or *every* live branch broken; partial is `degraded` anchored on the culprit (trace.go:913–1006); `nonMissingRefFindings` scopes a sibling-route missing-ref out of the subject's verdict (trace.go:1018); drained (weight-0) backends are excluded from the tally (trace.go:949).

---

## 4. Questions & coverage gaps

1. **F1 is the load-bearing question:** is a real `reached` (TCP-only / 3xx / 4xx) intended to ship as `healthy`? If yes, that decision should be pinned by a test and reconciled with the "never overclaims" copy; if no, `CoverageVerdict` needs a `reached`-only amber tier. This is the single most consequential honesty call in the PR and it is currently *incidental* (no test fixes it).
2. **F2:** confirm the intended contract of a `RouteResult.Route` label for a shared-backend multi-path Ingress under **static** probing — does "verified" on `host/api` claim the path works, or only that the backend answers? The UI/MCP wording should match whichever is intended.
3. Does the frontend banner render `verdict=healthy` + `Headline="Configuration only - not yet tested"` (F4) as green or neutral? If green, the static drawer overclaims.
4. `worstOutcome` order (F3): is probe append order guaranteed stable across builds today? Even if so, the first-hit-vs-worst discrepancy should be closed before a new degraded-tone layer is added.
5. `BrokenAt = -1` while `CoverageVerdict = degraded/broken` (when the failure is a coverage-layer secondary-port failure with no static finding): consumers keying on `BrokenAt`/`BrokenRoute` see "nothing broken" beside a non-green verdict. The design says read `Routes`, but the internal `BrokenAt` inconsistency is worth a note in the wire contract.
