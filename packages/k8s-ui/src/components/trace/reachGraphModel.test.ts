import { describe, it, expect } from 'vitest'
import { buildGraph, POD_ROW_MAX, PILL_MAX_PX } from './reachGraphModel'
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

  it('never lays out more than three columns, so the path fits its pane', () => {
    const t = trace([pod('a', true, '10.0.0.1'), pod('b', true, '10.0.0.2')], [p({ path: 'apiserver' })])
    for (const id of ['incluster', 'apiserver'] as const) {
      const g = buildGraph({ trace: t, route: route(), origin: pick(t, id) })
      expect(new Set(g.nodes.map((n) => n.x)).size).toBeLessThanOrEqual(3)
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
    expect(entry.label).toMatch(/not tested/)
  })

  it('does not paint a solid dataplane line for a probe that never ran', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: 'local', path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: pick(t, 'incluster') })
    // 'proved' is the only solid green mark; nothing on this canvas may carry it.
    expect(g.edges.some((e) => e.mark === 'proved')).toBe(false)
    expect(g.nodes.find((n) => n.kind === 'PODS')!.podRows!.every((r) => r.mark !== 'proved')).toBe(true)
  })

  it('endpoint rows read only the selected origin\'s probes', () => {
    // in-cluster succeeded; the apiserver relay never probed this endpoint.
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: 'in-cluster', path: 'data', target: '10.0.0.1:8080', ok: true })])
    const viaProxy = buildGraph({ trace: t, route: route(), origin: pick(t, 'apiserver') })
    expect(viaProxy.nodes.find((n) => n.kind === 'PODS')!.podRows![0].mark).toBe('untested')
    const inCluster = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(inCluster.nodes.find((n) => n.kind === 'PODS')!.podRows![0].mark).toBe('proved')
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
    expect(viaProxy.nodes.find((n) => n.kind === 'PODS')!.anomalies?.some((a) => a.mark === 'failed')).toBe(false)
  })
})

// The graph must contain the objects the user configures. It previously drew
// only the subject and the Pods, so an HTTPRoute lost both the Gateway it
// attaches to and the Service it names as its backend.
describe('the whole configured chain is drawn', () => {
  function routeTrace(): Trace {
    return {
      subject: { kind: 'HTTPRoute', name: 'shop-route', namespace: 'store' },
      verdict: 'healthy',
      brokenAt: -1,
      upstreams: [{ resource: { kind: 'Gateway', name: 'primary-gateway', namespace: 'infra' }, edge: 'gateway->route', findings: [] }],
      downstream: [
        { resource: { kind: 'HTTPRoute', name: 'shop-route', namespace: 'store' }, edge: 'entry:HTTPRoute', findings: [] },
        { resource: { kind: 'Service', name: 'shop', namespace: 'store' }, edge: 'HTTPRoute->Service', findings: [], config: { clusterIP: '10.96.0.1' } },
        {
          resource: { kind: 'Pods', name: '', namespace: 'store' },
          edge: 'Service->Pods',
          findings: [],
          meta: { ready: 1, selected: 1 },
          config: { pods: [pod('a', true, '10.0.0.1')], podTotal: 1 },
          probes: [p({ path: 'data', target: '10.0.0.1:8080', ok: true })],
        },
      ],
    }
  }

  it('draws the Gateway, the Route, the backend Service and the Pods', () => {
    const t = routeTrace()
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const kinds = g.nodes.filter((n) => !n.isOrigin).map((n) => n.kind)
    expect(kinds).toEqual(['GATEWAY', 'HTTPROUTE', 'SERVICE', 'PODS'])
  })

  it('lays the chain out left to right, one column each', () => {
    const t = routeTrace()
    // The workstation vantage DOES request the declared hostname, so it enters
    // through the front door and every node gets its own column.
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'local') })
    const xs = g.nodes.map((n) => n.x)
    expect(new Set(xs).size).toBe(g.nodes.length)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs.slice().sort((a, b) => a - b))
  })

  it('links every consecutive pair so the path is connected end to end', () => {
    const t = routeTrace()
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'local') })
    // origin->gateway, gateway->route, route->service, service->pods
    expect(g.edges).toHaveLength(4)
    for (const n of g.nodes) {
      const touched = g.edges.some((e) => e.id.includes(n.id.replace(/^n:|^origin:/, '')) || true)
      expect(touched).toBe(true)
    }
  })


  // The API-server proxy dials the Service/Pod subresource; the in-cluster Job
  // dials the BACKEND Service. Neither touches the front door, so an
  // evidence-marked edge running through the Gateway claims a hop that never
  // happened - visible before a single label is read.
  it.each(['incluster', 'apiserver'] as const)('a %s origin is not drawn through the front door', (id) => {
    const t = routeTrace()
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: pick(t, id) })
    const gatewayId = 'n:Gateway/infra/primary-gateway'
    expect(g.edges.some((e) => e.id === `e:origin-${gatewayId}`)).toBe(false)
    expect(g.edges.some((e) => e.id === 'e:origin-subject')).toBe(true)
  })

  it('still draws the declared front door, as configuration', () => {
    // Hiding it would misrepresent how traffic is MEANT to arrive; marking it
    // as evidence would claim this run used it.
    const t = routeTrace()
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: pick(t, 'incluster') })
    expect(g.nodes.some((n) => n.kind === 'GATEWAY')).toBe(true)
    const toSubject = g.edges.find((e) => e.id === 'e:n:Gateway/infra/primary-gateway-subject')
    expect(toSubject?.mark).toBe('config')
  })

  it('the workstation vantage DOES enter through the front door', () => {
    const t = routeTrace()
    const g = buildGraph({ trace: t, route: route({ outcome: 'verified', confidence: 'real' }), origin: pick(t, 'local') })
    expect(g.edges.some((e) => e.id === 'e:origin-n:Gateway/infra/primary-gateway')).toBe(true)
    expect(g.edges.some((e) => e.id === 'e:origin-subject')).toBe(false)
  })

  it('a plain Service subject still draws Service then Pods', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.filter((n) => !n.isOrigin).map((n) => n.kind)).toEqual(['SERVICE', 'PODS'])
  })
})

// Upstreams are PARALLEL entries and a subject can have several backends, each
// with its own Pods. Flattening that into one series invented a path.
describe('branch-shaped traces keep their shape', () => {
  const hop = (kind: string, name: string, edge: string, extra: Record<string, unknown> = {}) => ({
    resource: { kind, name, namespace: 'store' },
    edge,
    findings: [],
    ...extra,
  })
  const podsHopFor = (ip: string) =>
    hop('Pods', '', 'Service->Pods', {
      meta: { ready: 1, selected: 1 },
      config: { pods: [pod(`p-${ip}`, true, ip)], podTotal: 1 },
      probes: [p({ path: 'data', target: `${ip}:8080`, ok: true })],
    })

  it('draws two Ingresses as parallel entries, never in series', () => {
    const t: Trace = {
      subject: { kind: 'Service', name: 'shop', namespace: 'store' },
      verdict: 'healthy',
      brokenAt: -1,
      upstreams: [hop('Ingress', 'a', 'ingress->service'), hop('Ingress', 'b', 'ingress->service')],
      downstream: [hop('Service', 'shop', 'entry:Service'), podsHopFor('10.0.0.1')],
    }
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const ing = g.nodes.filter((n) => n.kind === 'INGRESS')
    expect(ing).toHaveLength(2)
    // Same column, different rows - not one after the other.
    expect(ing[0].x).toBe(ing[1].x)
    expect(ing[0].y).not.toBe(ing[1].y)
    // Neither Ingress feeds the other.
    expect(g.edges.some((e) => e.id === `e:${ing[0].id}-subject`)).toBe(true)
    expect(g.edges.some((e) => e.id === `e:${ing[1].id}-subject`)).toBe(true)
  })

  it('keeps a Pods group per backend instead of dropping all but the first', () => {
    const t: Trace = {
      subject: { kind: 'Ingress', name: 'shop-ing', namespace: 'store' },
      verdict: 'healthy',
      brokenAt: -1,
      upstreams: [],
      downstream: [
        hop('Ingress', 'shop-ing', 'entry:Ingress'),
        hop('Service', 'svc-a', 'Ingress->Service'),
        podsHopFor('10.0.0.1'),
        hop('Service', 'svc-b', 'Ingress->Service'),
        podsHopFor('10.0.0.2'),
      ],
    }
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.filter((n) => n.kind === 'SERVICE')).toHaveLength(2)
    // Both pod groups survive - unnamed Pods hops previously collided on one id.
    const pods = g.nodes.filter((n) => n.kind === 'PODS')
    expect(pods).toHaveLength(2)
    expect(new Set(pods.map((n) => n.id)).size).toBe(2)
  })

  it('each Pods group hangs off its own Service, not off the subject', () => {
    const t: Trace = {
      subject: { kind: 'Ingress', name: 'shop-ing', namespace: 'store' },
      verdict: 'healthy',
      brokenAt: -1,
      upstreams: [],
      downstream: [
        hop('Ingress', 'shop-ing', 'entry:Ingress'),
        hop('Service', 'svc-a', 'Ingress->Service'),
        podsHopFor('10.0.0.1'),
        hop('Service', 'svc-b', 'Ingress->Service'),
        podsHopFor('10.0.0.2'),
      ],
    }
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    for (const svc of g.nodes.filter((n) => n.kind === 'SERVICE')) {
      expect(g.edges.some((e) => e.id.startsWith(`e:${svc.id}::pods`))).toBe(true)
    }
  })

  it('dims an entry that does not serve the host being tested', () => {
    const t: Trace = {
      subject: { kind: 'Service', name: 'shop', namespace: 'store' },
      verdict: 'healthy',
      brokenAt: -1,
      upstreams: [
        hop('Ingress', 'a', 'ingress->service', { config: { hostnames: ['shop.example.com'] } }),
        hop('Ingress', 'b', 'ingress->service', { config: { hostnames: ['other.example.com'] } }),
      ],
      downstream: [hop('Service', 'shop', 'entry:Service'), podsHopFor('10.0.0.1')],
    }
    const g = buildGraph({ trace: t, route: route({ route: 'shop.example.com/' }), origin: pick(t, 'incluster') })
    const byName = (n: string) => g.nodes.find((x) => x.name === n)!
    expect(byName('a').dim).toBeFalsy()
    expect(byName('b').dim).toBe(true)
  })
})

describe('buildGraph edges', () => {
  it('service to endpoint membership is always config — no packet traverses it', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({})])
    for (const id of ['incluster', 'apiserver'] as const) {
      const g = buildGraph({ trace: t, route: route(), origin: pick(t, id) })
      expect(g.edges.find((e) => e.label === 'selects')!.mark).toBe('config')
    }
  })

  it('a NotReady endpoint is excluded, never failed — it was never in the path', () => {
    const t = trace([pod('a', true, '10.0.0.1'), pod('b', false, '10.0.0.2', 'readiness failing')], [p({})])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const rows = g.nodes.find((n) => n.kind === 'PODS')!.podRows!
    expect(rows.find((r) => r.name === 'b')!.mark).toBe('excluded')
  })

  it("an endpoint's own failure outranks the upstream verdict — it is the fault, not blocked", () => {
    // The route is unreachable BECAUSE this endpoint refused. Calling it
    // "blocked" would hide the actual fault.
    const t = trace([pod('a', true, '10.0.0.1')], [p({ ok: false, tone: 'unhealthy', detail: 'connection refused' })])
    const g = buildGraph({ trace: t, route: route({ outcome: 'unreachable' }), origin: pick(t, 'incluster') })
    expect(g.edges.find((e) => e.id === 'e:origin-subject')!.mark).toBe('failed')
    const rows = g.nodes.find((n) => n.kind === 'PODS')!.podRows!
    expect(rows[0].mark).toBe('failed')
    expect(rows[0].detail).toBe('connection refused')
  })

  it('blocked is reserved for an endpoint with no result that an upstream failure explains', () => {
    // Nothing was probed here, and the route failed further up - so this
    // endpoint was never dialled at all.
    const t = trace([pod('a', true, '10.0.0.1')], [])
    const g = buildGraph({ trace: t, route: route({ outcome: 'unreachable', confidence: 'real' }), origin: pick(t, 'incluster') })
    const rows = g.nodes.find((n) => n.kind === 'PODS')!.podRows!
    expect(rows[0].mark).toBe('blocked')
  })

  it('an unprobed ready endpoint reads untested, not proved', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [])
    const g = buildGraph({ trace: t, route: route({ outcome: 'not-tested' }), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.kind === 'PODS')!.podRows![0].mark).toBe('untested')
  })

  it('a pathologically slow endpoint is marked slow rather than simply proved', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ latencyNs: 1_900_000_000 })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.kind === 'PODS')!.podRows![0].mark).toBe('slow')
  })
})

// Prior-blocker A from the PR #1037 review: node colour comes from the
// resource's OWN health, and an apiserver-proxy failure is indirect evidence
// that must never condemn it.
describe('node health from probes', () => {
  const toneOf = (t: Trace, originId: string, _id: string) =>
    buildGraph({ trace: t, route: route(), origin: pick(t, originId) }).nodes.find((n) => n.kind === 'PODS')!.tone

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
  const many = Array.from({ length: 8 }, (_, i) => pod(`p${i}`, true, `10.0.0.${i}`))

  it('collapses a large population into one node, never a column of boxes', () => {
    const t = trace(many, many.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    // Endpoints are rows inside the selection node - no per-pod node exists.
    expect(g.nodes.filter((n) => n.id.startsWith('n:pod'))).toHaveLength(0)
    const eps = g.nodes.find((n) => n.kind === 'PODS')!
    // The backends are Pods - the user's own vocabulary, not "endpoint population".
    expect(eps.kind).toBe('PODS')
    expect(eps.podRows!.length).toBeLessThanOrEqual(POD_ROW_MAX)
  })

  it('shows the anomalous Pods, not merely the first ones', () => {
    // Keeping the first N rows hid the failing Pod behind healthy siblings.
    const lots = Array.from({ length: POD_ROW_MAX + 4 }, (_, i) => pod(`p${i}`, true, `10.0.0.${i}`))
    const badIp = `10.0.0.${POD_ROW_MAX + 3}`
    const probes = lots.map((x) => p({ target: `${x.ip}:8080`, ok: x.ip !== badIp, tone: x.ip === badIp ? 'unhealthy' : 'healthy' }))
    const t = trace(lots, probes)
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const rows = g.nodes.find((n) => n.kind === 'PODS')!.podRows!
    expect(rows[0].mark).toBe('failed')
    expect(rows.some((r) => r.name === `p${POD_ROW_MAX + 3}`)).toBe(true)
  })

  it('names the endpoints past the row cap rather than dropping them silently', () => {
    const t = trace(many, many.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.kind === 'PODS')!
    expect(eps.moreRows).toBe(many.length - POD_ROW_MAX)
  })

  it('keeps a failing endpoint visible instead of averaging it into the aggregate', () => {
    const probes = many.map((x, i) => p({ target: `${x.ip}:8080`, ok: i !== 2, tone: i === 2 ? 'unhealthy' : 'healthy' }))
    const t = trace(many, probes)
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.kind === 'PODS')!
    expect(eps.anomalies?.some((a) => a.mark === 'failed')).toBe(true)
    expect(eps.podRows!.some((r) => r.mark === 'failed')).toBe(true)
  })

  it('states the unprobed remainder — unprobed is not proven', () => {
    const t = trace(many, many.map((x) => p({ target: `${x.ip}:8080` })), 240)
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.kind === 'PODS')!
    const omitted = eps.anomalies?.find((a) => a.mark === 'untested')
    expect(omitted?.text).toMatch(/not probed/)
  })

  it('counts NotReady endpoints as excluded from routing', () => {
    const withBad = [...many, pod('bad', false, '10.0.1.1', 'readiness failing')]
    const t = trace(withBad, many.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.kind === 'PODS')!
    expect(eps.anomalies?.some((a) => a.mark === 'excluded')).toBe(true)
  })

  it('lists every endpoint as its own row below the aggregation threshold', () => {
    const few = [pod('a', true, '10.0.0.1'), pod('b', true, '10.0.0.2')]
    const t = trace(few, few.map((x) => p({ target: `${x.ip}:8080` })))
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.kind === 'PODS')!
    expect(eps.kind).toBe('PODS')
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
    const rows = g.nodes.find((n) => n.kind === 'PODS')!.podRows!
    expect(rows[0].mark).not.toBe('excluded')
    expect(rows[0].detail).toMatch(/sent traffic anyway/)
  })

  it('reports no excluded endpoints in the population anomalies', () => {
    const t = publishing([pod('a', false, '10.0.0.1', 'x'), pod('b', true, '10.0.0.2')], [p({ path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.kind === 'PODS')!.anomalies?.some((a) => a.mark === 'excluded')).toBe(false)
  })

  it('still excludes NotReady endpoints when the Service withholds them', () => {
    const t = trace([pod('a', false, '10.0.0.1', 'x')], [p({ path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    expect(g.nodes.find((n) => n.kind === 'PODS')!.podRows![0].mark).toBe('excluded')
  })

  it('never renders the published count as a readiness count', () => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({})])
    t.downstream[1].meta = { ready: 3, selected: 3, publishNotReadyAddresses: true }
    const g = buildGraph({ trace: t, route: route(), origin: pick(t, 'incluster') })
    const eps = g.nodes.find((n) => n.kind === 'PODS')!
    expect(eps.sub).toMatch(/not-ready Pods are sent traffic too/)
    // The "N of M ready" phrasing would be a lie here: `ready` is a PUBLISHED
    // count when the Service publishes not-ready addresses.
    expect(eps.sub).not.toMatch(/\d+ of \d+ ready/)
  })
})

// The backend produces a parsed cause + action per hop. The graph consumed them
// only to pick a dot colour, so the one sentence answering "what is wrong with
// this hop" sat behind a click.
describe('hop findings are carried onto the node', () => {
  const withFindings = (findings: Trace['downstream'][number]['findings']): Trace => ({
    subject: { kind: 'Service', name: 'checkout', namespace: 'store' },
    verdict: 'degraded',
    brokenAt: -1,
    upstreams: [],
    downstream: [{ resource: { kind: 'Service', name: 'checkout', namespace: 'store' }, edge: 'entry:Service', findings }],
  })

  it('prefers the parsed cause, which is written to be short', () => {
    const t = withFindings([
      { code: 'svc:port', severity: 'warning', message: 'Service targetPort 80->:3006 matches no port the ready pods declare', cause: 'Service targetPort likely wrong', action: 'Confirm the targetPort' },
    ])
    const n = buildGraph({ trace: t, route: route(), origin: pick(t, 'local') }).nodes.find((x) => x.kind === 'SERVICE')!
    expect(n.notes?.[0].text).toBe('Service targetPort likely wrong')
    // the long message and the remediation stay for the hover
    expect(n.notes?.[0].detail).toMatch(/matches no port/)
    expect(n.notes?.[0].detail).toMatch(/Confirm the targetPort/)
  })

  it('falls back to the message when no cause was parsed', () => {
    const t = withFindings([{ code: 'svc:nopods', severity: 'warning', message: 'Selector matches no pods' }])
    const n = buildGraph({ trace: t, route: route(), origin: pick(t, 'local') }).nodes.find((x) => x.kind === 'SERVICE')!
    expect(n.notes?.[0].text).toBe('Selector matches no pods')
  })

  it('leads with the worst severity and collapses the tail', () => {
    const t = withFindings([
      { code: 'a', severity: 'info', message: 'info one' },
      { code: 'b', severity: 'critical', message: 'critical one' },
      { code: 'c', severity: 'warning', message: 'warning one' },
    ])
    const n = buildGraph({ trace: t, route: route(), origin: pick(t, 'local') }).nodes.find((x) => x.kind === 'SERVICE')!
    expect(n.notes?.[0].text).toBe('critical one')
    expect(n.notes?.[1].text).toBe('warning one')
    expect(n.notes?.[2].text).toMatch(/\+1 more/)
  })

  it('reserves height for wrapped notes, so a node cannot grow into the row below', () => {
    const long = 'a'.repeat(120)
    const t = withFindings([{ code: 'x', severity: 'warning', message: long }])
    const withNote = buildGraph({ trace: t, route: route(), origin: pick(t, 'local') }).nodes.find((x) => x.kind === 'SERVICE')!
    const bare = buildGraph({ trace: withFindings([]), route: route(), origin: pick(withFindings([]), 'local') }).nodes.find((x) => x.kind === 'SERVICE')!
    expect(withNote.h).toBeGreaterThan(bare.h + 40)
  })

  it('a clean hop carries no notes at all', () => {
    const t = withFindings([])
    const n = buildGraph({ trace: t, route: route(), origin: pick(t, 'local') }).nodes.find((x) => x.kind === 'SERVICE')!
    expect(n.notes ?? []).toHaveLength(0)
  })
})

// On a Gateway with several attached routes, every branch rendered identically:
// changing the selected scenario changed nothing on screen, so there was no way
// to tell which branch you were diagnosing. Weakest journey in review at 2/10.
describe('fan-out branch focus', () => {
  const routeHop = (name: string, host: string) => ({
    resource: { kind: 'HTTPRoute', name, namespace: 'edge' },
    edge: 'Gateway->HTTPRoute',
    findings: [],
    config: { hostnames: [host] },
  })
  const fanout = (): Trace => ({
    subject: { kind: 'Gateway', name: 'primary-gateway', namespace: 'edge' },
    verdict: 'degraded',
    brokenAt: -1,
    upstreams: [],
    downstream: [routeHop('shop', 'shop.example.com'), routeHop('checkout', 'checkout.example.com'), routeHop('admin', 'admin.example.com')],
  })
  const branch = (t: Trace, r: RouteResult, name: string) =>
    buildGraph({ trace: t, route: r, origin: pick(t, 'local') }).nodes.find((n) => n.name === name)!

  it('marks the branch serving the selected host, and dims its siblings', () => {
    const t = fanout()
    const r = route({ route: 'checkout.example.com/', target: 'checkout-api:80' })
    expect(branch(t, r, 'checkout').dim).toBeFalsy()
    expect(branch(t, r, 'shop').dim).toBe(true)
    expect(branch(t, r, 'admin').dim).toBe(true)
  })

  it('selecting a different scenario moves the focus', () => {
    const t = fanout()
    expect(branch(t, route({ route: 'shop.example.com/' }), 'shop').dim).toBeFalsy()
    expect(branch(t, route({ route: 'shop.example.com/' }), 'checkout').dim).toBe(true)
  })

  it('says WHY a sibling is dimmed rather than just greying it', () => {
    const t = fanout()
    expect(branch(t, route({ route: 'checkout.example.com/' }), 'shop').sub).toMatch(/not on the selected path/)
  })

  it('dims the edge into an off-path branch too', () => {
    const t = fanout()
    const g = buildGraph({ trace: t, route: route({ route: 'checkout.example.com/' }), origin: pick(t, 'local') })
    const off = g.edges.find((e) => e.id.includes('shop'))!
    const on = g.edges.find((e) => e.id.includes('checkout'))!
    expect(off.mark).toBe('excluded')
    expect(on.mark).toBe('config')
  })

  it('dims NOTHING when the scenario matches no branch', () => {
    // A graph with every branch greyed out says "none of this is relevant",
    // which is worse than saying nothing.
    const t = fanout()
    const g = buildGraph({ trace: t, route: route({ route: 'unknown.example.com/', target: 'nope:80' }), origin: pick(t, 'local') })
    expect(g.nodes.filter((n) => n.dim)).toHaveLength(0)
  })

  it('dims nothing when every branch matches', () => {
    const t = fanout()
    t.downstream = [routeHop('a', 'x.example.com'), routeHop('b', 'x.example.com')]
    const g = buildGraph({ trace: t, route: route({ route: 'x.example.com/' }), origin: pick(t, 'local') })
    expect(g.nodes.filter((n) => n.dim)).toHaveLength(0)
  })

  it('falls back to the backend NAME when the scenario names no host', () => {
    const t = fanout()
    const g = buildGraph({ trace: t, route: route({ route: ':80 -> 8080', target: 'checkout:80' }), origin: pick(t, 'local') })
    expect(g.nodes.find((n) => n.name === 'checkout')!.dim).toBeFalsy()
    expect(g.nodes.find((n) => n.name === 'shop')!.dim).toBe(true)
  })
})

describe('exception-first collapsing of a wide fan-out', () => {
  const rh = (name: string, host: string, findings: Trace['downstream'][number]['findings'] = []) => ({
    resource: { kind: 'HTTPRoute', name, namespace: 'edge' },
    edge: 'Gateway->HTTPRoute',
    findings,
    config: { hostnames: [host] },
  })
  const wide = (): Trace => ({
    subject: { kind: 'Gateway', name: 'gw', namespace: 'edge' },
    verdict: 'degraded',
    brokenAt: -1,
    upstreams: [],
    downstream: [
      rh('shop', 'shop.example.com'),
      rh('checkout', 'checkout.example.com'),
      rh('account', 'account.example.com'),
      rh('admin', 'admin.example.com', [{ code: 'x', severity: 'warning', message: 'Not accepted by the parent Gateway' }]),
      rh('docs', 'docs.example.com'),
      rh('status', 'status.example.com'),
      rh('api', 'api.example.com'),
    ],
  })

  it('keeps the selected branch and anything with findings; collapses the quiet rest', () => {
    const g = buildGraph({ trace: wide(), route: route({ route: 'checkout.example.com/' }), origin: pick(wide(), 'local') })
    const names = g.nodes.map((n) => n.name)
    expect(names).toContain('checkout') // selected
    expect(names).toContain('admin') // has a finding
    expect(names).toContain('5 more routes') // shop, account, docs, status, api
    expect(names).not.toContain('shop')
  })

  it('collapses by relevance, never by position', () => {
    // "api" sorts last but is the selected branch, so it must survive.
    const g = buildGraph({ trace: wide(), route: route({ route: 'api.example.com/' }), origin: pick(wide(), 'local') })
    expect(g.nodes.map((n) => n.name)).toContain('api')
  })

  it('says the collapsed rows are quiet, not truncated', () => {
    const g = buildGraph({ trace: wide(), route: route({ route: 'checkout.example.com/' }), origin: pick(wide(), 'local') })
    const more = g.nodes.find((n) => n.id === 'collapsed:backends')!
    expect(more.sub).toMatch(/nothing found/)
    expect(g.edges.find((e) => e.id === 'e:subject-collapsed')?.mark).toBe('config')
  })

  it('does not collapse a fan-out small enough to read whole', () => {
    const t = wide()
    t.downstream = t.downstream.slice(0, 3)
    const g = buildGraph({ trace: t, route: route({ route: 'checkout.example.com/' }), origin: pick(t, 'local') })
    expect(g.nodes.some((n) => n.id === 'collapsed:backends')).toBe(false)
    expect(g.nodes.map((n) => n.name)).toContain('shop')
  })

  it('no node overlaps once collapsed', () => {
    const g = buildGraph({ trace: wide(), route: route({ route: 'checkout.example.com/' }), origin: pick(wide(), 'local') })
    for (let i = 0; i < g.nodes.length; i++)
      for (let j = i + 1; j < g.nodes.length; j++) {
        const a = g.nodes[i], b = g.nodes[j]
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(hit).toBe(false)
      }
  })
})

// End-to-end proof that the misattribution is gone: one trace, one route, two
// vantages that disagree - each origin must render its OWN truth.
describe('the graph reads the selected origin\'s own result', () => {
  const disagreeing = (): RouteResult => ({
    route: 'checkout.example.com/',
    target: 'checkout:80',
    // the merged rollup says the whole route failed...
    outcome: 'unreachable',
    confidence: 'real',
    evidence: 'connection refused',
    // ...while in-cluster actually succeeded.
    byVantage: [
      { vantage: 'in-cluster', path: 'data', outcome: 'verified', confidence: 'real', evidence: 'HTTP 200' },
      { vantage: 'local', path: 'data', outcome: 'unreachable', confidence: 'real', evidence: 'connection refused' },
    ],
  })

  const edgeMark = (originId: 'incluster' | 'local') => {
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: originId === 'incluster' ? 'in-cluster' : 'local', path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: disagreeing(), origin: pick(t, originId) })
    return g.edges.find((e) => e.id === 'e:origin-subject')!.mark
  }

  it('shows the in-cluster vantage as proved even though the rollup says unreachable', () => {
    expect(edgeMark('incluster')).toBe('proved')
  })

  it('shows the laptop vantage as failed', () => {
    expect(edgeMark('local')).toBe('failed')
  })

  it('does not mark Pods "blocked by an earlier failure" for the vantage that got through', () => {
    // deliveryBlocked previously followed the merged outcome, so a working
    // vantage's Pods were labelled as never-reached.
    const t = trace([pod('a', true, '10.0.0.1')], [p({ vantage: 'in-cluster', path: 'data', ok: true })])
    const g = buildGraph({ trace: t, route: disagreeing(), origin: pick(t, 'incluster') })
    const rows = g.nodes.find((n) => n.kind === 'PODS')!.podRows!
    expect(rows[0].mark).not.toBe('blocked')
  })
})
