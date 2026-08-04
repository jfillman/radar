import { describe, expect, it } from 'vitest'
import { inClusterConsentDetails } from './InClusterConsentDialog'

describe('inClusterConsentDetails', () => {
  it('names the request it is about to send, not just where it lands', () => {
    // This is the last screen before real pod-to-pod traffic. It used to show
    // only the cluster and namespace, so the operator confirmed a request they
    // were never shown.
    const out = inClusterConsentDetails({ cluster: 'prod-us-east1', namespace: 'payments', httpPath: '/healthz' })
    expect(out).toContain('prod-us-east1')
    expect(out).toContain('payments')
    expect(out).toContain('GET /healthz')
  })

  it('defaults the shown path to / rather than omitting it', () => {
    expect(inClusterConsentDetails({ namespace: 'payments' })).toContain('GET /')
  })

  it('states that the run covers every declared path, not the selected one', () => {
    // The view offers a path picker; the run ignores it. Saying so here is the
    // only place that mismatch is visible before traffic is sent.
    expect(inClusterConsentDetails({ namespace: 'payments', pathCount: 3 })).toMatch(/all 3 declared paths/)
  })

  it('says "path" singular for one', () => {
    expect(inClusterConsentDetails({ namespace: 'payments', pathCount: 1 })).toMatch(/all 1 declared path\b(?!s)/)
  })

  it('omits the coverage line when the count is unknown, rather than guessing', () => {
    expect(inClusterConsentDetails({ namespace: 'payments' })).not.toMatch(/declared path/)
    expect(inClusterConsentDetails({ namespace: 'payments', pathCount: 0 })).not.toMatch(/declared path/)
  })

  it('omits the cluster line when identity is unavailable', () => {
    const out = inClusterConsentDetails({ namespace: 'payments' })
    expect(out).not.toMatch(/Cluster:/)
    expect(out).toMatch(/Namespace: payments/)
  })
})
