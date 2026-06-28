import type { Trace, ResourceRef } from './types'
import type { StatusTone } from '../ui/status-tone'

// VIA_API_SERVER is the ONE operator-facing name for the apiserver-proxy vantage
// — a real request on the CONTROL-PLANE path (API server → endpoint/kubelet →
// pod) that bypasses kube-proxy + NetworkPolicy. Named by path, not real/fake.
// MUST stay identical to the Go const VantageAPIServer (coverage.go); pinned by a
// test on each side so the two headline generators can't drift.
export const VIA_API_SERVER = 'via API server'

export interface ReachVerdictView {
  icon: '✓' | '⚠' | '✗' | ''
  tone: StatusTone
  text: string
  caveat?: string
  /** The full explanation — shown in a tooltip behind an info icon next to the
   *  caveat, so the banner stays a one-liner instead of a wall of text. */
  detail?: string
}

/**
 * reachVerdict maps a trace to a plain-language verdict line. The honesty rule:
 * confidence is a LEVEL, not an alarm — a reached/200 (even via the proxy) reads
 * ✓ with a caveat, NEVER a ⚠. ⚠ is reserved for real problems (server-error,
 * partial, unreachable). Deliberately does NOT reuse the alarm VerdictBanner.
 */
/** The host an ExternalName Service aliases to, if the path ends in one. An
 *  ExternalName is a DNS CNAME to a host OUTSIDE the cluster — there are no pods
 *  or ClusterIP, so there is nothing in-cluster to actively probe. */
export function externalNameHost(trace: Trace): string | undefined {
  for (const h of trace.downstream ?? []) {
    if (h.resource?.kind === 'ExternalName') return h.resource.name
  }
  return undefined
}

// frontDoorStatus reads whether the EXTERNAL entry (the ingress/gateway host a user
// actually hits) was reached, couldn't-be-verified-from-here (a skip — e.g. split-
// horizon DNS), or genuinely failed. Only meaningful when the SUBJECT is the front
// door (Ingress/Gateway); for a Service subject the host is upstream context, not the
// thing under test. The host probe lives on the subject's own hop.
// hostFromTarget extracts the bare host from a probe target ("http://host:80/p"
// → "host"). Uses linear string ops + an anchored numeric check rather than
// chained `.replace(/\/.*$/…)` regexes — the target can carry cluster-derived
// hostnames (uncontrolled), and the chained form trips CodeQL's polynomial-regex
// (ReDoS) check.
export function hostFromTarget(target?: string): string {
  let s = target || ''
  const scheme = s.indexOf('://')
  if (scheme >= 0) s = s.slice(scheme + 3) // strip scheme
  s = s.split('/', 1)[0] // strip path
  const colon = s.lastIndexOf(':') // strip trailing :port (numeric only — leave IPv6 alone)
  if (colon >= 0 && /^[0-9]+$/.test(s.slice(colon + 1))) s = s.slice(0, colon)
  return s
}

function frontDoorStatus(trace: Trace): { state: 'reached' | 'partial' | 'partial-untested' | 'partial-reached' | 'http-reached' | 'transport' | 'server-error' | 'skipped' | 'failed' | 'none'; host?: string; detail?: string; dnsSkip?: boolean } {
  const k = trace.subject.kind
  if (k !== 'Ingress' && k !== 'Gateway') return { state: 'none' }
  const hop = (trace.downstream ?? []).find((h) => h.resource?.kind === k && h.resource?.name === trace.subject.name) ?? (trace.downstream ?? [])[0]
  const probes = hop?.probes ?? []
  if (probes.length === 0) return { state: 'none' }
  const hostOf = (p: { target?: string }) => hostFromTarget(p.target)
  const host = probes.map(hostOf).find(Boolean)
  const live = probes.filter((p) => !p.skipped)
  // Only an HTTP 2xx (tone 'healthy') is a CONFIRMED front door. A bare TCP/TLS
  // connect or a 5xx is not — an LB can answer the SYN or return 502 while the
  // app is down, so claiming "confirmed" off transport would overclaim health.
  const failed = live.find((p) => !p.ok)
  const http2xx = live.find((p) => p.layer === 'http' && p.ok && p.tone === 'healthy')
  if (http2xx) {
    // A 2xx confirms ONE host, but a multi-host entry can have a sibling host fail
    // (connection-refused on another hostname). Don't claim a blanket "confirmed"
    // then — surface the partial so the failed host isn't silently dropped.
    if (failed) return { state: 'partial', host, detail: failed.detail || failed.error }
    // A sibling host can return a 5xx (ok=true, tone 'degraded') — not a transport
    // 'failed', so it slips past the check above. Surface it as partial too, or the
    // banner would claim "confirmed" while a declared host is erroring.
    const sibling5xx = live.find((p) => p.layer === 'http' && p.ok && p.tone === 'degraded')
    if (sibling5xx) return { state: 'partial', host, detail: sibling5xx.detail || sibling5xx.error }
    // Symmetric to the FAILED case: a declared SIBLING host whose probes all
    // SKIPPED (split-horizon / internal host that didn't resolve from this vantage)
    // was never tested. A green "confirmed" over an untested host overclaims — name
    // the gap instead and keep the ✓ only when every declared host was confirmed.
    const okHost = hostOf(http2xx)
    // A sibling host can return a 3xx/4xx (ok=true, tone 'reached') — it WAS reached
    // at the HTTP layer but not verified end-to-end. The single-host path refuses to
    // confirm an identical 3xx/4xx (http-reached → neutral), so a blanket "confirmed"
    // here would overclaim. Name the unverified sibling instead.
    const siblingReached = live.find((p) => p.layer === 'http' && p.ok && p.tone === 'reached' && hostOf(p) && hostOf(p) !== okHost)
    if (siblingReached) return { state: 'partial-reached', host: okHost, detail: siblingReached.detail || siblingReached.error }
    const skippedOther = probes.find((p) => p.skipped && hostOf(p) && hostOf(p) !== okHost)
    if (skippedOther) return { state: 'partial-untested', host: okHost, detail: skippedOther.reason }
    return { state: 'reached', host, detail: http2xx.detail }
  }
  const http5xx = live.find((p) => p.layer === 'http' && p.ok && p.tone === 'degraded')
  if (http5xx) return { state: 'server-error', host, detail: http5xx.detail }
  if (failed) return { state: 'failed', host, detail: failed.detail || failed.error }
  // An HTTP 3xx/4xx (tone 'reached', ok=true) means the front door RETURNED an HTTP
  // response — it was reached at the HTTP layer, just not verified end-to-end. Check
  // this BEFORE the TCP/TLS transport branch: a front door answering 301/404 almost
  // always has a preceding TCP-ok probe, so testing transport first would mislabel a
  // real HTTP response as "transport only — the HTTP response wasn’t checked".
  const httpReached = live.find((p) => p.layer === 'http' && p.ok && p.tone === 'reached')
  if (httpReached) return { state: 'http-reached', host, detail: httpReached.detail }
  // Transport connected (TCP/TLS) but no HTTP-layer confirmation — reached, not verified.
  const transport = live.find((p) => p.ok && (p.layer === 'tcp' || p.layer === 'tls'))
  if (transport) return { state: 'transport', host, detail: transport.detail }
  // Nothing live succeeded — a skip. Surface the most relevant skip reason and
  // whether the DNS layer specifically was the skip (so the caveat doesn't claim
  // "didn't resolve" when DNS resolved fine and only TCP/HTTP were skipped).
  const dnsSkipProbe = probes.find((p) => p.skipped && p.layer === 'dns')
  return { state: 'skipped', host, detail: (dnsSkipProbe ?? probes[0])?.reason, dnsSkip: Boolean(dnsSkipProbe) }
}

// worstFindingMessage returns the plain one-line message of the worst static
// finding (critical first, then warning) across all hops — the operator-facing
// sentence, not the forensic cause/summary.
function worstFindingMessage(trace: Trace): string | undefined {
  const downstream = (trace.downstream ?? []).flatMap((h) => h.findings ?? [])
  // Upstream missing_ref findings concern a SIBLING backend route, not this
  // subject — drop them so a sibling's broken backend doesn't headline an
  // otherwise-healthy path (mirrors TracePanel HopRow's upstream scoping).
  const upstream = (trace.upstreams ?? []).flatMap((h) => h.findings ?? []).filter((x) => !(x.code ?? '').startsWith('missing_ref:'))
  const all = [...downstream, ...upstream]
  const f = all.find((x) => x.severity === 'critical') ?? all.find((x) => x.severity === 'warning')
  return f?.message
}

// entryControllerProblem returns the plain message of an ingress-controller
// PROBLEM on the entry hop (no controller installed, or its pods unready) — the
// real front-door blocker, which should headline the verdict.
function entryControllerProblem(trace: Trace): string | undefined {
  const entry = (trace.downstream ?? [])[0]
  const f = (entry?.findings ?? []).find((x) => x.code === 'ingress:no-controller' || x.code === 'ingress:controller-unready')
  return f?.message
}

// backendDown detects the "wired but no live backend" state: a downstream hop
// whose pods are SELECTED but NONE are ready (ready === 0, selected > 0). That's
// a DEFINITIVE break known from endpoint readiness — not a probe limitation — so
// the verdict must headline the real cause (the crashing/unpullable app), credit
// the parts that ARE confirmed (the Service is wired to its workload), and point
// at the backend. Scaled-to-0 (selected === 0) is excluded — it's deliberate
// dormancy with its own benign read, not a backend that failed.
function backendDown(trace: Trace): { reason: string; raw?: string; cause?: string; pod?: ResourceRef; ready: number; selected: number; transitional: boolean } | undefined {
  const hops = trace.downstream ?? []
  // If any backend can't be judged from pod readiness, we can't claim "no healthy
  // backend" — an unseen sibling might be serving. Unverifiable backends: a read
  // failure (RBAC-redacted / pod-lister error, or meta.endpointSource === 'unknown'
  // with no finding) AND terminal backends with no pod readiness to inspect —
  // selectorless (manual endpoints) or ExternalName (an external host). Stay
  // conservative and fall through to the partial/unknown route logic.
  const unverifiableBackend = hops.some((h) => {
    if (h.meta?.endpointSource === 'unknown' || h.meta?.selectorless === true || h.resource?.kind === 'ExternalName') return true
    return (h.findings ?? []).some((f) => {
      const c = f.code ?? ''
      return c.startsWith('rbac:') || c === 'pods:lister-error' || c === 'svc:selectorless' || c === 'svc:external-name'
    })
  })
  if (unverifiableBackend) return undefined
  // Consider only hops that actually have backend pods to judge (selector matched
  // ≥1 pod). Scaled-to-0 (selected === 0) is deliberate dormancy, not a failure.
  const backendHops = hops.filter((h) => typeof h.meta?.selected === 'number' && (h.meta.selected as number) > 0)
  if (backendHops.length === 0) return undefined
  // "No healthy backend" is only honest when EVERY backend is down. A multi-backend
  // Ingress/Gateway with one healthy backend must NOT be condemned — that path can
  // still serve, so fall through to the partial-route logic below.
  if (backendHops.some((h) => typeof h.meta?.ready === 'number' && (h.meta.ready as number) > 0)) return undefined
  const podsHop = backendHops[0]
  const ready = (podsHop.meta?.ready as number) ?? 0
  const selected = (podsHop.meta?.selected as number) ?? 0
  // Pick the most SPECIFIC cause for the headline. The "0/N selected pods ready"
  // symptom now carries a Pod ref too (linkNoReadyToCulprit), so it must be ranked
  // BELOW the real pod-failure findings (CrashLoopBackOff, ImagePullBackOff, …) —
  // otherwise the headline degrades to the generic "the backend pods aren't ready"
  // instead of naming the actual failure. Fall back to the symptom only if no
  // specific cause is present.
  const isSymptom = (code?: string) =>
    code === 'svc:no-ready-endpoints' || /^problem:0\/[1-9]\d* selected pods ready$/.test(code ?? '')
  const problems = hops.flatMap((h) => h.findings ?? []).filter((f) => (f.code ?? '').startsWith('problem:') || f.code === 'svc:no-ready-endpoints')
  const causes = problems.filter((f) => !isSymptom(f.code))
  const realCause =
    causes.find((f) => f.resource?.kind === 'Pod' && f.severity === 'critical') ??
    causes.find((f) => f.severity === 'critical')
  // Transitional: 0 ready but NO root-cause failure finding — only the generic
  // "0/N selected pods ready" symptom, which ALSO fires for Pending pods mid-rollout.
  // Without a corroborating crash/pull/OOM, this is "not ready YET", not a terminal
  // break — must read amber "may be starting", never hard-✗ (a fresh rollout isn't
  // an outage). A real failure finding makes it definitive.
  const transitional = !realCause
  const culprit = realCause ?? problems.find((f) => f.severity === 'critical')
  const raw = culprit ? (culprit.code ?? '').replace(/^problem:/, '') : undefined
  return { reason: plainPodReason(raw), raw, cause: culprit?.cause, pod: culprit?.resource, ready, selected, transitional }
}

// plainPodReason renders a backend pod's failure reason in operator language —
// the k8s reason stays as a tag in the headline for those who recognize it.
function plainPodReason(raw?: string): string {
  switch (raw) {
    case 'CrashLoopBackOff':
      return 'the backend app keeps crashing'
    case 'ImagePullBackOff':
    case 'ErrImagePull':
    case 'InvalidImageName':
      return "the backend pod can't pull its image"
    case 'OOMKilled':
      return 'the backend app ran out of memory'
    default:
      return "the backend pods aren't ready"
  }
}

const REACH_TONE_RANK: Record<string, number> = { healthy: 0, neutral: 1, unknown: 1, degraded: 2, alert: 3, unhealthy: 4 }

// reachVerdict floors the reachability read at the backend's static verdict. The
// probe only sees what it reaches: a static degrade/break it can't observe — a
// missing TLS secret, a pending LoadBalancer, any config-only finding — must not
// be painted over by a positive "backend reachable". When the static verdict is
// worse than the probe read, escalate the tone and surface the worst finding so
// the headline says why (it never DOWNGRADES — healthy/by-design reads are kept).
export function reachVerdict(trace: Trace, probed?: boolean): ReachVerdictView {
  const view = reachVerdictBase(trace, probed)
  let floor: StatusTone | undefined =
    trace.verdict === 'broken' ? 'unhealthy' : trace.verdict === 'degraded' ? 'degraded' : undefined
  // A transitional 0-ready backend (no failure finding — pods may be starting) must
  // not be floored to a hard ✗ by a static 'broken' verdict; cap it at degraded so
  // the honest "may be starting" amber survives (a fresh rollout isn't an outage).
  if (floor === 'unhealthy' && backendDown(trace)?.transitional) floor = 'degraded'
  if (floor && (REACH_TONE_RANK[view.tone] ?? 0) < REACH_TONE_RANK[floor]) {
    const why = worstFindingMessage(trace)
    const icon = floor === 'unhealthy' ? '✗' : '⚠'
    // The probe could only see what it reached; a static break/degrade it couldn't
    // observe must HEADLINE the verdict, not sit as a footnote under an optimistic
    // "reached" line. Lead with the problem; demote the probe read to a caveat so
    // the headline never reads "reached/healthy" on a broken/degraded path.
    if (why && why !== view.text) {
      return { ...view, tone: floor, icon, text: why, caveat: view.text, detail: view.caveat ?? view.detail }
    }
    return { ...view, tone: floor, icon, caveat: why ?? view.caveat }
  }
  return view
}

function reachVerdictBase(trace: Trace, probed?: boolean): ReachVerdictView {
  // ExternalName — a DNS alias to a host outside the cluster. It IS testable:
  // the probe DNS-resolves + HTTP-reaches the external host, producing a real
  // route. Un-probed, surface the alias + invite the test; once probed, fall
  // through to the normal route-based verdict (which reflects the live result).
  const ext = externalNameHost(trace)
  if (ext && !probed && (trace.routes ?? []).length === 0) {
    return { icon: '', tone: 'neutral', text: `Resolves to ${ext} — external DNS alias`, caveat: 'run the test to check reachability to it' }
  }
  const routes = trace.routes ?? []
  const okCount = routes.filter((r) => r.outcome === 'verified' || r.outcome === 'reached').length
  const total = routes.length
  const unreach = routes.filter((r) => r.outcome === 'unreachable' && !r.benign)
  // A proxy-only (indirect) unreachable never tested the real path — it must not
  // count as a CONFIRMED backend failure (that would false-condemn an untested
  // route), mirroring traceToSubgraph's isIndirectUnreach. The broken/onlyIndirect
  // branch below still uses the full `unreach` (it needs to SEE the indirect ones).
  const realUnreach = unreach.filter((r) => r.confidence !== 'indirect')
  const anyIndirectUnreach = unreach.some((r) => r.confidence === 'indirect')
  const any5xx = routes.some((r) => r.outcome === 'server-error')
  const allReal = okCount > 0 && routes.every((r) => !(r.outcome === 'verified' || r.outcome === 'reached') || r.confidence === 'real')
  const backendReachable = okCount > 0 && realUnreach.length === 0 && !any5xx

  // When the Ingress CONTROLLER itself is the problem (none installed, or pods
  // unready), that IS the front-door answer — lead with it. Otherwise the
  // neutral "backend reachable, entry not tested" below would bury the real
  // blocker (the operator's host can't be served at all, regardless of DNS).
  const ctrlProblem = entryControllerProblem(trace)
  if (ctrlProblem) {
    return { icon: '⚠', tone: 'degraded', text: ctrlProblem }
  }

  // No live backend (pods wired but none ready) — lead with the real cause and
  // credit what IS confirmed, instead of "unreachable via API server"
  // (which frames a diagnosed backend failure as an untested route). The path is
  // wired correctly up to the workload; the break is the app, not the network.
  const bd = backendDown(trace)
  if (bd) {
    const noun = bd.selected === 1 ? 'pod' : 'pods'
    if (bd.transitional) {
      // 0 ready but no failure detected — pods may still be starting (fresh rollout
      // / Pending). Amber + "not ready yet", never the terminal red of a real break.
      return {
        icon: '⚠',
        tone: 'degraded',
        text: `No ready backend yet — ${bd.ready}/${bd.selected} ${noun} ready`,
        caveat: 'No failure detected on the pods — they may still be starting (a fresh rollout or pending pods). Re-run once they settle.',
      }
    }
    const tag = bd.raw && !bd.raw.includes('ready') ? ` (${bd.raw})` : ''
    return {
      icon: '✗',
      tone: 'unhealthy',
      text: `No healthy backend — ${bd.reason}${tag}`,
      caveat: `The Service is wired to its workload (selector matches); the break is the backend, not the network. ${bd.ready}/${bd.selected} ${noun} ready.`,
      detail: bd.cause,
    }
  }

  // Ingress/Gateway SUBJECT: the FRONT DOOR (the external host a user hits) is the
  // journey under test — state it explicitly, instead of letting backend health speak
  // for a path it never proves. Honesty cuts both ways: a host actually reached from
  // outside is a first-class ✓, while a host that couldn't be verified from here (a
  // skip, e.g. split-horizon DNS) is named — never condemned, never papered over.
  const fd = frontDoorStatus(trace)
  // backendUntested distinguishes "no backend route was probed" from "a backend
  // route failed" — asserting "backend has issues" for an UNtested backend would
  // false-condemn it.
  const backendUntested = okCount === 0 && realUnreach.length === 0 && !any5xx
  // backendReachable folds only the directly-failed signals (realUnreach, 5xx); it
  // ignores routes that were skipped / not-tested / only-indirect-unreachable. A
  // passed sibling can therefore mark the backend "reachable" while another backend
  // route was never confirmed. Surface that gap as a caveat (the front door stays a
  // genuine ✓), instead of a silent green.
  const backendGap = (trace.coverage?.skipped ?? 0) > 0 || (trace.notTested?.length ?? 0) > 0 || anyIndirectUnreach
  const backendCaveat = backendReachable
    ? (backendGap ? 'some backend routes weren’t confirmed — see the path below' : undefined)
    : backendUntested ? 'backend not separately tested — see the path below' : 'backend has issues — see the path below'
  if (fd.state === 'reached') {
    // A 2xx to the front door (typically '/') does NOT prove a backend route that
    // actually FAILED. When a backend route is unreachable (not merely untested),
    // downgrade off the green ✓ — the path is partly broken, not confirmed healthy.
    const backendFailed = !backendReachable && !backendUntested
    return {
      icon: backendFailed ? '⚠' : '✓',
      tone: backendFailed ? 'degraded' : 'healthy',
      text: `Front door confirmed from outside${fd.detail ? ` — ${fd.detail}` : ''}`,
      caveat: backendCaveat,
    }
  }
  if (fd.state === 'partial') {
    // One host was confirmed (2xx) but another front-door host failed — don't
    // claim a blanket "confirmed from outside" that drops the failed host.
    return { icon: '⚠', tone: 'degraded', text: `Front door partially reachable — one host confirmed, another failed${fd.detail ? ` (${fd.detail})` : ''}`, caveat: backendCaveat }
  }
  if (fd.state === 'partial-untested') {
    // One host confirmed (2xx) but another DECLARED host's probes all skipped from
    // this vantage (split-horizon / internal host) — never tested. Stay neutral and
    // name the gap; a green ✓ here would claim "confirmed" over an untested host.
    return { icon: '', tone: 'neutral', text: `Front door: one host confirmed, another not tested from here${fd.host ? ` — ${fd.host}` : ''}`, caveat: fd.detail ? `another declared host wasn’t tested: ${fd.detail}` : 'another declared host wasn’t tested from this vantage', detail: backendUntested ? undefined : backendCaveat }
  }
  if (fd.state === 'partial-reached') {
    // One host confirmed (2xx) but another DECLARED host only returned a 3xx/4xx —
    // reached at the HTTP layer, not verified end-to-end. Stay neutral and name the
    // gap; a green ✓ here would claim "confirmed" over a host the single-host path
    // itself refuses to confirm (it routes the identical 3xx/4xx to http-reached).
    return { icon: '', tone: 'neutral', text: `Front door: one host confirmed, another reached but not verified${fd.host ? ` — ${fd.host}` : ''}`, caveat: fd.detail ? `another declared host returned ${fd.detail} (3xx/4xx) — reachable, but not verified end-to-end` : 'another declared host returned an HTTP 3xx/4xx — reachable, but not verified end-to-end', detail: backendUntested ? undefined : backendCaveat }
  }
  if (fd.state === 'server-error') {
    // The front door answered with a 5xx — the path reached the app, but it's
    // erroring. Reached, not confirmed healthy.
    return { icon: '⚠', tone: 'degraded', text: `Front door reached but returned a server error${fd.host ? ` — ${fd.host}` : ''}${fd.detail ? ` (${fd.detail})` : ''}` }
  }
  if (fd.state === 'http-reached') {
    // The front door RETURNED an HTTP response (3xx/4xx — e.g. a 301 redirect to https,
    // or a 404 at '/' on a path-routed app), so it WAS reached at the HTTP layer. Not
    // verified end-to-end (the route behind it wasn't confirmed) — but never claim the
    // dishonest "transport only / the HTTP response wasn’t checked".
    return { icon: '', tone: 'neutral', text: `Front door reached — HTTP responded, route not verified${fd.host ? ` — ${fd.host}` : ''}`, caveat: fd.detail ? `the front door returned ${fd.detail} (3xx/4xx) — reachable, but the route wasn’t verified end-to-end` : 'the front door returned an HTTP 3xx/4xx — reachable, but the route wasn’t verified end-to-end', detail: backendUntested ? undefined : backendCaveat }
  }
  if (fd.state === 'transport') {
    // TCP/TLS connected but no HTTP response was verified — never claim "confirmed".
    return { icon: '', tone: 'neutral', text: `Front door reachable (transport only) — not verified${fd.host ? ` — ${fd.host}` : ''}`, caveat: 'a TCP/TLS connect succeeded but the HTTP response wasn’t checked', detail: backendUntested ? undefined : backendCaveat }
  }
  if (fd.state === 'failed') {
    return { icon: '✗', tone: 'unhealthy', text: `Front door unreachable${fd.host ? ` — ${fd.host}` : ''}${fd.detail ? ` (${fd.detail})` : ''}` }
  }
  if (fd.state === 'skipped' && backendReachable) {
    // Two facts a developer must connect into ONE conclusion: the backend is up,
    // but the Ingress entry path itself was NOT tested (its host didn't resolve
    // where Radar ran). Headline states the relationship ("reachable — but…");
    // the caveat says how the backend WAS reached (so "via API server" reads as an
    // implication, not jargon) and gives the action that actually works for a
    // host that only resolves elsewhere — test it from where it resolves, NOT the
    // self-contradicting "from outside" when it may be cluster-internal.
    const host = fd.host || 'the host'
    const how = allReal ? 'confirmed by real in-cluster traffic' : 'reached through the API server, not the real ingress path'
    // The skip has two distinct causes: DNS didn't resolve here (split-horizon),
    // OR DNS resolved but TCP/HTTP were skipped (e.g. the ingress IP isn't routable
    // from a laptop). Only say "didn't resolve" when the DNS layer was the skip —
    // otherwise describe the actual gap and give the right next action.
    const gap = fd.dnsSkip
      ? `${host} didn’t resolve from where Radar ran`
      : `the entry path to ${host} couldn’t be reached from where Radar ran`
    const fix = fd.dnsSkip
      ? `request ${host} from a client that can resolve it (inside the cluster if it’s internal)`
      : `request ${host} from a client on a network that can reach the ingress (inside the cluster if it’s internal)`
    return {
      icon: '',
      tone: 'neutral',
      // Don't assert a flat "reachable" on API-server-only evidence — name HOW the
      // backend was reached so the word doesn't overclaim the real data path.
      text: allReal
        ? 'Backend reachable — but the Ingress entry point wasn’t tested'
        : `Backend answered ${VIA_API_SERVER} — but the Ingress entry point wasn’t tested`,
      // One short line stays on screen; the full why + fix lives in the tooltip.
      caveat: `${gap} — only the backend was checked.`,
      detail: `${gap} (it may be internal to the cluster), so requests coming in through the Ingress weren’t checked — only the backend, ${how}. To confirm the entry works, ${fix}.`,
    }
  }

  // Benign-only — every probed route is an intentional scale-to-0 (dormant by
  // design, not an outage). 'unreach' already excludes benign, so without this it
  // would fall through to the neutral "Config looks healthy" fallback and
  // contradict TraceSummary's amber 'No running backends'. Mirror that here.
  if (total > 0 && okCount === 0 && unreach.length === 0 && !any5xx && routes.some((r) => r.benign)) {
    return {
      icon: '⚠',
      tone: 'degraded',
      text: trace.headline || 'No running backends (scaled to 0)',
      caveat: 'the backing workload is intentionally scaled to 0 — nothing to reach',
    }
  }

  // Broken — nothing reachable. A 5xx route DID reach a backend (it answered),
  // so a mix of unreachable + server-error must degrade (⚠), not hard-condemn.
  if (!any5xx && (trace.verdict === 'broken' || (unreach.length > 0 && okCount === 0))) {
    // An apiserver-proxy-only (indirect) failure must NEVER hard-condemn the real
    // path — the proxy is "indirect, never the headline". When every unreachable
    // route is indirect AND the verdict isn't independently broken (a real/static
    // structural break), fall to neutral/unknown keeping the honest headline the
    // Go singleRouteHeadline already wrote, instead of overriding it with red.
    const onlyIndirectUnreach = unreach.length > 0 && unreach.every((r) => r.confidence === 'indirect')
    if (onlyIndirectUnreach && trace.verdict !== 'broken') {
      return { icon: '', tone: 'unknown', text: trace.headline || 'Unreachable via API server — real path not confirmed' }
    }
    return { icon: '✗', tone: 'unhealthy', text: trace.headline || 'Unreachable — traffic can’t reach the backend' }
  }
  // Partial — some routes reachable, some REALLY unreachable (a real problem → ⚠
  // honest). A proxy-only (indirect) unreachable is excluded — its real path was
  // never tested, so it isn't a confirmed failure to condemn here.
  if (realUnreach.length > 0 && okCount > 0) {
    return { icon: '⚠', tone: 'degraded', text: trace.headline || `${okCount} of ${total} routes reachable · ${realUnreach.length} unreachable` }
  }
  // Server error — reached, but the app is erroring (a real problem → ⚠ honest).
  if (any5xx) {
    return { icon: '⚠', tone: 'degraded', text: trace.headline || 'Reached, but the app returned a server error — network ok, the app is erroring' }
  }
  // Reachable. A proxy-only reach is NEUTRAL, not a green ✓ — the green check makes a
  // non-expert read "it works, done" and skip the real limitation. It is still NEVER a
  // ⚠ alarm (the path did reach). Only real-traffic verified earns the green ✓.
  if (okCount > 0) {
    // Gate the green ✓ on POSITIVE proof: any ok route that isn't provably
    // real-confidence (indirect OR undefined) must read neutral with a caveat —
    // undefined confidence is not real-traffic confirmation.
    if (!allReal) {
      // An ExternalName was dialed directly by Radar — say that, not "via the API
      // proxy" (which would contradict the matrix's "direct from your machine").
      if (ext) {
        return {
          icon: '',
          tone: 'neutral',
          text: `Reached ${ext} directly from Radar`,
          caveat: 'in-cluster clients may resolve or route it differently — not confirmed from inside the cluster',
        }
      }
      return {
        icon: '',
        tone: 'neutral',
        // Lead with the GAP, not the mechanism: the backend answered, but only on
        // the control-plane path — the real network path isn't confirmed.
        text: `Backend answered ${VIA_API_SERVER} — the real network path isn’t confirmed`,
        caveat: 'control-plane path: bypasses kube-proxy + NetworkPolicy — run the in-cluster test to confirm the real data path',
      }
    }
    // allReal is true here, but 'real' confidence only means the LIVE path was
    // exercised — a route that merely 'reached' (transport-only TCP/TLS, or an
    // HTTP 3xx/4xx) is NOT verified end-to-end. Green-checking it would overclaim,
    // contradicting coverageBannerTone's realPass and reachVerdict's own
    // indirect-reached neutral. Require a verified real route for the green ✓.
    const realVerified = routes.some((r) => r.confidence === 'real' && r.outcome === 'verified')
    if (!realVerified) {
      return { icon: '', tone: 'neutral', text: trace.headline || 'Reached — route not verified', caveat: 'the route responded but wasn’t verified end-to-end — see the path below' }
    }
    // Real-traffic confirmed. But if coverage is partial (routes still not tested),
    // a green tone overclaims full success — down-rank to neutral while keeping the
    // honest (coverage-aware) headline text.
    // A proxy-only (indirect) unreachable route is an UNTESTED real path, not a
    // pass — count it as a coverage gap so a sibling real pass doesn't green-light
    // the whole subject over a route whose real path was never confirmed.
    const hasGap = (trace.coverage?.skipped ?? 0) > 0 || (trace.notTested?.length ?? 0) > 0 || anyIndirectUnreach
    if (hasGap) {
      return { icon: '', tone: 'neutral', text: trace.headline || 'Reachable — some routes not yet tested', caveat: 'some routes weren’t tested — see the path below' }
    }
    return { icon: '✓', tone: 'healthy', text: trace.headline || 'Reachable — confirmed from inside the cluster' }
  }
  // Unknown — couldn’t determine (RBAC, cache cold, API absent). Not clean, not broken.
  if (trace.verdict === 'unknown') {
    return { icon: '', tone: 'unknown', text: trace.reason || trace.headline || 'Couldn’t determine reachability' }
  }
  // Not probed yet. Having passed the broken/degraded checks above, the STATIC
  // config is valid — a positive state, not an empty "not tested". The full
  // static path + config render below regardless; this is just the headline.
  // Never surface the backend's "Configuration only — not yet tested" string.
  if ((trace.routes ?? []).length === 0) {
    // Un-probed but the STATIC verdict found a config warning (e.g. targetPort
    // mismatch) — that is a real ⚠, never "✓ valid". The cause shows on the path below.
    if (trace.verdict === 'degraded') {
      // Prefer the worst finding's PLAIN message over diagnosis.summary (which can
      // be the forensic cause, e.g. "No IngressClass resolves…"). Mirrors the
      // drawer (TraceSummary) so the banner — the loudest surface — never leaks
      // the jargon the message was written to replace.
      return { icon: '⚠', tone: 'degraded', text: worstFindingMessage(trace) || trace.diagnosis?.summary || trace.headline || 'Configuration issue — see the path below' }
    }
    // The probe RAN but produced no testable route (every route skipped from this
    // vantage, or nothing probeable). Acknowledge it — clicking Run must not read
    // as a no-op — instead of telling the user to "run the test" they already ran.
    if (probed) {
      return { icon: '', tone: 'neutral', text: 'Tested — no route could be actively probed from here', caveat: 'the config looks valid; nothing was reachable to test from this vantage' }
    }
    return { icon: '', tone: 'neutral', text: 'Config valid — not yet tested', caveat: 'run the test to check live reachability' }
  }
  // Probed, but nothing conclusive (every route skipped from this vantage).
  return { icon: '', tone: 'neutral', text: 'Config looks healthy — not confirmed from this vantage' }
}
