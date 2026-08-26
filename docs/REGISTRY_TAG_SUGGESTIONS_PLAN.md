# Registry Tag Suggestions Plan

This is the deferred plan for a follow-up PR after rollout-state visibility. It intentionally contains no implementation.

## Product contract

Image tag suggestions are a lazy, best-effort convenience inside Set Image. Manual image entry always remains available, and lookup failure never disables Save. Radar must be explicit when results are partial, must not imply registry order is version order, and must not contact a registry until the user chooses **Show tags**.

The affordance is available by default because lookup remains an explicit user action, but its button/copy must name the registry host before the first request. Disabling the capability is the hard air-gap control.

## Capability and air-gap control

- Add `--no-registry-tag-suggestions`, default `false`. Read `cmd/explorer/main.go` before changing flags.
- Advertise the feature through the existing capabilities response. Read `internal/server/server.go` before adding the route.
- When disabled, Radar performs no outbound tag lookups and the frontend omits the affordance.
- Document the flag, outbound behavior, credential sources, and private-registry support in `docs/configuration.md`.

## Workload-scoped endpoint

Add:

`GET /api/workloads/{kind}/{namespace}/{name}/images/tags?type=container|initContainer&container=<name>`

The endpoint accepts no arbitrary repository. It resolves the selected current container through `pkg/k8score/workload_images.go`, including a Rollout `workloadRef`, and returns repository/current-reference metadata plus suggestions. Reuse or add a workload-image lookup result containing target identity, current image, Pod-template ServiceAccount, and declared pull-secret names; do not duplicate template traversal or serialize Secret names.

Use the request-scoped Kubernetes client. With auth enabled, workload, ServiceAccount, and exact Secret reads run as the caller and are enforced by the API server. An in-cluster or shared-listener no-auth deployment is anonymous-only for registry lookup: it must not use Radar's ServiceAccount to read pull Secrets and replay those credentials outbound. Local auth-disabled mode may use the operator's host keychain only when Radar is bound to loopback.

HTTP behavior:

- `400`: invalid kind, type, container, or image reference.
- `403`: workload or credential RBAC denied.
- `404`: workload or container missing.
- `503`: disconnected cluster.
- Expected registry, network, authentication, rate-limit, and unsupported-registry failures return `200` with a coarse `ok`, `empty`, `partial`, `unavailable`, or `disabled` status.

The response contains `repository`, `currentTag`, `currentDigest`, `tags`, `status`, `traversalComplete`, `resultComplete`, `scannedCount`, and `returnedCount`. Never invent a total. Logs and responses must not expose credentials, Secret names/data, auth headers, registry bodies, or resolved internal addresses.

## Bounded traversal

Use the existing go-containerregistry dependency and its paged lister. After Kubernetes resolution, apply one registry budget: 10 seconds, pages up to 1,000, at most 10,000 scanned tags, at most 1,000 returned tags, a bounded decoded response size per page and across the traversal, and a small explicit redirect-hop limit.

- If traversal finishes within budget and no tags were dropped, return the full scanned set with `status=ok`, `traversalComplete=true`, and `resultComplete=true`.
- If traversal finishes but more than 1,000 tags were scanned, return the bounded final registry-order window with `status=partial`, `traversalComplete=true`, and `resultComplete=false`.
- If time or scan budget stops traversal, return the bounded scanned window with `status=partial` and both completion fields false.
- Always merge the current tag when the reference is tagged, even if it falls outside the sample. Deduplicate while preserving registry order.

Distribution ordering is lexical/registry order, not semver or chronology. Client filtering applies only to the loaded result. Manual input is the escape hatch for tags outside partial coverage.

## Credentials

Create a pure explicit-secret keychain builder in `internal/images/auth.go` after checking existing helpers. Existing helpers are not safe to reuse blindly: one falls through to host defaults, another reads the shared informer and omits legacy formats, and the entry converter omits identity tokens.

The new builder accepts already-authorized `[]corev1.Secret`, never reads a cache, never falls back implicitly, and supports `kubernetes.io/dockerconfigjson`, `kubernetes.io/dockercfg`, and Docker identity tokens.

Credential order:

1. Anonymous.
2. Exact PodSpec `imagePullSecrets`, fetched through the request client.
3. Only when the PodSpec declares none, the workload ServiceAccount and its exact pull Secrets, also request-scoped.
4. Only in local, auth-disabled, loopback-bound mode, the operator's local Docker/Google keychain.

Forbidden or unreadable credentials degrade to `unavailable`; authenticated mode never falls through to informer Secrets or host keychains, and no-auth in-cluster/shared-listener mode never reads Kubernetes registry credentials. Add regression tests proving the endpoint cannot invoke the broad existing keychain helpers and never logs Secret names.

Before merging, perform a focused audit of the pre-existing `/api/images/inspect` credential behavior, including pull-secret-name logging. Track hardening separately if changing that contract would over-expand this PR.

## Network and abuse controls

- Move the existing `denyInternalControl` implementation unchanged from `pkg/probe/probe.go` into a shared `pkg/netguard` helper after the required helper search. Both probes and registry transport must use it so metadata-address cases cannot drift.
- Deny loopback, unspecified, link-local, and cloud metadata destinations after DNS resolution while allowing RFC1918. Apply the control on every dial so redirects and DNS rebinding are rechecked. Do not add a user-controlled insecure-registry bypass.
- Add a small bounded LRU keyed by repository plus a process-local cryptographic fingerprint of credential identity. Use roughly a two-minute positive TTL and a much shorter negative/partial TTL. Never log or expose the key.
- Deduplicate identical in-flight lookups on the same repository and credential fingerprint, never repository alone.
- Add per-principal rate limiting: authenticated identity when available, remote address only in no-auth mode. Collapse limits to `unavailable`.
- Add a per-repository ceiling across principals and honor registry `Retry-After` responses so a few users cannot exhaust a shared anonymous quota or trip private-registry lockout.
- Cache hits never substitute for the request-scoped Kubernetes authorization reads.

## UI

Add optional `onLoadImageTags` callbacks and response types to `SetImageDialog` and `ResourceActionsBar`; optional props remain additive. Fetch through the standard API configuration helpers.

- Keep the full image reference editable.
- Make **Show tags from `<registry-host>`** the only first-load trigger; opening or autofocus must not contact a registry.
- After explicit loading, support keyboard navigation, visible focus, Escape, screen-reader option semantics, and dialog focus containment.
- Cancel stale requests and deduplicate identical repository/container loads in the dialog session.
- Repository edits invalidate suggestions.
- Provide an explicit digest-to-tag action.
- Render inline loading, empty, partial, unavailable, and disabled states without toasts or disabling Save.
- Use theme tokens and verify dark/light, narrow dialogs, long references/tags, and one/many containers.

Add `packages/k8s-ui/src/utils/image-reference.ts` only after searching for an existing parser. It must correctly parse and replace tags in shorthand references, registries with ports, tagged images, digests, and tag-plus-digest references. Migrate sibling naive colon-split code in `ResourceActionsBar.tsx` and `resource-utils-cnpg.ts` so the same bug does not remain elsewhere.

## Verification

Go tests use an in-process TLS registry to cover pagination, complete/partial/empty results, current-tag retention, timeout, decoded-byte limits and malformed responses, anonymous then authenticated access, every credential format, pull-secret precedence, ServiceAccount fallback, caller-forbidden reads, anonymous-only no-auth shared/in-cluster operation, loopback-only local-keychain gating, cache isolation/deduplication, per-principal and per-repository rate limiting, `Retry-After`, sanitized errors/logging, bounded redirects, denied literal and DNS-resolved addresses, and allowed RFC1918 targets.

TypeScript/component tests cover reference parsing, lazy load, keyboard selection, cancellation and deduplication, digest confirmation, repository-edit invalidation, partial/unavailable/disabled copy, and Save during lookup failure.

Add a documented `scripts/registry-demo.sh` fixture cluster with deterministic Distribution-compatible TLS endpoints: public, basic-auth private, paginated/partial, empty, and unavailable. Keep Radar-to-registry traffic on an allowed private Service address and mount the fixture CA into the in-cluster Radar process. Production continues to deny loopback registries.

Visual E2E covers public success, explicit Show tags, selection and Save, partial and long lists, auth failure with manual fallback, digest switch, repository edits, loading, dark/light, narrow/wide, and keyboard/focus behavior. One selected image should deliberately create an attributed new-revision pull failure to exercise the rollout-liveness loop.

## Completion gates

- Follow `.claude/commands/qa.md`; run targeted Go/Vitest suites, `make tsc`, `make test`, and `make build`.
- Run the registry demo visual-test workflow and inspect every screenshot.
- Product-review the rendered autocomplete and failure states.
- Self-review and cross-review the implementation, triage findings, and converge before merging.

The PR is complete only when disabling the capability guarantees no lookup, authorization never exceeds the documented caller/mode boundary, registry failures never block Save, partial coverage is honest, and the real autocomplete works end to end.
