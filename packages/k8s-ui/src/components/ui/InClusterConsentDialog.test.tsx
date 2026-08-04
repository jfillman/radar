import { describe, expect, it } from 'vitest'
import { inClusterConsentDetails } from './InClusterConsentDialog'

const req = (route: string, request: string) => ({ route, request })

describe('inClusterConsentDetails', () => {
  it('names the requests it is about to send, not just where they land', () => {
    // This is the last screen before real pod-to-pod traffic. It used to show
    // only the cluster and namespace, so the operator confirmed requests they
    // were never shown.
    const out = inClusterConsentDetails({
      cluster: 'prod-us-east1',
      namespace: 'payments',
      requests: [req('checkout.example.com/', 'GET https://checkout.example.com/healthz')],
    })
    expect(out).toContain('prod-us-east1')
    expect(out).toContain('payments')
    expect(out).toContain('GET https://checkout.example.com/healthz')
  })

  it('shows each route its OWN path — a single "GET /" was wrong in the default case', () => {
    // With no path override the server keeps every route's declared path, so one
    // shared "/" is least accurate exactly when it used to be displayed.
    const out = inClusterConsentDetails({
      namespace: 'payments',
      requests: [
        req('a.example.com/api', 'GET https://a.example.com/api'),
        req('b.example.com/health', 'GET https://b.example.com/health'),
      ],
    })
    expect(out).toContain('/api')
    expect(out).toContain('/health')
  })

  it('counts declared paths that have no derivable request', () => {
    // They are part of the scope being agreed to; omitting them undercounted
    // what the run covers.
    const out = inClusterConsentDetails({
      namespace: 'payments',
      requests: [req('a/', 'GET http://svc:80/')],
      untestedCount: 2,
    })
    expect(out).toMatch(/3 declared paths/)
    expect(out).toMatch(/2 paths with no derivable request/)
  })

  it('says "path" singular for one', () => {
    expect(inClusterConsentDetails({ namespace: 'p', requests: [req('a', 'GET /')] })).toMatch(/1 declared path\b(?!s)/)
  })

  it('caps the listed requests but says how many are hidden', () => {
    const many = Array.from({ length: 9 }, (_, i) => req(`r${i}`, `GET http://svc:80/${i}`))
    const out = inClusterConsentDetails({ namespace: 'p', requests: many })
    expect(out).toMatch(/9 declared paths/)
    expect(out).toMatch(/and 3 more/)
  })

  it('omits the coverage block entirely when nothing is known, rather than guessing', () => {
    const out = inClusterConsentDetails({ namespace: 'payments' })
    expect(out).not.toMatch(/declared path/)
    expect(out).toMatch(/Namespace: payments/)
  })

  it('omits the cluster line when identity is unavailable', () => {
    expect(inClusterConsentDetails({ namespace: 'payments' })).not.toMatch(/Cluster:/)
  })
})
