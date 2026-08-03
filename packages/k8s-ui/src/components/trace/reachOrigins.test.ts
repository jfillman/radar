import { describe, it, expect } from 'vitest'
import { buildOrigins, defaultOrigin, strongestGap, originOf } from './reachOrigins'
import type { Trace, ProbeResult } from './types'

const p = (o: Partial<ProbeResult>): ProbeResult => ({ layer: 'http', target: 'svc:80', vantage: 'in-cluster', ok: true, ...o })

const traceWith = (probes: ProbeResult[]): Trace => ({
  subject: { kind: 'Service', name: 'shop', namespace: 'store' },
  verdict: 'healthy',
  brokenAt: -1,
  upstreams: [],
  downstream: [{ resource: { kind: 'Pods', name: '', namespace: 'store' }, edge: 'service->pods', findings: [], probes }],
})

describe('originOf', () => {
  it('the apiserver path wins over vantage — a relay is control plane wherever it is called from', () => {
    expect(originOf(p({ vantage: 'in-cluster', path: 'apiserver' }))).toBe('apiserver')
    expect(originOf(p({ vantage: 'in-cluster', path: 'data' }))).toBe('incluster')
    expect(originOf(p({ vantage: 'local', path: 'data' }))).toBe('local')
  })
})

describe('buildOrigins', () => {
  it('always surfaces the origins Radar cannot use, so synthetic evidence never looks complete', () => {
    const os = buildOrigins(traceWith([p({})]))
    const caller = os.find((o) => o.id === 'caller')
    const external = os.find((o) => o.id === 'external')
    expect(caller?.unsupported).toBe(true)
    expect(external?.unsupported).toBe(true)
    expect(caller?.unavailable).toBeTruthy()
    expect(external?.unavailable).toBeTruthy()
  })

  it('orders by evidence strength, strongest first', () => {
    const os = buildOrigins(traceWith([]))
    expect(os.map((o) => o.id)).toEqual(['caller', 'external', 'incluster', 'local', 'apiserver'])
  })

  it('marks the in-cluster probe proved on clean dataplane evidence', () => {
    const os = buildOrigins(traceWith([p({ vantage: 'in-cluster', path: 'data', ok: true })]))
    expect(os.find((o) => o.id === 'incluster')?.mark).toBe('proved')
  })

  it('never marks the apiserver origin proved, however clean the response', () => {
    const os = buildOrigins(traceWith([p({ vantage: 'local', path: 'apiserver', ok: true, tone: 'healthy' })]))
    expect(os.find((o) => o.id === 'apiserver')?.mark).toBe('proxied')
  })

  it('a failure among an origin’s probes wins over its successes', () => {
    const os = buildOrigins(traceWith([p({ ok: true }), p({ ok: false, tone: 'unhealthy' })]))
    expect(os.find((o) => o.id === 'incluster')?.mark).toBe('failed')
  })

  it('an all-skipped origin is blocked, not failed, and says why', () => {
    const os = buildOrigins(traceWith([p({ vantage: 'local', path: 'data', skipped: true, reason: 'ClusterIP is not routable from your host' })]))
    const local = os.find((o) => o.id === 'local')
    expect(local?.mark).toBe('blocked')
    expect(local?.unavailable).toMatch(/not routable/)
  })

  it('reports denied rather than untested when the probe is not permitted', () => {
    const os = buildOrigins(traceWith([]), { inClusterAllowed: false, inClusterDeniedReason: 'RBAC denies create on jobs' })
    const ic = os.find((o) => o.id === 'incluster')
    expect(ic?.mark).toBe('denied')
    expect(ic?.unavailable).toMatch(/RBAC/)
  })

  it('running beats any prior mark so nothing turns green optimistically', () => {
    const os = buildOrigins(traceWith([p({ ok: true })]), { inClusterRunning: true })
    expect(os.find((o) => o.id === 'incluster')?.mark).toBe('running')
  })

  it('stale evidence is greyed rather than carried forward as proof', () => {
    const os = buildOrigins(traceWith([p({ ok: true })]), { stale: true })
    expect(os.find((o) => o.id === 'incluster')?.mark).toBe('stale')
  })
})

describe('defaultOrigin', () => {
  it('opens on the strongest origin that actually produced evidence', () => {
    const os = buildOrigins(traceWith([p({ vantage: 'local', path: 'apiserver' })]))
    expect(defaultOrigin(os)).toBe('apiserver')
  })

  it('prefers real dataplane evidence over a relay when both exist', () => {
    const os = buildOrigins(traceWith([p({ vantage: 'local', path: 'apiserver' }), p({ vantage: 'in-cluster', path: 'data' })]))
    expect(defaultOrigin(os)).toBe('incluster')
  })

  it('falls back to a usable origin when nothing has run', () => {
    expect(defaultOrigin(buildOrigins(traceWith([])))).toBe('incluster')
  })
})

describe('strongestGap', () => {
  it('names the strongest untested origin as the remaining gap', () => {
    const os = buildOrigins(traceWith([p({ vantage: 'in-cluster', path: 'data' })]))
    // caller is unsupported+blocked and is the strongest thing still missing.
    expect(strongestGap(os)?.id).toBe('caller')
  })
})
