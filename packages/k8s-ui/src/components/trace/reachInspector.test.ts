import { describe, it, expect } from 'vitest'
import { buildSidebar, buildVerdict } from './reachInspector'
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

// Pods nodes are parent-scoped so multi-backend routes keep a group each, so
// tests address them by role rather than by a fixed id.
function podsNodeId(t: Trace): string {
  const g = buildGraph({ trace: t, route: route(), origin: buildOrigins(t).find((o) => o.id === 'incluster')! })
  return g.nodes.find((n) => n.kind === 'PODS')!.id
}
function podsEdgeId(t: Trace): string {
  const g = buildGraph({ trace: t, route: route(), origin: buildOrigins(t).find((o) => o.id === 'incluster')! })
  return g.edges.find((e) => e.label === 'selects')!.id
}

function ctx(t: Trace, originId: string, r = route()) {
  const origins = buildOrigins(t)
  const origin = origins.find((o) => o.id === originId)!
  const g = buildGraph({ trace: t, route: r, origin })
  return { trace: t, route: r, origin, origins, nodes: g.nodes }
}

describe('the diagnosis is always present', () => {
  // The reason the tab exists is "did traffic get through". That must never
  // require a click, so the path section is computed regardless of selection.
  it('answers the path question with nothing selected', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const s = buildSidebar(undefined, ctx(t, 'incluster'))
    expect(s.path.title).toBeTruthy()
    expect(s.path.evidence.length).toBeGreaterThan(0)
    expect(s.path.next.header).toBeTruthy()
    expect(s.resource).toBeUndefined()
  })

  it('selecting a node ADDS detail without replacing the diagnosis', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const c = ctx(t, 'incluster')
    const before = buildSidebar(undefined, c)
    const after = buildSidebar(podsNodeId(t), c)
    expect(after.path).toEqual(before.path)
    expect(after.resource?.kind).toBe('PODS')
  })

  it('an apiserver result always states what it skipped', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const s = buildSidebar(undefined, ctx(t, 'apiserver'))
    expect(s.path.notProve.join(' ')).toMatch(/relayed|routing|network policy|mesh/i)
  })

  it('a synthetic result always states the identity gap', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const s = buildSidebar(undefined, ctx(t, 'incluster'))
    expect(s.path.notProve.join(' ')).toMatch(/not as your application|who is calling/i)
  })

  it('never claims complete evidence', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    expect(buildSidebar(undefined, ctx(t, 'incluster')).path.notProve.length).toBeGreaterThan(0)
  })

  it('does not claim a front-door gap on a resource with no entry point', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    expect(t.upstreams).toHaveLength(0)
    expect(buildSidebar(undefined, ctx(t, 'incluster')).path.notProve.join(' ')).not.toMatch(/internet|outside/i)
  })

  it('offers only actions that can be taken', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const s = buildSidebar(undefined, ctx(t, 'apiserver'))
    expect(s.path.next.ctas.every((c) => !c.disabledReason)).toBe(true)
    expect(s.path.next.body).toMatch(/in-cluster/i)
  })

  it('the RBAC prompt names the permission and copies a command that runs', () => {
    // Every other vantage must be spent, or offering one of those would be the
    // better next step than asking for permission.
    const t = mk([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' }), p({ vantage: 'local', path: 'data' })])
    const origins = buildOrigins(t, { inClusterAllowed: false })
    const g = buildGraph({ trace: t, route: route(), origin: origins.find((o) => o.id === 'apiserver')! })
    const s = buildSidebar(undefined, { trace: t, route: route(), origin: origins.find((o) => o.id === 'apiserver')!, origins, nodes: g.nodes })
    expect(s.path.next.body).toMatch(/create.*jobs/i)
    expect(s.path.next.ctas[0].command).toMatch(/kubectl auth can-i/)
  })
})

// The graph already gates on this; the sidebar is the surface people actually
// read, so it must gate identically or it states another vantage's result under
// the selected vantage's name.
describe('the sidebar is scoped to the selected vantage', () => {
  it('an unavailable vantage never inherits another vantage\'s success', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const origins = buildOrigins(t)
    const caller = origins.find((o) => o.id === 'caller')!
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: caller })
    const s = buildSidebar(undefined, { trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: caller, origins, nodes: g.nodes })
    expect(s.path.body).not.toMatch(/a real request went through/i)
    expect(s.path.evidence.every((e) => e.mark !== 'proved')).toBe(true)
    expect(s.path.evidence.map((e) => e.text).join(' ')).toMatch(/cannot test from here/i)
  })

  it('a vantage that did run still reports its result', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const s = buildSidebar(undefined, ctx(t, 'incluster'))
    expect(s.path.body).toMatch(/a real request went through/i)
  })

  it('a stale result does not lead with its old assertion', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    t.headline = 'Reachable in-cluster on :80'
    const v = buildVerdict(t, route(), buildOrigins(t), { stale: true })
    expect(v.title).not.toMatch(/Reachable/)
    expect(v.title).toMatch(/out of date/i)
  })
})

describe('node detail is additive', () => {
  it('a Pods node reports what is and is not taking traffic', () => {
    const t = mk([pod('a', true, '10.0.0.1'), pod('b', false, '10.0.0.2', 'readiness failing')], [p({})])
    const r = buildSidebar(podsNodeId(t), ctx(t, 'incluster')).resource!
    expect(r.facts.find((x) => x.k === 'SITTING OUT')!.v).toMatch(/not ready/)
    // Derived from readiness, so it must not claim observed delivery.
    expect(r.facts.some((x) => x.k === 'ELIGIBLE')).toBe(true)
    expect(r.facts.some((x) => x.k === 'TAKING TRAFFIC')).toBe(false)
    expect(r.notProve.join(' ')).toMatch(/nothing was sent to them/)
    expect(r.rows!.some((x) => x.mark === 'excluded')).toBe(true)
  })

  it('a resource node carries its own config, not the path result', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const c = ctx(t, 'incluster')
    const svc = c.nodes.find((n) => n.kind === 'SERVICE')!
    const r = buildSidebar(svc.id, c).resource!
    expect(r.facts.some((x) => x.k === 'CLUSTER IP')).toBe(true)
    expect(r.openRef?.name).toBe('shop')
  })

  it('the origin capsule is not selectable', () => {
    const t = mk([pod('a', true, '10.0.0.1')], [p({})])
    const c = ctx(t, 'incluster')
    const cap = c.nodes.find((n) => n.isOrigin)!
    expect(buildSidebar(cap.id, c).resource).toBeUndefined()
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
