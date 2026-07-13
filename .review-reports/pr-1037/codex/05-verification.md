# PR #1037 skeptical verification

Reviewed exactly `1b9ad55632e0e72abcdd28bc4e700b7020753dad..d1face5b31572eb94afcd29920b93684f42281d3` by reading objects from those revisions. No source, configuration, tests, cluster, network, or GitHub state was changed.

## Verdict summary

| # | Candidate | Verdict | Severity assessment |
|---|---|---|---|
| 1 | Backend-direct Job heals a failed entry route | **ACCEPT, narrowed** | High for probe-only Ingress/parent-Gateway failures |
| 2 | Empty in-cluster result fold erases probe verdicts | **ACCEPT** | High |
| 3 | Throwaway Pod success clears source-sensitive NetworkPolicy warning | **REJECT** | The implementation deliberately preserves source-sensitive advisories |
| 4 | Five sequential Jobs cannot fit the request timeout | **ACCEPT** | High operational reliability |
| 5 | One-shot probe result permanently masks refreshed static trace | **ACCEPT** | High diagnostic staleness |
| 6 | `radar-app` peer range admits `k8s-ui` versions without trace exports | **ACCEPT** | Release-blocking for library consumers |
| 7 | Proxy-only failure paints a node red although the route is indirect | **ACCEPT, narrowed** | Medium |
| 8 | In-cluster consent key aliases distinct clusters | **ACCEPT, scoped** | Medium safety/consent issue; not an authorization bypass |

## 1. Backend-direct Job can heal a failed entry route

**Verdict: ACCEPT, narrowed.** The defect is reproducible for an Ingress route, and for an HTTPRoute/GRPCRoute whose front-door parent-Gateway probe failed. The candidate is too broad if read as including the standalone Gateway subject: that route is not assigned an in-cluster request.

Evidence:

- `internal/trace/coverage.go:102-108` explicitly documents that the runner dials the backend Service directly and does not traverse the Ingress.
- `internal/trace/coverage.go:1068-1086` combines entry and backend probes into one route, then attaches the in-cluster request derived from the backend configuration.
- `internal/reachability/incluster.go:55-72` executes each test against `r.Target`; `Host` and `Path` are only HTTP request attributes. The target is the Service, not the entry listener.
- `internal/trace/coverage.go:272-285` replaces the entire `RouteResult` with the result of that backend-direct Job.
- `internal/trace/coverage.go:327-358` then recomputes the trace verdict from static findings and coverage; it does not rerun the normal probe-vote reducer.
- `internal/trace/trace.go:616-632` shows that a real failed probe on the normal build path can make the route broken.
- `internal/trace/coverage.go:1093-1100` assigns no in-cluster request to a Gateway subject, which is why the standalone-Gateway form of the claim is not established.

Minimal causal scenario: an Ingress or Route has no critical static entry finding, its real entry-listener probe fails, and its backend Service proxy/request exists. The throwaway Job receives 2xx from the Service. Applying that result replaces the route-level failed result with `reachable/real`; recomputation finds no static reason to retain `broken`, even though the failed entry probe remains on the entry hop. The result now claims end-to-end reachability that the Job never tested.

Strongest counterargument: a critical static entry finding is sticky through recomputation, so the fold does not erase every entry failure; moreover, verifying the internal Service segment is useful. That only narrows the bug. A probe-only entry failure is still overwritten at route scope by evidence collected downstream of the failed segment.

Severity interaction: candidate 2 makes this broader because even no Job evidence can discard the original probe-derived verdict. Candidate 5 can then keep the falsely healed snapshot selected indefinitely.

## 2. Applying an empty result map is not idempotent

**Verdict: ACCEPT.** `ApplyInClusterResults(trace, emptyMap)` can change a finalized probe-derived verdict despite having no new evidence.

Evidence:

- `internal/trace/coverage.go:268-285` performs no route replacement for an empty result map.
- `internal/trace/coverage.go:327-341` nevertheless clears `Reason` and calls `computeVerdict` unconditionally, apart from the narrow sticky-unknown-class case.
- `internal/trace/trace.go:586-735` applies `reviseVerdictWithProbes` during normal trace construction; this is the separate step that turns real unanimous probe failures into `broken`.
- `internal/trace/trace.go:891-947` computes the base verdict from findings rather than preserving the raw-probe vote, and `internal/trace/trace.go:1240-1245` is the normal call site ordering that applies probe revision after that base verdict.
- `internal/trace/coverage.go:352-358` recounts route coverage and then derives `CoverageVerdict` from the mutated trace.
- `internal/server/reachability_run.go:248-254` calls `ApplyInClusterResults` even when the runner returns no folded results.
- `internal/reachability/incluster.go:78-112` has several ordinary paths that can return no result for a target, including nil client, budget cap, Job failure, or an unclean result.

Minimal causal scenario: a finalized trace has no critical static findings and one real failed direct probe, so normal construction set `VerdictBroken`. The in-cluster runner yields an empty map. No route changes, but application clears the existing reason and recomputes the base verdict without reapplying probe voting. With a failed route but no real pass, coverage subsequently becomes `unknown` rather than retaining `broken`.

Strongest counterargument: the existing in-cluster-result tests intentionally use application as a canonicalization pass that clears stale synthetic verdicts. That does not justify mutating an already finalized, probe-derived trace when the new evidence set is empty. If canonicalization is required, it must reproduce the complete original verdict pipeline.

Severity interaction: this is the broadest verdict-integrity issue in the set. It amplifies candidate 1 and may be reached more often when candidate 4 causes cancellation or partial/no Job results.

## 3. Source-sensitive NetworkPolicy advisories are not cleared

**Verdict: REJECT.** The proposed causal chain does not exist. Generic Pod success only reconciles the caller-independent `would-deny` finding; caller-dependent/source-sensitive policy remains an advisory.

Evidence:

- `internal/trace/netpol.go:15-22` states that caller-dependent results stay advisory because Radar's probing vantage is not the real caller.
- `internal/trace/netpol.go:31-37` distinguishes caller-independent `policyWouldDeny` from source-dependent `policyAdvisory`.
- `internal/trace/netpol.go:216-236` chooses advisory whenever any rule is caller-dependent; it emits `would-deny` only when denial is caller-independent.
- `internal/trace/netpol.go:282-301` marks a rule with non-empty `from` constraints as caller-dependent.
- `internal/trace/findings.go:169-195` emits source-sensitive policy as `netpol:advisory` with informational severity and caller-dependent wording.
- `internal/trace/coverage.go:366-395` reconciles only metadata value `policyVerdict == "would-deny"` and finding code `netpol:would-deny`. It does not remove `netpol:advisory`.

Minimal attempted scenario: a policy permits only a specific namespace, Pod selector, or IP block, while the generic runner Pod succeeds. Static evaluation classifies that source rule as caller-dependent and emits `netpol:advisory`. The success reconciliation does not match the advisory's metadata/code, so the finding survives.

Strongest counterargument for accepting the candidate: `internal/reachability/incluster.go:95-103` itself acknowledges that the runner's generated Pod is not necessarily the real source identity. That concern is valid in principle, but the NetworkPolicy evaluator already encodes it by refusing to promote source-dependent policy to `would-deny`; the reconciliation filter preserves exactly that case.

Severity interaction: none of this rescues candidate 1. A generic success is still over-applied to the whole route; it simply does not erase the particular source-sensitive NetworkPolicy advisory alleged here.

## 4. The five-Job budget exceeds the HTTP timeout

**Verdict: ACCEPT.** The endpoint advertises/runs up to five probes serially, but the request context expires before the configured per-Job worst case can complete.

Evidence:

- `internal/reachability/incluster.go:14-16` sets the run cap to five.
- `internal/reachability/incluster.go:55-90` invokes `runner.Run` in a synchronous loop.
- `internal/reachability/runner.go:113-116` configures a 25-second timeout per Job.
- `internal/reachability/runner.go:184-200` creates that per-Job deadline for each invocation; cleanup may additionally use a background context for up to five seconds.
- `internal/server/server.go:283-285` wraps the server in a 60-second request timeout, and `internal/server/server.go:330-338` registers the whole-subject reachability POST under that middleware.

Minimal causal scenario: five eligible targets each remain unresolved until their 25-second Job deadline. Two consume about 50 seconds; the request context is canceled during the third. The fourth and fifth cannot be meaningfully executed, so the endpoint cannot return the complete result set its own cap allows. The nominal worst case is at least 125 seconds before cleanup, more than twice the outer deadline.

Strongest counterargument: Jobs normally finish in a few seconds, and propagation of the parent cancellation prevents the server goroutine from running for 125 seconds. That proves the resource leak is bounded, not that the endpoint contract is reliable. Slow-but-valid Kubernetes scheduling or image startup turns a supported five-target request into a canceled/partial operation.

Severity interaction: cancellation increases the likelihood of partial or empty maps reaching candidate 2's non-idempotent fold, depending on where cancellation lands and how far the handler proceeds.

## 5. A one-shot probe result masks later static refreshes

**Verdict: ACCEPT.** Once set, `probeTrace` has higher display precedence than the five-second query and is not invalidated when that query changes.

Evidence:

- `web/src/api/client.ts:408-419` polls the static trace every five seconds.
- `web/src/components/workload/WorkloadView.tsx:974-1013` stores the one-shot result in local `probeTrace` state and clears it only on resource-key change or explicit reset/re-probe flow.
- `web/src/components/workload/WorkloadView.tsx:1083-1088` selects `probeTrace ?? staticTrace` as the base, then optionally overlays `inClusterTrace`.
- `web/src/components/workload/WorkloadView.tsx:1149-1153` refreshes only the query; it does not clear the selected probe snapshot.
- `web/src/components/workload/WorkloadView.tsx:1046-1049` resets the in-cluster mutation only when the selected base trace changes. While `probeTrace` remains selected, static polling cannot trigger that reset either.

Minimal causal scenario: the user probes during an outage and receives a broken snapshot. The workload heals; `staticTrace` polls healthy every five seconds, but the UI continues rendering the old broken `probeTrace`. The inverse is more dangerous: a probed healthy snapshot can mask a newly broken static trace. Manual refresh also leaves the stale snapshot selected.

Strongest counterargument: `web/src/components/workload/WorkloadView.tsx:963-966` explicitly says the one-shot result should remain stable rather than poll. Stability of the probe payload is reasonable, but making it permanently authoritative over the stated static source of truth is not. The UI can retain the historical probe while allowing fresher static evidence to supersede or visibly stale it.

Severity interaction: candidate 1's false-healed result, candidate 2's weakened verdict, or candidate 7's misleading node color can remain visible after backend state has moved on.

## 6. The published peer range is incompatible with the new imports

**Verdict: ACCEPT.** This is a package-contract failure hidden by the monorepo alias/workspace.

Evidence:

- `web/package.json:18-20` publishes only `web/src`; it does not bundle `packages/k8s-ui`.
- `web/package.json:41-43` still declares `@skyhook-io/k8s-ui: ">=1.7.3"`.
- `web/src/components/workload/WorkloadView.tsx:40-41` imports the newly added trace components, types, and utility from the peer package.
- `packages/k8s-ui/src/index.ts:43-46` newly exposes the trace module at the package root, and `packages/k8s-ui/src/components/trace/index.ts:1-9` lists the new named exports.
- `web/tsconfig.json:18-24` resolves `@skyhook-io/k8s-ui` directly to the checkout's source, so local typechecking cannot prove the declared minimum published peer is compatible.
- `web/package.json:53-56` likewise uses workspace `*` for the development copy, masking lower-bound compatibility.

Minimal causal scenario: a downstream source consumer installs the new `@skyhook-io/radar-app` with an older but semver-legal `@skyhook-io/k8s-ui` version satisfying `>=1.7.3`. That version lacks the trace named exports, so TypeScript or ESM module linking fails before the app runs.

Strongest counterargument: the release process may publish a matching `k8s-ui` and the repository itself always resolves both packages together. That does not repair the public peer constraint: package managers are explicitly allowed to select older compatible versions. The lower bound must be the first published version containing these exports.

Severity interaction: this blocks the embedded/library consumer path regardless of runtime correctness in candidates 1-5 and 7-8; the standalone binary's bundled frontend is not affected by this dependency resolution failure.

## 7. An indirect proxy failure can overrule the route's unknown status in node coloring

**Verdict: ACCEPT, narrowed.** This applies to non-skipped proxy failures that do not have an independent critical static finding. Several transport-wide proxy failures are deliberately skipped and therefore do not trigger it.

Evidence:

- `internal/trace/coverage.go:1427-1458` classifies API-server proxy evidence as indirect; a proxy-only failure yields an unreachable route result with indirect confidence.
- `internal/trace/trace.go:792-823` excludes proxy-only hop results from real verdict voting.
- `internal/trace/coverage.go:845-870` yields `unknown` when there is no real successful route, preserving the backend's uncertainty.
- `packages/k8s-ui/src/components/trace/traceToSubgraph.ts:19-23` maps an indirect unreachable route to unknown.
- `packages/k8s-ui/src/components/trace/traceToSubgraph.ts:115-124` computes `nodeOwnStatus` from any unskipped failed raw probe without considering its path/confidence.
- `packages/k8s-ui/src/components/trace/traceToSubgraph.ts:292-321` first derives unknown for an only-indirect-unreachable subject, then lets the unhealthy own-status floor override it to red.
- `packages/k8s-ui/src/components/trace/traceToSubgraph.ts:349-366` applies that same raw-probe status directly to downstream nodes.
- `pkg/probe/probe.go:602-622` skips broad proxy transport/cluster failures, while `pkg/probe/probe.go:624-632` leaves other failures, such as proxy authorization denial, as non-skipped evidence.

Minimal causal scenario: the laptop has only an API-server Service-proxy probe, and that probe gets a non-skipped failure such as proxy authorization denial. The backend correctly reports the route as indirect/unknown because the real traffic path was never exercised. The graph then reads the same raw hop failure without its indirect qualification and paints the node unhealthy/red.

Strongest counterargument: node color could intentionally represent the resource's observed response rather than the end-to-end route verdict. The graph does not communicate that semantic distinction, and the backend intentionally treats this observation as non-authoritative. Showing categorical red beside an unknown indirect route overstates the evidence and contradicts the route model.

Severity interaction: candidate 2 can change the top-level verdict independently, but this node remains red because the raw hop probe remains attached. Candidate 5 can preserve the misleading graph after newer static data arrives.

## 8. The in-cluster consent scope aliases distinct clusters

**Verdict: ACCEPT, scoped.** The collision is real when multiple in-cluster Radar backends share one browser origin, including the supported embedded/Hub shape. Ordinary standalone deployments on distinct origins do not collide.

Evidence:

- `internal/server/reachability_run.go:38-52` returns `k8s.GetContextName()` as the capability's cluster identifier.
- `internal/k8s/client.go:135-140` assigns the literal `"in-cluster"` as both context and cluster name for every true in-cluster bootstrap.
- `packages/k8s-ui/src/utils/inClusterConsent.ts:1-20` keys persistent consent only by that cluster string in origin-local storage.
- `packages/k8s-ui/src/components/trace/InClusterConsentDialog.tsx:13-49` displays the same value and promises “Don't ask again for this cluster.”
- `web/src/components/workload/WorkloadView.tsx:1094-1103` checks stored consent using the capability cluster, and `web/src/components/workload/WorkloadView.tsx:1165-1170` passes that value into the dialog.

Minimal causal scenario: a same-origin embedded UI switches from in-cluster Radar agent A to in-cluster Radar agent B. Both capability responses say `cluster: "in-cluster"`. Selecting “Don't ask again” on A writes the same local-storage key B checks, so B's Job-creation consent dialog is suppressed even though the user has never consented for B; the dialog label itself cannot distinguish them.

Strongest counterargument: local storage is origin-scoped, so two standalone Radar servers reached at different origins naturally receive distinct consent stores. That limits the affected deployment topology, but `radar-app` is explicitly distributed for embedding and multi-cluster consumers, where a shared origin is normal.

Severity interaction: this is not an RBAC or authentication bypass—the backend still performs its configured role/capability checks before creating a Job. It is a safety-promise and informed-consent failure, and candidate 4 makes the unexpectedly authorized operation more expensive and failure-prone.
