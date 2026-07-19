import { describe, it, expect, beforeEach, vi } from 'vitest'
import { inClusterConsentGiven, rememberInClusterConsent } from './inClusterConsent'

describe('inClusterConsent', () => {
  beforeEach(() => {
    const store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    })
  })

  it('defaults to not-given', () => {
    expect(inClusterConsentGiven('prod')).toBe(false)
  })

  it('remembers consent for a cluster', () => {
    rememberInClusterConsent('prod')
    expect(inClusterConsentGiven('prod')).toBe(true)
  })

  it('is keyed per cluster - consent on one does not grant another', () => {
    rememberInClusterConsent('dev')
    expect(inClusterConsentGiven('dev')).toBe(true)
    expect(inClusterConsentGiven('prod')).toBe(false)
  })

  it('does not throw when localStorage is unavailable, and reports not-given', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    expect(() => rememberInClusterConsent('prod')).not.toThrow()
    expect(inClusterConsentGiven('prod')).toBe(false)
  })
})

// No stable cluster identity → consent is never remembered, in ANY store. A
// persisted fallback key is shared by every cluster a single origin (Radar
// Hub) serves, and even an in-memory session flag is shared across every
// identity-less cluster in the session - either would let one cluster's
// "don't ask again" suppress the pod-creating confirm on all of them. So an
// identity-less run always asks: given() is always false, remember() no-ops.
describe('inClusterConsent without a cluster identity', () => {
  it('never writes to localStorage', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem })
    rememberInClusterConsent(undefined)
    rememberInClusterConsent('')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('never remembers consent - remember() is a no-op and given() stays false', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    expect(inClusterConsentGiven(undefined)).toBe(false)
    rememberInClusterConsent(undefined)
    expect(inClusterConsentGiven(undefined)).toBe(false)
    expect(inClusterConsentGiven('')).toBe(false)
  })

  it('does not read a persisted key when no cluster is known', () => {
    // Even if some earlier version persisted a shared sentinel, an identity-less
    // check must not honor it.
    const store: Record<string, string> = { 'radar.inClusterConsent.current': '1' }
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v },
    })
    expect(inClusterConsentGiven(undefined)).toBe(false)
  })

  it('identity-less remember does not leak into a named cluster', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    rememberInClusterConsent(undefined)
    expect(inClusterConsentGiven('prod')).toBe(false)
  })
})
