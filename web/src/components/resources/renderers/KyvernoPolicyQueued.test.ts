import { describe, it, expect } from 'vitest'
import { requestBelongsTo } from './KyvernoPolicyQueued'

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
