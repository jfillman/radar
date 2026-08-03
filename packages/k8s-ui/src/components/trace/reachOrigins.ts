import type { Trace, ProbeResult } from './types'
import type { Mark } from './reachMarks'

/**
 * An Origin is a vantage point - WHERE a test ran from, and as WHOM. It is a
 * first-class entity in the graph, never a Kubernetes resource, because two
 * results about the same Service can mean completely different things depending
 * on who sent the request and by what mechanism.
 *
 * Radar has three real origins today. `caller` and `external` are declared here
 * and rendered as unavailable rather than omitted: an operator reading this tab
 * needs to know that the strongest evidence - the real application caller, and a
 * genuine request from outside the cluster - is absent, not merely unrun.
 * Hiding them would make synthetic evidence look complete.
 */
export type OriginId = 'incluster' | 'apiserver' | 'local' | 'caller' | 'external'

/** Which lane an origin's traffic belongs to. */
export type Lane = 'dataplane' | 'control'

/** What the origin's identity means for the result's strength. */
export type OriginKind = 'synthetic' | 'real-client' | 'real-caller' | 'relayed'

export interface Origin {
  id: OriginId
  glyph: string
  name: string
  /** How the request is actually sent. */
  mech: string
  /** Namespace / ServiceAccount / mesh participation, as far as we know it. */
  identity: string
  kind: OriginKind
  kindTag: string
  lane: Lane
  mark: Mark
  /** Set when this origin cannot be used at all. Renders instead of an action. */
  unavailable?: string
  /** True for origins Radar does not implement (vs merely denied by RBAC). */
  unsupported?: boolean
}

export const ORIGIN_KIND_TAG: Record<OriginKind, string> = {
  synthetic: 'SYNTHETIC',
  'real-client': 'REAL CLIENT',
  'real-caller': 'REAL CALLER',
  relayed: 'RELAYED · NOT A CALLER',
}

/** Evidence strength, strongest first. Drives the "next strongest test" prompt. */
export const ORIGIN_STRENGTH: OriginId[] = ['caller', 'external', 'incluster', 'local', 'apiserver']

export function allProbes(trace?: Trace): ProbeResult[] {
  if (!trace) return []
  return [...(trace.upstreams ?? []), ...(trace.downstream ?? [])].flatMap((h) => h.probes ?? [])
}

/** Which origin produced a probe. The apiserver path wins over vantage: a proxy
 *  relay is a control-plane mechanism no matter where the process calling it runs. */
export function originOf(p: ProbeResult): OriginId {
  if (p.path === 'apiserver') return 'apiserver'
  return p.vantage === 'in-cluster' ? 'incluster' : 'local'
}

interface OriginContext {
  inClusterAllowed?: boolean
  inClusterRunning?: boolean
  inClusterDeniedReason?: string
  stale?: boolean
}

/**
 * Derives an origin's mark from the probes it actually produced.
 *
 * A live failure always wins over a success: when one origin's probes disagree
 * among themselves, surfacing the failure is the safe direction. An origin whose
 * every probe was SKIPPED did not fail - it never ran, which is `blocked`, and
 * the skip reason explains why (a ClusterIP is not routable from a laptop).
 */
function markFor(probes: ProbeResult[], id: OriginId, ctx: OriginContext): Mark {
  if (id === 'incluster' && ctx.inClusterRunning) return 'running'
  if (probes.length === 0) {
    if (id === 'incluster' && ctx.inClusterAllowed === false) return 'denied'
    return 'untested'
  }
  const live = probes.filter((p) => !p.skipped)
  if (live.length === 0) return 'blocked'
  if (ctx.stale) return 'stale'
  if (live.some((p) => !p.ok || p.tone === 'unhealthy')) return 'failed'
  if (live.some((p) => p.tone === 'degraded')) return 'answered'
  return id === 'apiserver' ? 'proxied' : 'proved'
}

/** The reason an all-skipped origin never ran, taken from the probes themselves. */
function skipReason(probes: ProbeResult[]): string | undefined {
  return probes.find((p) => p.skipped && p.reason)?.reason
}

/**
 * Builds the origin rail for a trace.
 *
 * Order is by evidence strength, not by availability, so the gap between what
 * was tested and what would be conclusive stays legible.
 */
export function buildOrigins(trace: Trace | undefined, ctx: OriginContext = {}): Origin[] {
  const probes = allProbes(trace)
  const byOrigin = new Map<OriginId, ProbeResult[]>()
  for (const p of probes) {
    const id = originOf(p)
    const arr = byOrigin.get(id) ?? []
    arr.push(p)
    byOrigin.set(id, arr)
  }
  const ns = trace?.subject.namespace ?? ''

  const caller: Origin = {
    id: 'caller',
    glyph: '◈',
    name: 'Real caller workload',
    mech: 'the application’s own Pod, identity and sidecar',
    identity: 'its ServiceAccount · its namespace · mesh as deployed',
    kind: 'real-caller',
    kindTag: ORIGIN_KIND_TAG['real-caller'],
    lane: 'dataplane',
    mark: 'blocked',
    unsupported: true,
    unavailable: 'Radar cannot run a request from an existing workload — no exec-based probe exists. Identity-dependent behaviour (mesh mTLS, AuthorizationPolicy, NetworkPolicy) stays untested.',
  }
  const external: Origin = {
    id: 'external',
    glyph: '◉',
    name: 'Direct external client',
    mech: 'a request from outside the cluster to the public address',
    identity: 'no cluster identity · anonymous client',
    kind: 'real-client',
    kindTag: ORIGIN_KIND_TAG['real-client'],
    lane: 'dataplane',
    mark: 'blocked',
    unsupported: true,
    unavailable: 'Radar has no origin that is proven to sit on the public internet. Tests from your machine are reported as such, never as “from outside”.',
  }

  const inClusterProbes = byOrigin.get('incluster') ?? []
  const incluster: Origin = {
    id: 'incluster',
    glyph: '⚗',
    name: 'In-cluster probe',
    mech: 'a short-lived Job sends real requests through the dataplane',
    identity: `ns ${ns || '—'} · Radar’s probe identity · no mesh sidecar`,
    kind: 'synthetic',
    kindTag: ORIGIN_KIND_TAG.synthetic,
    lane: 'dataplane',
    mark: markFor(inClusterProbes, 'incluster', ctx),
    unavailable: ctx.inClusterAllowed === false ? ctx.inClusterDeniedReason || 'Not permitted in this cluster.' : undefined,
  }

  const apiProbes = byOrigin.get('apiserver') ?? []
  const apiserver: Origin = {
    id: 'apiserver',
    glyph: '⌸',
    name: 'API-server proxy',
    mech: 'the apiserver relays the request · bypasses the dataplane',
    identity: 'Radar’s identity via the apiserver — no Pod identity',
    kind: 'relayed',
    kindTag: ORIGIN_KIND_TAG.relayed,
    lane: 'control',
    mark: markFor(apiProbes, 'apiserver', ctx),
  }

  const localProbes = byOrigin.get('local') ?? []
  const localMark = markFor(localProbes, 'local', ctx)
  const local: Origin = {
    id: 'local',
    glyph: '▣',
    name: 'Radar on your machine',
    mech: 'a direct request over your host network',
    identity: 'network position unknown · may be VPN or private LAN',
    kind: 'real-client',
    kindTag: ORIGIN_KIND_TAG['real-client'],
    // Not the cluster dataplane: from a laptop a request never traverses
    // kube-proxy, NetworkPolicy or the mesh, so it cannot sit in that lane.
    lane: 'control',
    mark: localMark,
    unavailable: localMark === 'blocked' ? skipReason(localProbes) : undefined,
  }

  const all: Record<OriginId, Origin> = { caller, external, incluster, local, apiserver }
  return ORIGIN_STRENGTH.map((id) => all[id])
}

/** The origin that should be selected when the view opens: the strongest one
 *  that actually produced evidence, else the strongest usable one. */
export function defaultOrigin(origins: Origin[]): OriginId {
  const evidence: Mark[] = ['proved', 'failed', 'answered', 'proxied', 'stale', 'running']
  const withEvidence = origins.find((o) => evidence.includes(o.mark))
  if (withEvidence) return withEvidence.id
  const usable = origins.find((o) => !o.unsupported && !o.unavailable)
  return usable?.id ?? 'apiserver'
}

const isGap = (o: Origin): boolean => o.mark === 'untested' || o.mark === 'denied' || (!!o.unsupported && o.mark === 'blocked')

/**
 * The strongest origin that is not yet proven, including ones Radar cannot use.
 * This is the honest ceiling on the evidence - useful as a caveat, but NEVER as
 * a call to action.
 */
export function strongestGap(origins: Origin[]): Origin | undefined {
  return origins.find(isGap)
}

/**
 * The strongest gap Radar can actually close.
 *
 * Kept separate from `strongestGap` deliberately. The real caller is almost
 * always the strongest missing origin AND permanently unavailable, so driving
 * the next-step prompt from `strongestGap` made every resource advertise a test
 * that cannot be run - a dead end exactly where the operator needs a next move.
 * The unreachable ceiling belongs in the caveats; the prompt belongs here.
 */
export function actionableGap(origins: Origin[]): Origin | undefined {
  // ORIGIN_STRENGTH is an evidence ranking, and a gap is only worth proposing
  // if it is STRONGER than what has already been proven. Without this the
  // panel told you your laptop (control lane) was "the strongest evidence
  // Radar can still collect" about in-cluster reachability, after the
  // in-cluster probe had already succeeded.
  const provenAt = origins.findIndex((o) => o.mark === 'proved')
  const ceiling = provenAt === -1 ? origins.length : provenAt
  return origins.slice(0, ceiling).find((o) => isGap(o) && !o.unsupported && o.mark !== 'denied')
}

/** True when the only thing left is something Radar cannot do - the point at
 *  which "no stronger test available" is the honest thing to say. */
export function atEvidenceCeiling(origins: Origin[]): boolean {
  return !actionableGap(origins)
}
