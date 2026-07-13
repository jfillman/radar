# PR #1037 review: evidence honesty, route identity, and verdict reduction

## Scope

- Base: `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- PR head: `d1face5b31572eb94afcd29920b93684f42281d3`
- Primary files: `internal/trace/trace.go`, `internal/trace/coverage.go`, `internal/trace/incluster_results_test.go`, `internal/trace/coverage_test.go`, and `internal/trace/trace_test.go`
- Producer/consumer seams inspected where needed: `internal/reachability/incluster.go`, `internal/server/reachability_run.go`, `internal/trace/entries.go`, and `internal/trace/probes.go`
- Method: read-only inspection from the exact Git objects above. I did not review the moving `main` worktree as a substitute for the PR head, and I did not execute or modify the PR checkout.

## Altitude assessment

The PR is aiming at the right product property: never turn partial, indirect, or vantage-specific evidence into a confident end-to-end claim. It has several good local safeguards, but the overall architecture does not yet enforce that property.

The fundamental problem is that four different concepts are compressed into one mutable `Trace`:

1. declared/static configuration health;
2. the set of intended traffic routes;
3. observations of individual path segments from particular vantages; and
4. the final operator-facing reachability verdict.

`computeVerdict`, `reviseVerdictWithProbes`, `buildRoutes`/`worstOutcome`, `CoverageVerdict`, and `ApplyInClusterResults` each reduce a different approximation of those concepts. They also use different units: hops, unique backend Services, backend ports, probe rows, and host/path labels. The code then tries to restore consistency by clearing and recomputing selected fields. That is why the implementation can be locally defensive and still produce a globally false answer.

The most important architectural correction is to make the traffic intent explicit and immutable:

```text
RouteIntent
  stable ID: entry + listener/parent + host + match + backend namespace/name/port
  segments: front door -> route match -> Service port -> endpoint
  static facts: per segment
  observations: per segment, target, vantage, and attempt
  final reduction: pure function over the above
```

Backend analysis can still be deduplicated internally, but deduplicating analysis must not deduplicate the route intentions reported to the user. A Service-direct Job result should attach to the Service segment. It must not replace an observation of the entry/front-door segment or certify a host/path route that it bypassed.

## Invariant matrix summary

This is the compact truth table I used. “Expected” is the minimum honesty invariant, not necessarily the exact product wording.

| State / evidence | Expected invariant | PR-head behavior |
|---|---|---|
| Static healthy, no probe attempted | Keep the static assessment and say “not tested”; do not infer an attempted coverage gap | A Service remains `healthy`, while a healthy Ingress/Route with backend branches becomes `unknown` because branches manufacture `route not actively tested` skips |
| Static degraded/broken, no probe | Preserve the known static fault; do not count it as an active test | Usually preserved when an issue finding exists, but static known breaks are also counted in `Coverage.Tested`; a confirmed nil backend without an issue-cache finding can headline “Unreachable” while shipping `unknown` |
| Indirect/API-server reach or failure | Localization only; never certify or condemn the real dataplane | Route headline mostly qualifies it correctly, but `Diagnosis` can promote an indirect failure as the primary route failure |
| Real TCP/TLS or HTTP 3xx/4xx | “Reached, exact route unverified”; whether that earns a green top-level status must be an explicit product decision | Counted as `Passed` and can produce `VerdictHealthy`; the caveat survives only in headline/reason |
| Real HTTP 2xx on the exact intended route | May verify that route only; unknown siblings and untested segments remain unknown | A direct Job 2xx to the backend Service is treated as exact-route verification even though it bypasses the Ingress/Gateway; a sticky `UnknownClass` can also leave `VerdictUnknown` beside a verified headline |
| Real server error / unreachable | All intended routes failed => broken; some failed => degraded; reduction must be independent of probe order | Works for separately represented branches, but same-backend routes are collapsed; `worstOutcome` returns the first bad observation and is order-dependent |
| Skipped / not attempted | Gap belongs to the exact route segment and attempt that skipped | Host-only dedupe/pruning lets one backend pass remove or suppress sibling host/path gaps |
| Partial readiness | Serving replicas mean degraded, not total outage | Correctly capped to degraded when `ready > 0` |
| Intentional scale-to-zero | Dormant/benign, not outage, unless a separate non-benign critical exists | Generally handled correctly |
| RBAC/cache uncertainty | Unknown only for affected route(s); known faults on other routes remain known | Uncertainty is global (`UnknownClass` / endpoint scan), so exact live evidence cannot resolve a covered route and attribution cannot be route-local |
| Reapplying the same/no in-cluster result | Idempotent: finalized trace must not change | `ApplyInClusterResults(tr, empty)` can clear a probe-derived verdict/reason and prune skips without any new evidence |

## Findings

### 1. High: a Service-direct Job can turn an unreachable Ingress/Gateway into “healthy”

Locations:

- `internal/reachability/incluster.go:60-71`
- `internal/trace/coverage.go:264-285`
- `internal/trace/coverage.go:327-358`
- `internal/trace/trace.go:621-632`

`RunInClusterTests` explicitly dials `r.Target`, which is the backend Service (`name:port` or `name.namespace.svc:port`). It carries the original Host/path as an HTTP request, but it does not traverse the Ingress/Gateway address or controller. This is useful backend-segment evidence; it is not end-to-end evidence for the declared front door.

`ApplyInClusterResults` then replaces the entire `RouteResult` with a result derived only from that Job. It subsequently recomputes the static verdict and coverage. An exact failure sequence is:

1. The Ingress front-door TCP/HTTP probe fails on a public address.
2. `reviseVerdictWithProbes` correctly sets `broken` at the entry (`trace.go:621-632`).
3. The backend Service answers the throwaway Job with HTTP 200.
4. `ApplyInClusterResults` replaces the route’s entry failure with `verified/real` from the Service-direct Job (`coverage.go:276-284`).
5. `computeVerdict` sees no static finding, returns healthy, and `CoverageVerdict` ships healthy.

The returned hop matrix can still contain the failed front-door probe while the banner/headline says healthy. The Job also cannot prove Gateway matching, Ingress controller programming, TLS termination, rewrite/filter behavior, or the actual external network path.

Concrete fix:

- Split observations by route segment. Fold the Job result onto the Service/backend segment only.
- Never replace the front-door observation with a backend observation.
- For an end-to-end route verification, probe the actual entry address/listener with the original Host/SNI and a concrete match path, and preserve the vantage qualification.
- Add a regression test: real front-door failure + backend Job 200 must remain broken/degraded at the entry and must never produce an all-green route.

### 2. High: “route” identity is actually unique backend/port identity, collapsing distinct host/path rules and corrupting counts and attribution

Locations:

- `internal/trace/entries.go:1376-1400`
- `internal/trace/entries.go:1736-1770`
- `internal/trace/coverage.go:1030-1087`
- `internal/trace/coverage.go:1203-1213`
- `internal/trace/coverage.go:1616-1663`
- `internal/trace/coverage.go:1791-1816`
- `internal/trace/trace.go:925-997`

Ingress and Gateway API traversal deduplicate backend Services before constructing branches. `buildRoutes` then gathers every host/path label selecting that backend and joins them into one string (`strings.Join(labels, ", ")`). If more than one Service port is involved, it replaces even that joined route label with `backend:port`. `firstRuleHostPath` chooses only the first matching request for the in-cluster Job.

Consequences:

- `/web -> app:80` and `/admin -> app:80` are one `RouteResult`, one coverage count, one in-cluster request, and one result key. Testing the first path is reported for both.
- Two hosts using the same backend collapse into one result even though DNS, TLS, listener attachment, and routing can differ.
- HTTPRoute method/header/query matches are not represented in `RouteRule` at all, so distinct Gateway API matches can share the same identity.
- A weighted rule with two backends is reported as two “routes”, while two rules with one shared backend are reported as one. The denominator therefore changes with backend reuse, not with user-visible traffic intentions.
- The missing-reference reducer mixes a count of entry findings with a denominator of unique backend branches (`trace.go:925-982`). For example, `/good -> svc:80` and `/bad -> svc:missing-name` share one backend branch. The missing-port finding counts that single branch as broken, so the whole Ingress can become `broken` even though `/good` still works. Coverage likewise matches the missing-ref by backend name and marks the aggregate `/good, /bad` result unreachable.

`InClusterResultKey(route, target, namespace)` is correctly namespaced and NUL-delimited, but it cannot recover identity that was already collapsed before the key was built.

Concrete fix:

- Introduce one `RouteIntent` per rule/match/backendRef/port. Give it a stable structured ID containing entry UID/ref, parent/listener, hostname, match type/value (including method/header/query where supported), backend namespace/name, and port.
- Deduplicate backend lookup/probing work behind those intentions, then project the observations back to every exact intent they actually cover.
- Do not use an empty port scope to mean both “all ports” and “declared named port did not resolve”; return a typed unresolved-port state.
- Add tests for same backend+port across two paths, same backend across two hosts, one valid and one invalid port on the same Service, weighted sibling backends, and HTTPRoute header/method matches.

### 3. High: `ApplyInClusterResults` is not idempotent and erases existing probe-derived verdicts even when no Job result was folded

Locations:

- `internal/trace/coverage.go:264-285`
- `internal/trace/coverage.go:292-340`
- `internal/trace/trace.go:586-735`
- `internal/trace/incluster_results_test.go:12-56`

After the result loop, `ApplyInClusterResults` unconditionally clears `Reason` and calls `computeVerdict` whenever `UnknownClass` is empty. `computeVerdict` reads findings, but it does not read probe outcomes. The normal build path runs `reviseVerdictWithProbes` afterward; the in-cluster fold does not.

Therefore `ApplyInClusterResults(tr, emptyMap)` can change a fully finalized trace:

- an entry made `broken` by unanimous real probe failures is recomputed as statically healthy;
- a probe-derived `degraded` verdict is cleared;
- the prior reason and `BrokenRoute` are removed;
- `CoverageVerdict` often softens a remaining real route failure to `unknown`, because its `!anyRealPass` check precedes its failed-route check.

This is not theoretical in the request flow: `RunInClusterTests` returns no foldable result when the client is unavailable, the Job fails to start, the cap is reached, the path is guessed, the throwaway-pod probe fails, or every result is skipped. The server still calls `ApplyInClusterResults`.

The current tests reinforce the unsafe operation by constructing deliberately stale verdicts and calling `ApplyInClusterResults(tr, nil)` to clear them. They do not include a finalized trace whose verdict legitimately came from `reviseVerdictWithProbes`.

Concrete fix:

- An empty/no-change fold must be a no-op.
- Track whether an exact observation or finding changed; clear only the reason attributable to that exact resolved condition.
- Recompute with one pure reducer over static facts plus all retained observations. As a narrow patch, rerun `reviseVerdictWithProbes` after `computeVerdict`, but that alone does not solve Finding 1’s segment replacement.
- Add an idempotence test over a finalized trace and cases for capped, auth-failed, guessed-path, and failed throwaway-Job outcomes.

### 4. Medium: skip reconciliation is host-wide and can hide untested sibling paths/ports

Locations:

- `internal/trace/coverage.go:292-313`
- `internal/trace/coverage.go:199-242`
- `internal/trace/coverage.go:1909-1940`

After any real pass, `ApplyInClusterResults` builds `resolvedHosts` and removes every vantage skip whose target reduces to that host. It does not limit pruning to routes changed by this fold, to the same path/port, or even to the same path segment. `routeHostKey` intentionally strips schemes, ports, and paths.

This creates two false-coverage cases:

1. A Service-direct Job pass removes the “could not reach the front door from here” skip even though the Job bypassed that front door.
2. A pass for `shop.example.com/web` removes the gap for `shop.example.com/admin` (and potentially a different listener/port).

The same host-only key is used in `recountCoverage` to suppress `OutcomeNotTested` rows. One host-level skip can therefore stand in for several intended routes, undercounting `Coverage.Skipped`.

Concrete fix:

- Key gaps by stable route-intent ID plus segment and attempt/vantage, not bare host.
- Remove a gap only when new evidence covers the same route segment.
- Keep front-door and backend gaps separate even when they share Host text.

### 5. Medium: no-probe static behavior differs by resource shape because “not attempted” is inferred from the presence of branches

Locations:

- `internal/trace/coverage.go:992-1027`
- `internal/trace/coverage.go:1030-1092`
- `internal/trace/coverage.go:1966-1985`
- `internal/trace/coverage.go:837-871`
- `internal/trace/trace_test.go:35-100`

A static healthy Service has no probes, `routesByPort` returns no routes, coverage remains nil, and the shipped verdict stays healthy. A static healthy Ingress/HTTPRoute with backend branches also has no probes, but each branch emits `RouteSkip{Reason: "route not actively tested"}`. That creates `Coverage{Tested:0, Skipped:N}`, and `CoverageVerdict` changes the same static assessment to unknown.

Both headlines say “Configuration only - not yet tested.” Only the verdict changes, based on flat trace shape rather than evidence. This also contradicts the `CoverageVerdict` comment that no active probing leaves the static assessment standing.

Concrete fix:

- Carry explicit attempt metadata (`ProbeAttempted`, or an attempt record) from `Options.Probe` into coverage.
- Distinguish “not attempted” from “attempted but skipped.” Do not manufacture coverage skips merely because no probe rows exist.
- Apply the same policy to Service, Ingress, Route, Gateway, selectorless, and ExternalName subjects.

### 6. Medium: a sticky global `UnknownClass` can coexist with an exact real verification, leaving verdict and headline contradictory

Locations:

- `internal/trace/coverage.go:327-358`
- `internal/trace/coverage.go:837-882`
- `internal/trace/incluster_results_test.go:59-91`

If `UnknownClass` is non-empty, `ApplyInClusterResults` refuses to recompute the verdict even after a real route result is folded. `CoverageVerdict` then returns the existing unknown immediately. The route and headline can say `verified/real` and “Reachable - verified,” while the top-level verdict remains unknown.

The test at `incluster_results_test.go:86-90` explicitly pins this behavior for a by-design unknown. For a selectorless Service, however, a successful direct ClusterIP request is real evidence that the Service path answered at that moment. It does not reveal the manually managed endpoint topology, but that is a separate configuration-visibility fact. Likewise, a successful Service path can be known even if pod listing is RBAC-redacted.

Concrete fix:

- Separate `StaticAssessment`/visibility from `ReachVerdict`, or localize uncertainty to route segments.
- Allow exact live evidence to resolve the reachability status of the segment it covered while retaining “endpoint topology unknown” as a caveat.
- If product semantics deliberately keep the combined verdict unknown, the headline must not say unqualified “Reachable - verified”; expose the two axes explicitly.

### 7. Medium: `worstOutcome` is order-dependent despite documenting a deterministic precedence

Location: `internal/trace/coverage.go:1462-1526`

The comment specifies “any transport failure -> unreachable; else degraded -> server-error; else verified; else reached.” The loop instead returns on the first failed or degraded probe. With `[HTTP 502, TCP refused]` the result is `server-error/upstream`; with the same observations reversed it is `unreachable/tcp`.

Merged probe sets can contain observations from several entry addresses, hosts, or targets, especially because same-backend routes are currently aggregated. Their ordering can therefore change the headline, failed layer, evidence, and diagnosis without changing facts.

Concrete fix:

- Scan all observations, rank outcomes after the scan, and choose evidence with a deterministic tie-break (segment, target, layer, then stable target text).
- Better, reduce per exact target first and then aggregate route targets explicitly as all/partial failure.
- Add permutation tests and mixed-address/mixed-host tests.

### 8. Medium: known static breaks, active-test counts, and the shipped verdict use incompatible evidence rules

Locations:

- `internal/trace/coverage.go:52-60`
- `internal/trace/coverage.go:220-242`
- `internal/trace/coverage.go:1061-1066`
- `internal/trace/coverage.go:1326-1367`
- `internal/trace/coverage.go:837-882`

`Coverage.Tested` is documented as routes that received a non-skipped probe. But `branchKnownBreak` synthesizes an `OutcomeUnreachable` route from a static missing backend and `recountCoverage` increments `Tested`/`Failed` for it. Static assessment is being counted as an active test.

There is also a reducer contradiction when the issue cache has not yet supplied a missing-ref finding (or `Deps.Issues` is nil):

1. `traceIngressEntry` has a confirmed missing backend (`Config == nil`).
2. `computeVerdict` has no finding to consume and returns healthy.
3. `branchKnownBreak` independently recognizes the nil config as a known break and emits `OutcomeUnreachable`.
4. The headline says “Unreachable.”
5. `CoverageVerdict` checks `!anyRealPass` before `Coverage.Failed`, so it ships unknown rather than broken.

The same optional issue-cache dependency is dangerous for a missing named Service port: `resolveBackendPort` returns zero, an empty scope means “all ports,” and a healthy sibling port can be used unless the asynchronous missing-port finding arrived first.

Concrete fix:

- Model static route state separately from probe coverage. A static break may drive the verdict but must not increment active `Tested`.
- Attach confirmed lookup/missing-port facts synchronously during trace construction instead of relying on the issues cache to make the verdict correct.
- Replace empty-slice sentinel semantics with typed scope resolution: all ports, exact ports, unresolved port, or no applicable port.
- Make the final verdict reducer consume the same structured route facts that produce the headline.

### 9. Low: folding a live result destroys prior localization evidence

Location: `internal/trace/coverage.go:276-284`

`ApplyInClusterResults` preserves only `InClusterRequest` and `TargetNamespace` before replacing the route. It drops existing `Localization`, evidence from the API-server proxy, and any other route-level fields. The pre-Job evidence is useful precisely because the feature is meant to compare vantages and localize the failing segment.

Concrete fix:

- Append the new observation to an immutable evidence list and re-reduce it.
- As a narrow patch, preserve/dedupe `Localization`, `Command`, and identity fields rather than replacing the whole struct.

## Investigated and not raised as findings

- `InClusterResultKey` itself is safely NUL-delimited and includes target namespace. Cross-namespace same-name Services do not collide once route identity is genuinely unique.
- `passedBackends` keys by name plus namespace and retains port sets, so its policy/targetPort reconciliation does not have the obvious same-name cross-namespace or cross-port collision.
- Partial-ready handling in `hopReachSeverity` correctly caps a pod-level critical to warning when ready endpoints still serve.
- The scale-to-zero softening checks for unrelated non-benign critical findings before changing broken to degraded; I did not find an obvious false softening in that guard.
- `classifyHopProbes` correctly prioritizes real data/direct paths over API-server proxy observations. The remaining problem is later replacement/reduction, not that local ordering rule.
- Throwaway-pod failures are deliberately not folded as definitive failures, which is conservative given source-scoped NetworkPolicy and mesh identity differences.
- The slice compaction used to remove `NotTested` rows does not duplicate rows on repetition. The bug is which rows it removes and that it runs without new evidence.

## Questions / product decisions that need an explicit answer

1. What does top-level `VerdictHealthy` mean: “static config has no known fault,” “at least one transport path answered,” or “the declared route was end-to-end verified”? The current code uses all three meanings.
2. What is the countable unit called a “route”: a host/path match, a listener+match, a backendRef edge, or a Service port? The implementation currently changes units by shape.
3. Is the in-cluster button intended to confirm only backend Service reachability or the whole Ingress/Gateway route? The runner implements the former; the outcome and copy claim the latter.
4. Should a real HTTP 3xx/4xx yield a green top-level verdict? “Reached but route not verified” is honest prose, but `VerdictHealthy` makes this an important product choice rather than an implementation detail.
5. Is “some tested routes pass, some declared routes were never tested” intentionally green? The code calls this footnote-green. If so, UI and MCP need a first-class partial-coverage signal because `VerdictHealthy` alone is unsafe for automation.
6. For Gateway API, must v1 support include method/header/query matches and filters before claiming route-level coverage? If not, the response should explicitly call the projection backend reachability rather than route verification.

## Recommended reducer tests before merge

Beyond the existing example tests, add a table-driven reducer suite over immutable inputs:

- static state: healthy / degraded / broken / unknown-by-design / unknown-investigate;
- observation: none / indirect pass / indirect fail / real reached / real verified / real 5xx / real unreachable / skipped;
- topology: one route / sibling routes / same-backend distinct paths / weighted backends / multi-port / truncated;
- backend state: all ready / partially ready / zero ready / scale zero / unreadable;
- operation: initial reduce / empty fold / same fold twice / different-vantage fold.

Every row should assert the tuple, not just one field:

```text
(Verdict, Headline, Reason, Coverage, Routes, NotTested, BrokenAt, BrokenRoute, Diagnosis)
```

Also assert permutation invariance for observations and idempotence for folds. Those two properties would have caught Findings 3 and 7 immediately.
