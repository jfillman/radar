import { describe, it, expect } from 'vitest'
import { hasRealProbes, probeToneToStatus, probeOrigin, backendRouteInfo, routeOutcomeLabel, routeTone, routeOutcomeRank, coverageBannerTone, inClusterOutcome, inClusterEligible } from './TracePanel'
import type { Trace, Hop, ProbeResult, HopConfig, RouteResult, Coverage } from './types'

describe('in-cluster test - eligibility + outcome', () => {
  const p = (o: Partial<ProbeResult>): ProbeResult => ({ layer: 'http', target: 't', vantage: 'in-cluster', ok: true, ...o })
  it('eligible: indirect or failed routes, NOT real-verified or benign', () => {
    expect(inClusterEligible({ route: '/', outcome: 'verified', confidence: 'indirect' })).toBe(true)
    expect(inClusterEligible({ route: '/', outcome: 'unreachable', confidence: 'real' })).toBe(true)
    expect(inClusterEligible({ route: '/', outcome: 'verified', confidence: 'real' })).toBe(false)
    expect(inClusterEligible({ route: '/', outcome: 'unreachable', benign: true })).toBe(false)
  })
  it('outcome: a real-dataplane HTTP 2xx is verified+green (the payoff)', () => {
    expect(inClusterOutcome([p({ layer: 'tcp', ok: true }), p({ layer: 'http', ok: true, tone: 'healthy' })]))
      .toEqual({ label: 'verified', tone: 'healthy', severity: 'success' })
  })
  it('outcome: a failed HTTP is unreachable+red; tcp-only is port reachable', () => {
    expect(inClusterOutcome([p({ layer: 'http', ok: false })]).severity).toBe('error')
    expect(inClusterOutcome([p({ layer: 'tcp', ok: true })])).toEqual({ label: 'port reachable', tone: 'healthy', severity: 'success' })
  })
})

describe('coverageBannerTone - the single honest banner tone', () => {
  const cov = (o: Partial<Coverage>): Coverage => ({ tested: 0, passed: 0, failed: 0, skipped: 0, ...o })
  const real = (outcome: RouteResult['outcome']): RouteResult => ({ route: '/', outcome, confidence: 'real' })
  const indirect = (outcome: RouteResult['outcome']): RouteResult => ({ route: '/', outcome, confidence: 'indirect' })

  it('green ONLY on a real-traffic pass', () => {
    expect(coverageBannerTone(cov({ tested: 1, passed: 1 }), [real('verified')])).toBe('success')
  })
  it('indirect-only all-pass is info, never green', () => {
    expect(coverageBannerTone(cov({ tested: 1, passed: 1 }), [indirect('verified')])).toBe('info')
  })
  it('zero-tested is info, never green or red', () => {
    expect(coverageBannerTone(cov({ tested: 0, skipped: 2 }), [])).toBe('info')
  })
  it('partial (some passed, some failed) is warning', () => {
    expect(coverageBannerTone(cov({ tested: 2, passed: 1, failed: 1 }), [real('verified'), real('unreachable')])).toBe('warning')
  })
  it('none reachable is error', () => {
    expect(coverageBannerTone(cov({ tested: 1, passed: 0, failed: 1 }), [real('unreachable')])).toBe('error')
  })
  it('all server-error (reached, no pass) is warning not red - matches the degraded verdict', () => {
    expect(coverageBannerTone(cov({ tested: 1, passed: 0, failed: 1 }), [real('server-error')])).toBe('warning')
  })
  it('all-failed-but-BENIGN (intentional scale-to-0) is warning, never red', () => {
    const scaledZero: RouteResult = { route: '/', outcome: 'unreachable', confidence: 'indirect', benign: true }
    expect(coverageBannerTone(cov({ tested: 1, passed: 0, failed: 1 }), [scaledZero])).toBe('warning')
  })
  it('a genuine unreachable (not benign) stays red even next to a benign one', () => {
    const benign: RouteResult = { route: '/a', outcome: 'unreachable', benign: true }
    const realDown: RouteResult = { route: '/b', outcome: 'unreachable', confidence: 'real' }
    expect(coverageBannerTone(cov({ tested: 2, passed: 0, failed: 2 }), [benign, realDown])).toBe('error')
  })
})

describe('route coverage rendering helpers', () => {
  const route = (o: RouteResult): RouteResult => o
  it('NEVER labels an indirect (apiserver) route "verified"', () => {
    const r = route({ route: '/', target: 'api:80', outcome: 'verified', confidence: 'indirect' })
    expect(routeOutcomeLabel(r)).toBe('reached')
    expect(routeOutcomeLabel(r)).not.toContain('verified')
    expect(routeTone(r)).toBe('neutral') // reachable via proxy, but not green
  })
  it('labels a real-traffic verified route "verified" and green', () => {
    const r = route({ route: '/', target: 'api:80', outcome: 'verified', confidence: 'real' })
    expect(routeOutcomeLabel(r)).toBe('verified')
    expect(routeTone(r)).toBe('healthy')
  })
  it('maps failure outcomes honestly', () => {
    expect(routeTone(route({ route: '/', outcome: 'unreachable', confidence: 'real' }))).toBe('unhealthy')
    expect(routeTone(route({ route: '/', outcome: 'server-error', confidence: 'real' }))).toBe('degraded')
    // A proxy-only (indirect) unreachable never tested the real path - neutral, not red.
    expect(routeTone(route({ route: '/', outcome: 'unreachable', confidence: 'indirect' }))).toBe('unknown')
    // ...and the label carries the qualifier rather than a bare condemnation.
    expect(routeOutcomeLabel(route({ route: '/', outcome: 'unreachable', confidence: 'indirect' }))).toBe('unreachable via API server (real path not confirmed)')
  })
  it('sorts failures first', () => {
    expect(routeOutcomeRank('unreachable')).toBeLessThan(routeOutcomeRank('reached'))
    expect(routeOutcomeRank('reached')).toBeLessThan(routeOutcomeRank('verified'))
  })
})

const probe = (overrides: Partial<ProbeResult>): ProbeResult => ({
  layer: 'tcp',
  target: 'port 80',
  vantage: 'local',
  ok: true,
  ...overrides,
})

const hop = (probes?: ProbeResult[]): Hop => ({
  resource: { kind: 'Service', namespace: 'prod', name: 'api' },
  edge: 'entry:Service',
  findings: [],
  probes,
})

const trace = (downstream: Hop[], upstreams: Hop[] = []): Trace => ({
  subject: { kind: 'Service', namespace: 'prod', name: 'api' },
  upstreams,
  downstream,
  verdict: 'healthy',
  brokenAt: -1,
})

describe('hasRealProbes', () => {
  it('is false when no hop carries probes', () => {
    expect(hasRealProbes(trace([hop(), hop()]))).toBe(false)
  })

  it('is false when every probe row skipped', () => {
    // The laptop default: probes requested but all skip for lack of proxy
    // RBAC. No live evidence, so the healthy banner must stay qualified.
    const skipped = trace([hop([probe({ ok: false, skipped: true, reason: 'no proxy access' })])])
    expect(hasRealProbes(skipped)).toBe(false)
  })

  it('is true when at least one non-skipped probe landed', () => {
    const mixed = trace([hop([probe({ ok: false, skipped: true }), probe({ ok: true })])])
    expect(hasRealProbes(mixed)).toBe(true)
  })

  it('counts a real probe on an upstream hop', () => {
    expect(hasRealProbes(trace([hop()], [hop([probe({ ok: true })])]))).toBe(true)
  })
})

describe('probeToneToStatus - honest reachability vocabulary', () => {
  it('maps a reached (3xx/4xx) probe to the calm neutral tone, never green', () => {
    expect(probeToneToStatus(probe({ ok: true, tone: 'reached' }))).toBe('neutral')
  })
  it('maps a 5xx (degraded) probe to degraded, not unhealthy', () => {
    expect(probeToneToStatus(probe({ ok: true, tone: 'degraded' }))).toBe('degraded')
  })
  it('maps a verified 2xx probe to healthy', () => {
    expect(probeToneToStatus(probe({ ok: true, tone: 'healthy' }))).toBe('healthy')
  })
  it('maps a transport failure to unhealthy', () => {
    expect(probeToneToStatus(probe({ ok: false, tone: 'unhealthy' }))).toBe('unhealthy')
  })
})

describe('probeOrigin', () => {
  it('reports the vantage even when every probe skipped (origin is where it was attempted)', () => {
    // All probes in a real run share one vantage; an all-skipped run must
    // still surface where it was attempted from, not hide the origin.
    const t = trace([hop([probe({ skipped: true, vantage: 'in-cluster' })])])
    expect(probeOrigin(t)).toBe('in-cluster')
  })
  it('reports the vantage of a live probe', () => {
    expect(probeOrigin(trace([hop([probe({ ok: true, vantage: 'local' })])]))).toBe('local')
  })
  it('is undefined when no probe ran at all', () => {
    expect(probeOrigin(trace([hop()]))).toBeUndefined()
  })
})

describe('backendRouteInfo', () => {
  const entry = (config: HopConfig): Hop => ({
    resource: { kind: 'Ingress', namespace: 'prod', name: 'multi' },
    edge: 'entry:Ingress',
    findings: [],
    config,
  })
  const backend = (name: string, config?: HopConfig): Hop => ({
    resource: { kind: 'Service', namespace: 'prod', name },
    edge: 'Ingress->Service',
    findings: [],
    config,
  })

  it('tags a backend with the path that selects it (single host)', () => {
    const e = entry({ hostnames: ['shop.example.com'], rules: [
      { hosts: ['shop.example.com'], paths: ['/web'], backends: [{ kind: 'Service', name: 'echo' }] },
      { hosts: ['shop.example.com'], paths: ['/api'], backends: [{ kind: 'Service', name: 'ghost' }] },
    ] })
    expect(backendRouteInfo(e, backend('echo', {})).tags).toEqual(['/web'])
  })

  it('flags a config-less named backend as missing (the broken route)', () => {
    const e = entry({ hostnames: ['shop.example.com'], rules: [
      { hosts: ['shop.example.com'], paths: ['/api'], backends: [{ kind: 'Service', name: 'ghost' }] },
    ] })
    const info = backendRouteInfo(e, backend('ghost'))
    expect(info.tags).toEqual(['/api'])
    expect(info.missing).toBe(true)
  })

  it('includes the host when the Ingress serves more than one (same-path disambiguation)', () => {
    const e = entry({ hostnames: ['api.example.com', 'admin.example.com'], rules: [
      { hosts: ['api.example.com'], paths: ['/'], backends: [{ kind: 'Service', name: 'echo' }] },
      { hosts: ['admin.example.com'], paths: ['/'], backends: [{ kind: 'Service', name: 'ghost' }] },
    ] })
    expect(backendRouteInfo(e, backend('echo', {})).tags).toEqual(['api.example.com/'])
    expect(backendRouteInfo(e, backend('ghost')).tags).toEqual(['admin.example.com/'])
  })

  it('matches on namespace too - a same-named backend in another namespace is NOT tagged or flagged missing (defect 14)', () => {
    // Route declares backend "api" in namespace nsA; the hop is a same-named "api"
    // in nsB. Name-only matching would attach nsA's route tags + missing flag to
    // the wrong backend.
    const e: Hop = {
      resource: { kind: 'Ingress', namespace: 'nsA', name: 'r' },
      edge: 'entry:Ingress',
      findings: [],
      config: { hostnames: ['shop.example.com'], rules: [
        { hosts: ['shop.example.com'], paths: ['/api'], backends: [{ kind: 'Service', name: 'api', namespace: 'nsA' }] },
      ] },
    }
    const hopNsB: Hop = { resource: { kind: 'Service', namespace: 'nsB', name: 'api' }, edge: 'Ingress->Service', findings: [] }
    const got = backendRouteInfo(e, hopNsB)
    expect(got.tags).toEqual([])
    expect(got.missing).toBe(false)
    // The correct-namespace backend still matches (and a config-less one is missing).
    const hopNsA: Hop = { resource: { kind: 'Service', namespace: 'nsA', name: 'api' }, edge: 'Ingress->Service', findings: [] }
    expect(backendRouteInfo(e, hopNsA).tags).toEqual(['/api'])
    expect(backendRouteInfo(e, hopNsA).missing).toBe(true)
  })

  it('does not mark an existing backend missing, and ignores non-backend hops', () => {
    const e = entry({ hostnames: ['shop.example.com'], rules: [
      { hosts: ['shop.example.com'], paths: ['/web'], backends: [{ kind: 'Service', name: 'echo' }] },
    ] })
    expect(backendRouteInfo(e, backend('echo', {})).missing).toBe(false)
    // A pods fan-out hop carries no ->Service edge, so it gets no route tags.
    const pods: Hop = { resource: { kind: 'Pods', name: '' }, edge: 'Service->Pods', findings: [] }
    expect(backendRouteInfo(e, pods)).toEqual({ tags: [], missing: false })
  })
})
