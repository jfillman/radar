import { describe, expect, it } from 'vitest'
import { buildCapacitySummary } from './capacity-model'

function pool(overrides: any = {}) {
  return {
    metadata: { name: 'default' },
    spec: { limits: { cpu: '20', memory: '80Gi', pods: '220' } },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      resources: { cpu: '10', memory: '40Gi', pods: '110' },
    },
    ...overrides,
  }
}

function node(name: string, overrides: any = {}) {
  return {
    metadata: {
      name,
      labels: {
        'karpenter.sh/nodepool': 'default',
        'karpenter.sh/capacity-type': 'spot',
        'node.kubernetes.io/instance-type': 'm6i.large',
        'topology.kubernetes.io/zone': 'us-east-1a',
        'kubernetes.io/arch': 'amd64',
      },
    },
    spec: {},
    status: {
      allocatable: { cpu: '2', memory: '8Gi' },
      conditions: [{ type: 'Ready', status: 'True' }],
    },
    ...overrides,
  }
}

describe('buildCapacitySummary', () => {
  it('keeps provisioned limit pressure separate from live usage', () => {
    const result = buildCapacitySummary(
      [pool()],
      [],
      [node('node-a')],
      [{ name: 'node-a', cpu: 1_000_000_000, memory: 2 * 1024 ** 3, podCount: 12, cpuAllocatable: 0, memoryAllocatable: 0 }],
    )

    expect(result.pools[0].pressure).toEqual([
      { resource: 'cpu', provisioned: '10', limit: '20', percent: 50 },
      { resource: 'memory', provisioned: '40Gi', limit: '80Gi', percent: 50 },
      { resource: 'pods', provisioned: '110', limit: '220', percent: 50 },
    ])
    expect(result.pools[0].actual.cpuPercent).toBe(50)
    expect(result.pools[0].actual.memoryPercent).toBe(25)
  })

  it('does not turn partial metrics coverage into a deceptively low percentage', () => {
    const result = buildCapacitySummary(
      [pool()],
      [],
      [node('covered'), node('missing')],
      [{ name: 'covered', cpu: 1_000_000_000, memory: 4 * 1024 ** 3, podCount: 8, cpuAllocatable: 0, memoryAllocatable: 0 }],
    )

    expect(result.pools[0].actual).toMatchObject({
      metricsNodes: 1,
      totalNodes: 2,
      cpuPercent: 50,
      memoryPercent: 50,
    })
  })

  it('retains allocatable capacity and unknown usage when metrics are absent', () => {
    const result = buildCapacitySummary([pool()], [], [node('node-a')], [])

    expect(result.pools[0].nodes[0]).toMatchObject({
      cpuAllocatable: 2_000_000_000,
      memoryAllocatable: 8 * 1024 ** 3,
      hasMetrics: false,
    })
    expect(result.pools[0].actual.cpuPercent).toBeNull()
    expect(result.pools[0].actual.memoryPercent).toBeNull()
  })

  it('treats an idle zero-usage sample as metrics coverage', () => {
    const result = buildCapacitySummary(
      [pool()],
      [],
      [node('node-a')],
      [{ name: 'node-a', cpu: 0, memory: 0, podCount: 0, cpuAllocatable: 0, memoryAllocatable: 0 }],
    )

    expect(result.pools[0].nodes[0].hasMetrics).toBe(true)
    expect(result.pools[0].actual).toMatchObject({
      metricsNodes: 1,
      cpuPercent: 0,
      memoryPercent: 0,
    })
  })

  it('supports pools without limits and arbitrary extended-resource limits', () => {
    const unlimited = buildCapacitySummary([pool({ spec: {}, status: { resources: { cpu: '4' } } })], [], [], [])
    expect(unlimited.pools[0].pressure).toEqual([])

    const gpu = buildCapacitySummary([
      pool({
        spec: { limits: { 'nvidia.com/gpu': '4' } },
        status: { conditions: [{ type: 'Ready', status: 'True' }], resources: { 'nvidia.com/gpu': '3' } },
      }),
    ], [], [], [])
    expect(gpu.pools[0].pressure[0]).toEqual({
      resource: 'nvidia.com/gpu',
      provisioned: '3',
      limit: '4',
      percent: 75,
    })
  })

  it('prioritizes unhealthy and constrained pools', () => {
    const healthy = pool({ metadata: { name: 'healthy' } })
    const unhealthy = pool({
      metadata: { name: 'unhealthy' },
      spec: { limits: { cpu: '10' } },
      status: { conditions: [{ type: 'Ready', status: 'False', reason: 'NodeClassNotReady' }], resources: { cpu: '9' } },
    })
    const result = buildCapacitySummary([healthy, unhealthy], [], [], [])

    expect(result.pools.map((entry) => entry.name)).toEqual(['unhealthy', 'healthy'])
    expect(result.unreadyPools).toBe(1)
    expect(result.unknownPools).toBe(0)
    expect(result.constrainedPools).toBe(1)
  })

  it('does not misclassify a missing Ready condition as unhealthy', () => {
    const result = buildCapacitySummary([pool({ status: { resources: { cpu: '0' } } })], [], [], [])

    expect(result.pools[0].statusLevel).toBe('unknown')
    expect(result.unreadyPools).toBe(0)
    expect(result.unknownPools).toBe(1)
  })
})
