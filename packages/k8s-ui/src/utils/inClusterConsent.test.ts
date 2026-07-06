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
