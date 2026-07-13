# PR #1037 review — probes and the mutating in-cluster boundary

## Scope

- PR: `skyhook-io/radar#1037`
- Exact diff reviewed: `1b9ad55632e0e72abcdd28bc4e700b7020753dad..d1face5b31572eb94afcd29920b93684f42281d3`
- Primary files: `pkg/probe/*`, `internal/trace/probes.go`, probe-related coverage folding, `internal/reachability/*`, `internal/server/reachability_run.go`, `internal/server/trace_handlers.go`, `cmd/explorer/probe_cmd.go`, MCP in-cluster orchestration, and image/config/Helm wiring.
- Method: read-only inspection with `git show` / `git diff` at the pinned refs. I did not review the moving `main` worktree, mutate a cluster, edit product code, or run the PR's tests.

## Altitude assessment

**Recommendation: request changes.**

The primitive probe package is unusually thoughtful: redirects are not followed, Host and SNI are coordinated, certificate failures are separated from transport failures, direct dials have a DNS-rebinding-safe `Dialer.Control` guard, probe budgets exist, and the Job is non-root, tokenless, read-only, capability-dropped, resource-limited, deadline-bound, and TTL-backed.

The load-bearing problem is higher in the stack. The product calls the Job result “real traffic,” but for an Ingress/HTTPRoute/GRPCRoute it dials the backend Service directly, not the declared entry path, and it runs from a generic Pod identity rather than the real source. The code correctly acknowledges that a failure from this Pod is not authoritative, then treats a success from the same non-representative Pod as authoritative enough to replace the route outcome and erase NetworkPolicy warnings. That asymmetry can produce the exact failure mode a diagnostic system must avoid: a confident green answer for a route that real clients cannot use.

The mutation authorization boundary is otherwise directionally sound: the REST and MCP entry points apply the Cloud `Member` gate, namespace scope, and caller-impersonated Kubernetes checks before Job creation. The remaining mutation risks are operational (aggregate timeout, pull credentials, and cleanup authorization), not an obvious privilege escalation.

## Findings

### 1. High — The “in-cluster route” check bypasses the entry path, then replaces the whole route with the backend-only result

**Locations:**

- `internal/reachability/incluster.go:55-72`
- `internal/trace/coverage.go:256-284`
- `internal/trace/coverage.go:335-358`
- `packages/k8s-ui/src/components/trace/ReachabilityExplainer.tsx:59-78,98-119`

**What breaks:** For an Ingress, HTTPRoute, or GRPCRoute, `RunInClusterTests` always sets the Job target to `r.Target`, which is the backend Service (`service:port`). Host and path are carried as HTTP request metadata, but no packet traverses the Ingress/Gateway/controller/listener. `ApplyInClusterResults` then rebuilds and replaces the entire `RouteResult` from that backend-only result and gives it `ConfidenceReal`.

The follow-up recomputation calls `computeVerdict`, but not `reviseVerdictWithProbes`, so a prior live front-door dial failure left on the entry hop does not necessarily survive into the shipped coverage verdict after the backend result replaces the route. The frontend's own matrix explicitly says entry hosts are not tested by the in-cluster Job, yet the route-level headline can still be upgraded by that Job.

**Practical failure:** `shop.example.com/api` is refused at the load balancer, points to the wrong controller, or is rejected by its listener, while `api:8080` answers inside the cluster. The first reachability run correctly sees the front door fail. “Test in-cluster” dials `api:8080` directly, receives HTTP 200, replaces the route with a real-confidence pass, and can ship a green/reachable headline even though no request exercised `shop.example.com` or the controller.

**Concrete fix:** Keep entry-path evidence and backend-localization evidence as different facts. A direct backend Job may upgrade the backend Service hop only; it must not replace the declared route outcome. If a full-route in-cluster test is desired, explicitly dial the programmed Gateway/Ingress address with the intended Host/SNI/path and model the hairpin/source caveat. Re-run the probe-verdict reconciliation after applying any live result so surviving front-door failures cannot be healed by a backend result.

### 2. High — Success from the throwaway Pod is treated as ground truth even though the code admits that this Pod's source identity is not representative

**Locations:**

- `internal/reachability/incluster.go:68-72,95-113`
- `internal/reachability/runner.go:271-302`
- `internal/trace/coverage.go:315-326,361-407`

**What breaks:** A failed Job probe is deliberately not folded because the Pod has a different identity from the real client and may be denied by source-scoped NetworkPolicy or mesh mTLS. A successful probe from that same Pod is folded as `ConfidenceReal`, and `reconcileInClusterPolicy` rewrites a static `would-deny` warning into a reassuring info message saying the rule is not blocking the path.

The Job runs in the subject namespace with only Radar's two labels, the namespace's default ServiceAccount identity (token automount is off, but network/mesh identity still exists), and whatever admission injection applies there. It does not clone the Ingress controller namespace, Pod labels, ServiceAccount, sidecars, mesh identity, or an actual caller workload. Success is therefore source-specific too.

**Practical failure:** An Ingress in `app` routes to a Service in `app`; policy allows same-namespace Pods but denies the actual `ingress-nginx` controller namespace. The probe Job is also in `app`, so it succeeds. The code then removes the warning that correctly predicted the controller-to-backend denial and labels the route confirmed, while every real ingress request is still blocked.

**Concrete fix:** Treat both pass and fail as “from a Radar probe Pod” unless the source has been faithfully selected. Do not clear source-sensitive policy findings or promote the intended route to real confidence from this evidence. A stronger design would let the user select a real source workload and execute from that workload's namespace/labels/identity (or attach an ephemeral probe there); otherwise keep a distinct `probe-pod` confidence/vantage and use it only for localization.

### 3. High — Five sequential 25-second Jobs are mounted under a 60-second request timeout

**Locations:**

- `internal/reachability/incluster.go:14-16,55-90`
- `internal/reachability/runner.go:113-116,184-213`
- `internal/server/server.go:283-285,328-338`

**What breaks:** The whole-subject action permits five routes and invokes `Run` sequentially. Each `Run` has a 25-second create-to-log timeout, so the backend permits roughly 125 seconds plus trace building and repeated SSARs. All three reachability routes are inside Chi's 60-second timeout group.

**Practical failure:** A five-route Ingress in a cluster with an 8–15 second image pull/admission/scheduling delay is entirely normal. The third or later Job crosses the HTTP deadline, request context cancellation aborts the run, and the client receives the middleware timeout rather than the carefully accumulated per-route statuses. Two Jobs may already have executed, so retrying also generates duplicate diagnostic traffic.

**Concrete fix:** Give the whole operation one aggregate deadline below the HTTP timeout and run the capped routes concurrently (or in one multi-target Job/Pod), with bounded fan-out. Perform `Capability` once per namespace rather than three SSARs per route. Return explicit “aggregate budget exhausted” rows for unfinished routes. Alternatively move this route outside the generic timeout, but it still needs a deliberate aggregate product deadline.

### 4. Medium — Every TLS Ingress host is also required to pass port 80

**Locations:**

- `internal/trace/probes.go:1013-1127` (especially `1082-1090`)
- `internal/trace/coverage.go:1430-1458,1470-1478`

**What breaks:** `probeIngress` always probes port 80 and adds 443 for TLS hosts. Coverage folds all of those front-door results into the same intended route, and `worstOutcome` makes any transport failure unreachable. Kubernetes Ingress does not require an HTTPS host to expose an HTTP listener; controllers can be configured HTTPS-only.

**Practical failure:** A healthy TLS-only Ingress returns HTTP 200 on 443 but intentionally refuses 80. Radar records the port-80 refusal, combines it with the successful TLS/HTTPS probes, and calls the route unreachable (or at least degraded) even though the declared HTTPS route works.

**Concrete fix:** Model HTTP and HTTPS entry surfaces separately. For a TLS host, 443 is the declared route's primary probe; port 80 may be an independent redirect/advisory check, but its failure must not condemn the HTTPS route. For non-TLS hosts, probe 80. Add an HTTPS-only fixture with 80 closed and 443 returning 2xx.

### 5. Medium — The supported whole-subject Gateway action is a silent no-op

**Locations:**

- `internal/trace/coverage.go:1030-1040,1093-1099`
- `internal/reachability/incluster.go:55-59`
- `internal/server/reachability_run.go:197-255`

**What breaks:** `buildRoutes` excludes a Gateway's attached routes, then creates one fallback Gateway route from front-door probes. Unlike Service/backend routes, it never calls `attachInClusterRequest`. `RunInClusterTests` silently skips every route whose request is nil. The handler still returns a finalized trace and no error.

**Practical failure:** The capability endpoint says the caller may test a Gateway, the button runs, no Job is created, `inClusterTests` is empty, and no in-cluster result is stamped. The user sees a completed request that did not do the advertised mutation or test.

**Concrete fix:** Decide the product truth first. If in-cluster probing a Gateway entry is not meaningful (the UI already calls it a hairpin), make the action explicitly inapplicable and explain why. If it is supported, build per-listener/address requests and preserve listener identity; do not synthesize one portless Gateway route and silently skip it. Capability should include semantic eligibility, not just RBAC.

### 6. Medium — ExternalName probing tests the origin host on assumed port 80, not how clients use the Service, and cannot run via the whole-subject Job

**Locations:**

- `internal/trace/entries.go:38-54`
- `internal/trace/probes.go:428-475`
- `internal/trace/coverage.go:1001-1016`

**What breaks:** The ExternalName branch drops the Service's `Config`, even though ExternalName Services may declare ports. The probe then unconditionally tries `http://externalName:80`, uses the external name as Host, and the coverage branch returns without an `InClusterRequest`.

This is not the client-visible request. A workload connects to the Service DNS name; DNS follows the CNAME, but HTTP Host / TLS SNI normally remains the Service name. Kubernetes explicitly warns that this hostname difference can break HTTP and TLS. Probing the origin with its own hostname can pass while the Service-facing request fails. Conversely, a valid `port: 443`, database, or other declared-port ExternalName is reported only as an assumed-port-80 gap. The UI's suggested “run in-cluster” follow-up cannot run because there is no request to schedule.

**Practical failure:** `payments` is an ExternalName Service with port 443. `payments.prod.svc` clients fail certificate validation or Host routing, but Radar probes `http://vendor.example:80` (or follows a 3xx only as “reached”) and never exercises 443 or the client-visible name.

**Concrete fix:** Preserve `serviceConfig(svc)` and produce one route per declared port/protocol. Distinguish origin reachability from Service-client semantics: dial the external target but use the client-visible Service Host/SNI when claiming the Service works; show the origin-host result separately as localization. Add a DNS-only in-cluster request when no port is declared rather than silently omitting the action. See the official Kubernetes [ExternalName caution](https://kubernetes.io/docs/concepts/services-networking/service/#externalname).

### 7. Medium — The custom “what to test” path is not the path sent by the Job, and current normalization corrupts valid HTTP request targets

**Locations:**

- `packages/k8s-ui/src/components/trace/TracePanel.tsx:281-294`
- `internal/server/reachability_run.go:180-182,228-241`
- `internal/trace/coverage.go:1083-1087,1666-1683`
- `internal/reachability/incluster.go:68-72`
- `internal/trace/probes.go:31-44`
- `pkg/probe/probe.go:515-541,548-562`

**What breaks:** The UI promises that the custom path applies to both reachability and the in-cluster test. The whole-subject handler passes that value only as `Options.ProbePath`, which controls the inline probe. Each route's `InClusterRequest` is later built from the declared rule path, and the Job consumes that route path, so the user-selected value is ignored by the Job.

Separately, `path.Clean` removes trailing slashes, collapses duplicate slashes, and resolves dot segments. Those are observable HTTP routing semantics, particularly for `Exact` paths. The API-server proxy path also feeds the value through client-go `rest.Request.Suffix` (which path-joins it), so a path containing a query is not represented like the direct HTTP URL. Different vantages can therefore test different request targets while the UI presents them as the same test.

**Practical failure:** The operator selects exact path `/ready/`; the inline normalizer changes it to `/ready`, while the Job receives the route's original declared path instead of the override. With `/ready/?deep=1`, direct HTTP interprets the query normally but the API proxy treats `?deep=1` as path material. A 2xx from any one of those requests is not evidence about the same requested endpoint.

**Concrete fix:** Represent the custom request as a parsed relative URL (`escaped path` plus `RawQuery`), reject schemes/authorities instead of filesystem-cleaning it, and preserve trailing slash/escaping. Apply the same normalized request object to direct HTTP, API proxy, and the Job. An explicit custom path must override the route's guessed/declared `InClusterRequest.Path`. Add parity tests for `/foo/`, repeated slashes, `%2F`, and `?key=value` across all three transports.

### 8. Medium — Reusing Radar's image reference does not reuse the credentials or pull policy needed to run it

**Locations:**

- `internal/reachability/runner.go:46-75,84-110`
- `internal/reachability/runner.go:240-305`
- `deploy/helm/radar/templates/deployment.yaml:31-47,190-200`

**What breaks:** `ResolveImage` reads only the image string from Radar's Pod and advertises this as automatically correct for private registries and mirrors. The generated Job does not copy/configure `imagePullSecrets`, `serviceAccountName`, or `imagePullPolicy`, and it is usually created in a different namespace where Radar's pull secret cannot be referenced.

**Practical failure:** Radar itself runs successfully from `registry.corp/radar:1.8` using an `imagePullSecret` in the Radar namespace. A probe Job in `payments` uses the same image string under the default ServiceAccount with no secret and sits in `ImagePullBackOff` until the 25-second timeout. The fallback command has the same problem. A mutable non-`latest` tag can also use a stale cached image because the original pull policy is lost.

**Concrete fix:** Make the execution image contract explicit. Options include a dedicated publicly/preattached probe image, configurable per-namespace `serviceAccountName`/`imagePullSecrets`, or a documented requirement that the mirror be anonymously/node-credential pullable. Preserve the source pull policy, and prefer a digest/ImageID when the claim is “the same image.” Add a private-registry integration test; a unit test of the image string is insufficient.

### 9. Low — “Self-destructing” cleanup is not part of the capability contract

**Locations:**

- `internal/reachability/runner.go:143-163`
- `internal/reachability/runner.go:192-201`
- `internal/reachability/runner.go:271-276`

**What breaks:** Capability requires `create jobs`, `list pods`, and `get pods/log`, but not `delete jobs`. Cleanup uses the caller-impersonated client, ignores the delete error, and relies on `ttlSecondsAfterFinished` as a backstop. TTL starts only after the Job reaches a terminal state and depends on the Job/TTL controllers.

**Practical failure:** A role grants exactly the advertised minimum verbs but not delete. Every successful run gets a Forbidden cleanup, and a Job that never becomes terminal because controllers are impaired can remain indefinitely. Even ordinary completed objects live longer than the UI's “self-destructing” language suggests.

**Concrete fix:** Either include `delete jobs` in capability and surface cleanup failures, or weaken/document the guarantee and expose residual Job status. A bounded delete on a background context is good; silently ignoring a predictably unauthorized delete is not.

## Existing review-thread adjudication

### Cross-namespace `name.namespace.svc`

**Verdict on the existing “wrong DNS / guaranteed NXDOMAIN” claim: skip as stated, but simplify the code.**

`fqdnDialTarget` at `internal/reachability/incluster.go:119-129` produces `name.namespace.svc`. Under the Job's default `ClusterFirst` DNS policy, the Pod search list includes the cluster suffix and `ndots:5`, so that name expands to `name.namespace.svc.<cluster-domain>` and resolves. The existing thread's claim that the extra `.svc` necessarily makes the name invalid is therefore not correct for a normal Pod resolver.

That said, Kubernetes documents `name.namespace` and the fully qualified `name.namespace.svc.<cluster-domain>` as the supported forms, and notes that other layouts that happen to work are implementation details. `name.namespace` is cluster-domain agnostic and takes fewer search attempts, so it is a cleaner fix than relying on partial `.svc` expansion. See [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/#namespaces-of-services). This is robustness/portability, not the medium-severity outage asserted by the thread.

### Custom path normalization

**Verdict on the original stale claim: the literal issue was addressed at head, but the current result is still wrong.**

At `d1face5`, `internal/trace/probes.go:31-44` does call `path.Clean`, so the thread's statement that it merely trims and prepends `/` no longer describes the reviewed head. The generic POST also cleans at `internal/server/reachability_run.go:139-147`. However, cleaning an HTTP request target is not a security boundary and changes valid routing semantics, while the whole-subject Job ignores the custom path entirely. Finding 7 should replace the old thread rather than marking the path area clean.

## Security and correctness checks that passed

- **Cloud-role and namespace parity:** capability mirrors namespace scope and Cloud `Member` at `internal/server/reachability_run.go:62-87`; both mutating POSTs enforce the same gates at `:121-133` and `:208-227`; MCP checks `Member` before calling the shared runner. `Run` repeats authoritative caller-impersonated SSARs and the actual Create.
- **Job hardening:** non-root UID, runtime-default seccomp, read-only root FS, no privilege escalation, all capabilities dropped, service-account-token automount disabled, CPU/memory limits, no retries, active deadline, and TTL are all present at `internal/reachability/runner.go:258-305`.
- **No shell injection in the Job:** the container command is an argv slice. The fallback command single-quotes every variable value with embedded-quote escaping at `internal/reachability/runner.go:487-564`; the JSON override is also quoted.
- **Direct-dial SSRF guard:** TCP/TLS/HTTP all use the `Dialer.Control` hook, so the decision is made against the resolved IP on every connection, including DNS rebinding. It denies loopback, unspecified, link-local, and named non-link-local metadata IPs at `pkg/probe/probe.go:48-85`. Private cluster ranges remain intentionally allowed.
- **Arbitrary target in the standalone POST is not an obvious RBAC escalation:** the endpoint is generic and does not bind `target` to `{kind}/{name}`, but running it requires the caller to be allowed to create arbitrary Jobs in that namespace. Such a caller can already submit the same fixed, tokenless probe Job. It is still worth documenting/auditing as a blind network action.
- **HTTP transport basics:** redirects are returned rather than followed; Host and TLS `ServerName` move together; each request has a context deadline; keep-alive is disabled; certificate trust failures are not mislabeled as TCP reachability failures.
- **Previously reported nil-client cap and namespace-gate issues are fixed at head:** nil client is handled before the counter at `internal/reachability/incluster.go:74-89`, and the standalone capability/POST now apply namespace scope at `internal/server/reachability_run.go:62-69,127-133`.

## Questions and coverage gaps

1. There is no real-cluster test covering the core semantic matrix: actual ingress-controller source denied while a same-namespace probe Pod is allowed; entry down while backend Service returns 2xx; or mesh identities that differ between probe and workload.
2. Add an aggregate-time test with 3–5 routes and delayed Pod startup. Current unit tests exercise the cap only with a nil client, so no Job duration is involved.
3. Add real Jobs in a private-registry namespace with `imagePullSecrets`, an admission-injected classic sidecar/init container, a restricted PSA, and create/list/log-but-not-delete RBAC.
4. The `32Mi` memory limit is aggressive for the full Radar binary (which imports the server/client-go stack even though `main` dispatches early). Measure peak RSS of the released container's `radar probe` path before relying on it.
5. Exercise HTTPS-only Ingress, a dual-stack/multi-address Gateway with one address unavailable from the probe vantage, a real h2c/TLS GRPCRoute, and ExternalName Services on 443/non-HTTP ports.
6. Real-cluster API-proxy tests should distinguish a backend-generated 404/429/5xx from the apiserver's own resource-not-found, throttling, or internal error. `proxyResult` trusts almost every recovered status as a backend response after special-casing only Forbidden; synthetic `StatusError` unit tests do not establish the wire distinction.
7. Add exact request-target parity tests across direct HTTP, Service/Pod proxy, and Job transport, including trailing slash, repeated slash, escaped slash, query parameters, wildcard/regex guesses, and an operator override.
