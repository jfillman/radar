import { describe, it, expect } from 'vitest'
import { buildGraph, POD_DETAIL_MAX, POD_ROW_MAX, PILL_MAX_PX } from './reachGraphModel'
import { buildOrigins } from './reachOrigins'
import type { Trace, RouteResult, PodStatus, ProbeResult } from './types'

const p = (o: Partial<ProbeResult>): ProbeResult => ({ layer: 'http', target: '10.0.0.1:8080', vantage: 'in-cluster', path: 'data', ok: true, ...o })
const pod = (name: string, ready: boolean, ip: string, reason?: string): PodStatus => ({ name, ready, ip, reason })

function trace(pods: PodStatus[], probes: ProbeResult[], podTotal?: number): Trace {
  return {
    subject: { kind: 'Service', name: 'shop', namespace: 'store' },
    verdict: 'healthy',
    brokenAt: -1,
    upstreams: [],
    downstream: [
      { resource: { kind: 'Service', name: 'shop', namespace: 'store' }, edge: 'service', findings: [], config: { clusterIP: '10.96.0.1' } },
      {
        resource: { kind: 'Pods', name: '', namespace: 'store' },
        edge: 'service->pods',
        findings: [],
        meta: { ready: pods.filter((x) => x.ready).length, selected: podTotal ?? pods.length },
        config: { pods, podTotal: podTotal ?? pods.length },
        probes,
      },
    ],
  }
}

const route = (o: Partial<RouteResult> = {}): RouteResult => ({ route: 'GET /', target: ':80 → 8080', outcome: 'verified', confidence: 'real', ...o })

const originsFor = (t: Trace) => buildOrigins(t)
const pick = (t: Trace, id: string) => originsFor(t).find((o) => o.id === id)!

describe('buildGraph lanes', () => {
  it('puts a control-plane origin in its own lane above the dataplane', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'apiserver') })
    expect(g.originIsControl).toBe(true)
    expect(g.nodes.find((n) => n.isOrigin)!.lane).toBe('control')
    expect(g.laneControl!.y + g.laneControl!.h).toBeLessThanOrEqual(g.laneData!.y)
  })

  it('carries the relay on the edge rather than spending a column on a node', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver' })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'apiserver') })
    expect(g.nodes.find((n) => n.id === 'n:apiserver')).toBeUndefined()
    // A clean relay is proxied, never proved - it bypassed the dataplane.
    expect(g.edges.find((e) => e.id === 'e:origin-subject')!.mark).toBe('proxied')
  })

  it('a dataplane origin has no control lane at all', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({})])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.originIsControl).toBe(false)
    // An unused lane is omitted rather than drawn empty.
    expect(g.laneControl).toBeUndefined()
    expect(g.nodes.find((n) => n.isOrigin)!.lane).toBe('data')
  })

  it('never lays out more than four columns, so the path fits its pane', () => {
    const t = trace([pod('a', true, '10.0.0.1'), pod('b', true, '10.0.0.2')], [p({ path: 'apiserver' })])
    for (const id of ['incluster', 'apiserver'] as const) {
      const g = buildGraph({ trace: t, route: route(), origin: pick(t, id) })
      expect(new Set(g.nodes.map((n) => n.x)).size).toBeLessThanOrEqual(4)
    }
  })

  it('the origin is drawn as a vantage capsule, never as a Kubernetes resource', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({})])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const origin = g.nodes.find((n) => n.isOrigin)!
    expect(origin.ref).toBeUndefined()
    expect(origin.kind).toBe('TESTED FROM')
  })
})

// The single most damaging failure this view can have: rendering one vantage's
// success as another vantage's proof. RouteResult holds ONE merged outcome, so
// the graph must gate on the selected origin's own evidence.
describe('evidence is scoped to the selected origin', () => {
  it('an origin that never ran shows its own mark, not another origin\'s success', () => {
    // A local (laptop) probe verified the route. The in-cluster probe never ran.
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: 'local', path: 'data', ok: true, tone: 'healthy' })])
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: pick(t, 'incluster') })
    const entry = g.edges.find((e) => e.id === 'e:origin-subject')!
    expect(entry.mark).toBe('untested')
    expect(entry.mark).not.toBe('proved')
    expect(entry.label).toMatch(/not tested from here/)
  })

  it('does not paint a solid dataplane line for a probe that never ran', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: 'local', path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: pick(t, 'incluster') })
    // 'proved' is the only solid green mark; nothing on this canvas may carry it.
    expect(g.edges.some((e) => e.mark === 'proved')).toBe(false)
    expect(g.nodes.find((n) => n.id === 'n:endpoints')!.podRows!.every((r) => r.mark !== 'proved')).toBe(true)
  })

  it('endpoint rows read only the selected origin\'s probes', () => {
    // in-cluster succeeded; the apiserver relay never probed this endpoint.
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: 'in-cluster', path: 'data', target: '10.0.0.1:8080', ok: true })])
    const viaProxy = buildGraph({ trace: t, route: route(), origin: pick(t, 'apiserver') })
    expect(viaProxy.nodes.find((n) => n.id === 'n:endpoints')!.podRows![0].mark).toBe('untested')
    const inCluster = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(inCluster.nodes.find((n) => n.id === 'n:endpoints')!.podRows![0].mark).toBe('proved')
  })

  it('an origin WITH evidence still renders the route outcome', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: 'in-cluster', path: 'data', target: '10.0.0.1:8080', ok: true })])
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: pick(t, 'incluster') })
    expect(g.edges.find((e) => e.id === 'e:origin-subject')!.mark).toBe('proved')
  })

  it('anomalies are not attributed to an origin that produced none', () => {
    const many = Array.from({ length: 7 }, (_, i) => pod(`p${i}`, true, `10.0.0.${i}`))
    const t = trace(many, many.map((x, i) => p({ vantage: 'in-cluster', path: 'data', target: `${x.ip}:8080`, ok: i !== 2, tone: i === 2 ? 'unhealthy' : 'healthy' })))
    const viaProxy = buildGraph({ trace: t, route: route(), origin: pick(t, 'apiserver') })
    expect(viaProxy.nodes.find((n) => n.id === 'n:endpoints')!.anomalies?.some((a) => a.mark === 'failed')).toBe(false)
  })
})

describe('buildGraph edges', () => {
  it('service to endpoint membership is always config — no packet traverses it', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({})])
    for (const id of ['incluster', 'apiserver'] as const) {
      const g = buildGraph({ trace: t, route: route(), origin: pick(t, id) })
      expect(g.edges.find((e) => e.id === 'e:subject-endpoints')!.mark).toBe('config')
    }
  })

  it('a NotReady endpoint is excluded, never failed — it was never in the path', () => {
    const t = trace([pod('a', true, '10.0.0.1'), pod('b', false, '10.0.0.2', 'readiness failing')], [p({})])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const rows = g.nodes.find((n) => n.id === 'n:endpoints')!.podRows!
    expect(rows.find((r) => r.name === 'b')!.mark).toBe('excluded')
  })

  it("an endpoint's own failure outranks the upstream verdict — it is the fault, not blocked", () => {
    // The route is unreachable BECAUSE this endpoint refused. Calling it
    // "blocked" would hide the actual fault.
    const t = trace([pod('a', true, '10.0.0.1')], [p({ ok: false, tone: 'unhealthy', detail: 'connection refused' })])
    const g = buildGraph({ trace: t, route: route({ outcome: 'unreachable' }), origin: pick(t, 'incluster') })
    expect(g.edges.find((e) => e.id === 'e:origin-subject')!.mark).toBe('failed')
    const rows = g.nodes.find((n) => n.id === 'n:endpoints')!.podRows!
    expect(rows[0].mark).toBe('failed')
    expect(rows[0].detail).toBe('connection refused')
  })

  it('blocked is reserved for an endpoint with no result that an upstream failure explains', () => {
    // Nothing was probed here, and the route failed further up - so this
    // endpoint was never dialled at all.
    const t = trace([pod('a', true, '10.0.0.1')], [])
    const g = buildGraph({ trace: t, route: route({ outcome: 'unreachable', confidence: 'real' }), origin: pick(t, 'incluster') })
    const rows = g.nodes.find((n) => n.id === 'n:endpoints')!.podRows!
    expect(rows[0].mark).toBe('blocked')
  })

  it('an unprobed ready endpoint reads untested, not proved', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [])
    const g = buildGraph({ trace: t, route: route({ outcome: 'not-tested' }), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.id === 'n:endpoints')!.podRows![0].mark).toBe('untested')
  })

  it('a pathologically slow endpoint is marked slow rather than simply proved', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ latencyNs: 1_900_000_000 })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.id === 'n:endpoints')!.podRows![0].mark).toBe('slow')
  })
})

// Prior-blocker A from the PR #1037 review: node colour comes from the
// resource's OWN health, and an apiserver-proxy failure is indirect evidence
// that must never condemn it.
describe('node health from probes', () => {
  const toneOf = (t: Trace, originId: string, id: string) =>
    buildGraph({ trace: t, route: route(), origin: pick(t, originId) }).nodes.find((n) => n.id === id)!.tone

  it('a failed real probe never renders as healthy', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ path: 'data', ok: false, tone: 'unhealthy' })])
    expect(toneOf(t, 'incluster', 'n:endpoints')).toBe('unhealthy')
  })

  it('a failed apiserver probe leaves health unknown, never red', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ path: 'apiserver', ok: false, tone: 'unhealthy' })])
    expect(toneOf(t, 'apiserver', 'n:endpoints')).toBe('unknown')
  })

  it('a real failure still condemns even when a proxy probe passed', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [
      p({ path: 'apiserver', ok: true, tone: 'healthy' }),
      p({ path: 'data', ok: false, tone: 'unhealthy' }),
    ])
    expect(toneOf(t, 'incluster', 'n:endpoints')).toBe('unhealthy')
  })

  it('a degraded probe reads degraded, not unhealthy', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ path: 'data', ok: true, tone: 'degraded' })])
    expect(toneOf(t, 'incluster', 'n:endpoints')).toBe('degraded')
  })
})

describe('buildGraph aggregation', () => {
  const many = Array.from({ length: POD_DETAIL_MAX + 3 }, (_, i) => pod(`p${i}`, true, `10.0.0.${i}`))

  it('collapses a large population into one node, never a column of boxes', () => {
    const t = trace(many, many.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    // Endpoints are rows inside the selection node - no per-pod node exists.
    expect(g.nodes.filter((n) => n.id.startsWith('n:pod'))).toHaveLength(0)
    const eps = g.nodes.find((n) => n.id === 'n:endpoints')!
    expect(eps.kind).toBe('ENDPOINT POPULATION')
    expect(eps.podRows!.length).toBeLessThanOrEqual(POD_ROW_MAX)
  })

  it('names the endpoints past the row cap rather than dropping them silently', () => {
    const t = trace(many, many.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.id === 'n:endpoints')!
    expect(eps.moreRows).toBe(many.length - POD_ROW_MAX)
  })

  it('keeps a failing endpoint visible instead of averaging it into the aggregate', () => {
    const probes = many.map((x, i) => p({ target: `${x.ip}:8080`, ok: i !== 2, tone: i === 2 ? 'unhealthy' : 'healthy' }))
    const t = trace(many, probes)
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.id === 'n:endpoints')!
    expect(eps.anomalies?.some((a) => a.mark === 'failed')).toBe(true)
    expect(eps.podRows!.some((r) => r.mark === 'failed')).toBe(true)
  })

  it('states the unprobed remainder — unprobed is not proven', () => {
    const t = trace(many, many.map((x) => p({ target: `${x.ip}:8080` })), 240)
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.id === 'n:endpoints')!
    const omitted = eps.anomalies?.find((a) => a.mark === 'untested')
    expect(omitted?.text).toMatch(/not probed/)
  })

  it('counts NotReady endpoints as excluded from routing', () => {
    const withBad = [...many, pod('bad', false, '10.0.1.1', 'readiness failing')]
    const t = trace(withBad, many.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.id === 'n:endpoints')!
    expect(eps.anomalies?.some((a) => a.mark === 'excluded')).toBe(true)
  })

  it('lists every endpoint as its own row below the aggregation threshold', () => {
    const few = [pod('a', true, '10.0.0.1'), pod('b', true, '10.0.0.2')]
    const t = trace(few, few.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.id === 'n:endpoints')!
    expect(eps.kind).toBe('ENDPOINT SELECTION')
    expect(eps.podRows).toHaveLength(2)
    expect(eps.moreRows).toBe(0)
  })
})

// The layout is computed rather than hand-placed precisely so that content of
// any length lays out without collisions. These pin that guarantee.
describe('layout collisions', () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  const scenarios: [string, Trace][] = [
    ['single ready pod', trace([pod('a', true, '10.0.0.1')], [p({})])],
    [
      'long names and many pods',
      trace(
        Array.from({ length: 4 }, (_, i) => pod(`a-very-long-workload-name-with-hash-${i}-abcdef123456`, i !== 3, `10.0.0.${i}`, 'readiness probe failing for 12m')),
        [p({})],
      ),
    ],
    ['no backends at all', trace([], [])],
    ['large sampled population', trace(Array.from({ length: 9 }, (_, i) => pod(`p${i}`, true, `10.0.0.${i}`)), [p({})], 240)],
  ]

  for (const [name, t] of scenarios) {
    for (const originId of ['incluster', 'apiserver'] as const) {
      it(`never overlaps two nodes — ${name}, from ${originId}`, () => {
        const g = buildGraph({ trace: t, route: route(), origin: pick(t, originId) })
        for (let i = 0; i < g.nodes.length; i++) {
          for (let j = i + 1; j < g.nodes.length; j++) {
            expect(overlaps(g.nodes[i], g.nodes[j]), `${g.nodes[i].id} overlaps ${g.nodes[j].id}`).toBe(false)
          }
        }
      })

      // The pill's BOX must clear every node, not merely its centre point - a
      // centre-only check passed while a wide pill overran its gutter onto the
      // node beside it.
      it(`keeps every edge pill's full box clear of every node — ${name}, from ${originId}`, () => {
        const g = buildGraph({ trace: t, route: route(), origin: pick(t, originId) })
        const PILL_H = 20
        for (const e of g.edges) {
          const box = { x: e.px - PILL_MAX_PX / 2, y: e.py - PILL_H / 2, w: PILL_MAX_PX, h: PILL_H }
          for (const n of g.nodes) {
            expect(overlaps(box, n), `pill ${e.id} overruns onto node ${n.id}`).toBe(false)
          }
        }
      })
    }
  }

  it('keeps every node inside the reported canvas', () => {
    const t = trace([pod('a', true, '10.0.0.1'), pod('b', false, '10.0.0.2', 'x')], [p({})])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'apiserver') })
    for (const n of g.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(g.canvas.w)
      expect(n.y + n.h).toBeLessThanOrEqual(g.canvas.h)
    }
  })

  it('truncates a long edge label and keeps the full text as a title', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({})])
    const long = 'an extremely long piece of probe evidence that would otherwise overrun its gutter entirely'
    const g = buildGraph({ trace: t, route: route({ evidence: long }), origin: pick(t, 'incluster') })
    const entry = g.edges.find((e) => e.id === 'e:origin-subject')!
    expect(entry.label.length).toBeLessThan(long.length)
    expect(entry.title).toBe(long)
  })
})

describe('publishNotReadyAddresses', () => {
  // With this set the dataplane routes to NotReady Pods, so none of them is
  // excluded. Honouring it in the subtitle but not in the rows told the user a
  // Pod was "never routed to" while it was in fact serving traffic.
  const publishing = (pods: PodStatus[], probes: ProbeResult[]) => {
    const t = trace(pods, probes)
    t.downstream[1].meta = { ready: pods.length, selected: pods.length, publishNotReadyAddresses: true }
    return t
  }

  it('does not call a NotReady endpoint excluded when not-ready addresses are published', () => {
    const t = publishing([pod('a', false, '10.0.0.1', 'readiness failing')], [p({ path: 'data', target: '10.0.0.1:8080', ok: true })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const rows = g.nodes.find((n) => n.id === 'n:endpoints')!.podRows!
    expect(rows[0].mark).not.toBe('excluded')
    expect(rows[0].detail).toMatch(/published anyway/)
  })

  it('reports no excluded endpoints in the population anomalies', () => {
    const t = publishing([pod('a', false, '10.0.0.1', 'x'), pod('b', true, '10.0.0.2')], [p({ path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.id === 'n:endpoints')!.anomalies?.some((a) => a.mark === 'excluded')).toBe(false)
  })

  it('still excludes NotReady endpoints when the Service withholds them', () => {
    const t = trace([pod('a', false, '10.0.0.1', 'x')], [p({ path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.id === 'n:endpoints')!.podRows![0].mark).toBe('excluded')
  })

  it('never renders the published count as a readiness count', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({})])
    t.downstream[1].meta = { ready: 3, selected: 3, publishNotReadyAddresses: true }
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.id === 'n:endpoints')!
    expect(eps.sub).toMatch(/regardless of readiness/)
    // The "N of M ready" phrasing would be a lie here: `ready` is a PUBLISHED
    // count when the Service publishes not-ready addresses.
    expect(eps.sub).not.toMatch(/\d+ of \d+ ready/)
  })
})
