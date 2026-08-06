import type { Trace, ProbeResult, RouteResult } from './types'
import type { Mark } from './reachMarks'
import { originRouteEvidence, routeMark } from './reachMarks'

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
export type OriginId = 'incluster' | 'radar-incluster' | 'apiserver' | 'local' | 'caller' | 'external'

/** Which lane an origin's traffic belongs to. */
export type Lane = 'dataplane' | 'control'

/** What the origin's identity means for the result's strength. */
export type OriginKind = 'synthetic' | 'radar' | 'real-client' | 'real-caller' | 'relayed'

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
  radar: 'RADAR ITSELF',
  'real-client': 'REAL CLIENT',
  'real-caller': 'REAL CALLER',
  relayed: 'RELAYED · NOT A CALLER',
}

/** Evidence strength, strongest first. Drives the "next strongest test" prompt. */
export const ORIGIN_STRENGTH: OriginId[] = ['caller', 'external', 'incluster', 'radar-incluster', 'local', 'apiserver']

export function allProbes(trace?: Trace): ProbeResult[] {
  if (!trace) return []
  return [...(trace.upstreams ?? []), ...(trace.downstream ?? [])].flatMap((h) => h.probes ?? [])
}

/** Which origin produced a probe. The apiserver path wins over vantage: a proxy
 *  relay is a control-plane mechanism no matter where the process calling it runs. */
export function originOf(p: ProbeResult, runVantage?: string): OriginId {
  if (p.path === 'apiserver') return 'apiserver'
  if (p.vantage !== 'in-cluster') return 'local'
  if (p.source === 'probe-job') return 'incluster'
  if (p.source === 'radar') return 'radar-incluster'
  // No source: an older producer. An in-cluster dataplane probe can only be
  // Radar's own when Radar itself runs in the cluster; from a laptop the only
  // way to get one is the throwaway Job. runVantage is what the producer knows
  // about itself, so it settles the ambiguity without guessing.
  return runVantage === 'in-cluster' ? 'radar-incluster' : 'incluster'
}

interface OriginContext {
  inClusterAllowed?: boolean
  /** The scenario on screen. Marks are scored against THIS route when the
   *  producer sent per-vantage results, so the rail cannot disagree with the
   *  graph about what a vantage found. */
  route?: RouteResult
  inClusterRunning?: boolean
  inClusterDeniedReason?: string
  /** A run was ATTEMPTED and its probe never started (image pull, quota,
   *  webhook). "Not tested" would erase the attempt; execution failure is its
   *  own state, distinct from reachability. */
  inClusterRunError?: string
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
  // The SELECTED route's own result for this origin wins when the producer sent
  // one. Without it the rail scored an origin across EVERY route at once, so a
  // vantage that failed on one path read as failed while the graph beside it -
  // now route-scoped - showed that same vantage succeeding on the selected one.
  const ev = ctx.route ? originRouteEvidence(ctx.route, id) : undefined
  if (ev?.kind === 'own') {
    if (ctx.stale) return 'stale'
    return routeMark(ev.result, {})
  }
  // The producer sent a breakdown and this origin is not in it. That means the
  // ROUTE has no result from here - it does NOT mean this vantage sent nothing.
  // A laptop that dialled a public Ingress and got an answer has real evidence
  // on the entry hop; the route is built from the backend's probes and cannot
  // see it. Saying "not tested" there contradicted the graph beside it, which
  // was drawing that very dial. Fall through to what this origin actually did.
  if (ev?.kind === 'none' && probes.filter((p) => !p.skipped).length === 0) {
    if (id === 'incluster' && ctx.inClusterAllowed === false) return 'denied'
    return 'untested'
  }
  if (probes.length === 0) {
    if (id === 'incluster' && ctx.inClusterAllowed === false) return 'denied'
    return 'untested'
  }
  const live = probes.filter((p) => !p.skipped)
  if (live.length === 0) return 'blocked'
  if (ctx.stale) return 'stale'
  if (live.some((p) => !p.ok || p.tone === 'unhealthy')) return 'failed'
  // 'reached' = answered with a 3xx/4xx/app-5xx: evidence the port serves, not a
  // clean pass - same rule as the route rollup, where reached maps to answered.
  if (live.some((p) => p.tone === 'degraded' || p.tone === 'reached')) return 'answered'
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
    const id = originOf(p, trace?.runVantage)
    const arr = byOrigin.get(id) ?? []
    arr.push(p)
    byOrigin.set(id, arr)
  }
  const ns = trace?.subject.namespace ?? ''

  const caller: Origin = {
    id: 'caller',
    glyph: '◈',
    name: 'Real caller workload',
    mech: 'one of your running Pods, as itself',
    identity: 'the app’s own account and namespace',
    kind: 'real-caller',
    kindTag: ORIGIN_KIND_TAG['real-caller'],
    lane: 'dataplane',
    mark: 'blocked',
    unsupported: true,
    unavailable: 'Radar can’t send a request from one of your running Pods yet. Until it can, anything that depends on who is calling — mesh mTLS, authorization policy, network policy — stays untested.',
  }
  const external: Origin = {
    id: 'external',
    glyph: '◉',
    name: 'Direct external client',
    mech: 'a request from the public internet',
    identity: 'no cluster identity · anonymous client',
    kind: 'real-client',
    kindTag: ORIGIN_KIND_TAG['real-client'],
    lane: 'dataplane',
    mark: 'blocked',
    unsupported: true,
    unavailable: 'Radar has nowhere to test from that is provably on the public internet. A test from your machine is reported as exactly that, never as “from outside”.',
  }

  const inClusterProbes = byOrigin.get('incluster') ?? []
  // A failed ATTEMPT is not "not tested": the operator clicked Run and the
  // probe never started. Only when no live probe made it through - a partial
  // run that produced results keeps its evidence-based mark.
  const inClusterFailedToRun =
    !!ctx.inClusterRunError && !ctx.inClusterRunning && inClusterProbes.filter((p) => !p.skipped).length === 0
  const incluster: Origin = {
    id: 'incluster',
    glyph: '⚗',
    name: 'In-cluster probe',
    mech: 'a throwaway Pod Radar starts inside the cluster',
    // The Job sets no serviceAccountName and disables token automount, so it runs
    // as the target namespace's default SA with no credentials mounted - NOT as
    // Radar. Sidecar injection is admission's call, not ours; the runner handles
    // injected sidecars precisely because they do appear.
    identity: `in ${ns || 'the namespace'} · the namespace’s default account, no token`,
    kind: 'synthetic',
    kindTag: ORIGIN_KIND_TAG.synthetic,
    lane: 'dataplane',
    mark: inClusterFailedToRun && ctx.inClusterAllowed !== false ? 'blocked' : markFor(inClusterProbes, 'incluster', ctx),
    unavailable:
      ctx.inClusterAllowed === false
        ? ctx.inClusterDeniedReason || 'Not permitted in this cluster.'
        : inClusterFailedToRun
          ? ctx.inClusterRunError
          : undefined,
  }

  const apiProbes = byOrigin.get('apiserver') ?? []
  const apiserver: Origin = {
    id: 'apiserver',
    glyph: '⌸',
    name: 'API-server proxy',
    mech: 'Kubernetes relays the request for us',
    identity: 'Radar’s own credentials — not a Pod',
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
    mech: 'this machine, over your own network',
    kind: 'real-client',
    kindTag: ORIGIN_KIND_TAG['real-client'],
    // Not the cluster dataplane: from a laptop a request never traverses
    // kube-proxy, NetworkPolicy or the mesh, so it cannot sit in that lane.
    lane: 'control',
    mark: localMark,
    identity: localIdentity(localProbes),
    unavailable: localMark === 'blocked' ? skipReason(localProbes) : undefined,
  }

  const radarProbes = byOrigin.get('radar-incluster') ?? []
  // Radar running AS a Pod is not the throwaway Job: it dials with Radar's own
  // ServiceAccount from Radar's own namespace, and whatever sidecars Radar has.
  // Collapsing the two credited Radar's direct dials to a Job never created.
  const radarInCluster: Origin = {
    id: 'radar-incluster',
    glyph: '◈',
    name: 'Radar, inside the cluster',
    mech: 'Radar\u2019s own process, running as a Pod',
    identity: 'Radar\u2019s own namespace and ServiceAccount',
    kind: 'radar',
    kindTag: ORIGIN_KIND_TAG.radar,
    lane: 'dataplane',
    mark: markFor(radarProbes, 'radar-incluster', ctx),
    unsupported: trace?.runVantage !== 'in-cluster' && radarProbes.length === 0,
    unavailable:
      trace?.runVantage !== 'in-cluster' && radarProbes.length === 0
        ? 'Radar is not running in this cluster, so it cannot dial from inside on its own. The in-cluster test starts a throwaway Pod instead.'
        : undefined,
  }

  const all: Record<OriginId, Origin> = { caller, external, incluster, 'radar-incluster': radarInCluster, local, apiserver }
  // Radar not being a Pod is not an evidence GAP - the in-cluster Job covers the
  // same ground. Listing it as "never tested" would pad the coverage caveat with
  // a deployment detail, next to genuine holes like "as your application".
  const radarIsAbsent = radarProbes.length === 0 && trace?.runVantage !== 'in-cluster'
  return ORIGIN_STRENGTH.filter((id) => !(id === 'radar-incluster' && radarIsAbsent)).map((id) => all[id])
}

/**
 * What we can honestly say about where the laptop sat on the network.
 *
 * This used to be a constant - "we can't tell where on the network you are" -
 * for every trace forever. DNS already resolves the address, so when the name
 * resolves to a globally routable one we DO know the request left for a public
 * address, and saying nothing under-claims.
 *
 * It stops there deliberately. A public address is not proof the packet crossed
 * the public internet: a VPN, hairpin NAT or split-horizon DNS all break that
 * inference. So this describes the ADDRESS and never the journey, and it does
 * not make the external vantage supported - that is a different claim.
 */
export function localIdentity(probes: ProbeResult[]): string {
  const scopes = new Set(probes.filter((p) => !p.skipped && p.addressScope).map((p) => p.addressScope))
  if (scopes.has('mixed')) {
    return 'this name resolves to both public and private addresses — we can’t tell which one you reached'
  }
  if (scopes.has('public')) {
    return 'you dialled a public address — though a VPN or split-horizon DNS could still have kept it internal'
  }
  if (scopes.has('private')) {
    return 'you dialled a private address, so this did not come from the public internet'
  }
  return 'we can’t tell where on the network you are'
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

