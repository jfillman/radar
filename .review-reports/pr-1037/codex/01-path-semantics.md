# PR #1037 review: Kubernetes path semantics, cache authority, and controller discovery

## Scope

- Base: `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- PR head: `d1face5b31572eb94afcd29920b93684f42281d3`
- Primary files: `internal/trace/entries.go`, `internal/trace/findings.go`, `internal/trace/netpol.go`, `internal/trace/egress.go`, `internal/trace/ingress_controller.go`, `internal/k8s/detect.go`, `internal/k8s/detect_missing_refs.go`, `pkg/k8score/cache.go`, and `pkg/k8score/dynamic_cache.go`
- Boundary files inspected where needed: `internal/server/trace_handlers.go`, `internal/trace/trace.go`, `internal/trace/coverage.go`, `internal/k8s/subsystems.go`, and the associated unit tests.
- Method: read-only inspection from the exact Git objects above, plus comparison with the Kubernetes, Gateway API, and AWS Load Balancer Controller specifications. I did not treat the moving worktree's `main` checkout as the PR head and did not execute or modify the PR checkout.

## Altitude assessment

The feature is directionally right: path diagnosis should compose the user's declared route, controller state, Service routing, endpoint state, policy, and live evidence into one explanation. The problem is that this PR still conflates three distinct layers:

```text
declared intent              controller-realized state             observation
Ingress/Gateway/Route spec -> status + EndpointSlices + cache sync -> probes by vantage
           |                              |                              |
           +---------------- evidence-graded reduction -----------------+
                                          |
                               operator-facing verdict
```

Several local comments explicitly try to “fail toward silence” or mark uncertainty, but the inputs do not carry enough authority metadata to enforce that rule globally. A selector plus Pod `Ready` is treated as the Service dataplane; an IngressClass or annotation is treated as a running controller; a non-empty informer snapshot is treated as a complete reverse index; and a redacted object is treated as safe even though its name and namespace are still disclosed. Those are all versions of the same abstraction error: desired or partial state is promoted to observed, authorized fact.

The strongest correction is to make every static read answer two questions before its value reaches the verdict:

1. **Is this the authoritative Kubernetes source for the fact?** For Service routing that is EndpointSlice state, not merely selector + Pod readiness. For attachment/controller claims it includes status and controller observations, not merely class/annotation intent.
2. **Is this snapshot complete and authorized for this request?** Namespace scope, exact cluster-scoped permission, informer sync, and cluster-wide versus namespace-fallback coverage must travel with the result.

Without that boundary, the extensive downstream honesty logic cannot repair an incorrect fact at its source.

## Severity summary

| # | Severity | Summary | Recommendation |
|---|---|---|---|
| 1 | High / security | Reverse walks and controller discovery disclose resources outside the caller's RBAC scope | Merge blocker for auth-enabled Radar |
| 2 | High | Pod readiness is promoted to authoritative Service routing and mishandles `publishNotReadyAddresses` | Merge blocker for the diagnosis verdict |
| 3 | High | Cloud class/annotations are reported as proof an Ingress is served; the AWS controller assumption is factually wrong | Merge blocker for Ingress diagnosis |
| 4 | High in restricted installs | Namespace-scoped Service-cache misses become confirmed missing backends | Merge blocker if namespace/RBAC-restricted installs are supported |
| 5 | Medium | Non-blocking dynamic-cache snapshots are used as complete reverse indexes | Fix before relying on reverse topology or no-controller findings |
| 6 | Medium | Egress policy rules are unioned across different selected Pods | Fix or explicitly label the summary as a heterogeneous union |
| 7 | Medium | Gateway traces silently omit TCPRoute and TLSRoute attachments | Fix or explicitly scope Gateway diagnosis to L7 |

## Findings

### 1. High / security: “redacted” reverse dependencies still disclose hidden object identities, and controller discovery bypasses request RBAC

Locations:

- `internal/server/trace_handlers.go:29-76`
- `internal/trace/trace.go:63-91`
- `internal/trace/entries.go:1068-1102`
- `internal/trace/entries.go:1903-1924`
- `internal/trace/ingress_controller.go:76-100`
- `internal/trace/ingress_controller.go:169-181`
- `internal/trace/ingress_controller.go:223-245`

The handler gives the trace package only a namespace allow-list. The new reverse walks then scan Radar's shared cache cluster-wide. When they find an object in a namespace the caller cannot read, they withhold its findings but return the real `Kind`, `Name`, and `Namespace` in both the `ResourceRef` and message.

That is not redaction for either reverse relation:

- A Service does not contain the names of HTTPRoutes/GRPCRoutes that point to it. `routeUpstreamsForService` therefore reveals a fact available only by listing hidden Route objects.
- A Gateway does not contain the names of Routes that select it through `parentRefs`. `traceGatewayEntry` similarly reveals hidden Route names and namespaces.

The tests deliberately lock in this disclosure: `internal/trace/trace_test.go:470-492` requires the out-of-scope `team-c` route hop to remain present. Hiding findings does not make the object identity public under Kubernetes RBAC.

There are two additional leaks in Ingress controller discovery:

- `resolveIngressClass` reads cluster-scoped IngressClass objects from the shared service-identity cache and exposes their `spec.controller` without an exact caller SAR.
- `findControllerPods` lists Pods across all namespaces and returns controller ready/total counts. A user who cannot read `kube-system` can therefore learn the health and replica shape of shared infrastructure.

Concrete failure scenario:

1. A tenant can diagnose `tenant-a/api`, but cannot list Routes in `tenant-b` or Pods in `kube-system`.
2. `tenant-b/private-checkout` references `tenant-a/api`; an ingress controller also runs in `kube-system`.
3. Diagnosing the Service returns the hidden route's exact name/namespace. Diagnosing an Ingress can return the controller's ready and total Pod counts and controller implementation.
4. Both values came from Radar's broader shared cache, not the request identity.

This conflicts with Radar's documented security boundary: namespaced responses are filtered per user, and cluster-scoped kinds require an exact `(group, resource, verb)` authorization check.

Concrete fix:

- Do not return names, namespaces, counts, or even a confirmed count of dependencies outside scope. At most return a generic statement such as “additional upstreams may exist outside your readable namespaces.”
- Make reverse request paths use `ListNamespaces(gvr, authorizedNamespaces)` rather than `ListWatched`. A nil allow-list can retain the single-user path, but auth-enabled requests must drive the list from the caller's explicit set.
- Extend `Deps` with a request-scoped authorization function for cluster-scoped facts and gate IngressClass reads with the same exact SAR machinery used elsewhere by `Server.canRead`.
- Only summarize controller Pods in namespaces the caller can read. Otherwise say the controller's runtime state is unavailable; do not expose counts from the shared cache.
- Add response-level tests that seed uniquely named hidden Routes/controller Pods and assert those strings and counts are absent from serialized JSON.

### 2. High: the trace uses Pod readiness as authoritative Service routing and falsely breaks `publishNotReadyAddresses` Services

Locations:

- `internal/trace/entries.go:97-103`
- `internal/trace/entries.go:380-399`
- `internal/trace/entries.go:435-458`
- `internal/trace/entries.go:519-559`
- `internal/trace/entries.go:734-748`
- `internal/trace/findings.go:120-135`
- `internal/k8s/detect.go:535-540`
- `internal/k8s/detect.go:613-677`
- `internal/trace/coverage.go:157-193`

The Service path is reconstructed from selector-matched Pods and their raw `PodReady` condition. That value drives the “ready” count, the zero-ready finding, the probe target roster, and ultimately the verdict. The standing detector likewise emits critical `svc:no-ready-endpoints` when no selected Pod has `PodReady=True`.

This is not the Service dataplane contract. Kubernetes service proxies consume EndpointSlices, including each endpoint's realized port and `ready` / `serving` / `terminating` conditions. The [Service API](https://kubernetes.io/docs/reference/kubernetes-api/core/service-v1/) is explicit that `publishNotReadyAddresses` makes generated Endpoints and EndpointSlices treat every endpoint as ready even when its Pod is not. EndpointSlice is also the recommended source for Service backends and carries information selector reconstruction cannot reproduce ([Service documentation](https://kubernetes.io/docs/concepts/services-networking/service/), [EndpointSlice API](https://kubernetes.io/docs/reference/kubernetes-api/discovery/endpoint-slice-v1/)).

The PR already knows this exception in one place: `policyFinding` includes every selected Pod when `svc.Spec.PublishNotReadyAddresses` is true. The primary ready count and `podsConfig`, however, do not use the same rule. That makes the NetworkPolicy advisory more accurate than the actual path verdict.

Concrete failure scenario:

1. A StatefulSet uses a headless peer-discovery Service with `publishNotReadyAddresses: true`.
2. During bootstrap, all Pods are Running with IPs but are intentionally not Ready until they discover peers through that Service.
3. Kubernetes publishes and routes those endpoints by design.
4. Radar reports `0/N selected pods ready`, can import the detector's critical `svc:no-ready-endpoints`, excludes every Pod IP/name from probing, and marks the Service broken or degraded.
5. Even a successful Service-proxy observation cannot reliably repair the static claim because the trace treats critical static findings as authoritative and only allows a narrow set of reconciliations.

The same model also cannot represent selectorless Services backed by manually managed EndpointSlices, per-endpoint named `targetPort` resolution, mixed endpoint ports, terminating-but-serving endpoints, topology hints, or traffic-policy effects. `unresolvedNamedTargetPorts` at `internal/k8s/detect.go:1875-1895` additionally unions port names across all selected Pods, so one Pod declaring a name can hide another selected Pod for which that target port does not resolve.

Concrete fix:

- Resolve EndpointSlices labeled `kubernetes.io/service-name=<service>` and derive routeable endpoint/port state from them. Preserve Pod readiness separately as application health rather than calling it endpoint truth.
- If EndpointSlice state is unavailable or unsynced, mark the endpoint segment unknown. Selector + Pod readiness can remain a clearly labeled approximation, but it must not create a definitive red verdict.
- As a minimum short-term patch, apply `svc.Spec.PublishNotReadyAddresses || PodReady` consistently to the routeable count and probe roster. That fixes the immediate false break but is not a substitute for EndpointSlice state.
- Add tests for: all Pods NotReady with `publishNotReadyAddresses`; selectorless manually managed EndpointSlices; mixed named-target-port resolution; and `ready`/`serving`/`terminating` combinations.

### 3. High: IngressClass and cloud annotations are treated as proof that an Ingress is being served

Locations:

- `internal/trace/ingress_controller.go:55-68`
- `internal/trace/ingress_controller.go:201-220`
- `internal/trace/ingress_controller.go:259-263`
- `internal/trace/ingress_controller_test.go:108-119`
- `internal/trace/ingress_controller_test.go:135-139`

For a known cloud controller, `ingressControllerStatus` immediately emits a quiet “Served by” pill when either the class or a cloud-looking annotation is present. It does so even when `status.loadBalancer.ingress` is empty and no controller state was observed.

That promotes desired configuration to realized service. The assumption is especially wrong for `ingress.k8s.aws/alb`: the AWS Load Balancer Controller is an in-cluster Deployment. Its own [installation guide](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/installation/) installs `aws-load-balancer-controller` in `kube-system`, and its [architecture documentation](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/how-it-works/) describes a reconciliation loop that watches Ingresses and only then provisions the ALB, target groups, listeners, and rules. The PR's comment and test instead assert that AWS has “no in-cluster pods by design.”

Concrete failure scenario:

1. An Ingress has class `alb` or an `alb.ingress.kubernetes.io/*` annotation.
2. The AWS controller Deployment is absent, crash-looping, or unable to provision because IAM/subnet discovery is broken. The Ingress has no published address.
3. Radar returns “via AWS Application Load Balancer” / “Served by a cloud load balancer — no in-cluster controller pods to check” with no finding.
4. The actual external entry path does not exist.

The same desired-versus-observed error applies to a stale GCE class or an annotation copied into a cluster with no matching controller. An address is stronger evidence that reconciliation happened at some point; a class or annotation alone is only intent.

Concrete fix:

- Change the class/annotation-only wording to “configured for …” and keep the serving state pending or unverified until observed status exists.
- Add AWS controller labels (`app.kubernetes.io/name=aws-load-balancer-controller`, with an appropriate component/instance strategy) and inspect its Pods when authorized. Controller health is useful supporting evidence, but a programmed address/status or an actual probe should remain the front-door evidence.
- For provider-managed controllers whose Pods are intentionally invisible, use the Ingress address, conditions/events where available, and a provisioning grace period. Do not convert invisibility into “served.”
- Replace the current honesty test with cases that distinguish `configured`, `programmed`, `controller unavailable`, and `verified`.

### 4. High in restricted installs: an out-of-scope Service lister miss is interpreted as a confirmed missing backend

Locations:

- `pkg/k8score/cache.go:1201-1231`
- `internal/trace/entries.go:938-967`
- `internal/trace/entries.go:1221-1234`
- `internal/trace/entries.go:1479-1490`
- `internal/k8s/detect_missing_refs.go:791-800`

This PR adds `KindCoversNamespace` and correctly uses it for an empty Pod list: a namespace-scoped informer returns an empty result for a namespace it does not watch, and that absence is not authoritative. The same invariant is missing from Service lookups.

Client-go listers return a Kubernetes-style NotFound error when an object is absent from their local indexer. If the Services informer only covers another namespace, that NotFound means “not in this cache,” not “the API object does not exist.” Both Ingress/Route tracing paths reserve `endpointSource=unknown` for non-NotFound errors and therefore treat an out-of-scope lister miss as confirmed absence. `DetectMissingGatewayRefs` has the same bug and can seed a critical “Missing Gateway backend Service” finding that the new trace then imports.

Concrete failure scenario:

1. Radar runs with namespace- or kind-specific RBAC, and Services are cached only for namespace `app-a`.
2. A readable HTTPRoute references `app-b/api` through a valid cross-namespace backendRef.
3. In single-user/auth-disabled mode `AllowedNamespaces` is nil, so the Route walk reaches the backend lookup even though the typed Service cache does not cover `app-b`.
4. `Services().Services("app-b").Get("api")` returns NotFound from the local indexer.
5. Radar reports a missing backend / broken path instead of an unverifiable backend.

The same can happen for an Ingress when per-kind cache scopes differ: the Ingress may be readable in a namespace that the Services informer cannot cover.

Concrete fix:

- Before interpreting a lister NotFound as object absence, require `KindCoversNamespace("services", namespace)`.
- Centralize this as an authoritative typed-cache lookup result (`found`, `confirmed-absent`, `unreadable/out-of-scope`) and grep all lister-Get call sites for the same pattern. A local index miss is only a confirmed absence inside a synced, covering informer.
- Apply the same check in `DetectMissingGatewayRefs`; otherwise the issue cache will continue to inject false critical findings even after the trace lookup is fixed.
- Add tests with independent per-kind namespace scopes for Services, Ingresses/Routes, and Pods.

### 5. Medium: request-facing reverse walks use partial dynamic-cache snapshots as complete indexes

Locations:

- `pkg/k8score/dynamic_cache.go:958-986`
- `pkg/k8score/dynamic_cache.go:989-1013`
- `pkg/k8score/dynamic_cache.go:1537-1549`
- `internal/k8s/subsystems.go:107-135`
- `internal/trace/entries.go:1068-1081`
- `internal/trace/entries.go:1997-2025`
- `internal/trace/ingress_controller.go:96-114`

The cache API documents the relevant contract clearly:

- `List` is non-blocking and returns whatever data is available immediately.
- `ListWatched` unions whatever informer scopes happen to be running and explicitly says request-facing reads should use `List`/`ListNamespaces` with explicit namespaces.
- `IsClusterWideSynced` exists to tell callers when absence and completeness are authoritative across every namespace.

The new trace code ignores those distinctions. `routeUpstreamsForService` and `attachedRoutes` only try another listing path when `ListWatched` is empty. A non-empty but partial informer snapshot suppresses the fallback and silently omits other Routes. This is reachable during normal startup because CRD warmup and discovery run in the background, and it is permanent for namespace-fallback informers that cover only a subset.

`resolveIngressClass` fails in both directions:

- A partial non-empty list that does not yet contain the requested/default class is treated as complete and can produce a false no-controller finding.
- A fully synced cluster with genuinely zero IngressClasses is forcibly changed to `couldRead=false`, so the intended positive no-controller signal can never fire for the empty-cluster case.

Concrete failure scenario:

1. A cluster-wide HTTPRoute informer has delivered one Route but has not completed its initial list.
2. A second Route in another namespace also references the diagnosed Service.
3. `ListWatched` returns the first Route; because the result is non-empty, the code never checks sync or retries.
4. The response presents a complete-looking upstream list with the second route absent. No truncation or uncertainty marker explains the omission.

Concrete fix:

- Never use result non-emptiness as a sync/completeness signal. Require `IsClusterWideSynced(gvr)` before making cluster-wide absence or completeness claims.
- In auth-enabled request paths, use `ListNamespaces(gvr, deps.AllowedNamespaces)` and track whether every requested namespace informer is synced. In single-user cluster-wide mode, use a synced cluster-wide informer or return an explicit partial/unknown coverage marker.
- A bounded wait can fit inside the trace's three-second context, but a timeout must degrade completeness rather than silently return a complete-looking subset.
- For IngressClass, a synced empty list is authoritative; an unsynced non-empty list is not.
- Add warm-cache, cold-empty, cold-partial, synced-empty, cluster-wide, and namespace-fallback tests.

### 6. Medium: egress rules are unioned across Pods even though NetworkPolicy additivity is per selected Pod

Locations:

- `internal/trace/netpol.go:112-146`
- `internal/trace/egress.go:71-103`
- `internal/trace/egress.go:105-140`
- `internal/trace/egress.go:301-323`
- `internal/trace/egress.go:543-558`

Kubernetes NetworkPolicies are additive **for each Pod**: once a Pod is isolated for egress, its allowed connections are the union of egress rules from policies that select that Pod. They are not additive across all replicas behind a Service ([Kubernetes NetworkPolicy semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/)).

`summarizeEgress` first checks whether every endpoint Pod is selected by at least one policy, then concatenates every rule from every policy into one Service-wide union. If different policies select disjoint subsets, the result grants every replica the aggregate permissions of all subsets.

Concrete failure scenario:

- Pod `blue` is selected by policy A, which allows only database TCP/5432 and does not allow DNS.
- Pod `green` is selected by policy B, which allows only DNS to `kube-system` UDP/53.
- Every Pod is selected, so `partialReplicas=false`.
- The returned summary says “This service's pods” can reach both destinations and classifies DNS as covered.
- In reality, `blue` cannot resolve DNS and `green` cannot reach the database.

There is a second DNS false reassurance in the same reduction: `rulePort53` ignores `NetworkPolicyPort.Protocol`, so a TCP-only port 53 rule is considered full DNS coverage even though ordinary DNS queries use UDP and robust policies normally allow both UDP and TCP.

Concrete fix:

- Compute the applicable-policy union independently for each non-nil endpoint Pod.
- Aggregate those per-Pod summaries into “all replicas,” “some replicas,” and “mixed” facts. DNS should be `covered` only when every governed replica has the required protocol coverage; otherwise show partial/uncertain state and identify the affected replica count.
- Preserve the current enforcement disclaimer; this remains a declared policy summary rather than proof the CNI enforces it.
- Add a two-Pod/two-disjoint-selector test and TCP-only/UDP-only port-53 cases. The current tests use one label-less Pod for almost every case and therefore cannot expose the selector-partition bug.

### 7. Medium: Gateway traces silently ignore supported L4 Route kinds

Locations:

- `internal/trace/entries.go:1888-1931`
- `internal/trace/entries.go:1997-2025`
- `internal/k8s/dynamic_cache.go:188-189`
- `internal/k8s/detect_missing_refs.go:706-715`
- `internal/trace/trace.go:1315-1324`

`attachedRoutes` scans only `HTTPRoute` and `GRPCRoute`. Elsewhere Radar already discovers `TCPRoute` and `TLSRoute`, records their history, and checks their missing Gateway/backend references. Gateway API explicitly defines transport-specific Route types; TCPRoute and TLSRoute are valid Gateway attachments, not exotic custom resources ([Gateway API overview](https://gateway-api.sigs.k8s.io/docs/concepts/api-overview/), [TLSRoute reference](https://gateway-api.sigs.k8s.io/reference/api-types/tlsroute/)).

Concrete failure scenario:

1. A Gateway has a TCP listener for PostgreSQL and a TLS passthrough listener.
2. A TCPRoute and TLSRoute select those listeners and route to live Services.
3. Diagnosing the Gateway returns only the Gateway hop, reports zero attached routes, and sets neither `Truncated` nor an unsupported/not-tested marker.
4. The product silently erases the Gateway's actual traffic paths.

It is reasonable for direct entry diagnosis to remain limited to the five advertised kinds. It is not reasonable for the Gateway's attachment inventory to claim completeness while omitting Route kinds the repository already recognizes.

Concrete fix:

- Include TCPRoute and TLSRoute in the attachment inventory (and UDPRoute once Radar discovers/supports it).
- If L4 backend probing is not part of this PR, keep those route hops as static-only and add an explicit “backend path not tested for this protocol” coverage item.
- Distinguish a Route that merely requests attachment in `spec.parentRefs` from one accepted by a listener. `routeAttachedToGateway` currently ignores listener `allowedRoutes`, `sectionName`/port matching, and Route `status.parents[].conditions[Accepted]`. Showing rejected intent is useful for diagnosis, but label it “configured/requested” and attach the rejected condition rather than calling it attached.
- Add Gateway tests with HTTP + TCP + TLS attachments and one rejected parentRef.

## Cross-cutting regression matrix

The current suite has substantial happy-path and uncertainty coverage, but these cases are missing and would catch most of the findings above:

| Axis | Required cases |
|---|---|
| Service realization | `publishNotReadyAddresses`; selectorless Service + manual EndpointSlice; heterogeneous named target ports; terminating/serving endpoints |
| Cache authority | cluster-wide synced; cluster-wide partial; synced empty; namespace fallback; per-kind typed scopes that differ |
| Request authorization | hidden reverse Route; hidden controller namespace; denied IngressClass; auth disabled with restricted service identity |
| Ingress control plane | class only; annotation only; address programmed; AWS controller missing/unready; managed controller not observable |
| NetworkPolicy egress | one policy selecting all; disjoint selectors; overlapping selectors; mixed DNS coverage; TCP/UDP 53 |
| Gateway protocols | HTTPRoute, GRPCRoute, TCPRoute, TLSRoute; requested-but-rejected attachment; `sectionName` and listener namespace policy |

## Investigated and not raised as blockers

- The inbound NetworkPolicy evaluator generally preserves per-Pod selection, effective `policyTypes`, additive ingress semantics, target-port handling, and caller-dependent uncertainty. I did not find an equivalent cross-Pod union bug in its main inbound verdict.
- A cross-namespace backend Service named in a Route the caller can already read is not itself a new identity leak: the `backendRef` is visible in that Route's spec. Suppressing the Service's config, Pods, findings, and probes outside scope is the right behavior. The reverse Service→Route and Gateway→Route cases are different because the in-scope object does not disclose those Route identities.
- Weight-zero Route backends are deliberately excluded from the active path while retained informationally. That matches Gateway API traffic intent and avoids false failures during cutover.
- Using `spec.parentRefs` to show an attempted Gateway attachment is diagnostically useful because rejected conditions can explain the failure. The issue is the “attached” label and completeness claim, not the decision to surface rejected intent.
- Selectorless Services are currently classified as unverifiable rather than confidently healthy. That is safer than selector reconstruction, but EndpointSlice support is still needed for the feature to answer the path question for a first-class Kubernetes Service shape.

## Additional coverage questions

1. Does the product intend “Service reachable” to be cluster-wide, or from a specific node/client? `internalTrafficPolicy: Local`, `externalTrafficPolicy: Local`, topology-aware hints, and traffic distribution can make the eligible EndpointSlice set vantage-specific.
2. Should Gateway attachment inventory include custom implementation-specific Route kinds, or explicitly declare the supported set? A silent hard-coded set will drift as Gateway API evolves.
3. Ingress `TypedLocalObjectReference` resource backends are currently omitted because `ingressBackendNames` only follows `.service`. They need an explicit unsupported/not-tested representation rather than disappearing.
4. `internal/trace/trace.go:12-17` still says active probes, EndpointSlice reads, and NetworkPolicy evaluation are out of scope, while this PR now performs probes and NetworkPolicy analysis. That stale package contract will mislead future maintainers about which evidence layer belongs here.

## Recommended order of repair

1. Close the authorization boundary: no hidden reverse identities, no controller-Pod counts, exact cluster-scoped authorization.
2. Introduce an authoritative Service endpoint model backed by EndpointSlices; fix `publishNotReadyAddresses` immediately even if the full model lands separately.
3. Split controller intent (`class`/annotations) from programmed/observed state and correct AWS controller discovery.
4. Make cache scope and sync explicit for every absence/completeness decision; fix both typed Service misses and dynamic reverse lists.
5. Repair per-Pod egress aggregation and then extend Gateway protocol coverage.
