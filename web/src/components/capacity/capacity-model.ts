import type { TopNodeMetrics } from '../../api/client'
import { parseCPUToNanocores, parseMemoryToBytes } from '@skyhook-io/k8s-ui/utils/format'

const NODEPOOL_LABEL = 'karpenter.sh/nodepool'
const CAPACITY_TYPE_LABEL = 'karpenter.sh/capacity-type'
const INSTANCE_TYPE_LABEL = 'node.kubernetes.io/instance-type'
const ZONE_LABEL = 'topology.kubernetes.io/zone'
const ARCH_LABEL = 'kubernetes.io/arch'

export interface CapacityBreakdown {
  value: string
  count: number
}

export interface CapacityPressure {
  resource: string
  provisioned: string
  limit: string
  percent: number
}

export interface CapacityNode {
  resource: any
  name: string
  ready: boolean
  cordoned: boolean
  capacityType: string
  instanceType: string
  zone: string
  architecture: string
  podCount: number
  hasMetrics: boolean
  cpuUsage: number
  memoryUsage: number
  cpuAllocatable: number
  memoryAllocatable: number
}

export interface PoolActualUsage {
  metricsNodes: number
  totalNodes: number
  cpuUsage: number
  cpuAllocatable: number
  memoryUsage: number
  memoryAllocatable: number
  cpuPercent: number | null
  memoryPercent: number | null
}

export interface CapacityPool {
  resource: any
  name: string
  statusLevel: 'ready' | 'notReady' | 'unknown'
  statusText: string
  nodes: CapacityNode[]
  nodeClaims: any[]
  readyNodes: number
  cordonedNodes: number
  actual: PoolActualUsage
  provisioned: Record<string, string>
  limits: Record<string, string>
  pressure: CapacityPressure[]
  capacityTypes: CapacityBreakdown[]
  instanceTypes: CapacityBreakdown[]
  zones: CapacityBreakdown[]
  architectures: CapacityBreakdown[]
  nodeClassRef?: { group?: string; kind?: string; name?: string }
  consolidationPolicy: string
  consolidateAfter?: string
  expireAfter?: string
  disruptionBudgets: any[]
  requirements: any[]
}

export interface CapacitySummary {
  pools: CapacityPool[]
  totalNodes: number
  readyNodes: number
  cordonedNodes: number
  metricsNodes: number
  totalNodeClaims: number
  unreadyPools: number
  unknownPools: number
  constrainedPools: number
}

function isNodeReady(node: any): boolean {
  return node.status?.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True') ?? false
}

function poolStatus(nodePool: any): { level: 'ready' | 'notReady' | 'unknown'; text: string } {
  const ready = nodePool.status?.conditions?.find((condition: any) => condition.type === 'Ready')
  if (ready?.status === 'True') return { level: 'ready', text: 'Ready' }
  if (ready?.status === 'False') return { level: 'notReady', text: ready.reason || 'Not Ready' }
  return { level: 'unknown', text: 'Unknown' }
}

function countBy(nodes: CapacityNode[], select: (node: CapacityNode) => string): CapacityBreakdown[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const value = select(node)
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

function parseResource(resource: string, quantity: string): number {
  if (resource === 'cpu') return parseCPUToNanocores(quantity)
  if (resource === 'memory' || resource.includes('storage')) return parseMemoryToBytes(quantity)
  const parsed = Number(quantity)
  return Number.isFinite(parsed) ? parsed : 0
}

function resourcePressure(provisioned: Record<string, string>, limits: Record<string, string>): CapacityPressure[] {
  return Object.entries(limits).map(([resource, limit]) => {
    const current = provisioned[resource] ?? '0'
    const denominator = parseResource(resource, String(limit))
    const numerator = parseResource(resource, String(current))
    return {
      resource,
      provisioned: String(current),
      limit: String(limit),
      percent: denominator > 0 ? (numerator / denominator) * 100 : 0,
    }
  }).sort((a, b) => b.percent - a.percent || a.resource.localeCompare(b.resource))
}

function buildNode(node: any, metric: TopNodeMetrics | undefined): CapacityNode {
  const labels = node.metadata?.labels ?? {}
  const hasMetrics = !!metric
  return {
    resource: node,
    name: node.metadata?.name ?? '',
    ready: isNodeReady(node),
    cordoned: node.spec?.unschedulable === true,
    capacityType: labels[CAPACITY_TYPE_LABEL] ?? 'unknown',
    instanceType: labels[INSTANCE_TYPE_LABEL] ?? 'unknown',
    zone: labels[ZONE_LABEL] ?? 'unknown',
    architecture: labels[ARCH_LABEL] ?? 'unknown',
    podCount: metric?.podCount ?? 0,
    hasMetrics,
    cpuUsage: hasMetrics ? metric?.cpu ?? 0 : 0,
    memoryUsage: hasMetrics ? metric?.memory ?? 0 : 0,
    cpuAllocatable: parseCPUToNanocores(String(node.status?.allocatable?.cpu ?? '')),
    memoryAllocatable: parseMemoryToBytes(String(node.status?.allocatable?.memory ?? '')),
  }
}

function actualUsage(nodes: CapacityNode[]): PoolActualUsage {
  const covered = nodes.filter((node) => node.hasMetrics)
  const cpuUsage = covered.reduce((sum, node) => sum + node.cpuUsage, 0)
  const cpuAllocatable = covered.reduce((sum, node) => sum + node.cpuAllocatable, 0)
  const memoryUsage = covered.reduce((sum, node) => sum + node.memoryUsage, 0)
  const memoryAllocatable = covered.reduce((sum, node) => sum + node.memoryAllocatable, 0)
  return {
    metricsNodes: covered.length,
    totalNodes: nodes.length,
    cpuUsage,
    cpuAllocatable,
    memoryUsage,
    memoryAllocatable,
    cpuPercent: cpuAllocatable > 0 ? (cpuUsage / cpuAllocatable) * 100 : null,
    memoryPercent: memoryAllocatable > 0 ? (memoryUsage / memoryAllocatable) * 100 : null,
  }
}

export function buildCapacitySummary(
  nodePools: any[],
  nodeClaims: any[],
  nodes: any[],
  metrics: TopNodeMetrics[],
): CapacitySummary {
  const metricsByName = new Map(metrics.map((metric) => [metric.name, metric]))
  const nodesByPool = new Map<string, CapacityNode[]>()
  for (const node of nodes) {
    const poolName = node.metadata?.labels?.[NODEPOOL_LABEL]
    if (!poolName) continue
    const entry = buildNode(node, metricsByName.get(node.metadata?.name))
    nodesByPool.set(poolName, [...(nodesByPool.get(poolName) ?? []), entry])
  }

  const claimsByPool = new Map<string, any[]>()
  for (const claim of nodeClaims) {
    const poolName = claim.metadata?.labels?.[NODEPOOL_LABEL]
    if (!poolName) continue
    claimsByPool.set(poolName, [...(claimsByPool.get(poolName) ?? []), claim])
  }

  const pools = nodePools.map((nodePool): CapacityPool => {
    const name = nodePool.metadata?.name ?? ''
    const poolNodes = (nodesByPool.get(name) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    const status = poolStatus(nodePool)
    const provisioned = nodePool.status?.resources ?? {}
    const limits = nodePool.spec?.limits ?? {}
    const disruption = nodePool.spec?.disruption ?? {}
    return {
      resource: nodePool,
      name,
      statusLevel: status.level,
      statusText: status.text,
      nodes: poolNodes,
      nodeClaims: claimsByPool.get(name) ?? [],
      readyNodes: poolNodes.filter((node) => node.ready).length,
      cordonedNodes: poolNodes.filter((node) => node.cordoned).length,
      actual: actualUsage(poolNodes),
      provisioned,
      limits,
      pressure: resourcePressure(provisioned, limits),
      capacityTypes: countBy(poolNodes, (node) => node.capacityType),
      instanceTypes: countBy(poolNodes, (node) => node.instanceType),
      zones: countBy(poolNodes, (node) => node.zone),
      architectures: countBy(poolNodes, (node) => node.architecture),
      nodeClassRef: nodePool.spec?.template?.spec?.nodeClassRef,
      consolidationPolicy: disruption.consolidationPolicy ?? 'WhenEmptyOrUnderutilized',
      consolidateAfter: disruption.consolidateAfter,
      expireAfter: nodePool.spec?.template?.spec?.expireAfter,
      disruptionBudgets: disruption.budgets ?? [],
      requirements: nodePool.spec?.template?.spec?.requirements ?? [],
    }
  }).sort((a, b) => {
    const statusRank = { notReady: 0, unknown: 1, ready: 2 }
    if (a.statusLevel !== b.statusLevel) return statusRank[a.statusLevel] - statusRank[b.statusLevel]
    const aPressure = a.pressure[0]?.percent ?? -1
    const bPressure = b.pressure[0]?.percent ?? -1
    return bPressure - aPressure || a.name.localeCompare(b.name)
  })

  return {
    pools,
    totalNodes: pools.reduce((sum, pool) => sum + pool.nodes.length, 0),
    readyNodes: pools.reduce((sum, pool) => sum + pool.readyNodes, 0),
    cordonedNodes: pools.reduce((sum, pool) => sum + pool.cordonedNodes, 0),
    metricsNodes: pools.reduce((sum, pool) => sum + pool.actual.metricsNodes, 0),
    totalNodeClaims: pools.reduce((sum, pool) => sum + pool.nodeClaims.length, 0),
    unreadyPools: pools.filter((pool) => pool.statusLevel === 'notReady').length,
    unknownPools: pools.filter((pool) => pool.statusLevel === 'unknown').length,
    constrainedPools: pools.filter((pool) => pool.pressure.some((pressure) => pressure.percent >= 80)).length,
  }
}

export function capacityResourceLabel(resource: string): string {
  if (resource === 'cpu') return 'CPU'
  if (resource === 'memory') return 'Memory'
  if (resource === 'ephemeral-storage') return 'Ephemeral storage'
  if (resource === 'pods') return 'Pods'
  return resource
}
