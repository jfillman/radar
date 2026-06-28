import { describe, it, expect } from 'vitest'
import { summarizeTrace } from './TraceSummary'
import type { Trace, Coverage, RouteResult } from './types'

const trace = (o: Partial<Trace>): Trace => ({
  subject: { kind: 'Service', namespace: 'prod', name: 'api' },
  upstreams: [], downstream: [], verdict: 'healthy', brokenAt: -1, ...o,
})
const cov = (o: Partial<Coverage>): Coverage => ({ tested: 0, passed: 0, failed: 0, skipped: 0, ...o })
const route = (o: Partial<RouteResult>): RouteResult => ({ route: '/', outcome: 'verified', ...o })

describe('summarizeTrace — the passive drawer glance', () => {
  it('minimal when not probed (static / config-only): invites the run, honesty subtitle, no tone, no worst line', () => {
    const v = summarizeTrace(trace({}))
    expect(v.kind).toBe('minimal')
    expect(v.ctaLabel).toBe('Run reachability test →')
    expect(v.subtitle).toContain('Config check only')
    expect(v.tone).toBeUndefined()
    expect(v.worst).toBeUndefined()
  })

  it('a coverage projection with tested===0 is NOT a probed glance — falls through to config-only (never "not yet tested" headline + "See test detail")', () => {
    const v = summarizeTrace(trace({
      verdict: 'healthy',
      headline: 'Configuration only — not yet tested',
      coverage: cov({ tested: 0, skipped: 1 }),
      notTested: [{}] as Trace['notTested'],
    }))
    expect(v.headline).not.toContain('Configuration only')
    expect(v.ctaLabel).toBe('Run reachability test →')
  })

  it('a config red flag the verdict did NOT escalate (warning finding on a healthy verdict) is surfaced, not swallowed', () => {
    const v = summarizeTrace(trace({
      verdict: 'healthy',
      downstream: [
        { resource: { kind: 'Pods', namespace: 'prod', name: '' }, edge: 'Service->Pods', findings: [
          { code: 'netpol:would-deny', severity: 'warning', message: 'A cluster network rule would block traffic to these pods on :80', cause: 'A NetworkPolicy selects these pods and no rule allows :80' },
        ] },
      ],
    }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('warning')
    expect(v.headline).toContain('network rule')
    expect(v.ctaLabel).toBe('Run reachability test →')
  })

  it('partial failure: warning tone + the worst-offender line + Open Reachability CTA', () => {
    const v = summarizeTrace(trace({
      headline: '1 of 2 routes reachable · 1 unreachable',
      coverage: cov({ tested: 2, passed: 1, failed: 1 }),
      routes: [
        route({ route: '/web', outcome: 'verified', confidence: 'real' }),
        route({ route: '/admin', target: 'admin:9090', outcome: 'unreachable', confidence: 'real', evidence: 'connection refused' }),
      ],
    }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('warning')
    expect(v.worst).toEqual({ route: '/admin', target: 'admin:9090', evidence: 'connection refused', failingCount: 1 })
    expect(v.ctaLabel).toBe('Open Reachability →')
  })

  it('all unreachable (none passed): error tone + worst line', () => {
    const v = summarizeTrace(trace({
      headline: 'None of 1 routes reachable',
      coverage: cov({ tested: 1, passed: 0, failed: 1 }),
      routes: [route({ route: '/', target: 'api:80', outcome: 'unreachable', confidence: 'real', evidence: 'connection refused' })],
    }))
    expect(v.tone).toBe('error')
    expect(v.worst?.route).toBe('/')
    // A single failing route is just "the failing route" — not "worst of N".
    expect(v.worst?.failingCount).toBe(1)
  })

  it('multiple failing routes: failingCount reflects all of them (label becomes "Worst of N")', () => {
    const v = summarizeTrace(trace({
      headline: '1 of 3 routes reachable · 2 unreachable',
      coverage: cov({ tested: 3, passed: 1, failed: 2 }),
      routes: [
        route({ route: '/web', outcome: 'verified', confidence: 'real' }),
        route({ route: '/admin', target: 'admin:9090', outcome: 'unreachable', confidence: 'real', evidence: 'connection refused' }),
        route({ route: '/api', target: 'api:80', outcome: 'server-error', confidence: 'real', evidence: 'HTTP 503' }),
      ],
    }))
    expect(v.worst?.failingCount).toBe(2)
    // Worst-first: unreachable outranks server-error.
    expect(v.worst?.route).toBe('/admin')
  })

  it('healthy verified: calm — success tone, NO worst line, "See test detail" CTA', () => {
    const v = summarizeTrace(trace({
      headline: 'All 1 routes reachable',
      coverage: cov({ tested: 1, passed: 1 }),
      routes: [route({ outcome: 'verified', confidence: 'real' })],
    }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('success')
    expect(v.worst).toBeUndefined()
    expect(v.ctaLabel).toBe('See test detail →')
  })

  it('benign scale-to-0 reads amber and is NEVER surfaced as the worst offender', () => {
    const v = summarizeTrace(trace({
      headline: 'No running backends (scaled to 0)',
      coverage: cov({ tested: 1, passed: 0, failed: 1 }),
      routes: [route({ route: '/', outcome: 'unreachable', benign: true })],
    }))
    expect(v.tone).toBe('warning') // benign → amber, not red
    expect(v.worst).toBeUndefined() // not called out as a failure
  })

  it('surfaces the not-tested count from notTested length', () => {
    const v = summarizeTrace(trace({
      headline: 'All 1 tested routes reachable · 2 not tested',
      coverage: cov({ tested: 1, passed: 1, skipped: 2 }),
      routes: [route({ outcome: 'verified', confidence: 'real' })],
      notTested: [{}, {}] as Trace['notTested'],
    }))
    expect(v.notTested).toBe(2)
  })

  it('static BROKEN (no probes yet) surfaces the diagnosis cause in error tone — never "Configuration only"', () => {
    const v = summarizeTrace(trace({
      verdict: 'broken',
      headline: 'Configuration only — not yet tested',
      diagnosis: { summary: '0/2 selected pods ready' } as Trace['diagnosis'],
    }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('error')
    expect(v.headline).toBe('0/2 selected pods ready')
    expect(v.headline).not.toContain('Configuration only')
    expect(v.ctaLabel).toBe('Run reachability test →')
  })

  it('static DEGRADED (heuristic, no probes) reads amber — not a hard red', () => {
    const v = summarizeTrace(trace({
      verdict: 'degraded',
      headline: 'Configuration only — not yet tested',
      diagnosis: { summary: 'Service targetPort likely wrong' } as Trace['diagnosis'],
    }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('warning')
    expect(v.headline).toBe('Service targetPort likely wrong')
  })

  it('static broken with no diagnosis falls back to a generic cause, still error tone', () => {
    const v = summarizeTrace(trace({ verdict: 'broken' }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('error')
    expect(v.headline).toContain('config check')
  })

  it('clean static (healthy, not probed) describes the path in plain language, never the empty "Configuration only" placeholder', () => {
    const v = summarizeTrace(trace({
      verdict: 'healthy',
      headline: 'Configuration only — not yet tested',
      downstream: [
        { resource: { kind: 'Service', namespace: 'prod', name: 'echo' }, edge: 'entry:Service', findings: [], config: { ports: [{ port: 80, targetPort: '8080' }], hostnames: ['shop.example.com'] } },
        { resource: { kind: 'Pods', namespace: 'prod', name: '' }, edge: 'Service->Pods', findings: [], meta: { ready: 1, selected: 1 } },
      ],
    }))
    expect(v.kind).toBe('minimal')
    expect(v.headline).toContain('shop.example.com')
    expect(v.headline).toContain('1 running pod')
    expect(v.headline).toContain('port 80')
    // No k8s idioms leaking into the plain glance.
    expect(v.headline).not.toContain('→:')
    expect(v.headline).not.toContain('Configuration only')
    expect(v.ctaLabel).toBe('Run reachability test →')
  })

  it('path-owning subject (Ingress) clean+unprobed: NO wiring restatement — "routes to N pods" both repeats the Rules section and overclaims the unverified front door', () => {
    const v = summarizeTrace(trace({
      subject: { kind: 'Ingress', namespace: 'prod', name: 'wild' },
      verdict: 'healthy',
      headline: 'Configuration only — not yet tested',
      downstream: [
        { resource: { kind: 'Service', namespace: 'prod', name: 'echo' }, edge: 'entry:Service', findings: [], config: { ports: [{ port: 80 }], hostnames: ['shop.example.com'] } },
        { resource: { kind: 'Pods', namespace: 'prod', name: '' }, edge: 'Service->Pods', findings: [], meta: { ready: 1, selected: 1 } },
      ],
    }))
    expect(v.kind).toBe('minimal')
    expect(v.headline.toLowerCase()).toContain('not tested')
    // Never asserts the backend wiring as if it were the verified entry.
    expect(v.headline).not.toContain('routes to')
    expect(v.headline).not.toContain('running pod')
    expect(v.headline).not.toContain('shop.example.com')
    expect(v.tone).toBeUndefined()
    expect(v.ctaLabel).toBe('Run reachability test →')
  })

  it('Service subject clean+unprobed STILL gets the wiring glance — no Rules section there, so it is the only place the path appears (not a restatement)', () => {
    const v = summarizeTrace(trace({
      subject: { kind: 'Service', namespace: 'prod', name: 'echo' },
      verdict: 'healthy',
      downstream: [
        { resource: { kind: 'Service', namespace: 'prod', name: 'echo' }, edge: 'entry:Service', findings: [], config: { ports: [{ port: 80 }], hostnames: ['shop.example.com'] } },
        { resource: { kind: 'Pods', namespace: 'prod', name: '' }, edge: 'Service->Pods', findings: [], meta: { ready: 1, selected: 1 } },
      ],
    }))
    expect(v.kind).toBe('minimal')
    expect(v.headline).toContain('shop.example.com')
    expect(v.headline).toContain('1 running pod')
  })

  it('scaled-to-zero (a scale-0 finding backs it) — amber dormant, names "scaled to zero"', () => {
    const v = summarizeTrace(trace({
      verdict: 'healthy',
      downstream: [
        { resource: { kind: 'Service', namespace: 'prod', name: 'echo' }, edge: 'entry:Service', findings: [{ code: 'svc:scaled-to-zero', severity: 'warning', message: 'Backing workload scaled to 0' }], config: { ports: [{ port: 80 }] } },
        { resource: { kind: 'Pods', namespace: 'prod', name: '' }, edge: 'Service->Pods', findings: [], meta: { ready: 0, selected: 0 } },
      ],
    }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('warning')
    // The scale-0 finding leads the glance with its own plain message (amber dormant).
    expect(v.headline.toLowerCase()).toContain('scaled to 0')
  })

  it('0 selected with NO scale-0 finding does NOT fabricate "scaled to zero" — says the selector matched nothing', () => {
    const v = summarizeTrace(trace({
      verdict: 'healthy',
      downstream: [
        { resource: { kind: 'Service', namespace: 'prod', name: 'echo' }, edge: 'entry:Service', findings: [], config: { ports: [{ port: 80 }] } },
        { resource: { kind: 'Pods', namespace: 'prod', name: '' }, edge: 'Service->Pods', findings: [], meta: { ready: 0, selected: 0 } },
      ],
    }))
    expect(v.tone).toBe('warning')
    expect(v.headline).not.toContain('scaled to zero')
    expect(v.headline.toLowerCase()).toContain('selector')
  })

  it('worst finding message (plain) beats a verbose diagnosis.summary in the headline', () => {
    const v = summarizeTrace(trace({
      verdict: 'degraded',
      diagnosis: { summary: 'A NetworkPolicy (np-x) selects these pods and no ingress rule permits :80 from any source. Whether it is actually enforced depends on the cluster network plugin which Radar cannot check from here.' } as Trace['diagnosis'],
      downstream: [
        { resource: { kind: 'Pods', namespace: 'prod', name: '' }, edge: 'Service->Pods', findings: [
          { code: 'netpol:would-deny', severity: 'warning', message: 'A cluster network rule would block traffic to these pods on :80 — no rule allows it.' },
        ] },
      ],
    }))
    expect(v.headline).toBe('A cluster network rule would block traffic to these pods on :80 — no rule allows it.')
    expect(v.headline).not.toContain('NetworkPolicy')
  })

  it('UNKNOWN (RBAC denied / cache not synced) surfaces the uncertainty in neutral info tone — never "Configuration only"', () => {
    const v = summarizeTrace(trace({
      verdict: 'unknown',
      reason: 'RBAC denied: cannot list pods in namespace prod',
      headline: 'Configuration only — not yet tested',
    }))
    expect(v.kind).toBe('glance')
    expect(v.tone).toBe('info')
    expect(v.headline).toBe('RBAC denied: cannot list pods in namespace prod')
    expect(v.headline).not.toContain('Configuration only')
  })
})
