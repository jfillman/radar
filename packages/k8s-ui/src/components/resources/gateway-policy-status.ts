import type { GenericStatus } from './generic-status'

/**
 * Gateway API policy attachment (GEP-713) reports status per *ancestor*, at
 * `status.ancestors[].conditions`, not at `status.conditions` — so the generic
 * ladder finds nothing and these kinds render "-".
 *
 * The shape is shared by every policy implementation: Gateway API's own
 * BackendTLSPolicy and BackendLBPolicy, Envoy Gateway's SecurityPolicy /
 * ClientTrafficPolicy / BackendTrafficPolicy / EnvoyPatchPolicy /
 * EnvoyExtensionPolicy, and GKE's GCPBackendPolicy family. Dispatching on the
 * shape rather than on a list of kinds means a policy from an implementation
 * Radar has never heard of reads correctly too.
 *
 * Kept separate from the generic ladder rather than folded into it, because the
 * ladder resolves positive conditions before negative ones and that order is
 * wrong here: a policy is routinely `Accepted=True` *and* `Programmed=False`,
 * which means the controller took ownership and then failed to apply it. Read
 * positives-first, that object is healthy; it is not.
 */

/** Conditions that describe whether the policy took effect. */
const EFFECT_CONDITIONS = ['Accepted', 'Programmed'] as const

/** Conditions that mean trouble when True, mirroring the generic ladder's set. */
const NEGATIVE_CONDITIONS = new Set(['Degraded', 'Warning'])

function conditionsOf(ancestor: any): any[] {
  return Array.isArray(ancestor?.conditions) ? ancestor.conditions : []
}

function problemText(cond: any): string {
  const reason = typeof cond?.reason === 'string' ? cond.reason.trim() : ''
  if (reason) return reason
  const type = typeof cond?.type === 'string' ? cond.type.trim() : ''
  return type ? `Not ${type}` : 'Failed'
}

/** True when the object carries a Gateway API PolicyStatus. */
export function hasGatewayPolicyStatus(resource: any): boolean {
  return Array.isArray(resource?.status?.ancestors)
}

/**
 * Status for one policy, aggregated across the Gateways it attaches to.
 *
 * A policy may attach to several ancestors with different outcomes, so a
 * failure anywhere wins and the count says how widespread it is — collapsing to
 * a bare "Accepted" would hide the Gateway that rejected it.
 */
export function getGatewayPolicyStatus(resource: any): GenericStatus | null {
  const ancestors = resource?.status?.ancestors
  if (!Array.isArray(ancestors)) return null

  // Distinct from an unset status: the controller published a PolicyStatus and
  // said this policy applies to nothing. Reported as text without a health
  // claim, because "not attached" and "not reconciled yet" look identical here.
  if (ancestors.length === 0) return { text: 'No ancestors', tone: 'unknown' }

  let failed = 0
  let degraded = 0
  let accepted = 0
  let problem: { text: string; reason?: string } | null = null

  for (const ancestor of ancestors) {
    const conditions = conditionsOf(ancestor)

    const broken = conditions.find(
      (c: any) => EFFECT_CONDITIONS.includes(c?.type) && c?.status === 'False',
    )
    if (broken) {
      failed++
      problem ??= { text: problemText(broken), reason: broken?.message }
      continue
    }

    const warned = conditions.find((c: any) => NEGATIVE_CONDITIONS.has(c?.type) && c?.status === 'True')
    if (warned) {
      degraded++
      problem ??= { text: problemText(warned), reason: warned?.message }
      continue
    }

    if (conditions.some((c: any) => c?.type === 'Accepted' && c?.status === 'True')) accepted++
  }

  const total = ancestors.length
  const scope = (n: number) => (total > 1 ? ` (${n}/${total})` : '')

  if (failed > 0 && problem) {
    return { text: `${problem.text}${scope(failed)}`, tone: 'unhealthy', reason: problem.reason }
  }
  if (degraded > 0 && problem) {
    return { text: `${problem.text}${scope(degraded)}`, tone: 'degraded', reason: problem.reason }
  }
  if (accepted === total) return { text: 'Accepted', tone: 'healthy' }

  // Some ancestor published neither an outcome nor a failure — the controller
  // has seen the policy but not finished with it.
  return { text: `Pending${scope(total - accepted)}`, tone: 'degraded' }
}
