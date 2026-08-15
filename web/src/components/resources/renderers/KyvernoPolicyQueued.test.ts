import { describe, it, expect } from 'vitest'
import { queueBannerTitle, requestBelongsTo } from './KyvernoPolicyQueued'

/**
 * Kyverno permits a namespaced Policy and a ClusterPolicy to share a name, and
 * records the first qualified and the second bare. Accepting the bare form as a
 * fallback for a namespaced policy shows it someone else's backlog — the same
 * collision the coverage lookup refuses, reintroduced here once already.
 */
describe('requestBelongsTo', () => {
  const req = (policy: string) => ({ spec: { policy } })

  it('matches a cluster-scoped policy on the bare name only', () => {
    expect(requestBelongsTo(req('require-labels'), 'require-labels', '')).toBe(true)
    expect(requestBelongsTo(req('team-a/require-labels'), 'require-labels', '')).toBe(false)
  })

  it('matches a namespaced policy on the qualified name only', () => {
    expect(requestBelongsTo(req('team-a/require-labels'), 'require-labels', 'team-a')).toBe(true)
    // The bug: this is a ClusterPolicy's request and must not appear here.
    expect(requestBelongsTo(req('require-labels'), 'require-labels', 'team-a')).toBe(false)
  })

  it('does not match another namespace', () => {
    expect(requestBelongsTo(req('team-b/require-labels'), 'require-labels', 'team-a')).toBe(false)
  })

  it('matches nothing when either side is missing', () => {
    expect(requestBelongsTo({}, 'require-labels', '')).toBe(false)
    expect(requestBelongsTo(req('require-labels'), '', '')).toBe(false)
  })
})

/**
 * The banner is the only thing on this page that makes a claim rather than a
 * count, so the claim has to be the one the numbers support.
 */
describe('queueBannerTitle', () => {
  it('says work stopped only when something has actually sat still', () => {
    expect(queueBannerTitle(3, 12, '12m')).toBe('Queued work has not moved for 12m')
  })

  // The bug: this branch fires when NOTHING is older than the stall threshold,
  // which is the case most likely to be a burst draining normally.
  it('does not tell you a moving backlog is not being processed', () => {
    const title = queueBannerTitle(30, 1, '1m')
    expect(title).toBe('30 requests are queued')
    expect(title).not.toContain('not being processed')
  })

  it('stays quiet for a queue doing what a queue does', () => {
    expect(queueBannerTitle(3, 1, '1m')).toBeNull()
    expect(queueBannerTitle(0, 0, '')).toBeNull()
  })

  it('prefers the measured stall over the size when both apply', () => {
    expect(queueBannerTitle(40, 30, '30m')).toContain('has not moved')
  })
})
