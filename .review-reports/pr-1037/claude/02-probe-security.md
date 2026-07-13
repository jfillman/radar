# PR 1037 — Subreview 2: Probe correctness & mutation security

Read-only deep review. Scope: DNS/TCP/TLS/HTTP probe classification, SSRF boundaries,
the in-cluster Job runner, the REST/MCP triggers, and image/config/Helm wiring.

- **Base:** `1b9ad55632e0e72abcdd28bc4e700b7020753dad`
- **Head:** `d1face5b31572eb94afcd29920b93684f42281d3`

## Files inspected (at PR head)

- `pkg/probe/probe.go` (full)
- `internal/reachability/runner.go`, `internal/reachability/incluster.go` (full)
- `internal/server/reachability_run.go`, `internal/server/trace_handlers.go` (full)
- `cmd/explorer/probe_cmd.go` (full)
- `internal/trace/probes.go` (target/host/path construction, timeouts, SSRF-guard demotion)
- `internal/trace/coverage.go` (`ProbeRequest`, `guessInClusterRequest`, `guessConcretePath`)
- `internal/mcp/tools_diagnose.go` + `internal/mcp/tools.go` (diagnose `inCluster` gating + tool hint)
- `internal/k8s/context_client.go`, `internal/server/server.go` (impersonation, `requireCloudRole`, route wiring)
- `cmd/explorer/main.go`, `internal/config/config.go`, `internal/app/bootstrap.go`,
  `deploy/helm/radar/templates/deployment.yaml`, `Makefile` (image resolution wiring)

I did NOT build, run, or probe anything. Tests were read for intent only, not trusted as spec.

---

## Altitude / design assessment

**The design is sound and unusually security-conscious for a feature that mutates a
customer cluster.** The load-bearing decisions are right:

- **In-cluster probing is the correct approach and it's honest about vantage.** The whole
  feature is built around the distinction that a laptop/apiserver-proxy success does NOT
  prove pod-to-pod reachability. `Result.Vantage`, `Result.Path` (`data` vs `apiserver`),
  and the `confidence: indirect|real` projection all keep that separation. In-cluster
  probe failures are *never* allowed to escalate a static verdict to "broken"
  (`inClusterClean`, `stampInClusterProbes` records a throwaway-pod failure as a *skip*),
  which is the right call — a source-scoped NetworkPolicy or mesh mTLS legitimately denies
  a throwaway pod while real traffic flows.

- **The Job is the right shape.** `buildProbeJob` produces a restricted-PSA-compliant pod:
  `runAsNonRoot`, `runAsUser: 65532`, `seccomp: RuntimeDefault`, `allowPrivilegeEscalation:
  false`, `readOnlyRootFilesystem: true`, `drop: [ALL]`, `automountServiceAccountToken: false`,
  `backoffLimit: 0`, `activeDeadlineSeconds: 25`, `ttlSecondsAfterFinished: 60`. It runs the
  operator-controlled image (never user-controlled) with an **exec-form** `Command` (no shell
  → no command injection). The probe pod is *more* restricted than anything a user with
  `create jobs` could build for themselves, so it grants no capability the caller lacks.

- **RBAC + Cloud-role gating is real and enforced by the apiserver, not just SSAR.** `Run`
  gates on `Capability` (SSAR for `create jobs` + `list pods` + `get pods/log`), but the
  actual Create/List/GetLogs run under the **impersonated caller's** client
  (`getClientForRequest` / `ClientFromContext`), so the apiserver is the authority — SSAR is
  a courtesy pre-flight for a clean error, not the security boundary. Both mutating entry
  points additively require Cloud `RoleMember` (REST `requireCloudRole`; MCP
  `CloudRoleFromContext(...).AtLeast(RoleMember)`), and both re-check the namespace scope
  against the user's allow-list before creating anything. The capability GET mirrors the
  POST's gates exactly, so the UI never shows an "allowed" button that then 403s.

- **The MCP hint change is correct.** `diagnose` dropped `ReadOnlyHint: true` (old `readOnly`
  annotation) for `diagnoseAnno` (no read-only hint, `DestructiveHint: false`). Since
  `inCluster=true` creates pods, removing the read-only hint is the honest move — a client
  that auto-approves read-only tools will now prompt for `diagnose`.

- **SSRF is treated as a first-class threat.** `denyInternalControl` is wired into every
  direct dial (TCP/TLS/HTTP transport `Control` hook) and blocks loopback, unspecified
  (`0.0.0.0`/`::`), link-local (covers `169.254.169.254` — AWS/GCP/Azure/OCI/DO IMDS), plus
  explicit Alibaba `100.100.100.100` and IPv6 `fd00:ec2::254`. The hook receives the
  *resolved* concrete IP, so it is not DNS-rebinding-bypassable.

Net: no critical or high findings. The residual issues below are low-severity hardening
and one design gap (no global kill-switch). I'd ship this with the notes addressed at
leisure.

---

## Findings (ordered by severity)

### 1. [Low] `handleProbeInCluster` accepts an arbitrary `Target`/`Scheme` unbound to the named subject

`internal/server/reachability_run.go` (`handleProbeInCluster`, ~lines 120–165). The route is
`/trace/{kind}/{namespace}/{name}/probe-in-cluster`, but the dial `Target` comes entirely
from the request body and is validated only as well-formed `host:port`:

```go
if _, _, err := net.SplitHostPort(strings.TrimSpace(req.Target)); err != nil {
    s.writeError(w, http.StatusBadRequest, "target must be host:port")
    return
}
```

Nothing ties `Target` to `{name}`'s observed config. A caller with `create jobs` in the
namespace + `RoleMember` can therefore turn this endpoint into a **generic in-cluster
network-probe primitive** against any `host:port` reachable from a pod in that namespace
(other namespaces' ClusterIPs, external hosts, etc.).

**Why it's Low, not higher:** the throwaway pod applies `denyInternalControl` (metadata /
loopback blocked), carries no service-account token, and the caller already has `create
jobs` — i.e. they could build an identical pod by hand. So this is not a privilege
escalation, only a mild "Radar as confused deputy" concern, and the probe response
(status/redirect/cert) surfaces to the *operator*, not an attacker. `req.Scheme` is also
unvalidated (passed as `--scheme` into the pod and used in `scheme://target/path`); a
crafted scheme could reshape the effective URL, but since `Target` is already fully
caller-controlled this adds nothing.

**Fix:** validate `req.Scheme ∈ {http, https}` and (optional, defense-in-depth) verify
`req.Target`'s host resolves to a ClusterIP/PodIP/declared-host of `{name}` before creating
the Job — or document that this endpoint is intentionally a general namespace-scoped probe.

### 2. [Low] No operator kill-switch to disable in-cluster Job creation

`cmd/explorer/main.go` adds `--reachability-image` but there is no `--no-reachability` /
`--disable-in-cluster-probe` flag, unlike the `--no-mcp` precedent for the other
sensitive surface. The only controls on the sole mutating diagnostic are per-user RBAC
(`create jobs`) and Cloud `RoleMember`. An operator who wants a strictly read-only Radar
deployment cannot centrally forbid probe-Job creation; they must ensure no impersonated
identity is ever granted `create jobs` (and, in auth-disabled/local mode where the SA
identity is used, RBAC is the SA's own).

**Fix:** add a config/flag kill-switch (`--reachability-in-cluster=false`) checked in
`handleProbeInCluster` / `handleTraceInCluster` / the MCP `inCluster` branch before any
Job creation. Cheap defense-in-depth for compliance-sensitive operators.

### 3. [Low] Local direct probes reach RFC1918 targets from Radar's in-cluster network identity

`pkg/probe/probe.go` (`denyInternalControl`, ~lines 63–85) deliberately allows private
ranges (`10/8`, `172.16/12`, `192.168/16`, IPv6 ULA) as "normal cluster networking".
Probe targets for `probeIngress` / `probeGateway` / `probeExternalName`
(`internal/trace/probes.go`) are taken from cluster routing config (Ingress hostnames,
Gateway `status.addresses`, `ExternalName`). When Radar runs **in-cluster**, a user who can
create a routing object that a viewed trace fans out to (e.g. an `ExternalName` or Ingress
host resolving to an internal `10.x` admin endpoint or kubelet `:10250`) can make Radar's
privileged in-cluster process send an unauthenticated `GET` to that internal target and
surface its status/`Location`/cert to the operator.

**Why it's Low:** GET only, no auth headers/body/cookies, the metadata crown-jewel is
blocked, redirects are not followed, and the response is shown only to the operator viewing
the trace (not returned to the attacker). Reaching RFC1918 from an in-cluster pod is also
Radar's normal, expected capability. Acceptable residual risk — worth a one-line note in
`docs/diagnose.md` that local probes traverse Radar's own network position.

### 4. [Low] `Capability` omits `delete jobs`; cleanup relies on the TTL controller

`internal/reachability/runner.go`. `Capability` gates `create jobs` / `list pods` /
`get pods/log`, but `Run`'s deferred cleanup does `Jobs().Delete(...)`. A caller who can
create but not delete Jobs passes the gate; the deferred `Delete` then fails and the error
is intentionally swallowed. This is **not a leak** — `TTLSecondsAfterFinished: 60` +
`ActiveDeadlineSeconds: 25` + `BackoffLimit: 0` guarantee cleanup by the (controller-manager-run)
TTL controller regardless of the caller's delete permission — but it is a silent dependency
on the TTL-after-finished controller being enabled (it is, by default, since k8s 1.21).

**Fix:** none required; optionally note the TTL dependency in a comment so a future reader
doesn't "fix" the ignored Delete error. On a cluster with the TTL controller disabled, a
finished Job created by a delete-denied caller would linger until manual cleanup — an
acceptable edge.

---

## Investigated and rejected / downgraded

**Adjudicated concern 1 — cross-namespace DNS `name.namespace.svc` parsing: NOT a bug.**
`internal/reachability/incluster.go` `fqdnDialTarget` rewrites a cross-namespace
`name:port` to `name.ns.svc:port` (only when `TargetNamespace != probePodNamespace`;
same-namespace stays bare, which resolves in-pod). `name.ns.svc` is a valid short form:
with in-cluster `ndots:5` the 2-dot name is treated as non-FQDN and the resolver appends
the `cluster.local` search suffix, yielding `name.ns.svc.cluster.local`. Correct for the
Gateway-API cross-namespace `backendRef` case it targets. Route `Target`s are Service
names (not IPs) here, so the "name" assumption holds.

**Adjudicated concern 2 — path normalization / traversal: handled correctly.** The mutating
single-probe endpoint applies `path.Clean("/" + p)` (`handleProbeInCluster`), collapsing
`../`. The trace `ProbePath` flows through `httpPath()` in `internal/trace/probes.go`, which
also does `path.Clean`. The in-cluster runner's request path comes from
`guessConcretePath` (cluster route config), not raw user input. `proxySuffix` only
guarantees a leading slash without `path.Clean`, but the apiserver-proxy path runs under the
caller's own `services/proxy` RBAC and returns only to the operator — no escalation. No
traversal issue.

**HTTP redirect following (SSRF via 3xx): rejected.** `probe.HTTP` sets
`CheckRedirect: func(...) error { return http.ErrUseLastResponse }` — redirects are captured
(`Location` shown in `Detail`) but never followed, so a redirect to an internal target is
not chased. Explicitly correct.

**SNI / Host header correctness: correct.** `probe.HTTP` sets `req.Host = host` and
`tlsCfg.ServerName = host` when a host is supplied, so a Gateway HTTPS backend dialed by IP
presents the right SNI/Host and cert verification matches the declared name (documented
rationale in the function comment). `probe.TLS` sets `ServerName` + `MinVersion: TLS1.2`.

**Command injection in the probe Job: none.** `buildProbeJob` uses exec-form `Command`
`[]string`; user values (`target/host/scheme/path/layers`) are argv elements, not shell.
`FallbackCommand` (a copy-paste string, never executed by Radar) `shellQuote`s every
user-controlled value including `layers`.

**Unbounded network ops / server hang: none found.** Every dial/read is context-bounded:
per-layer timeouts (`dnsTimeout` 250ms, `tcpTimeout` 700ms, `tls/httpTimeout` 1s), an overall
`defaultProbeBudget` 3s deadline in `runProbes`, `jobTimeout` 25s for the create→read cycle,
a bounded 5s cleanup context, `HTTP` uses `DisableKeepAlives` + fresh transport per call, and
`readPodLogs` caps at `io.LimitReader(1<<20)`.

**Image can be forced to an attacker image: rejected.** `ResolveImage` sources the image
only from operator-controlled inputs (override/config → self-read of Radar's own pod → env
`RADAR_IMAGE` → version default). No user-request field influences the image. `selfPodImage`
correctly refuses to guess in a multi-container pod that has no container named `radar`.

**HTTP status classification conflation: rejected.** `classifyHTTPStatus` is deliberately
network-path-scoped: 2xx `healthy`, 3xx/4xx/app-5xx `reached`, only proxy-class 502/504
`degraded`. This is coherent for a reachability diagnosis and consistent between the direct
and apiserver-proxy paths (`classifyProxy5xx`). DNS is classified by
`net.DNSError.{IsNotFound,IsTimeout,IsTemporary}` (NXDOMAIN vs SERVFAIL vs timeout) — the
distinction operators need. TLS cert-trust failures are separated into vantage-dependent
(private CA → `reached`) vs deterministic (expired/wrong-host → `degraded`), which is the
right split.

**MCP `inCluster` bypassing consent: downgraded to accepted design.** There is no
human-consent gate on the MCP path (the `InClusterConsentDialog` is frontend-only), so an AI
agent with `RoleMember` + RBAC can create probe pods. This is intended — the tool is
annotated non-read-only and its schema description states it CREATES pods — and it is bounded
by RBAC + Cloud-role. Worth being aware of, not a defect.

---

## Questions / coverage gaps

1. **TCP failure granularity (out of my file scope to fully judge in the UI):** `probe.TCP`
   returns only `sanitizeError(err)` — "connection refused" vs "i/o timeout" is
   distinguishable by text but not structurally classified the way DNS is. At the verdict
   level both collapse to unreachable, which is fine; if the UI ever wants to separate
   "closed" from "filtered" it will need a classifier. Not a bug today.
2. **`--reachability-image` in local/dev with a `-dirty` build:** the default
   `ghcr.io/skyhook-io/radar:<version>` won't exist for unreleased builds (the `Makefile
   kind-load-probe` target exists precisely for this). Confirm released binaries always
   carry a published tag so the default resolves — otherwise the probe silently
   `ImagePullBackOff`s (handled gracefully as a reason, but a poor first-run experience).
3. **Auth-disabled / local mode:** in that mode `ClientFromContext` returns Radar's SA
   client, so the "caller's RBAC" for Job creation is Radar's kubeconfig identity. That's
   the intended local-operator model, but a reviewer of the deployment story should confirm
   Radar's own SA is not granted cluster-wide `create jobs` in a shared/cloud deployment
   where auth is expected to always be on. (The impersonated path is correct; this is only
   about the no-auth fallback.)
4. **Node scheduling of the probe pod:** the Job sets no `nodeSelector`/tolerations. On a
   cluster where the caller's namespace has restrictive scheduling (taints), the pod may sit
   unschedulable until `activeDeadlineSeconds` — handled honestly by `podStartupBlock`, but a
   heavily-tainted cluster will see more timeouts. Behavioral, not a defect.
