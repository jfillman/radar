import { describe, it, expect } from 'vitest'
import { pillState } from './ReachabilityExplainer'
import type { ProbeResult } from './types'

const p = (o: Partial<ProbeResult>): ProbeResult => ({ layer: 'http', target: 'svc:80', vantage: 'local', ok: true, ...o })

describe('pillState (reachability matrix cell)', () => {
  it('an HTTP 2xx is "Verified"/healthy with its code', () => {
    const s = pillState(p({ layer: 'http', ok: true, tone: 'healthy', detail: 'HTTP 200' }), {})
    expect(s.label).toBe('Verified')
    expect(s.tone).toBe('healthy')
    expect(s.code).toBe('200')
  })

  it('an HTTP 3xx/4xx is "Reached"/neutral, never "Verified"', () => {
    const s = pillState(p({ layer: 'http', ok: true, tone: 'reached', detail: 'HTTP 404' }), {})
    expect(s.label).toBe('Reached')
    expect(s.tone).toBe('neutral')
    expect(s.code).toBe('404')
  })

  it('a TCP-only success is "Port reachable"/neutral, NOT "Verified" (port accepts, serves unknown)', () => {
    const s = pillState(p({ layer: 'tcp', ok: true, detail: 'connected' }), {})
    expect(s.label).toBe('Port reachable')
    expect(s.tone).toBe('neutral')
    expect(s.code).toBeUndefined()
  })

  it('a TLS-only success is "Port reachable"/neutral', () => {
    const s = pillState(p({ layer: 'tls', ok: true, detail: 'valid' }), {})
    expect(s.label).toBe('Port reachable')
    expect(s.tone).toBe('neutral')
  })

  it('a 5xx is "Degraded"', () => {
    const s = pillState(p({ layer: 'http', ok: true, tone: 'degraded', detail: 'HTTP 503' }), {})
    expect(s.label).toBe('Degraded')
    expect(s.tone).toBe('degraded')
  })

  it('a transport failure is "Unreachable"', () => {
    const s = pillState(p({ layer: 'tcp', ok: false, tone: 'unhealthy', error: 'connection refused' }), {})
    expect(s.label).toBe('Unreachable')
    expect(s.tone).toBe('unhealthy')
  })

  it('a skipped probe is "Not tested"/muted', () => {
    const s = pillState(p({ skipped: true, ok: false, reason: 'HTTPS - needs a direct test' }), {})
    expect(s.label).toBe('Not tested')
    expect(s.muted).toBe(true)
  })

  it('an absent probe is "Not tested"/muted', () => {
    const s = pillState(undefined, {})
    expect(s.label).toBe('Not tested')
    expect(s.muted).toBe(true)
  })

  it('an entry host in a non-direct column is "n/a"/muted', () => {
    const s = pillState(undefined, { naEntry: true })
    expect(s.label).toBe('n/a')
    expect(s.muted).toBe(true)
  })
})
