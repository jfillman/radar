import { describe, it, expect } from 'vitest'
import { getKyvernoPolicyAction } from './resource-utils-kyverno'

function cpol(spec: any) {
  return { apiVersion: 'kyverno.io/v1', kind: 'ClusterPolicy', metadata: { name: 'p' }, spec }
}

/**
 * The two cases here were confirmed against a live Kyverno 1.18 admission
 * controller: each one creates a pod that the apiserver actually rejects while
 * the fields this accessor used to read say Audit.
 */
describe('getKyvernoPolicyAction', () => {
  it('lets a rule-level failureAction override the spec-level one', () => {
    // Live result: pod REJECTED by validate.kyverno.svc-fail.
    expect(
      getKyvernoPolicyAction(
        cpol({
          validationFailureAction: 'Audit',
          rules: [{ name: 'r', validate: { failureAction: 'Enforce' } }],
        }),
      ),
    ).toBe('Enforce')
  })

  it('reads the failureAction on an image-verification rule', () => {
    // Live result: pod REJECTED by mutate.kyverno.svc-fail. Kyverno had
    // defaulted spec.validationFailureAction to Audit on its own.
    expect(
      getKyvernoPolicyAction(
        cpol({
          validationFailureAction: 'Audit',
          rules: [{ name: 'r', verifyImages: [{ failureAction: 'Enforce' }] }],
        }),
      ),
    ).toBe('Enforce')
  })

  it('does not claim Enforce when every rule overrides it away', () => {
    expect(
      getKyvernoPolicyAction(
        cpol({
          validationFailureAction: 'Enforce',
          rules: [{ name: 'r', validate: { failureAction: 'Audit' } }],
        }),
      ),
    ).toBe('Audit')
  })

  it('applies the spec-level action to rules that declare none', () => {
    expect(
      getKyvernoPolicyAction(
        cpol({
          validationFailureAction: 'Enforce',
          rules: [{ name: 'r', validate: { pattern: {} } }],
        }),
      ),
    ).toBe('Enforce')
  })

  it('falls back to Audit when nothing declares an action', () => {
    expect(getKyvernoPolicyAction(cpol({ rules: [{ name: 'r', validate: {} }] }))).toBe('Audit')
    expect(getKyvernoPolicyAction(cpol({}))).toBe('Audit')
  })
})
