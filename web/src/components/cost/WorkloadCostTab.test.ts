import { describe, expect, it } from 'vitest'
import { getWorkloadCostState } from './WorkloadCostTab'
import { buildLineChart } from './chart'
import type { OpenCostWorkloadDetailResponse, OpenCostWorkloadTrendResponse } from '../../api/client'

describe('getWorkloadCostState', () => {
  it('treats scaled-to-zero as a valid zero state', () => {
    const current: OpenCostWorkloadDetailResponse = {
      available: true,
      namespace: 'default',
      kind: 'Deployment',
      name: 'checkout',
      current: {
        name: 'checkout',
        kind: 'Deployment',
        hourlyCost: 0,
        cpuCost: 0,
        memoryCost: 0,
        replicas: 0,
      },
    }
    const trend: OpenCostWorkloadTrendResponse = {
      available: false,
      reason: 'no_metrics',
      namespace: 'default',
      kind: 'Deployment',
      name: 'checkout',
      range: '24h',
    }

    expect(getWorkloadCostState(current, trend, false)).toBe('zero')
  })

  it('keeps current cost visible when only historical owner metrics are missing', () => {
    const current: OpenCostWorkloadDetailResponse = {
      available: true,
      namespace: 'default',
      kind: 'Deployment',
      name: 'checkout',
      current: {
        name: 'checkout',
        kind: 'Deployment',
        hourlyCost: 0.2,
        cpuCost: 0.12,
        memoryCost: 0.08,
        replicas: 2,
      },
    }
    const trend: OpenCostWorkloadTrendResponse = {
      available: false,
      reason: 'no_metrics',
      namespace: 'default',
      kind: 'Deployment',
      name: 'checkout',
      range: '24h',
    }

    expect(getWorkloadCostState(current, trend, false)).toBe('partial_missing_history')
  })

  it('keeps current cost visible while historical owner metrics are still loading', () => {
    const current: OpenCostWorkloadDetailResponse = {
      available: true,
      namespace: 'default',
      kind: 'Deployment',
      name: 'checkout',
      current: {
        name: 'checkout',
        kind: 'Deployment',
        hourlyCost: 0.2,
        cpuCost: 0.12,
        memoryCost: 0.08,
        replicas: 2,
      },
    }

    expect(getWorkloadCostState(current, undefined, { trendLoading: true })).toBe('data')
  })

  it('uses historical data when current metrics are absent but history exists', () => {
    const current: OpenCostWorkloadDetailResponse = {
      available: false,
      reason: 'no_metrics',
      namespace: 'default',
      kind: 'Deployment',
      name: 'checkout',
    }
    const trend: OpenCostWorkloadTrendResponse = {
      available: true,
      namespace: 'default',
      kind: 'Deployment',
      name: 'checkout',
      range: '7d',
      dataPoints: [
        { timestamp: 1700000000, value: 0.1 },
        { timestamp: 1700003600, value: 0.2 },
      ],
    }

    expect(getWorkloadCostState(current, trend, false)).toBe('partial_missing_current')
  })

  it('separates load failures from absent workload metrics', () => {
    expect(getWorkloadCostState(undefined, undefined, { currentError: true })).toBe('load_error')
  })

  it('surfaces workload access and existence failures', () => {
    const current: OpenCostWorkloadDetailResponse = {
      available: false,
      reason: 'access_denied',
      namespace: 'prod',
      kind: 'Deployment',
      name: 'checkout',
    }

    const missing: OpenCostWorkloadTrendResponse = {
      available: false,
      reason: 'not_found',
      namespace: 'prod',
      kind: 'Deployment',
      name: 'checkout',
      range: '24h',
    }

    expect(getWorkloadCostState(current, undefined, false)).toBe('access_denied')
    expect(getWorkloadCostState(undefined, missing, false)).toBe('not_found')
  })
})

describe('buildLineChart', () => {
  it('returns stable paths for a non-empty workload series', () => {
    const chart = buildLineChart([
      { timestamp: 1700000000, value: 1 },
      { timestamp: 1700003600, value: 2 },
      { timestamp: 1700007200, value: 1 },
    ])

    expect(chart?.linePath).toContain('M 44.0')
    expect(chart?.linePath).toContain('L 374.0')
    expect(chart?.areaPath.endsWith('Z')).toBe(true)
    expect(chart?.yTicks).toHaveLength(3)
  })
})
