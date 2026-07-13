# PR 1037 — Subreview 1: Kubernetes path semantics (reachability trace)

## 1. Reviewed SHAs and files inspected

- Base: `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- Head: `d1face5b31572eb94afcd29920b93684f42281d3`
- All quotes/line numbers are at **PR head** (extracted via `git show <head>:<path>`).

Files inspected in depth (my scope):
- `internal/trace/entries.go` (2129 lines) — Service/Ingress/Route/Gateway entry tracing, endpoint derivation, upstream reverse-walk, cross-namespace redaction.
- `internal/trace/netpol.go` (484) — static NetworkPolicy ingress evaluation.
- `internal/trace/egress.go` (712) — egress-note summarization + DNS-gap heuristic.
- `internal/trace/ingress_controller.go` (308) — ingress controller tier / class resolution.
- `internal/trace/findings.go` (278) — finding construction, `policyFinding`.
- `internal/k8s/detect.go` (diff) — scale-to-zero detection (`scaledToZeroBackingWorkload`), `ErrDynamicNotReady`.
- `internal/k8s/cache.go` (diff) — `ErrDynamicNotReady` sentinel.
- `pkg/k8score/cache.go` (diff) — `KindCoversNamespace`.

Cross-referenced (for wiring only, not full review): `internal/trace/trace.go` (`Deps.NamespaceAllowed`), `internal/trace/coverage.go` (verdict), tests in the package.

---

## 2. Altitude / design assessment

**The core modeling choice is sound and refreshingly honest.** The design treats every static conclusion as a *prior* and defers to a live in-cluster probe for ground truth (`netpol.go:15-22`). It fails toward silence, it distinguishes "no resource" from "couldn't read" (`endpointSource=unknown`, `unreadable`), and it has a real per-user RBAC redaction boundary for cross-namespace hops. The NetworkPolicy engine is the strongest part: additive union across policies, correct `policyTypes` defaulting (`netpol.go:360-374`), correct named-port-not-declared semantics (`netpol.go:305-348`), Service-port → targetPort → containerPort resolution done in one place (`servicePortMaps` / `resolveTargetPort`). These are the things people usually get wrong, and they're right here.

**Where the model is weaker — all in the same direction: it derives reachability from *spec references* and *pod readiness*, and skips the authoritative Kubernetes signals that say whether a reference actually took effect.** Concretely:

1. **Gateway API cross-namespace references are resolved by name/namespace only — `ReferenceGrant` and listener `allowedRoutes` are never consulted.** This is the biggest semantic gap. A cross-namespace `backendRef` or a route attaching across namespaces is *invalid* without a grant, and the Gateway controller refuses it (`ResolvedRefs=False` / `NotAllowedByListeners`, HTTP 500). The trace shows it as a working path. (Finding 1.)
2. **Route/Gateway attachment and ref-resolution are read from `spec`, never from `status.parents[].conditions`.** The route's own status is the authority on whether it attached and resolved; the code ignores it entirely (grep for `ResolvedRefs`/`Accepted`/`status...parents` in `entries.go`/`coverage.go` → no hits). (Finding 2.)
3. **Endpoints are derived from `Service.spec.selector` + pod `Ready` condition, not from EndpointSlices.** That drops the layer where `internalTrafficPolicy: Local` / `externalTrafficPolicy: Local` / topology-aware routing decide which pods actually serve a given client, and where terminating endpoints are pruned. (Findings 4, 5.)
4. **The headline `ingress:no-controller` warning is gated off precisely on the most common broken cluster** (zero IngressClasses installed). (Finding 6.)

None of these make the *implementation* wrong — they're honest simplifications, and the live probe covers many of them. But the feature's promise is "an honest verdict about whether traffic can reach the target," and for Gateway API cross-namespace paths the static verdict + topology + config presentation actively over-claim, and Radar's probe (which dials the Service directly, bypassing the Gateway) will *confirm* the wrong answer. That is worth fixing or at least explicitly disclaiming.

---

## 3. Findings (ordered by severity)

### Finding 1 — Gateway API cross-namespace refs ignore ReferenceGrant / allowedRoutes → false "reachable" (Medium-High)

**Files/lines:** `internal/trace/entries.go:1114-1146` (`routeReferencesService`), `:1736-1773` (`routeBackends`), `:1775-1869` (`routeParentGateways`), `:1997-2066` (`attachedRoutes` / `routeAttachedToGateway`).

**Scenario:** An `HTTPRoute` in namespace `team-a` has `backendRefs: [{name: api, namespace: team-b, port: 8080}]`, but there is **no** `ReferenceGrant` in `team-b` permitting `HTTPRoute` → `Service`. Per Gateway API, the controller sets that backendRef's `ResolvedRefs` condition to `False` (`RefNotPermitted`) and returns HTTP 500 for it — traffic cannot reach `team-b/api`. Symmetrically, a Gateway with `listeners[].allowedRoutes.namespaces.from: Same` rejects routes from other namespaces (`NotAllowedByListeners`).

**Evidence:** the resolver matches purely on name+namespace and treats the ref as valid:

```go
// entries.go:1736 routeBackends
if ns == "" { ns = route.GetNamespace() }
key := ns + "/" + name
...
out = append(out, ResourceRef{Kind: "Service", Namespace: ns, Name: name})
```

`routeAttachedToGateway` (`:2034`) likewise checks only `parentRef.name/namespace == gw`, never the Gateway's `allowedRoutes`. There is no `ReferenceGrant` lookup anywhere in the package (grep: only two *comments* mention it, no code). So `traceRouteEntry` fans out to `team-b/api`, builds its Pods hop, and — because Radar probes the Service's ClusterIP directly rather than through the Gateway — the probe succeeds and the path reads healthy, contradicting the cluster's actual behavior.

**Impact:** For the exact case Radar advertises careful cross-namespace RBAC handling on, it produces a confidently wrong "reachable." This is a correctness miss on the feature's core claim.

**Fix:** When a `backendRef`/attachment crosses namespaces, look up `ReferenceGrant` in the target namespace (dynamic cache, `gateway.networking.k8s.io/ReferenceGrant`) and verify a grant whose `spec.from` matches (group/kind/namespace of the referrer) and `spec.to` matches (group/kind, optional name of the target). If absent, emit a critical/warning finding (`gateway:ref-not-permitted`) and mark the hop unverifiable rather than tracing it as live. Cheaper interim fix: cross-check the route's `status.parents[].conditions` for `ResolvedRefs=False`/`Accepted=False` (Finding 2) and surface that instead of a clean path.

---

### Finding 2 — Route/Gateway attachment derived from spec only; `status.parents` conditions ignored (Medium)

**Files/lines:** `internal/trace/entries.go:1775-1869` (`routeParentGateways`), `:1997-2032` (`attachedRoutes`), `:2034-2066` (`routeAttachedToGateway`).

**Scenario:** An `HTTPRoute` lists a `parentRef` to Gateway `gw`, but its `status.parents[].conditions` shows `Accepted=False` (hostname doesn't intersect any listener, listener protocol mismatch, port not exposed) or `ResolvedRefs=False`. The route is *not* serving traffic through that Gateway. The trace still shows Gateway→Route and Route→Service as a live path.

**Evidence:** attachment is computed entirely from `spec.parentRefs` / `spec.rules`; the route's own `status` is never read. The reproducer command they emit even points at status (`findings.go:255`: `kubectl get httproute ... -o jsonpath='{.status.parents}'`), showing they know it's the authority — but the verdict doesn't consume it. `gateway:missing-parent` (`entries.go:1839-1845`) only fires on the Gateway object being absent, not on a present-but-rejecting parent.

**Impact:** Over-claims attachment/resolution for misconfigured routes (hostname/listener/port mismatches, the most common Gateway-API footguns). The graph shows an edge the data plane doesn't honor.

**Fix:** Read `route.status.parents`, match the entry for `(parentRef, controllerName)`, and downgrade/annotate the hop when `Accepted` or `ResolvedRefs` is `False`. This also subsumes much of Finding 1 (the controller reports `RefNotPermitted` in `ResolvedRefs`).

---

### Finding 3 — Reverse cross-namespace walk discloses name + namespace of resources in namespaces the caller can't read (Low-Medium, info disclosure)

**Files/lines:** `internal/trace/entries.go:1092-1104` (`routeUpstreamsForService`), and the Gateway attach path `:1910-1926` (`attachedRoutes` reverse from a Gateway subject).

**Scenario:** A user can read Service `A/web` (their namespace `A`). An `HTTPRoute` `secret-route` in namespace `B` (which the user cannot list) has a `backendRef` to `A/web`. Radar lists routes cluster-wide (`ListWatched` / cluster-wide fallback, `:1068-1081`), finds the reference, and — although it redacts findings — emits:

```go
// entries.go:1100
Message: fmt.Sprintf("Upstream %s %q is in namespace %q, which is outside the namespaces you can read. Its findings are not shown.", kind, route.GetName(), route.GetNamespace())
```

This reveals the **existence, name, and namespace** of `B/secret-route` to a user with no RBAC on namespace `B`.

**Distinction from the safe cases:** For *downstream* refs (`traceRouteEntry`/`routeParentGateways` redaction at `:1461`, `:1814`) the referencing object is the subject the user is already reading, so revealing the target is derived from data they can see — that's fine. The **reverse** direction (upstream routes pointing *at* the user's Service, and routes attaching *to* the user's Gateway from foreign namespaces) surfaces the referrer's identity, which the user has no independent right to enumerate. CLAUDE's scope explicitly asks "Does it leak existence of resources the user can't see?" — here, yes.

**Impact:** Minor existence/name disclosure across the RBAC boundary. Not a data leak (spec/status stay hidden), but it is enumeration the user couldn't do directly.

**Fix:** For reverse-reference hops where `!NamespaceAllowed(referrerNs)`, either omit the hop entirely, or replace name/namespace with a generic "an upstream in another namespace references this Service (redacted)" that doesn't identify the object. Decide deliberately; if the product judgment is that a Service owner should know who routes to them, document that as an intentional exception.

---

### Finding 4 — `internalTrafficPolicy: Local` / `externalTrafficPolicy: Local` / topology-aware routing not modeled → over-claims reachability (Low-Medium, coverage)

**Files/lines:** `internal/trace/entries.go:942-968` (`selectedPods`), `:519-641` (`podsConfig`); no reference to `internalTrafficPolicy`/`externalTrafficPolicy`/topology anywhere in `internal/trace` (grep confirms).

**Scenario:** A ClusterIP Service with `internalTrafficPolicy: Local` only routes to endpoints **on the same node as the client**. If no ready pod runs on the client's node, in-cluster traffic to the ClusterIP fails even though ready pods exist elsewhere. The trace enumerates all ready pods and reports the path reachable. `externalTrafficPolicy: Local` similarly drops external traffic on nodes without a local endpoint. Topology-aware hints add another routing filter the trace ignores.

**Impact:** The static verdict can read "reachable" for a Service that is unreachable from many/most vantages. Radar's own probe originates from one vantage (in-cluster runner pod / API proxy) so it won't reliably surface the gap either.

**Fix:** At minimum surface an info finding when `internalTrafficPolicy==Local` or `externalTrafficPolicy==Local` ("only endpoints co-located with the client node receive traffic; reachability is node-dependent"). Fuller fix: correlate endpoint `nodeName` with the probe vantage.

---

### Finding 5 — Terminating (deleting) pods with `Ready=True` are counted as live endpoints (Low)

**Files/lines:** `internal/trace/entries.go:984-998` (`readyCount`), `:738-748` (`isPodReadyForTrace`); contrast `livePods` at `:973-982` which *does* filter `DeletionTimestamp`.

**Scenario:** During a rolling update, old pods carry `DeletionTimestamp != nil` but keep `Ready=True` until the kubelet flips them. kube-proxy removes terminating pods from the active endpoint set (serving them only as terminating fallback). `readyCount` and `isPodReadyForTrace` check only the `Ready` condition, not `DeletionTimestamp`, so terminating pods inflate the "ready endpoints" count and can keep `readyCount(pods)==0` from firing (`buildPodsHop:440`), briefly masking a "0 real endpoints" state.

**Evidence:** `readyCount` iterates conditions only; `livePods` (used for the *controller* count in `ingress_controller.go`) already demonstrates the correct filter but isn't applied on the main endpoint path.

**Impact:** Transient over-count / brief false-healthy during rollouts and scale-downs. Low because it's short-lived and the probe layer corrects it.

**Fix:** Exclude `DeletionTimestamp != nil` pods from the ready-endpoint count on the main path too (reuse `livePods`, or add the check to `isPodReadyForTrace`'s trace-facing callers).

---

### Finding 6 — `ingress:no-controller` warning is gated off when the cluster has zero IngressClasses (Low-Medium, coverage)

**Files/lines:** `internal/trace/ingress_controller.go:107-114`, `:281-307`.

**Scenario:** The most common truly-broken case — an Ingress created on a cluster with **no ingress controller and therefore no IngressClass objects at all**. `resolveIngressClass` returns an empty class list; the code then forces `couldRead = false`:

```go
// ingress_controller.go:107
if len(classes) == 0 {
    // ... treat an empty result as unverifiable ...
    couldRead = false
}
```

`classReadable=false` routes to the soft "couldn't identify the controller" pill (`:281-288`) and the positive `ingress:no-controller` finding (`:298-306`) can only fire when `classReadable==true`, i.e. when **≥1 IngressClass exists but none resolves**.

**Impact:** The headline "nothing is serving this Ingress" warning never fires on a bare cluster with no controller installed — the case it most needs to catch. This is a deliberate cold-cache-safety trade-off (empty vs. cold is indistinguishable via the dynamic informer), but the result is a real detection hole.

**Fix:** Distinguish cold from empty using the same technique `detect.go`'s scale-to-zero path adopted in this very PR — gate on `DynamicResourceCache.IsSynced(gvr)` for the IngressClass GVR (see `detect.go:1846-1855`). When the informer is synced and genuinely returns zero classes, treat empty as authoritative and allow the no-controller finding (still guarded by no-address / no-cloud-anno / no-legacy-class).

---

### Finding 7 — DNS-gap heuristic treats TCP-only port 53 as covering DNS; UDP/53-blocking policy is silently cleared (Low)

**Files/lines:** `internal/trace/egress.go:301-324` (`rulePort53`).

**Scenario:** An egress NetworkPolicy allows only `{protocol: TCP, port: 53}` to kube-system, but not UDP/53. Standard resolvers use UDP/53 first, so name resolution is in fact broken. `rulePort53` matches on the port number regardless of protocol:

```go
// egress.go:311
if p.Port.Type == intstr.Int {
    if p.Port.IntVal == 53 || (p.EndPort != nil && p.Port.IntVal <= 53 && *p.EndPort >= 53) {
        return triYes // a numeric port or range covering 53
    }
}
```

so it returns `triYes` → `dnsCovered` → the DNS-gap note is suppressed.

**Impact:** A real DNS gap (UDP blocked) is silently cleared. This is the one *active* egress warning and it can be defeated by a TCP-only 53 rule. Low because it's a niche misconfig and the whole subsystem is "fail toward silence," but it's a false-silence in the informative direction.

**Fix:** Require UDP/53 (or protocol unspecified, which defaults to all-of-that-protocol) to be covered before concluding `dnsCovered`; TCP-53-only should be at most `dnsUncertain`.

---

## 4. Investigated and rejected / downgraded

- **`nonNilPods` aliasing (`netpol.go:447-455`):** `out := pods[:0:0]` has cap 0, so the first `append` reallocates — the input slice is **not** mutated. No bug. Rejected.
- **`isZeroCIDR` suffix match (`egress.go:688`):** `HasSuffix(cidr, "/0")` only matches a `/0` prefix length for well-formed CIDRs (`/10`, `/20`, `/30` end in `0` but not `/0`). Handles `::/0` correctly too. Rejected.
- **NetworkPolicy `policyTypes` defaulting (`netpol.go:360-374`):** matches Kubernetes semantics exactly (Ingress always isolated when omitted; Egress isolated iff egress rules present). Correct.
- **Named-port-not-declared in netpol (`netpol.go:305-348`):** correctly treated as a clean no-match per K8s (rule ignored for that pod), not as uncertainty. Correct and the comment's reasoning is right.
- **Additive multi-policy union & default-deny detection (`netpol.go:262-303`):** traced several combinations (default-deny + specific-allow, allow-anywhere + default-deny, wrong-port allow) — all produce the correct verdict. Solid.
- **Multi-port worst-verdict aggregation (`netpol.go:151-162`):** `denyPort` (pod port, for probe matching) vs `res.port` (`:80` service form, operator display) are kept distinct and not conflated. Correct.
- **Cold-cache pod emptiness (`entries.go:964`, `KindCoversNamespace`):** the new `KindCoversNamespace` guard correctly converts an out-of-scope empty pod list into `unreadable=true`. Good. (Residual: a covered-but-not-yet-synced informer still reads empty as authoritative, but Pods is a startup-blocking critical informer, so this is not reachable in steady state — downgraded to a non-finding.)
- **ipBlock `0.0.0.0/0` in a netpol `from` (`netpol.go:284`):** classified as caller-dependent (advisory) rather than allow-from-anywhere, so it emits an unnecessary advisory on an actually-open path. This is conservative in the *safe* direction (never false-clears), so it's UX noise, not a correctness bug — noted here, not raised as a finding.
- **`scaledToZeroBackingWorkload` Rollout handling (`detect.go:1808-1856`):** the uncertain/absent-CRD/not-synced tri-state is careful and correct; `IsSynced(gvr)` guard against `([], nil)` cold reads is exactly right. No issue. (It reads `spec.template.metadata.labels`; a Rollout using `workloadRef` instead of an inline template won't match here, but the referenced Deployment is caught by the Deployment branch — acceptable.)
- **ExternalName / selectorless / headless Service handling (`entries.go:38-104`, `annotateServiceTerminal`):** consistent between direct-Service and Ingress/Route-backed paths (the `annotateServiceTerminal` symmetry note at `:643-650` is a genuinely good catch by the author). Correct.

---

## 5. Questions and coverage gaps

1. **ReferenceGrant / allowedRoutes / route status** — the three related Gateway-API gaps (Findings 1, 2). Is the intent to lean entirely on the live probe? If so, note that Radar's probe dials the Service directly and does **not** traverse the Gateway, so it cannot detect a Gateway-level refusal — the probe will *confirm* the false-positive. This deserves an explicit product decision.
2. **Endpoint source of truth** — deriving endpoints from selector+readiness instead of EndpointSlices drops `internalTrafficPolicy`/`externalTrafficPolicy`/topology hints and terminating-endpoint pruning (Findings 4, 5). Was EndpointSlice-based derivation considered and rejected for cost, or just not yet built?
3. **Ingress request-path semantics** — the trace enumerates every backend regardless of `pathType`/host, which is correct for "can this workload be reached at all." But `ingressConfig` renders paths without `pathType` (`entries.go:1319-1342`); confirm the UI isn't implying a specific request matches.
4. **`gatewayConfig` listeners vs `allowedRoutes`** — listeners are captured for probing (`entries.go:1951-1995`) but `allowedRoutes` is dropped, so the config can't later be used to validate attachment. If Finding 1/2 are addressed, capture it here.
5. **Per-user RBAC gate (`Deps.NamespaceAllowed`, `trace.go:74-82`)** — I confirmed the redaction call sites but did not audit whether `NamespaceAllowed` is correctly populated from the request identity in the server handler; that belongs to the server/handlers subreview. The reverse-disclosure in Finding 3 is independent of whether the gate itself is correct.
6. **DNS transport** — Finding 7 aside, `classifyDNS` also can't see the real CoreDNS pod labels and stays `triMaybe` for non-well-known selectors, which is the right conservative call; no gap there.
