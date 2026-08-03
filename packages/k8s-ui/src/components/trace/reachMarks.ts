import type { RouteResult, RouteOutcome, ProbeResult } from './types'

/**
 * A Mark is the evidence class of ONE path segment for one scenario and one
 * origin. It is deliberately distinct from health: a node's dot says whether a
 * resource is well, a mark says what we actually learned about traffic reaching
 * it. The two must never be conflated - a healthy node behind a failed edge
 * stays healthy and the edge stays red.
 *
 * The vocabulary is closed. Adding a member means deciding its glyph, its tone,
 * and its line style, because every mark renders in all three.
 */
export type Mark =
  | 'proved' // observed through the dataplane - real packets, real path
  | 'answered' // something replied, but not the thing we asked for
  | 'proxied' // reached via the apiserver proxy - bypasses the dataplane
  | 'config' // declared in configuration; predicted, never observed
  | 'failed' // confirmed failure
  | 'blocked' // never ran because an earlier segment failed
  | 'excluded' // not in the path by design (NotReady, not an eligible endpoint)
  | 'untested' // no origin has exercised this
  | 'stale' // observed, but before a change that invalidates it
  | 'running' // in flight right now
  | 'denied' // we are not permitted to run this test
  | 'slow' // answered, far outside the normal latency band

export interface MarkStyle {
  glyph: string
  /** CSS custom property reference - never a literal color. */
  color: string
  /** SVG stroke-dasharray; 'none' for the solid lines that carry proof. */
  dash: string
  strokeWidth: number
  strokeOpacity: number
}

/**
 * Only `proved` and `failed` draw solid. Solid means "a packet did this" -
 * everything softer is dashed so a predicted or relayed segment can never be
 * misread as observed truth at a glance.
 */
export const MARKS: Record<Mark, MarkStyle> = {
  proved: { glyph: '●', color: 'var(--color-success-dark)', dash: 'none', strokeWidth: 2.6, strokeOpacity: 1 },
  answered: { glyph: '◑', color: 'var(--color-warning-dark)', dash: '3 6', strokeWidth: 1.8, strokeOpacity: 1 },
  proxied: { glyph: '◐', color: 'var(--color-info)', dash: '8 5', strokeWidth: 1.8, strokeOpacity: 1 },
  config: { glyph: '◇', color: 'var(--text-tertiary)', dash: '2 5', strokeWidth: 1.8, strokeOpacity: 1 },
  failed: { glyph: '✕', color: 'var(--color-error-dark)', dash: 'none', strokeWidth: 2.6, strokeOpacity: 1 },
  blocked: { glyph: '⊘', color: 'var(--text-disabled)', dash: '3 6', strokeWidth: 1.8, strokeOpacity: 0.75 },
  excluded: { glyph: '⊗', color: 'var(--text-disabled)', dash: '3 6', strokeWidth: 1.8, strokeOpacity: 0.75 },
  untested: { glyph: '○', color: 'var(--text-disabled)', dash: '3 6', strokeWidth: 1.8, strokeOpacity: 0.75 },
  stale: { glyph: '◷', color: 'var(--color-warning-dark)', dash: '6 4', strokeWidth: 1.8, strokeOpacity: 1 },
  running: { glyph: '◌', color: 'var(--color-info)', dash: '4 4', strokeWidth: 1.8, strokeOpacity: 1 },
  denied: { glyph: '⊘', color: 'var(--color-warning-dark)', dash: '3 6', strokeWidth: 1.8, strokeOpacity: 1 },
  slow: { glyph: '◔', color: 'var(--color-warning-dark)', dash: '3 6', strokeWidth: 1.8, strokeOpacity: 1 },
}

export const MARK_LEGEND: { mark: Mark; text: string }[] = [
  { mark: 'proved', text: 'observed through the dataplane' },
  { mark: 'proxied', text: 'via API proxy — bypasses dataplane' },
  { mark: 'answered', text: 'answered, not verified' },
  { mark: 'config', text: 'config only — predicted' },
  { mark: 'failed', text: 'confirmed failure' },
  { mark: 'blocked', text: 'blocked by an earlier failure' },
  { mark: 'excluded', text: 'excluded from routing' },
  { mark: 'untested', text: 'not tested' },
  { mark: 'stale', text: 'stale evidence' },
]

export function markStyle(m: Mark): MarkStyle {
  return MARKS[m] ?? MARKS.untested
}

/** Inline style for a mark glyph. */
export function glyphStyle(m: Mark): React.CSSProperties {
  return { color: markStyle(m).color, fontWeight: 700, fontSize: '12px', lineHeight: 1.1, flex: 'none' }
}

/**
 * Ranks marks by how much they should dominate an aggregate. A confirmed
 * failure outranks everything: when several segments collapse into one summary,
 * the failure must survive rather than average away. `proved` ranks LOWEST of
 * the real signals so a single success never masks a sibling's problem.
 */
const MARK_RANK: Record<Mark, number> = {
  failed: 100,
  denied: 90,
  slow: 80,
  stale: 70,
  answered: 60,
  running: 50,
  blocked: 40,
  untested: 30,
  excluded: 20,
  config: 10,
  proxied: 5,
  proved: 0,
}

export function worstMark(marks: Mark[]): Mark {
  if (marks.length === 0) return 'untested'
  return marks.reduce((a, b) => (MARK_RANK[b] > MARK_RANK[a] ? b : a))
}

/**
 * The evidence class of a route's headline result.
 *
 * `confidence` is what separates proof from relay: an 'indirect' outcome came
 * through the apiserver proxy, which bypasses kube-proxy, NetworkPolicy and the
 * mesh - so it can never be `proved` no matter how clean the response was.
 * A benign unreachable (deliberately scaled to zero) is not a failure.
 */
export function routeMark(r: RouteResult, opts: { stale?: boolean; running?: boolean } = {}): Mark {
  if (opts.running) return 'running'
  if (opts.stale) return 'stale'
  const indirect = r.confidence === 'indirect'
  switch (r.outcome) {
    case 'verified':
      return indirect ? 'proxied' : 'proved'
    case 'reached':
      return indirect ? 'proxied' : 'answered'
    case 'server-error':
      return 'answered'
    case 'unreachable':
      // A proxy-only failure never condemns the real path - it was never tested.
      if (indirect) return 'answered'
      return r.benign ? 'excluded' : 'failed'
    case 'not-tested':
    default:
      return 'untested'
  }
}

/** A route outcome's severity tone, for the scenario tab dot and verdict dot. */
export type SevTone = 'healthy' | 'degraded' | 'alert' | 'unhealthy' | 'unknown' | 'info'

export const SEV_COLOR: Record<SevTone, string> = {
  healthy: 'var(--color-success)',
  degraded: 'var(--color-warning)',
  alert: 'var(--color-alert)',
  unhealthy: 'var(--color-error)',
  unknown: 'var(--text-disabled)',
  info: 'var(--color-info)',
}

/** Badge class for a tone - the repo's canonical `.status-*` vocabulary. */
export const SEV_BADGE: Record<SevTone, string> = {
  healthy: 'status-healthy',
  degraded: 'status-degraded',
  alert: 'status-alert',
  unhealthy: 'status-unhealthy',
  unknown: 'status-unknown',
  info: 'status-neutral',
}

export function routeTone(r: RouteResult, opts: { stale?: boolean; running?: boolean } = {}): SevTone {
  if (opts.running) return 'info'
  if (opts.stale) return 'unknown'
  const indirect = r.confidence === 'indirect'
  switch (r.outcome) {
    case 'verified':
      return indirect ? 'degraded' : 'healthy'
    case 'reached':
    case 'server-error':
      return 'degraded'
    case 'unreachable':
      // Indirect-only and benign unreachables are never red - see routeMark.
      return indirect || r.benign ? 'degraded' : 'unhealthy'
    case 'not-tested':
    default:
      return 'unknown'
  }
}

/** Short qualifier chip for a scenario tab - what kind of evidence backs it. */
export function routeChip(r: RouteResult, opts: { stale?: boolean; running?: boolean } = {}): string {
  if (opts.running) return 'probing…'
  if (opts.stale) return 'stale'
  const indirect = r.confidence === 'indirect'
  switch (r.outcome) {
    case 'verified':
      return indirect ? 'answered via proxy only' : 'verified'
    case 'reached':
      return indirect ? 'answered via proxy only' : 'reached, not verified'
    case 'server-error':
      return 'server error'
    case 'unreachable':
      if (indirect) return 'proxy failed — real path untested'
      return r.benign ? 'scaled to zero' : 'unreachable'
    case 'not-tested':
    default:
      return 'not tested'
  }
}

const OUTCOME_RANK: Record<RouteOutcome, number> = {
  unreachable: 0,
  'server-error': 1,
  'not-tested': 2,
  reached: 3,
  verified: 4,
}

/** Worst-first ordering, so the scenario that needs attention leads the strip. */
export function orderRoutes(routes: RouteResult[]): RouteResult[] {
  return [...routes].sort((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome])
}

/**
 * A scenario is one testable path as an operator thinks about it. It is NOT
 * always one RouteResult: a Gateway route declaring several hostnames produces
 * one result per host, and when those results agree in every respect they are
 * one situation with several front doors, not several situations.
 */
export interface Scenario {
  key: string
  /** Tab title. */
  label: string
  /** Secondary line - the backend, plus the host count when grouped. */
  sub: string
  /** Every route folded into this scenario. */
  routes: RouteResult[]
  /** Representative used for tone, chip and the graph. */
  primary: RouteResult
  /** The distinct entry hostnames, when this scenario groups several. */
  hosts: string[]
}

/** The host part of a route label like "example.com/path". */
function hostOf(route: string): string {
  const slash = route.indexOf('/')
  return slash === -1 ? route : route.slice(0, slash)
}

/**
 * Groups routes that are indistinguishable in outcome. Splitting them out again
 * happens exactly when it carries information - a differing outcome, layer or
 * confidence - so identical hosts collapse but a host that behaves differently
 * always keeps its own tab.
 */
export function groupRoutes(routes: RouteResult[]): Scenario[] {
  const groups = new Map<string, RouteResult[]>()
  for (const r of orderRoutes(routes)) {
    // For an untested route the REASON is the whole content - "port 443 can't
    // be verified through the proxy" and "port 80 timed out" are different
    // situations even though both are merely not-tested. Folding them together
    // would hide the distinction the operator needs.
    const distinguishing = r.outcome === 'not-tested' ? r.evidence ?? '' : ''
    const key = [r.target ?? '', r.outcome, r.confidence ?? '', r.failedLayer ?? '', r.benign ? 'benign' : '', distinguishing].join('|')
    const arr = groups.get(key) ?? []
    arr.push(r)
    groups.set(key, arr)
  }
  return [...groups.entries()].map(([key, rs]) => {
    const primary = rs[0]
    const hosts = [...new Set(rs.map((r) => hostOf(r.route)).filter(Boolean))]
    const grouped = rs.length > 1
    return {
      key,
      label: grouped ? primary.target || `${rs.length} routes` : primary.route,
      sub: grouped
        ? `${hosts.length} hostname${hosts.length === 1 ? '' : 's'}${primary.target ? ` · ${primary.target}` : ''}`
        : primary.target || '',
      routes: rs,
      primary,
      hosts,
    }
  })
}

/**
 * Routes the tracer declined to test still describe real paths, so they become
 * scenarios too. Without this an untested resource renders no strip at all and
 * the paths it has are invisible.
 */
export function scenariosFor(routes: RouteResult[], notTested: { route?: string; reason: string }[]): Scenario[] {
  const synthesized: RouteResult[] = notTested
    .filter((s) => !!s.route)
    .map((s) => ({ route: s.route as string, outcome: 'not-tested' as RouteOutcome, evidence: s.reason }))
  return groupRoutes([...routes, ...synthesized])
}

/**
 * Latency far outside the band is its own signal - a route that answers in
 * seconds is not simply "healthy". Threshold is deliberately generous: this
 * flags pathology, not ordinary variance.
 */
export const SLOW_THRESHOLD_NS = 1_000_000_000

export function isSlow(p: ProbeResult): boolean {
  return typeof p.latencyNs === 'number' && p.latencyNs >= SLOW_THRESHOLD_NS
}

export function formatLatency(ns?: number): string {
  if (typeof ns !== 'number' || ns <= 0) return ''
  const ms = ns / 1_000_000
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
