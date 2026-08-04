import { describe, it, expect } from 'vitest'
import { routeMark, routeTone, routeChip, worstMark, orderRoutes, scenariosFor, isSlow, formatLatency, MARKS } from './reachMarks'
import type { RouteResult, Hop } from './types'

const r = (o: Partial<RouteResult>): RouteResult => ({ route: 'GET /', outcome: 'verified', ...o })

describe('routeMark', () => {
  it('only real-traffic evidence is ever proved', () => {
    expect(routeMark(r({ outcome: 'verified', confidence: 'real' }))).toBe('proved')
    // An apiserver relay bypasses kube-proxy, NetworkPolicy and the mesh, so a
    // clean response through it can never be proof of the real path.
    expect(routeMark(r({ outcome: 'verified', confidence: 'indirect' }))).toBe('proxied')
  })

  it('a proxy-only failure never condemns the real path', () => {
    expect(routeMark(r({ outcome: 'unreachable', confidence: 'indirect' }))).not.toBe('failed')
    expect(routeMark(r({ outcome: 'unreachable', confidence: 'real' }))).toBe('failed')
  })

  it('a deliberate scale-to-zero is excluded, not failed', () => {
    expect(routeMark(r({ outcome: 'unreachable', confidence: 'real', benign: true }))).toBe('excluded')
  })

  it('reached is weaker than verified', () => {
    expect(routeMark(r({ outcome: 'reached', confidence: 'real' }))).toBe('answered')
  })

  it('running and stale override the outcome', () => {
    expect(routeMark(r({ outcome: 'verified', confidence: 'real' }), { running: true })).toBe('running')
    expect(routeMark(r({ outcome: 'verified', confidence: 'real' }), { stale: true })).toBe('stale')
  })

  it('not-tested is untested, never a failure', () => {
    expect(routeMark(r({ outcome: 'not-tested' }))).toBe('untested')
  })
})

describe('routeTone', () => {
  it('indirect verified is never green', () => {
    expect(routeTone(r({ outcome: 'verified', confidence: 'indirect' }))).toBe('degraded')
    expect(routeTone(r({ outcome: 'verified', confidence: 'real' }))).toBe('healthy')
  })

  it('not-tested is never red', () => {
    expect(routeTone(r({ outcome: 'not-tested' }))).toBe('unknown')
  })

  it('benign and indirect unreachables stay amber', () => {
    expect(routeTone(r({ outcome: 'unreachable', benign: true, confidence: 'real' }))).toBe('degraded')
    expect(routeTone(r({ outcome: 'unreachable', confidence: 'indirect' }))).toBe('degraded')
    expect(routeTone(r({ outcome: 'unreachable', confidence: 'real' }))).toBe('unhealthy')
  })
})

describe('routeChip', () => {
  it('names the caveat rather than claiming verification', () => {
    // Asserts the meaning: an indirect result must say it skipped the real path.
    expect(routeChip(r({ outcome: 'verified', confidence: 'indirect' }))).toMatch(/skipped/i)
    expect(routeChip(r({ outcome: 'verified', confidence: 'real' }))).toBe('got through')
  })
})

describe('worstMark', () => {
  it('a failure survives aggregation with any number of successes', () => {
    expect(worstMark(['proved', 'proved', 'failed', 'proved'])).toBe('failed')
  })

  it('an empty aggregate is untested, not healthy', () => {
    expect(worstMark([])).toBe('untested')
  })

  it('untested outranks proved so a partial sample never reads complete', () => {
    expect(worstMark(['proved', 'untested'])).toBe('untested')
  })
})

describe('orderRoutes', () => {
  it('leads with the worst outcome', () => {
    const out = orderRoutes([r({ route: 'a', outcome: 'verified' }), r({ route: 'b', outcome: 'unreachable' }), r({ route: 'c', outcome: 'not-tested' })])
    expect(out.map((x) => x.route)).toEqual(['b', 'c', 'a'])
  })
})

describe('marks vocabulary', () => {
  it('only proved and failed draw solid — everything softer must be dashed', () => {
    for (const [name, style] of Object.entries(MARKS)) {
      if (name === 'proved' || name === 'failed') expect(style.dash).toBe('none')
      else expect(style.dash).not.toBe('none')
    }
  })
})

describe('latency', () => {
  it('flags pathological latency only', () => {
    expect(isSlow({ layer: 'http', target: 't', vantage: 'local', ok: true, latencyNs: 11_000_000 })).toBe(false)
    expect(isSlow({ layer: 'http', target: 't', vantage: 'local', ok: true, latencyNs: 1_900_000_000 })).toBe(true)
  })

  it('formats across unit boundaries', () => {
    expect(formatLatency(11_000_000)).toBe('11 ms')
    expect(formatLatency(1_900_000_000)).toBe('1.9 s')
    expect(formatLatency(undefined)).toBe('')
  })
})

describe('scenariosFor', () => {
  const r2 = (o: Partial<RouteResult>): RouteResult => ({ route: 'h/', outcome: 'verified', ...o })

  it('folds routes that agree in every respect into one scenario', () => {
    // A Gateway route with three hostnames and one backend is one situation
    // with three front doors, not three situations.
    const s = scenariosFor(
      [
        r2({ route: 'a.example.com/', target: 'svc:8080', outcome: 'reached', confidence: 'indirect' }),
        r2({ route: 'b.example.com/', target: 'svc:8080', outcome: 'reached', confidence: 'indirect' }),
        r2({ route: 'c.example.com/', target: 'svc:8080', outcome: 'reached', confidence: 'indirect' }),
      ],
      [],
    )
    expect(s).toHaveLength(1)
    expect(s[0].hosts).toEqual(['a.example.com', 'b.example.com', 'c.example.com'])
    expect(s[0].sub).toMatch(/3 hostnames/)
  })

  it('keeps a host that behaves differently in its own scenario', () => {
    const s = scenariosFor(
      [
        r2({ route: 'a.example.com/', target: 'svc:8080', outcome: 'verified', confidence: 'real' }),
        r2({ route: 'b.example.com/', target: 'svc:8080', outcome: 'unreachable', confidence: 'real' }),
      ],
      [],
    )
    expect(s).toHaveLength(2)
    // Worst first, so the failure leads.
    expect(s[0].primary.outcome).toBe('unreachable')
  })

  it('separates different backends even when the outcome matches', () => {
    const s = scenariosFor(
      [r2({ route: 'a/', target: 'svc:80', outcome: 'verified' }), r2({ route: 'b/', target: 'svc:9090', outcome: 'verified' })],
      [],
    )
    expect(s).toHaveLength(2)
  })

  it('surfaces untested routes as scenarios — otherwise an unprobed resource shows no paths at all', () => {
    const s = scenariosFor([], [{ route: 'a.example.com/', reason: 'route not actively tested' }])
    expect(s).toHaveLength(1)
    expect(s[0].primary.outcome).toBe('not-tested')
  })

  it('keeps untested routes apart when their reasons differ', () => {
    // "port 443 can't be verified through the proxy" and "port 80 timed out"
    // are different situations, even though both are merely not-tested.
    const s = scenariosFor([], [
      { route: 'port 80', reason: 'the backend did not respond within the probe budget' },
      { route: 'port 443', reason: 'HTTPS backend - the API-server proxy speaks plain HTTP' },
    ])
    expect(s).toHaveLength(2)
    expect(s.map((x) => x.label).sort()).toEqual(['port 443', 'port 80'])
  })

  it('still folds untested routes that share one reason', () => {
    const s = scenariosFor([], [
      { route: 'a.example.com/', reason: 'route not actively tested' },
      { route: 'b.example.com/', reason: 'route not actively tested' },
    ])
    expect(s).toHaveLength(1)
  })

  it('gives a scenario a key that survives re-sorting', () => {
    // The strip is sorted worst-first, so a re-run that changes an outcome
    // re-orders it. Selection is stored by key precisely because a positional
    // index would silently move the user to a different path.
    const before = scenariosFor(
      [r2({ route: 'a/', target: 'svc:80', outcome: 'unreachable', confidence: 'real' }), r2({ route: 'b/', target: 'svc:90', outcome: 'verified', confidence: 'real' })],
      [],
    )
    expect(before[0].primary.target).toBe('svc:80')
    const bKey = before[1].key

    // Outcomes swap on the next run; worst-first now puts svc:90 first.
    const after = scenariosFor(
      [r2({ route: 'a/', target: 'svc:80', outcome: 'verified', confidence: 'real' }), r2({ route: 'b/', target: 'svc:90', outcome: 'unreachable', confidence: 'real' })],
      [],
    )
    expect(after[0].primary.target).toBe('svc:90')
    // The old index 1 now points at a different scenario - which is why the key,
    // not the index, is what selection must be stored by.
    expect(after[1].key).not.toBe(bKey)
    expect(new Set(after.map((x) => x.key)).size).toBe(after.length)
  })

  it('uses the single route label verbatim when nothing was grouped', () => {
    const s = scenariosFor([r2({ route: 'only.example.com/', target: 'svc:80' })], [])
    expect(s[0].label).toBe('only.example.com/')
  })

  const gw = (name: string, ...hostnames: string[]): Hop => ({
    resource: { kind: 'Gateway', namespace: 'infra', name },
    edge: 'routes',
    findings: [],
    config: { hostnames },
  })

  it('splits two hosts that reach the same backend through DIFFERENT front doors', () => {
    // One Gateway can be broken while its sibling is fine. Folding them behind a
    // shared verdict hides exactly the difference worth debugging.
    const s = scenariosFor(
      [
        r2({ route: 'a.example.com/', target: 'svc:8080', outcome: 'verified', confidence: 'real' }),
        r2({ route: 'b.example.com/', target: 'svc:8080', outcome: 'verified', confidence: 'real' }),
      ],
      [],
      [gw('public-gw', 'a.example.com'), gw('internal-gw', 'b.example.com')],
    )
    expect(s).toHaveLength(2)
    expect(s.map((x) => x.entry).sort()).toEqual(['internal-gw', 'public-gw'])
    expect(s[0].sub).toMatch(/via /)
  })

  it('still folds hosts that share one front door', () => {
    const s = scenariosFor(
      [
        r2({ route: 'a.example.com/', target: 'svc:8080', outcome: 'verified', confidence: 'real' }),
        r2({ route: 'b.example.com/', target: 'svc:8080', outcome: 'verified', confidence: 'real' }),
      ],
      [],
      [gw('public-gw', 'a.example.com', 'b.example.com')],
    )
    expect(s).toHaveLength(1)
    expect(s[0].entry).toBe('public-gw')
  })

  it('does not invent a front door when no upstream serves the host', () => {
    const s = scenariosFor([r2({ route: 'a.example.com/', target: 'svc:80' })], [], [gw('other-gw', 'z.example.com')])
    expect(s[0].entry).toBeUndefined()
    expect(s[0].sub).not.toMatch(/via /)
  })
})
