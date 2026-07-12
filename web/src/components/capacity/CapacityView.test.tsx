import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CapacityView } from './CapacityView'

vi.mock('../../context/ConnectionContext', () => ({
  useConnection: () => ({ connection: { state: 'connected' } }),
}))

function renderCapacity({ withMetrics = true }: { withMetrics?: boolean } = {}) {
  const client = new QueryClient()
  client.setQueryData(['resources', 'nodepools', 'karpenter.sh', undefined], [{
    metadata: { name: 'default' },
    spec: { limits: { cpu: '20' }, disruption: { consolidationPolicy: 'WhenEmptyOrUnderutilized' } },
    status: { conditions: [{ type: 'Ready', status: 'True' }], resources: { cpu: '10' } },
  }])
  client.setQueryData(['resources', 'nodeclaims', 'karpenter.sh', undefined], [])
  client.setQueryData(['resources', 'nodes', undefined, undefined], [{
    metadata: {
      name: 'worker-a',
      labels: {
        'karpenter.sh/nodepool': 'default',
        'karpenter.sh/capacity-type': 'spot',
        'node.kubernetes.io/instance-type': 'm6i.large',
        'topology.kubernetes.io/zone': 'us-east-1a',
      },
    },
    spec: {},
    status: { allocatable: { cpu: '2', memory: '8Gi' }, conditions: [{ type: 'Ready', status: 'True' }] },
  }])
  client.setQueryData(['top-node-metrics'], withMetrics ? [{
    name: 'worker-a', cpu: 1_000_000_000, memory: 2 * 1024 ** 3, podCount: 10, cpuAllocatable: 2_000_000_000, memoryAllocatable: 8 * 1024 ** 3,
  }] : [])

  return renderToString(
    <QueryClientProvider client={client}>
      <CapacityView available onOpenResource={() => {}} />
    </QueryClientProvider>,
  )
}

describe('CapacityView', () => {
  it('leads with configured ceilings and labels live usage as an efficiency signal', () => {
    const html = renderCapacity()

    expect(html).toContain('Configured ceiling')
    expect(html).toContain('Actual node usage')
    expect(html).toContain('Karpenter schedules from pod requests')
    expect(html).toContain('not scheduler headroom')
    expect(html).toContain('Provisioned resources reported by Karpenter versus spec.limits')
    expect(html).toContain('10 cores')
    expect(html).toContain('20 cores')
    expect(html).toContain('width:50%')
  })

  it('shows an honest unknown state when live metrics are missing', () => {
    const html = renderCapacity({ withMetrics: false })

    expect(html).toContain('No live sample')
    expect(html).toContain('Provisioned capacity and node inventory remain valid')
    expect(html).not.toContain('0% CPU')
  })

  it('shows a non-Karpenter route state without fetching fake legacy shapes', () => {
    const client = new QueryClient()
    const html = renderToString(
      <QueryClientProvider client={client}>
        <CapacityView available={false} onOpenResource={() => {}} />
      </QueryClientProvider>,
    )

    expect(html).toContain('Karpenter not detected')
  })
})
