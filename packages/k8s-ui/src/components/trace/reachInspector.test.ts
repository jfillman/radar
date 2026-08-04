import { describe, it, expect } from 'vitest'
import { buildInspector, buildVerdict } from './reachInspector'
import { buildGraph } from './reachGraphModel'
import { buildOrigins } from './reachOrigins'
import type { Trace, RouteResult, ProbeResult, PodStatus } from './types'

const p = (o: Partial<ProbeResult>): ProbeResult => ({ layer: 'http', target: '10.0.0.1:8080', vantage: 'in-cluster', path: 'data', ok: true, ...o })
const pod = (name: string, ready: boolean, ip: string, reason?: string): PodStatus => ({ name, ready, ip, reason })

function mk(pods: PodStatus[], probes: ProbeResult[]): Trace {
  return {
    subject: { kind: 'Service', name: 'shop', namespace: 'store' },
    verdict: 'healthy',
    brokenAt: -1,
    upstreams: [],
    downstream: [
      { resource: { kind: 'Service', name: 'shop', namespace: 'store' }, edge: 'service', findings: [], config: { clusterIP: '10.96.0.1', selector: { app: 'shop' } } },
      {
        resource: { kind: 'Pods', name: '', namespace: 'store' },
        edge: 'service->pods',
        findings: [],
        meta: { ready: pods.filter((x) => x.ready).length, selected: pods.length },
        config: { pods, podTotal: pods.length },
        probes,
      },
    ],
  }
}

const route = (o: Partial<RouteResult> = {}): RouteResult => ({ route: 'GET /', target: ':80 → 8080', outcome: 'verified', confidence: 'real', ...o })

function ctx(t: Trace, originId: string, r = route()) {
  const origins = buildOrigins(t)
  const origin = origins.find((o) => o.id === originId)!
  const g = buildGraph({ trace: t, route: r, origin })
  return { trace: t, route: r, origin, origins, nodes: g.nodes, edges: g.edges }
}

describe('inspector caveats', () => {
  it('an apiserver result always states what it bypassed', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const c = ctx(t, 'apiserver')
    const insp = buildInspector('e:origin-subject', c)
    expect(insp.notProve.join(' ')).toMatch(/kube-proxy|NetworkPolicy|mesh/)
  })

  it('a synthetic probe result always states the identity gap', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const insp = buildInspector('e:origin-subject', ctx(t, 'incluster'))
    // Asserts the MEANING, not the wording - the caveat must say the test did
    // not run as the user's application.
    expect(insp.notProve.join(' ')).toMatch(/not as your application|who is calling/i)
  })

  it('does not claim a front-door gap on a resource that has no front door', () => {
    // The external origin is always unsupported, so an ungated check appended
    // this caveat to every ClusterIP Service that has no entry point at all.
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    expect(t.upstreams).toHaveLength(0)
    const insp = buildInspector('e:origin-subject', ctx(t, 'incluster'))
    expect(insp.notProve.join(' ')).not.toMatch(/front door/i)
  })

  it('does name the front-door gap when an entry point exists', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    t.upstreams = [{ resource: { kind: 'Gateway', name: 'gw', namespace: 'store' }, edge: 'gateway->service', findings: [] }]
    const insp = buildInspector('e:origin-subject', ctx(t, 'incluster'))
    expect(insp.notProve.join(' ')).toMatch(/front door/i)
  })

  it('never claims complete evidence — a proved result still carries caveats', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const insp = buildInspector('e:origin-subject', ctx(t, 'incluster'))
    expect(insp.notProve.length).toBeGreaterThan(0)
  })
})

describe('inspector selections', () => {
  it('names an excluded NotReady endpoint as a coverage gap, not a failure', () => {
    const t = mk([pod('a', true, '10.0.0.1'), pod('b', false, '10.0.0.2', 'readiness failing')], [p({})])
    const insp = buildInspector('n:endpoints', ctx(t, 'incluster'))
    expect(insp.scope.find((x) => x.k === 'SITTING OUT')!.v).toMatch(/not ready/)
    expect(insp.notProve.join(' ')).toMatch(/no traffic was routed there/)
    expect(insp.next.header).toMatch(/READINESS, NOT REACHABILITY/)
  })

  it('a blocked segment reports an absence of evidence, not a fault', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({ vantage: 'local', path: 'data', skipped: true, reason: 'ClusterIP is not routable from your host' })])
    const insp = buildInspector('e:origin-subject', ctx(t, 'local'))
    expect(insp.chipText).toBe('not tested')
    expect(insp.notProve.join(' ')).toMatch(/not exercised|Anything about this segment/)
  })

  it('a node selection redirects to the edges for path truth', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const insp = buildInspector('n:Service/store/shop', ctx(t, 'incluster'))
    expect(insp.scopeHeader).toMatch(/HEALTH IS NOT REACHABILITY/)
    expect(insp.notProve.join(' ')).toMatch(/That any request reached this resource/)
  })

  it('the membership edge is a config relationship, not a hop', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const insp = buildInspector('e:subject-endpoints', ctx(t, 'incluster'))
    expect(insp.chipText).toBe('config relationship')
    expect(insp.body).toMatch(/Nothing travels along this line/)
  })

  it('an unsupported origin explains the limitation instead of offering an action', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const insp = buildInspector('origin:caller', ctx(t, 'incluster'))
    expect(insp.body).toMatch(/can’t send a request from one of your running Pods/)
  })

  it('proposes an origin Radar can actually use, never an impossible one', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const insp = buildInspector('origin:apiserver', ctx(t, 'apiserver'))
    expect(insp.next.header).toBe('NEXT STRONGEST TEST')
    expect(insp.next.body).toMatch(/in-cluster probe/i)
    // Every offered CTA must be pressable.
    expect(insp.next.ctas.every((c) => !c.disabledReason)).toBe(true)
    // The unreachable ceiling is still stated - as a caveat, not an action.
    expect(insp.next.blocked).toMatch(/real caller/i)
  })

  it('does not offer a test it cannot run once every usable origin is spent', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({}), p({ path: 'apiserver' }), p({ vantage: 'local', path: 'data' })])
    const insp = buildInspector('origin:incluster', ctx(t, 'incluster'))
    expect(insp.next.header).toBe('NO STRONGER TEST AVAILABLE')
    expect(insp.next.ctas.every((c) => !c.disabledReason)).toBe(true)
  })

  it('defaults to the entry edge when nothing is selected', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const insp = buildInspector(undefined, ctx(t, 'incluster'))
    expect(insp.scopeHeader).toBe('TEST SCOPE')
  })
})

describe('verdict band', () => {
  it('reports nothing proven when no origin has run', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [])
    const v = buildVerdict(t, route({ outcome: 'not-tested' }), buildOrigins(t))
    expect(v.tone).toBe('unknown')
    expect(v.facts.find((f) => f.k === 'proven to:')?.v).toBe('nothing')
    expect(v.facts.find((f) => f.k === 'origins:')?.v).toMatch(/none/)
  })

  it('an apiserver-only pass never claims the backend was proven', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const v = buildVerdict(t, route({ confidence: 'indirect' }), buildOrigins(t))
    expect(v.tone).toBe('degraded')
    expect(v.facts.find((f) => f.k === 'proven to:')?.v).toMatch(/serving process/)
  })

  it('points the next step at something Radar can actually do', () => {
    // The real caller is the strongest missing origin AND permanently
    // unavailable. Naming it here would give every resource the same
    // un-actionable line.
    const t = mk([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const v = buildVerdict(t, route({ confidence: 'indirect' }), buildOrigins(t))
    const next = v.facts.find((f) => f.k === 'next:')!.v
    expect(next).toMatch(/in-cluster probe/i)
    expect(next).not.toMatch(/real caller/i)
  })

  it('says so plainly when nothing stronger can be run', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({}), p({ path: 'apiserver' }), p({ vantage: 'local', path: 'data' })])
    const v = buildVerdict(t, route(), buildOrigins(t))
    expect(v.facts.find((f) => f.k === 'next:')!.v).toMatch(/nothing stronger/i)
  })

  it('falls back to the backend verdict when there is no route to derive a tone from', () => {
    // A config fault found without probing still has a verdict; a grey
    // "unknown" dot there under-reports what the tracer already concluded.
    const t = mk([pod('a', true, '10.0.0.1')], [])
    t.verdict = 'degraded'
    t.routes = []
    const v = buildVerdict(t, undefined, buildOrigins(t))
    expect(v.tone).toBe('degraded')
  })

  it('leads with the named fault rather than burying it under a coverage headline', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [])
    t.headline = 'Configuration only - not yet tested'
    t.diagnosis = { summary: 'Accepted: NoMatchingListenerHostname - no hostname intersections' }
    const v = buildVerdict(t, undefined, buildOrigins(t))
    expect(v.problem).toMatch(/NoMatchingListenerHostname/)
    // and it is not duplicated into the body
    expect(v.body).toBe('')
  })

  it('a running test is informational, never green', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const v = buildVerdict(t, route(), buildOrigins(t), { running: true })
    expect(v.tone).toBe('info')
    expect(v.chipText).toBe('testing')
  })
})
