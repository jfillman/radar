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
