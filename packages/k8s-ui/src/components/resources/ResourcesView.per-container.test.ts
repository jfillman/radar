import { describe, expect, it } from 'vitest'
import type { ContainerResourceMetrics } from '../../types'
import { pickConstraint, readContainer } from './ResourcesView'

// Build a CPU-only container fixture; memory fields default to 0.
function cpu(name: string, usage: number, request: number, limit: number): ContainerResourceMetrics {
  return { name, cpu: usage, cpuRequest: request, cpuLimit: limit, memory: 0, memoryRequest: 0, memoryLimit: 0 }
}

// Build a memory-only container fixture; cpu fields default to 0.
function mem(name: string, usage: number, request: number, limit: number): ContainerResourceMetrics {
  return { name, cpu: 0, cpuRequest: 0, cpuLimit: 0, memory: usage, memoryRequest: request, memoryLimit: limit }
}

describe('readContainer', () => {
  it("uses limit as the yardstick when a limit is set", () => {
    const r = readContainer(cpu('app', 50, 25, 100), 'cpu')
    expect(r.yardstick).toBe('limit')
    expect(r.denom).toBe(100)
    expect(r.pct).toBe(50)
  })

  it('falls back to request when limit is 0 but request is set', () => {
    const r = readContainer(cpu('app', 80, 100, 0), 'cpu')
    expect(r.yardstick).toBe('request')
    expect(r.denom).toBe(100)
    expect(r.pct).toBe(80)
  })

  it('allows request-only pct to exceed 100%', () => {
    const r = readContainer(cpu('app', 200, 100, 0), 'cpu')
    expect(r.yardstick).toBe('request')
    expect(r.pct).toBe(200)
  })

  it("reports 'none' when neither request nor limit is set", () => {
    const r = readContainer(cpu('app', 40, 0, 0), 'cpu')
    expect(r.yardstick).toBe('none')
    expect(r.pct).toBe(-1)
  })

  it('reads the memory fields for the memory kind', () => {
    const r = readContainer(mem('app', 64, 32, 128), 'memory')
    expect(r.yardstick).toBe('limit')
    expect(r.denom).toBe(128)
    expect(r.pct).toBe(50)
  })
})

describe('pickConstraint', () => {
  it('prefers a limited container even when a request-only container has a higher ratio', () => {
    const containers = [
      cpu('app', 60, 50, 100),   // limited, 60% of limit
      cpu('sidecar', 200, 100, 0), // request-only, 200% of request
    ]
    const result = pickConstraint(containers, 'cpu')
    expect(result.mode).toBe('limit')
    expect(result.container?.name).toBe('app')
    expect(result.pct).toBe(60)
    expect(result.denom).toBe(100)
    expect(result.unlimitedCount).toBe(1) // the request-only sidecar
  })

  it('picks the most-constrained LIMITED container among several', () => {
    const containers = [
      cpu('a', 30, 0, 100), // 30%
      cpu('b', 90, 0, 100), // 90%
      cpu('c', 50, 0, 100), // 50%
    ]
    const result = pickConstraint(containers, 'cpu')
    expect(result.mode).toBe('limit')
    expect(result.container?.name).toBe('b')
    expect(result.pct).toBe(90)
    expect(result.unlimitedCount).toBe(0)
  })

  it('falls back to the most-constrained REQUEST-ONLY container when nothing is limited', () => {
    const containers = [
      cpu('a', 50, 100, 0), // 50% of request
      cpu('b', 90, 100, 0), // 90% of request
    ]
    const result = pickConstraint(containers, 'cpu')
    expect(result.mode).toBe('request')
    expect(result.container?.name).toBe('b')
    expect(result.pct).toBe(90)
    expect(result.denom).toBe(100)
    expect(result.unlimitedCount).toBe(2)
  })

  it("returns mode 'none' when no container sets a request or limit", () => {
    const containers = [cpu('a', 10, 0, 0), cpu('b', 20, 0, 0)]
    const result = pickConstraint(containers, 'cpu')
    expect(result.mode).toBe('none')
    expect(result.container).toBeNull()
    expect(result.unlimitedCount).toBe(2)
  })

  it('breaks ties deterministically — equal pct picks the lexicographically lower name', () => {
    const containers = [
      cpu('zzz', 50, 0, 100), // 50%
      cpu('aaa', 50, 0, 100), // 50%
    ]
    const result = pickConstraint(containers, 'cpu')
    expect(result.container?.name).toBe('aaa')
  })

  it('counts every limit==0 container in unlimitedCount (request-only and unset)', () => {
    const containers = [
      cpu('limited', 50, 0, 100),
      cpu('reqonly', 50, 100, 0),
      cpu('unset', 10, 0, 0),
    ]
    const result = pickConstraint(containers, 'cpu')
    expect(result.mode).toBe('limit')
    expect(result.unlimitedCount).toBe(2)
  })
})
