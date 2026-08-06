# Reachability tab — communication-state audit

Every distinct situation the page can put in front of a user, what each surface
says in that situation (exact strings from code), and a grade for how well the
surfaces agree. Sources: `reachMarks.ts` (marks/chips/tones/legend),
`reachOrigins.ts` (capsule marks), `reachGraphModel.ts` (capsule+pill labels,
`originEntryEvidence` L566-605, `noEvidenceLabel` L1236-1248),
`reachInspector.ts` (sidebar body/evidence L280-425), `reachVerdict` (band),
`coverage.go` (headline/evidence), `probe.go` (skip reasons).

## The surfaces (what can disagree with what)

| # | Surface | Vocabulary source |
|---|---------|-------------------|
| S1 | Verdict band: headline + chip + trust line + problem | backend `headline`/`diagnosis` + `routeChip` + `probeCheckStats` |
| S2 | PATH picker rows | `routeTone` dot + `routeChip` |
| S3 | Origin capsules: status row glyph+label, unavailable text | `markFor` → mark; `originEntryEvidence` label |
| S4 | Entry-edge pills | same `originEntryEvidence` (or L1236 variant) |
| S5 | Hop nodes: health dot (cluster state) + pod-row chips | resource health — **deliberately not test state** |
| S6 | Inspector THIS PATH: chip, body, WHAT WE SAW, ALONG THIS PATH, RUN THIS NEXT | `buildSidebar` |
| S7 | Legend + mark hovers | `MARK_LEGEND` |
| S8 | Footer ledger | coverage counts + WHEN |

## Scenario matrix

Grades: **A** one coherent story · **B** correct but takes work (jargon/indirection)
· **C** vocabulary conflict between surfaces · **D** false or dropped information.
"(fixed)" = addressed in this session's commits/working tree.

### Group 1 — the selected vantage produced evidence

| # | Scenario | Band/picker chip | Capsule | Sidebar body | Grade |
|---|----------|------------------|---------|--------------|-------|
| 1 | verified, real path (in-cluster/laptop dial, 2xx) | `got through` | ● + evidence | "A real request went through and the target answered." | **A** |
| 2 | verified via proxy | `got through via the API server` | ◐ `relayed by Kubernetes` | "Kubernetes relayed a request… shows something is serving, not that the normal path works." | **A** |
| 3 | reached, real (3xx/4xx) | `answered, not confirmed` | ◑ + evidence | "The target answered, but not with what was asked for." | **A−** (chip vs body slightly different claims) |
| 4 | reached via proxy | `answered via the API server` | ◑ | same | **A** |
| 5a | app 5xx (classifies as `reached`, NOT server-error) | `answered, not confirmed` + evidence "HTTP 500 · reached, server error" | ◑ | — | **B+** — deliberate: app health is not path health |
| 5b | TLS cert failure (`server-error`/tls) | was `the app returned an error` → now `TLS certificate failed` | ◑ | — | was **D** (blamed the app), now **A−** (fixed) |
| 5c | 502/504 upstream (`server-error`/upstream) | was `the app returned an error` → now `the front door couldn’t reach the backend` | ◑ | — | was **D**, now **A−** (fixed) |
| 6 | unreachable, real | `could not get through` | ✕ solid red | "This is the first confirmed failure…" + LIKELY CAUSE + culprit CTA | **A** |
| 7 | unreachable, proxy-only | now `couldn’t get through via the API server` | ◑ | — | was **C**, now **B+** (fixed; residual: mark stays `answered` — open question) |
| 8 | unreachable, benign (scaled to zero) | `nothing running (on purpose)` | ⊗ `not sent any traffic` | — | **A−** ("on purpose" is a strong claim; basis is declared intent) |
| 9 | backend-scoped verified (dial bypassed front door) | `got through · backend` + headline "Backend verified - the entry path was not exercised by this test" | ● | — | **B+** — honest, compact; `· backend` needs the hover |
| 10 | slow (answered outside latency band) | — (chip stays outcome-based) | ◔ `answered, but very slowly` | — | **A−** |

### Group 2 — derived, never dialled

| # | Scenario | Chip | Capsule | Sidebar | Grade |
|---|----------|------|---------|---------|-------|
| 11 | broken as declared (config fault) | `broken as declared` | ◇ `broken as configured` | "The configuration itself is broken, so this path cannot work from any vantage. No request was sent…" | **A** — chip says "declared", capsule "configured": same family, minor drift |
| 12 | nothing ready (cluster-state basis) | `nothing ready to serve` | ◇ | "Nothing is ready to serve this path right now, so it cannot work from any vantage…" | **A** |

### Group 3 — the selected vantage produced NOTHING (the user's pain cluster)

| # | Scenario | Chip | Capsule | WHAT WE SAW | Grade |
|---|----------|------|---------|-------------|-------|
| 13 | run skipped every dial, reasons exist (argocd case) | `not tested` | was ⊘ `not routable` → now `couldn’t test` | was "no test has been run from here" → now the actual skip reason | was **D**, now **A−** (fixed: exact probe-identity attribution via `originSkipReason`; both label sites unified through `originNoEvidenceLabel`) |
| 14 | per-vantage rows exist, this origin absent | `not tested` (neutral tone) | ○ `not tested` | "no test has been run from here" — absence IS the evidence | **A−** |
| 15 | no row, but origin dialled the front door | — | best hop evidence (e.g. ● `HTTP 200`) | "This vantage did reach part of the path — see what it saw below…" + hop rows | **A** — subtle case done well |
| 16 | nothing tested anywhere (fresh page, no probe run) | `not tested` | ○ everywhere, green health dots | "Nothing has been tested from here…" + (new) "The dots on the graph show each resource's own reported health — cluster state, not a test result." | was **C**, now **B+** (fixed) |
| 17 | in-cluster denied (RBAC) | — | ⊘ amber `not permitted` + reason | "not permitted to run this test" | **A−** |
| 18 | in-cluster run attempted, probe never started (image pull / quota) | — | ⊘ `test couldn’t run` + error text as body | evidence row still says "no test has been run from here" | **C** — capsule preserves the attempt, WHAT WE SAW erases it |
| 19 | ran, kept informational (demoted Job dials) | — | ◍ `ran — kept informational` + banner "evidence only / some routes updated" | — | **B+** — needs the hover to understand *why* informational |
| 20 | testing now (selected origin running) | `probing…` | ◌ `testing now` | "A test is running. Earlier results stay until new ones replace them." | **A** |
| 21 | stale (cluster changed since test) | `stale` | ◷ | "This result predates a change to the cluster, so it is set aside rather than trusted." + amber WHEN | **A** |

### Group 4 — vantages Radar cannot use (permanent)

| # | Scenario | Surface | Grade |
|---|----------|---------|-------|
| 22 | real caller workload (unsupported) | capsule: "Radar can't send a request from one of your running Pods yet…" + WHAT THIS DOESN'T PROVE | **A** — the honesty differentiator |
| 23 | external client (unsupported) | "no request has come in from outside" / upgraded variant when the laptop's outside dial answered | **A** |

### Group 5 — cross-cutting page states

| # | Scenario | Surfaces | Grade |
|---|----------|----------|-------|
| 24 | multi-path, mixed outcomes | picker worst-first; band chip scoped `FOR X · FROM Y`; headline resource-wide | **B+** — scope labels carry it, but reader must internalize two scopes |
| 25 | service-routing boundary (Pods answered, Service didn't) | edge break + "the Pods answered directly, but the Service did not — so the Service's own routing is what breaks" | **A** |
| 26 | break at exit of a hop | "routing to its Pods breaks just past here" | **A−** |
| 27 | partial in-cluster fold | banner "In-cluster test: some routes updated — others kept informational" | **B+** |
| 28 | healthy dots + red edge (failure on healthy resources) | dot=health, line=test; caption + legend note | **B** — same dot/line split as #16 but in the *tested* direction; caption carries it |

### Group 6 — the words inside skip reasons (backend strings)

| # | String | Problem | Grade |
|---|--------|---------|-------|
| 29 | "the backend didn't respond within the probe budget - it may be slow or still starting (not a cluster-connection problem)" | "probe budget" = internal jargon (it's per-dial ~1-1.5s inside a 3s total); asserts a *backend* observation on a dial that concluded nothing; misses the common TLS-expecting-backend cause (argocd's exact case) | **C** |
| 30 | "probe budget exhausted before this hop/check finished" | same jargon; means the 3s *total* ran out | **C** |
| 31 | "HTTPS backend - the API-server proxy speaks plain HTTP and can't verify TLS on this port. Test it directly." | precise, names mechanism and next step | **A** |
| 32 | legend `blocked`: "never tried — something failed earlier" | true for *edges* (downstream of a break) but the same mark on an all-skipped *capsule* means "tried and every dial was refused" — hover contradicts the capsule | **C** → fixed |

## Ranked fix list (proposed)

1. **[done]** #13 skip reasons surface in WHAT WE SAW, attributed to the run's origins only.
2. **[done]** #16 dot-vs-test disambiguation sentence in the untested state.
3. **[working tree]** #13 `not routable` → `couldn’t test` — apply to BOTH sites (L1243 done, L591 pending).
4. #29/#30 reword: name the wait plainly, stop asserting about the backend, add the TLS cause:
   - timeout-through-proxy → "no response within the few seconds Radar waits — the backend may be slow, still starting, or expecting TLS on this port; nothing was concluded (the cluster connection itself is fine)"
   - total-budget exhaustion → "the test ran out of time before this check could run"
   - port dial timeout → "Timed out — the port accepted no connection in the time Radar waits."
5. #32 legend `blocked` text → "never ran — something stopped it first" (covers both the earlier-segment case and the all-dials-skipped case; the capsule/pill carries the specific reason).
6. #7 `only the shortcut failed` → "couldn’t get through via the API server — the real path is untested" (parallel to the other via-API-server chips; drop the undefined "shortcut").
7. #18 WHAT WE SAW for an attempted-but-failed in-cluster run should state the attempt (reuse the capsule's error), not "no test has been run from here".
8. #5 (optional) app-5xx mark: keep `answered` mark but consider legend/hover footnote; chip already correct.

Non-goals (deliberate, re-affirmed): health dots stay health-only; `not tested`
stays neutral-toned; proxy results stay capped below proof; benign unreachable
stays non-red.

## Post-review revisions (codex adversarial pass, all triaged)

- **Accepted (high):** server-error ≠ app 5xx — `OutcomeServerError` is only TLS-cert
  failure or 502/504 upstream (coverage.go:2083-2094); app 5xx classifies `reached`
  (probe.go classifyHTTPStatus). Chip now splits on `failedLayer`. Rows 5a-5c above.
- **Accepted (high):** run-mode attribution was wrong — in-cluster runs also relay
  through the proxy, so the heuristic lost the proxy's reason there and repeated it
  under the laptop. Replaced with `originSkipReason` (exact vantage/path/source +
  port match, portless skips speak for all ports; another port's reason never
  borrowed). Tests pin all four directions.
- **Accepted (medium):** both `not routable` sites unified into exported
  `originNoEvidenceLabel`; graph-model test asserts capsule+edge agree.
- **Accepted (medium):** timeout copy made cause-neutral ("no response before the
  check gave up - could be a slow or starting backend, a port expecting TLS, or the
  relay itself; nothing was concluded").
- **Accepted (medium):** `blocked` legend → "never completed — an earlier failure or
  a skip stopped it" (covers both the downstream-of-break and all-dials-skipped cases).
- **Resolved (2nd codex pass, Q1):** proxy-only failure keeps the AMBER family
  (attention - the only signal is negative and the real path is untested; blue
  would file an actionable negative as harmless disposition), but no surface may
  claim an answer: the `answered` legend now reads "the attempt didn't verify the
  asked-for path" (class description; the chip carries answered-vs-couldn't), and
  the sidebar body for indirect-unreachable states "The relayed dial failed... the
  real path is still untested" instead of "The target answered". The mark RENAME
  codex proposed was rejected as churn - same user-facing result via legend+body.
- **Resolved (user decision, Q2):** budget stays 3s; transparency shipped instead -
  the timeout skip reason states the measured wait ("no response within the 1.0s
  this check waits"), and the band trust tooltip states the ~1s/check + 3s/run
  budget. A "retry with longer timeout" preset (codex: must raise BOTH TotalBudget
  and the 1s proxy child deadline, probes.go:713) is the agreed follow-up, later.
- **Fixed (scenario 33, missed by the audit):** local vantage on a subject with no
  front door is STRUCTURALLY undialable - after a probed run with zero local
  probes and no upstreams, the capsule says "couldn't test" and the sidebar states
  "This Service has no entry point Radar can dial from your machine - no Ingress,
  Gateway address or LoadBalancer..." instead of a bare "not tested". Gated on
  localMark==='untested' so an own-route result is never overridden, and never
  claimed before any run.
- **Fixed:** WHAT-WE-SAW for an attempted-but-failed in-cluster run carries the
  execution error (fix #7).
