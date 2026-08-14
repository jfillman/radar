import { isForbiddenError } from '../../../types/fetch-error'

interface LookupFailureNoteProps {
  /** The failed queries. Nulls and undefineds are ignored, so callers can pass
   *  `[a.error, b.error, c.error]` straight from their hooks. */
  errors: unknown[]
  /** What could not be checked, as the tail of a sentence: "which clusters use
   *  this store", "what replicates out of this database". */
  what: string
  /** True when rows are already on screen. The failure then means the list is
   *  short rather than absent, and saying "could not check" over a populated
   *  list reads as though nothing was found. */
  incomplete?: boolean
}

/**
 * A reverse lookup that did not come back.
 *
 * Sections that answer "what else points at this object" run one query per kind
 * and then have three outcomes to tell apart: the list is genuinely empty, the
 * caller may not read it, or the fetch failed. Collapsing any two of those
 * states reports an absence that was never established — the same mistake
 * RBACErrorSection exists to prevent, one screen over.
 *
 * The split is the same as that component's, and for the same reason: being
 * unable to see something is an expected, non-actionable state and reads as a
 * calm note, while a genuine fault stays loud. Both use `isForbiddenError` so
 * "what counts as unavailable" has one definition across the two.
 *
 * A partially-failed lookup is the case most easily lost: when one query of
 * three fails and the others return rows, the section still has content to
 * render, and a count drawn from what survived is smaller than the truth.
 * `incomplete` is what keeps that count from reading as exact.
 */
export function LookupFailureNote({ errors, what, incomplete }: LookupFailureNoteProps) {
  const real = errors.filter(Boolean)
  if (real.length === 0) return null

  // Any forbidden among them makes this a permission answer: the fetch worked,
  // the caller is not allowed the data. A genuine fault alongside it still wins,
  // because that one is actionable and this one is not.
  const fault = real.find((e) => !isForbiddenError(e))
  if (!fault) {
    return (
      <div className="text-xs text-theme-text-tertiary">
        {incomplete
          ? `This may be incomplete: you don’t have permission to check ${what}.`
          : `You don’t have permission to check ${what}.`}
      </div>
    )
  }

  const message = fault instanceof Error ? fault.message : String(fault)
  return (
    <div className="text-xs text-red-400">
      {incomplete
        ? `This may be incomplete — could not check ${what}: ${message}`
        : `Could not check ${what}: ${message}`}
    </div>
  )
}
