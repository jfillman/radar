import { describe, expect, it } from 'vitest'
import { getGatewayPolicyStatus, hasGatewayPolicyStatus } from './gateway-policy-status'
import { getGenericResourceStatus } from './generic-status'

const cond = (type: string, status: string, reason?: string, message?: string) => ({ type, status, reason, message })
const policy = (...ancestors: any[]) => ({ status: { ancestors } })
const anc = (...conditions: any[]) => ({ ancestorRef: { kind: 'Gateway', name: 'gw' }, conditions })

describe('Gateway API PolicyStatus', () => {
  // Taken from a live EnvoyPatchPolicy. The controller accepted the policy and
  // then could not apply it. Read positives-first — the way the generic ladder
  // resolves conditions — this object is healthy, which is the whole reason it
  // gets its own reader.
  it('reports the failure on a policy that was accepted and then not applied', () => {
    const p = policy(anc(cond('Accepted', 'True', 'Accepted'), cond('Programmed', 'False', 'ResourceNotFound')))
    expect(getGatewayPolicyStatus(p)).toMatchObject({ text: 'ResourceNotFound', tone: 'unhealthy' })
  })

  it('reports a plain accepted policy as healthy', () => {
    expect(getGatewayPolicyStatus(policy(anc(cond('Accepted', 'True', 'Accepted')))))
      .toMatchObject({ text: 'Accepted', tone: 'healthy' })
  })

  it('reports a rejected policy with the controller reason', () => {
    expect(getGatewayPolicyStatus(policy(anc(cond('Accepted', 'False', 'Conflicted')))))
      .toMatchObject({ text: 'Conflicted', tone: 'unhealthy' })
  })

  it('falls back to the condition type when the controller gave no reason', () => {
    expect(getGatewayPolicyStatus(policy(anc(cond('Accepted', 'False')))))
      .toMatchObject({ text: 'Not Accepted', tone: 'unhealthy' })
  })

  // Envoy Gateway publishes this combination. A positives-first read returns
  // healthy and the warning never surfaces.
  it('does not let an accepted policy hide a warning', () => {
    const p = policy(anc(cond('Accepted', 'True'), cond('Warning', 'True', 'ShadowedRules')))
    expect(getGatewayPolicyStatus(p)).toMatchObject({ text: 'ShadowedRules', tone: 'degraded' })
  })

  it('carries the controller message as the tooltip reason', () => {
    const p = policy(anc(cond('Accepted', 'False', 'Invalid', 'spec.targetRef.kind is not supported')))
    expect(getGatewayPolicyStatus(p)?.reason).toBe('spec.targetRef.kind is not supported')
  })
})

describe('aggregating across ancestors', () => {
  // A policy may attach to several Gateways with different outcomes. Collapsing
  // to a bare "Accepted" would hide the one that rejected it.
  it('reports a failure anywhere, and how widespread it is', () => {
    const p = policy(
      anc(cond('Accepted', 'True')),
      anc(cond('Accepted', 'False', 'NotAllowed')),
      anc(cond('Accepted', 'True')),
    )
    expect(getGatewayPolicyStatus(p)).toMatchObject({ text: 'NotAllowed (1/3)', tone: 'unhealthy' })
  })

  it('does not add a count when the policy attaches to one ancestor', () => {
    expect(getGatewayPolicyStatus(policy(anc(cond('Accepted', 'False', 'NotAllowed'))))?.text)
      .toBe('NotAllowed')
  })

  // Absence is not acceptance: an ancestor the controller has not answered for
  // must not be counted as healthy just because its sibling was.
  it('does not read an ancestor with no verdict as accepted', () => {
    const p = policy(anc(cond('Accepted', 'True')), anc())
    expect(getGatewayPolicyStatus(p)).toMatchObject({ text: 'Pending (1/2)', tone: 'degraded' })
  })

  it('treats Unknown as undecided rather than as failure', () => {
    const p = policy(anc(cond('Accepted', 'Unknown', 'Pending')))
    expect(getGatewayPolicyStatus(p)).toMatchObject({ tone: 'degraded' })
  })

  it('is healthy only when every ancestor accepted', () => {
    expect(getGatewayPolicyStatus(policy(anc(cond('Accepted', 'True')), anc(cond('Accepted', 'True')))))
      .toMatchObject({ text: 'Accepted', tone: 'healthy' })
  })
})

describe('shapes that are not a verdict', () => {
  // The controller published a PolicyStatus saying this policy applies to
  // nothing. "Not attached" and "not reconciled yet" are indistinguishable
  // here, so this reports the fact without claiming health either way.
  it('says so when the policy attaches to nothing', () => {
    expect(getGatewayPolicyStatus(policy())).toMatchObject({ text: 'No ancestors', tone: 'unknown' })
  })

  it('ignores malformed ancestors rather than throwing', () => {
    expect(() => getGatewayPolicyStatus({ status: { ancestors: [null, 'nope', 42] } })).not.toThrow()
    expect(() => getGatewayPolicyStatus({ status: { ancestors: [{ conditions: 'nope' }] } })).not.toThrow()
  })

  it('is not a policy when ancestors is absent or not an array', () => {
    expect(hasGatewayPolicyStatus({ status: { conditions: [] } })).toBe(false)
    expect(hasGatewayPolicyStatus({ status: { ancestors: {} } })).toBe(false)
    expect(getGatewayPolicyStatus({ status: {} })).toBeNull()
  })
})

describe('wiring into the generic ladder', () => {
  it('resolves a policy through its own reader', () => {
    const p = policy(anc(cond('Accepted', 'True', 'Accepted'), cond('Programmed', 'False', 'ResourceNotFound')))
    expect(getGenericResourceStatus(p)).toMatchObject({ text: 'ResourceNotFound', tone: 'unhealthy' })
  })

  // The dispatch is on shape, so it must not intercept an ordinary resource.
  it('leaves a resource with top-level conditions alone', () => {
    const r = { status: { conditions: [{ type: 'Ready', status: 'True' }] } }
    expect(getGenericResourceStatus(r)).toMatchObject({ text: 'Ready', tone: 'healthy' })
  })

  it('leaves a phase-based resource alone', () => {
    expect(getGenericResourceStatus({ status: { phase: 'Running' } })).toMatchObject({ text: 'Running', tone: 'healthy' })
  })
})
