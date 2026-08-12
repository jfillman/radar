// Per-resource policy findings, from GET /api/policy/resource/{kind}/{ns}/{name}.
//
// The coverage fields are not decoration. An empty `findings` array means one of
// several very different things — nothing violated, no engine installed, the
// caller may not read the reports, the index is still warming — and a section
// that renders all of them as blank space tells an operator they are compliant
// in the cases where we simply do not know.

export type PolicyResult = 'pass' | 'fail' | 'warn' | 'error' | 'skip' | string

export interface PolicyResourceFinding {
  policy: string
  rule?: string
  result: PolicyResult
  severity?: string
  category?: string
  message?: string
  engine?: string
}

export interface PolicyResourceCounts {
  pass: number
  fail: number
  warn: number
  error: number
  skip: number
}

export interface PolicyResourceResponse {
  /** False whenever the answer is "we could not check". Never treat an empty
   *  findings array as "clean" without consulting this first. */
  evaluated: boolean
  status: string
  reasonCode?: string
  /** Report families the caller could not read. Present even when evaluated:
   *  the answer is real but incomplete. */
  deniedGroups?: string[]
  /** False when the index is frozen at its initial contents. */
  liveUpdates: boolean
  counts: PolicyResourceCounts
  findings: PolicyResourceFinding[]
}
