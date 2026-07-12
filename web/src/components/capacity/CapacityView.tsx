import { useMemo, useState, type ReactNode } from 'react'
import { Activity, AlertTriangle, Boxes, ChevronRight, Cpu, Gauge, Layers3, Shield, Waypoints } from 'lucide-react'
import { FreshnessControl, PaneLoader, ResourceBar } from '@skyhook-io/k8s-ui'
import { Badge } from '@skyhook-io/k8s-ui/components/ui/Badge'
import { formatCPUNanocores, formatCPUString, formatMemoryBytes, formatMemoryString, parseCPUToNanocores } from '@skyhook-io/k8s-ui/utils/format'
import { useResources, useTopNodeMetrics } from '../../api/client'
import { useConnection } from '../../context/ConnectionContext'
import type { SelectedResource } from '../../types'
import { kindToPlural } from '../../utils/navigation'
import { buildCapacitySummary, capacityResourceLabel, type CapacityBreakdown, type CapacityPool } from './capacity-model'

interface CapacityViewProps {
  available: boolean
  discovering?: boolean
  onOpenResource: (resource: SelectedResource) => void
}

export function CapacityView({ available, discovering = false, onOpenResource }: CapacityViewProps) {
  const { connection } = useConnection()
  const nodePools = useResources<any>('nodepools', undefined, 'karpenter.sh', { enabled: available, refetchInterval: 30_000 })
  const nodeClaims = useResources<any>('nodeclaims', undefined, 'karpenter.sh', { enabled: available, refetchInterval: 30_000 })
  const nodes = useResources<any>('nodes', undefined, undefined, { enabled: available, refetchInterval: 30_000 })
  const metrics = useTopNodeMetrics({ enabled: available })
  const [selectedName, setSelectedName] = useState<string | null>(null)

  const summary = useMemo(
    () => buildCapacitySummary(nodePools.data ?? [], nodeClaims.data ?? [], nodes.data ?? [], metrics.data ?? []),
    [nodePools.data, nodeClaims.data, nodes.data, metrics.data],
  )
  const selected = summary.pools.find((pool) => pool.name === selectedName) ?? summary.pools[0]
  const isLoading = nodePools.isLoading || nodes.isLoading
  const isFetching = nodePools.isFetching || nodeClaims.isFetching || nodes.isFetching || metrics.isFetching
  const dataUpdatedAt = Math.max(nodePools.dataUpdatedAt, nodeClaims.dataUpdatedAt, nodes.dataUpdatedAt, metrics.dataUpdatedAt)
  const partialErrors = [
    nodeClaims.error ? 'NodeClaims' : null,
    nodes.error ? 'Nodes' : null,
    metrics.error ? 'live metrics' : null,
  ].filter(Boolean) as string[]

  const refresh = () => Promise.all([nodePools.refetch(), nodeClaims.refetch(), nodes.refetch(), metrics.refetch()])

  if (discovering) return <PaneLoader label="Discovering capacity providers…" className="flex-1 min-h-0" />

  if (!available) {
    return (
      <EmptyState
        icon={Gauge}
        title="Karpenter not detected"
        detail="Capacity appears automatically when this cluster exposes Karpenter NodePools. Nodes remain available in Resources."
      />
    )
  }

  if (isLoading) return <PaneLoader label="Loading capacity…" className="flex-1 min-h-0" />

  if (nodePools.error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Capacity unavailable"
        detail={`Radar could not read Karpenter NodePools: ${nodePools.error.message}`}
      />
    )
  }

  if (summary.pools.length === 0) {
    return (
      <EmptyState
        icon={Layers3}
        title="No NodePools"
        detail="The Karpenter API is installed, but there are no NodePool resources visible to this user."
      />
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-theme-base">
      <div className="mx-auto max-w-[1600px] space-y-5 px-5 py-5 xl:px-7">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2.5">
              <Gauge className="h-5 w-5 text-accent-text" />
              <h1 className="text-xl font-semibold text-theme-text-primary">Capacity</h1>
              <Badge kind="NodePool">Karpenter</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-theme-text-secondary">
              Compare provisioned capacity with NodePool ceilings, then inspect actual node usage and fleet shape.
              Karpenter schedules from pod requests; live usage is an efficiency signal, not scheduler headroom.
            </p>
          </div>
          <FreshnessControl
            mode="auto"
            dataUpdatedAt={dataUpdatedAt}
            isFetching={isFetching}
            onRefresh={refresh}
            connectionState={connection.state}
          />
        </header>

        {partialErrors.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text-secondary">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            Some data is unavailable ({partialErrors.join(', ')}). Available capacity data is still shown.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryStat
            label="NodePools"
            value={summary.pools.length}
            detail={summary.unreadyPools ? `${summary.unreadyPools} not ready` : summary.unknownPools ? `${summary.unknownPools} status unknown` : 'All ready'}
            attention={summary.unreadyPools > 0}
          />
          <SummaryStat label="Karpenter nodes" value={summary.totalNodes} detail={`${summary.readyNodes} ready · ${summary.cordonedNodes} cordoned`} attention={summary.readyNodes < summary.totalNodes || summary.cordonedNodes > 0} />
          <SummaryStat label="Near a limit" value={summary.constrainedPools} detail="Pools at 80%+ of any configured ceiling" attention={summary.constrainedPools > 0} />
          <SummaryStat label="Actual usage coverage" value={`${summary.metricsNodes}/${summary.totalNodes}`} detail="Karpenter nodes with live samples" attention={summary.metricsNodes < summary.totalNodes} />
        </div>

        <section className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
          <div className="border-b-subtle px-4 py-3">
            <h2 className="font-medium text-theme-text-primary">NodePools</h2>
            <p className="text-xs text-theme-text-tertiary">Select a pool to inspect its capacity and fleet composition.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-left">
              <thead className="border-b border-theme-border bg-theme-base/60 text-[11px] uppercase tracking-wide text-theme-text-tertiary">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Pool</th>
                  <th className="px-3 py-2.5 font-medium">Nodes</th>
                  <th className="w-[210px] px-3 py-2.5 font-medium">Configured ceiling</th>
                  <th className="w-[210px] px-3 py-2.5 font-medium">Actual usage</th>
                  <th className="px-3 py-2.5 font-medium">Fleet</th>
                  <th className="px-3 py-2.5 font-medium">Policy</th>
                  <th className="w-10 px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="table-divide-subtle">
                {summary.pools.map((pool) => (
                  <PoolRow
                    key={pool.name}
                    pool={pool}
                    selected={selected?.name === pool.name}
                    onSelect={() => setSelectedName(pool.name)}
                    onOpen={() => onOpenResource({ kind: 'nodepools', namespace: '', name: pool.name, group: 'karpenter.sh' })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {selected && (
          <PoolInspector pool={selected} onOpenResource={onOpenResource} />
        )}
      </div>
    </div>
  )
}

function SummaryStat({ label, value, detail, attention = false }: { label: string; value: string | number; detail: string; attention?: boolean }) {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-theme-sm">
      <div className="text-xs font-medium text-theme-text-tertiary">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-theme-text-primary">{value}</span>
        {attention && <span className="h-2 w-2 rounded-full bg-amber-500" aria-label="Needs attention" />}
      </div>
      <div className="mt-1 text-xs text-theme-text-secondary">{detail}</div>
    </div>
  )
}

function PoolRow({ pool, selected, onSelect, onOpen }: { pool: CapacityPool; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const highestPressure = pool.pressure[0]
  return (
    <tr
      className={`cursor-pointer transition-colors ${selected ? 'selection' : 'hover:bg-theme-hover/50'}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      tabIndex={0}
      aria-selected={selected}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-theme-text-primary">{pool.name}</span>
          <Badge severity={pool.statusLevel === 'ready' ? 'success' : pool.statusLevel === 'notReady' ? 'error' : 'neutral'} size="sm">{pool.statusText}</Badge>
        </div>
        <div className="mt-1 text-xs text-theme-text-tertiary">{pool.nodeClassRef?.name ?? 'No NodeClass reference'}</div>
      </td>
      <td className="px-3 py-3">
        <div className="font-mono text-sm tabular-nums text-theme-text-primary">{pool.nodes.length}</div>
        <div className="text-xs text-theme-text-tertiary">{pool.readyNodes} ready · {pool.nodeClaims.length} claims</div>
      </td>
      <td className="px-3 py-3">
        {highestPressure ? (
          <ResourceBar
            used={highestPressure.provisioned}
            total={highestPressure.limit}
            percent={highestPressure.percent}
            colorScheme="quiet"
            layout="inline"
            label={shortResourceLabel(highestPressure.resource)}
            tooltip={`${capacityResourceLabel(highestPressure.resource)} provisioned: ${highestPressure.provisioned} of ${highestPressure.limit} configured limit`}
          />
        ) : (
          <span className="text-xs text-theme-text-tertiary">No NodePool limits</span>
        )}
      </td>
      <td className="space-y-1 px-3 py-3">
        <ActualUsageBar label="CPU" percent={pool.actual.cpuPercent} covered={pool.actual.metricsNodes} total={pool.actual.totalNodes} />
        <ActualUsageBar label="MEM" percent={pool.actual.memoryPercent} covered={pool.actual.metricsNodes} total={pool.actual.totalNodes} />
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {pool.capacityTypes.slice(0, 2).map((item, index) => (
            <Badge key={item.value} tone={index === 0 ? 'accent1' : 'accent2'} size="sm">{item.value} {item.count}</Badge>
          ))}
          {pool.capacityTypes.length === 0 && <span className="text-xs text-theme-text-tertiary">No nodes</span>}
        </div>
        <div className="mt-1 text-xs text-theme-text-tertiary">{pool.zones.length} zones · {pool.instanceTypes.length} types</div>
      </td>
      <td className="px-3 py-3">
        <div className="text-sm text-theme-text-secondary">{pool.consolidationPolicy}</div>
        <div className="text-xs text-theme-text-tertiary">{pool.consolidateAfter ? `after ${pool.consolidateAfter}` : 'default timing'}</div>
      </td>
      <td className="px-3 py-3">
        <button
          type="button"
          className="rounded-md p-1 text-theme-text-tertiary hover:bg-theme-hover hover:text-theme-text-primary"
          aria-label={`Open ${pool.name} NodePool`}
          onClick={(event) => { event.stopPropagation(); onOpen() }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}

function ActualUsageBar({ label, percent, covered, total }: { label: string; percent: number | null; covered: number; total: number }) {
  if (percent == null) return <div className="flex items-center gap-2 text-[11px] text-theme-text-tertiary"><span className="w-7">{label}</span><span>No live sample</span></div>
  return (
    <ResourceBar
      used={`${Math.round(percent)}%`}
      total="allocatable"
      percent={percent}
      colorScheme="quiet"
      layout="inline"
      label={label}
      tooltip={`Actual ${label.toLowerCase()} usage across ${covered} of ${total} nodes with live metrics. Karpenter scheduling uses pod requests, not this value.`}
    />
  )
}

function PoolInspector({ pool, onOpenResource }: { pool: CapacityPool; onOpenResource: (resource: SelectedResource) => void }) {
  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
      <div className="flex items-center justify-between gap-4 border-b-subtle px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-medium text-theme-text-primary">{pool.name}</h2>
            <Badge kind="NodePool" size="sm">NodePool</Badge>
          </div>
          <p className="mt-0.5 text-xs text-theme-text-tertiary">Aggregate capacity and fleet data. Open the resource for its complete configuration.</p>
        </div>
        <button
          type="button"
          className="btn-brand px-3 py-1.5 text-sm"
          onClick={() => onOpenResource({ kind: 'nodepools', namespace: '', name: pool.name, group: 'karpenter.sh' })}
        >
          Open NodePool
        </button>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <InspectorCard icon={Shield} title="Configured ceilings" detail="Provisioned resources reported by Karpenter versus spec.limits.">
          {pool.pressure.length > 0 ? (
            <div className="space-y-3">
              {pool.pressure.map((pressure) => (
                <div key={pressure.resource}>
                  <div className="mb-1 text-xs font-medium text-theme-text-secondary">{capacityResourceLabel(pressure.resource)}</div>
                  <ResourceBar
                    used={formatPressureQuantity(pressure.resource, pressure.provisioned)}
                    total={formatPressureQuantity(pressure.resource, pressure.limit)}
                    percent={pressure.percent}
                    colorScheme="quiet"
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-theme-text-secondary">No NodePool limits are configured. Cloud-provider quotas are the effective ceiling.</p>
          )}
        </InspectorCard>

        <InspectorCard icon={Activity} title="Actual node usage" detail="Point-in-time metrics-server usage. This measures efficiency, not Karpenter scheduling headroom.">
          {pool.actual.metricsNodes > 0 ? (
            <div className="space-y-3">
              <UsageDetail label="CPU" percent={pool.actual.cpuPercent} used={formatCPUNanocores(pool.actual.cpuUsage)} total={formatCPUNanocores(pool.actual.cpuAllocatable)} />
              <UsageDetail label="Memory" percent={pool.actual.memoryPercent} used={formatMemoryBytes(pool.actual.memoryUsage)} total={formatMemoryBytes(pool.actual.memoryAllocatable)} />
              <p className="text-xs text-theme-text-tertiary">
                Coverage: {pool.actual.metricsNodes} of {pool.actual.totalNodes} nodes. Percentages include only nodes with samples.
              </p>
            </div>
          ) : (
            <p className="text-sm text-theme-text-secondary">No live samples are available for this pool. Provisioned capacity and node inventory remain valid.</p>
          )}
        </InspectorCard>

        <InspectorCard icon={Waypoints} title="Fleet composition" detail="What Karpenter has actually provisioned for this pool.">
          <div className="grid grid-cols-2 gap-3">
            <Breakdown title="Purchase" values={pool.capacityTypes} />
            <Breakdown title="Zones" values={pool.zones} />
            <Breakdown title="Instance types" values={pool.instanceTypes} />
            <Breakdown title="Architecture" values={pool.architectures} />
          </div>
        </InspectorCard>

        <InspectorCard icon={Boxes} title="Provisioning chain" detail="NodeClaims created by this pool and the provider configuration they use.">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-theme-text-secondary">NodeClass</span>
              {pool.nodeClassRef?.name ? (
                <button
                  type="button"
                  className="text-sm font-medium text-accent-text hover:underline"
                  onClick={() => onOpenResource({
                    kind: kindToPlural(pool.nodeClassRef?.kind ?? 'EC2NodeClass'),
                    namespace: '',
                    name: pool.nodeClassRef?.name ?? '',
                    group: pool.nodeClassRef?.group ?? '',
                  })}
                >
                  {pool.nodeClassRef.name}
                </button>
              ) : <span className="text-sm text-theme-text-tertiary">Not configured</span>}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-theme-text-secondary">NodeClaims</span>
              <span className="font-mono text-sm text-theme-text-primary">{pool.nodeClaims.length}</span>
            </div>
            {pool.nodeClaims.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pool.nodeClaims.slice(0, 8).map((claim) => (
                  <Badge
                    key={claim.metadata?.name}
                    tone="structural"
                    size="sm"
                    onClick={() => onOpenResource({ kind: 'nodeclaims', namespace: '', name: claim.metadata?.name ?? '', group: 'karpenter.sh' })}
                  >
                    {claim.metadata?.name}
                  </Badge>
                ))}
                {pool.nodeClaims.length > 8 && <Badge tone="structural" size="sm">+{pool.nodeClaims.length - 8}</Badge>}
              </div>
            )}
          </div>
        </InspectorCard>
      </div>

      <div className="border-t border-theme-border px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-theme-text-primary">Nodes</h3>
            <p className="text-xs text-theme-text-tertiary">The concrete fleet behind this pool.</p>
          </div>
          <Badge tone="structural" size="sm">{pool.nodes.length}</Badge>
        </div>
        {pool.nodes.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-theme-border">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-theme-base/60 text-[11px] uppercase tracking-wide text-theme-text-tertiary">
                <tr><th className="px-3 py-2 font-medium">Node</th><th className="px-3 py-2 font-medium">State</th><th className="px-3 py-2 font-medium">Purchase</th><th className="px-3 py-2 font-medium">Instance</th><th className="px-3 py-2 font-medium">Zone</th><th className="px-3 py-2 font-medium">Actual usage</th></tr>
              </thead>
              <tbody className="table-divide-subtle">
                {pool.nodes.map((node) => (
                  <tr key={node.name} className="hover:bg-theme-hover/40">
                    <td className="px-3 py-2.5"><button className="font-medium text-accent-text hover:underline" onClick={() => onOpenResource({ kind: 'nodes', namespace: '', name: node.name, group: '' })}>{node.name}</button></td>
                    <td className="px-3 py-2.5"><Badge severity={!node.ready ? 'error' : node.cordoned ? 'warning' : 'success'} size="sm">{!node.ready ? 'Not Ready' : node.cordoned ? 'Cordoned' : 'Ready'}</Badge></td>
                    <td className="px-3 py-2.5"><Badge tone="accent1" size="sm">{node.capacityType}</Badge></td>
                    <td className="px-3 py-2.5 text-theme-text-secondary">{node.instanceType}</td>
                    <td className="px-3 py-2.5 text-theme-text-secondary">{node.zone}</td>
                    <td className="px-3 py-2.5 text-xs text-theme-text-secondary">{nodeUsageText(node)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-theme-border px-4 py-6 text-center text-sm text-theme-text-secondary">
            This NodePool has no provisioned Nodes right now. Karpenter will create them when unschedulable pod requests match its constraints.
          </div>
        )}
      </div>
    </section>
  )
}

function UsageDetail({ label, percent, used, total }: { label: string; percent: number | null; used: string; total: string }) {
  if (percent == null) return null
  return <div><div className="mb-1 text-xs font-medium text-theme-text-secondary">{label}</div><ResourceBar used={used} total={total} percent={percent} colorScheme="quiet" /></div>
}

function InspectorCard({ icon: Icon, title, detail, children }: { icon: typeof Cpu; title: string; detail: string; children: ReactNode }) {
  return (
    <div className="card-inner-lg">
      <div className="mb-3 flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" />
        <div><h3 className="text-sm font-medium text-theme-text-primary">{title}</h3><p className="text-xs text-theme-text-tertiary">{detail}</p></div>
      </div>
      {children}
    </div>
  )
}

function Breakdown({ title, values }: { title: string; values: CapacityBreakdown[] }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-theme-text-tertiary">{title}</div>
      <div className="flex flex-wrap gap-1">
        {values.length > 0 ? values.slice(0, 5).map((item) => <Badge key={item.value} tone="structural" size="sm">{item.value} · {item.count}</Badge>) : <span className="text-xs text-theme-text-tertiary">No nodes</span>}
      </div>
    </div>
  )
}

function EmptyState({ icon: Icon, title, detail }: { icon: typeof Gauge; title: string; detail: string }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-theme-base">
      <div className="max-w-md text-center">
        <Icon className="mx-auto h-9 w-9 text-theme-text-tertiary/50" />
        <h1 className="mt-3 text-lg font-medium text-theme-text-primary">{title}</h1>
        <p className="mt-1 text-sm text-theme-text-secondary">{detail}</p>
      </div>
    </div>
  )
}

function shortResourceLabel(resource: string): string {
  if (resource === 'memory') return 'MEM'
  if (resource === 'ephemeral-storage') return 'DISK'
  if (resource === 'nvidia.com/gpu') return 'GPU'
  return resource.slice(0, 4).toUpperCase()
}

function nodeUsageText(node: CapacityPool['nodes'][number]): string {
  if (!node.hasMetrics) return 'No live sample'
  const parts: string[] = []
  if (node.cpuAllocatable > 0) parts.push(`${Math.round((node.cpuUsage / node.cpuAllocatable) * 100)}% CPU`)
  if (node.memoryAllocatable > 0) parts.push(`${Math.round((node.memoryUsage / node.memoryAllocatable) * 100)}% memory`)
  return parts.join(' · ') || 'Live sample has no allocatable baseline'
}

function formatPressureQuantity(resource: string, quantity: string): string {
  if (resource === 'cpu') return parseCPUToNanocores(quantity) === 0 ? '0 cores' : formatCPUString(quantity)
  if (resource === 'memory') return formatMemoryString(quantity)
  return quantity
}
