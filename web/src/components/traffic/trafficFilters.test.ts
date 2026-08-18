import { describe, it, expect } from 'vitest'
import { matchesStatusRanges, bucketsFromCounts, bucketsFromStatus, isRateBasedSource, keepAvailable, effectiveThreshold } from './trafficFilters'

describe('matchesStatusRanges', () => {
  it('does not filter when nothing is selected', () => {
    expect(matchesStatusRanges(new Set(), [], false)).toBe(true)
  })

  it('matches an event-based flow on its own status bucket', () => {
    const ranges = new Set(['5xx'])
    expect(matchesStatusRanges(ranges, bucketsFromStatus(503), false)).toBe(true)
    expect(matchesStatusRanges(ranges, bucketsFromStatus(200), false)).toBe(false)
  })

  it('matches an aggregate on the buckets it actually reports', () => {
    const counts = { '2xx': 40, '5xx': 3 }
    expect(matchesStatusRanges(new Set(['5xx']), bucketsFromCounts(counts), false)).toBe(true)
    expect(matchesStatusRanges(new Set(['4xx']), bucketsFromCounts(counts), false)).toBe(false)
  })

  it('ignores a bucket present but zero', () => {
    expect(matchesStatusRanges(new Set(['5xx']), bucketsFromCounts({ '5xx': 0 }), false)).toBe(false)
  })

  // The load-bearing case. A rate-based source measures a 5xx rate rather than
  // observing individual responses, so it has no status code and no bucket. The
  // filter used to require one, which hid exactly the failing traffic the user
  // had asked to see.
  it('finds a failing edge that reports an error signal but no status', () => {
    expect(matchesStatusRanges(new Set(['5xx']), [], true)).toBe(true)
    expect(matchesStatusRanges(new Set(['5xx']), bucketsFromStatus(undefined), true)).toBe(true)
    expect(matchesStatusRanges(new Set(['5xx']), bucketsFromCounts(undefined), true)).toBe(true)
  })

  it('does not let an error signal satisfy a non-5xx selection', () => {
    expect(matchesStatusRanges(new Set(['2xx']), [], true)).toBe(false)
    expect(matchesStatusRanges(new Set(['4xx']), [], true)).toBe(false)
  })

  it('still matches a selected bucket when there are no errors', () => {
    expect(matchesStatusRanges(new Set(['2xx', '5xx']), bucketsFromStatus(204), false)).toBe(true)
  })
})

describe('isRateBasedSource', () => {
  it('knows which sources report rates rather than counts', () => {
    expect(isRateBasedSource('beyla')).toBe(true)
    expect(isRateBasedSource('istio')).toBe(true)
    expect(isRateBasedSource('hubble')).toBe(false)
    expect(isRateBasedSource('caretta')).toBe(false)
    expect(isRateBasedSource(undefined)).toBe(false)
    expect(isRateBasedSource('')).toBe(false)
  })
})

describe('keepAvailable', () => {
  it('drops a choice whose control is no longer offered', () => {
    // The button is gone, so the selection must stop filtering — otherwise the map
    // goes blank with nothing left to clear.
    expect(keepAvailable(new Set(['5xx']), [])).toEqual(new Set())
    expect(keepAvailable(new Set(['2xx', '5xx']), ['5xx'])).toEqual(new Set(['5xx']))
  })

  it('leaves an empty selection alone', () => {
    expect(keepAvailable(new Set(), ['5xx'])).toEqual(new Set())
  })

  it('keeps everything still on offer', () => {
    expect(keepAvailable(new Set(['GET', 'POST']), ['GET', 'POST', 'PUT'])).toEqual(new Set(['GET', 'POST']))
  })
})

describe('effectiveThreshold', () => {
  it('keeps a threshold the active source actually offers', () => {
    expect(effectiveThreshold(100, false)).toBe(100)
    expect(effectiveThreshold(10, true)).toBe(10)
    expect(effectiveThreshold(0, true)).toBe(0)
  })

  it('drops one carried over from the other unit', () => {
    // 10000 connections against a rate source hides every edge; 1 req/s against a
    // counting source is not even selectable.
    expect(effectiveThreshold(10000, true)).toBe(0)
    expect(effectiveThreshold(1, false)).toBe(0)
  })
})
