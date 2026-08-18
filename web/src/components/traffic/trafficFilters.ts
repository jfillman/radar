/**
 * Does a flow fall into one of the selected HTTP status ranges?
 *
 * Shared by the graph's aggregated filter and the flow list's per-row filter.
 * They read different fields — one has a bucket histogram and an error count, the
 * other a single status code and an error rate — but the rule has to be the same,
 * and keeping it in one place is what stops the two from drifting apart.
 *
 * `hasErrors` exists because a rate-based source (Beyla, Istio) measures a 5xx
 * rate rather than observing individual responses. It has no status code to offer
 * and no bucket to match, so a filter that insists on one hides precisely the
 * traffic the user asked to see.
 *
 * @param ranges  selected buckets, e.g. {"2xx", "5xx"}; empty means no filtering
 * @param buckets buckets this flow actually reports
 * @param hasErrors whether the flow carries a non-zero error signal
 */
export function matchesStatusRanges(
  ranges: Set<string>,
  buckets: string[],
  hasErrors: boolean
): boolean {
  if (ranges.size === 0) return true
  if (ranges.has('5xx') && hasErrors) return true
  return buckets.some(b => ranges.has(b))
}

/** Buckets an aggregated flow reports, from its status histogram. */
export function bucketsFromCounts(counts: Record<string, number> | undefined): string[] {
  if (!counts) return []
  return Object.keys(counts).filter(k => (counts[k] ?? 0) > 0)
}

/** The single bucket a raw flow reports, if it carries a status code at all. */
export function bucketsFromStatus(httpStatus: number | undefined): string[] {
  if (!httpStatus) return []
  return [`${Math.floor(httpStatus / 100)}xx`]
}

/**
 * Does this source measure rates rather than counting individual events?
 *
 * Beyla and Istio read counters out of Prometheus, so what they report per edge is
 * a per-second rate: "connections" is really requests per second, and the error
 * count is errors per second. Hubble and Caretta observe individual flows and
 * report genuine counts. The distinction changes units, labels and the sensible
 * scale of a volume filter, so it lives in one place rather than being re-derived
 * wherever it is needed.
 */
export function isRateBasedSource(source: string | undefined): boolean {
  return source === 'istio' || source === 'beyla'
}

/**
 * Narrow a set of chosen filter values to the ones still offered.
 *
 * The filter controls are built from what the flows actually contain, so a choice
 * can outlive its button: pick 5xx, let the errors stop, and the toggle disappears
 * while the selection keeps filtering — a blank map with nothing left to clear it.
 * Applying the intersection at the point of use rather than editing the stored
 * selection means the choice is ignored while it is unavailable and takes effect
 * again by itself if the traffic comes back.
 */
export function keepAvailable(selected: Set<string>, available: string[]): Set<string> {
  if (selected.size === 0) return selected
  const offered = new Set(available)
  const kept = new Set<string>()
  for (const value of selected) {
    if (offered.has(value)) kept.add(value)
  }
  return kept
}

/** Volume-filter steps for a source that counts events. */
export const CONNECTION_THRESHOLDS = [
  { value: 0, label: 'All traffic' },
  { value: 100, label: '100+ connections' },
  { value: 1000, label: '1K+ connections' },
  { value: 10000, label: '10K+ connections' },
  { value: 100000, label: '100K+ connections' },
]

/**
 * Volume-filter steps for a source that measures rates. Both the unit and the
 * scale differ: a busy service runs at single-digit requests per second, so the
 * connection steps above would filter the whole map away.
 */
export const RATE_THRESHOLDS = [
  { value: 0, label: 'All traffic' },
  { value: 1, label: '1+ req/s' },
  { value: 10, label: '10+ req/s' },
  { value: 100, label: '100+ req/s' },
  { value: 1000, label: '1K+ req/s' },
]

export function volumeThresholds(isRateBased: boolean | undefined) {
  return isRateBased ? RATE_THRESHOLDS : CONNECTION_THRESHOLDS
}

/**
 * A threshold chosen against one source's scale is meaningless against the other's
 * — 10000 connections carried over to a rate source hides every edge, and 1 req/s
 * carried the other way is not even an option the dropdown can show as selected.
 * Falls back to no filtering rather than to some nearest neighbour, because the
 * unit changed and there is no honest translation.
 */
export function effectiveThreshold(value: number, isRateBased: boolean | undefined): number {
  return volumeThresholds(isRateBased).some(t => t.value === value) ? value : 0
}
