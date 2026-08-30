// Task-dependency DAG for a Tekton Pipeline or PipelineRun. Lives only in
// the resource's fullscreen "full view" (wired via renderExpandedOverview in
// web/src/components/workload/WorkloadView.tsx) — never in the compact
// drawer, which has no room to render a DAG legibly.
//
// Layout uses the same ELK.js engine and options as the main Topology view
// (packages/k8s-ui/src/components/topology/layout.ts: layered, RIGHT,
// ORTHOGONAL edge routing, NETWORK_SIMPLEX placement) rather than a hand-
// rolled rank/row placement — NETWORK_SIMPLEX minimizes edge crossings,
// which a same-order placement does not, and that crossing-minimization is
// exactly what was missing (overlapping, hard-to-follow lines).
//
// Node cards intentionally mirror K8sResourceNode's visual language
// (topology-node-card CSS, icon + kind-label header row, status dot) so a
// task in this DAG reads as "the same kind of thing" as a node in the real
// Topology view, without extending the shared NodeKind enum or wiring
// Tekton into pkg/topology/builder.go — that stays a separate, larger PR.

import { memo, useEffect, useMemo, useState } from 'react'
import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import '../../topology/topology.css'
import { CheckCircle2, CircleDashed, ListTodo, Loader2, MinusCircle, XCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { healthToSeverity, SEVERITY_DOT } from '../../../utils/badge-colors'
import type { TektonTaskNode, TektonTaskNodeStatus } from '../resource-utils-tekton'

const NODE_WIDTH = 220
const NODE_HEIGHT = 66

const STATUS_ICON: Record<TektonTaskNodeStatus, typeof CheckCircle2> = {
  succeeded: CheckCircle2,
  failed: XCircle,
  running: Loader2,
  pending: CircleDashed,
  skipped: MinusCircle,
  unknown: CircleDashed,
}

// TektonTaskNodeStatus -> the same HealthStatus vocabulary K8sResourceNode's
// status dot uses, so a task's dot color means the same thing a topology
// node's dot color means.
const STATUS_HEALTH: Record<TektonTaskNodeStatus, 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'neutral'> = {
  succeeded: 'healthy',
  failed: 'unhealthy',
  running: 'neutral',
  pending: 'unknown',
  skipped: 'degraded',
  unknown: 'unknown',
}

const elkOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.spacing.nodeNode': '32',
  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
}

async function layoutNodes(tasks: TektonTaskNode[]): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const ELK = (await import('elkjs/lib/elk.bundled.js')).default
  const elk = new ELK()

  const byName = new Set(tasks.map((t) => t.name))
  const elkEdges = tasks.flatMap((task) =>
    task.dependsOn.filter((dep) => byName.has(dep)).map((dep) => ({
      id: `${dep}->${task.name}`,
      sources: [dep],
      targets: [task.name],
    })),
  )

  const result = await elk.layout({
    id: 'root',
    layoutOptions: elkOptions,
    children: tasks.map((t) => ({ id: t.name, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: elkEdges,
  } as any) as any

  const positionByName = new Map<string, { x: number; y: number }>(
    (result.children ?? []).map((c: any) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]),
  )

  const nodes: Node[] = tasks.map((task) => ({
    id: task.name,
    type: 'tektonTask',
    position: positionByName.get(task.name) ?? { x: 0, y: 0 },
    data: { task },
    draggable: false,
    selectable: true,
  }))

  const edges: Edge[] = elkEdges.map((e) => ({
    id: e.id,
    source: e.sources[0],
    target: e.targets[0],
    type: 'smoothstep',
    style: { stroke: '#64748b', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b', width: 16, height: 16 },
  }))

  return { nodes, edges }
}

interface TektonTaskCardData extends Record<string, unknown> {
  task: TektonTaskNode
  onClick?: (task: TektonTaskNode) => void
}

const TektonTaskCard = memo(function TektonTaskCard({ data }: NodeProps<Node<TektonTaskCardData>>) {
  const { task, onClick } = data
  const status = task.status ?? 'unknown'
  const Icon = STATUS_ICON[status]
  const severity = healthToSeverity(STATUS_HEALTH[status])
  const clickable = Boolean(onClick && task.taskRunName)
  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-0 !w-0 !border-0 !bg-transparent" />
      <div
        className={clsx(
          'topology-node-card relative rounded-lg bg-theme-surface transition-opacity',
          clickable && 'cursor-pointer hover:ring-1 hover:ring-skyhook-500/50',
          status === 'running' && 'animate-pulse',
        )}
        style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
        onClick={clickable ? () => onClick?.(task) : undefined}
        title={task.reason ? `${task.name} — ${task.reason}` : task.name}
      >
        <div className="px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5">
            <ListTodo className="h-3.5 w-3.5 shrink-0 text-theme-text-tertiary" aria-hidden />
            <span className="text-[10px] font-medium uppercase tracking-wide text-theme-text-tertiary">Task</span>
            <span className={clsx('ml-auto h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[severity])} />
          </div>
          <div className="flex items-center gap-1.5">
            <Icon className={clsx('h-3.5 w-3.5 shrink-0', status === 'running' && 'animate-spin', {
              'text-emerald-500': status === 'succeeded',
              'text-red-500': status === 'failed',
              'text-sky-500': status === 'running',
              'text-amber-500': status === 'skipped',
              'text-theme-text-tertiary': status === 'pending' || status === 'unknown',
            })} />
            <span className="truncate text-sm font-medium text-theme-text-primary">{task.name}</span>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-0 !w-0 !border-0 !bg-transparent" />
    </>
  )
})

const NODE_TYPES: NodeTypes = { tektonTask: TektonTaskCard }

export interface PipelineDagViewProps {
  tasks: TektonTaskNode[]
  height?: number
  onTaskClick?: (task: TektonTaskNode) => void
}

export function PipelineDagView({ tasks, height, onTaskClick }: PipelineDagViewProps) {
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null)
  const taskKey = useMemo(() => tasks.map((t) => `${t.name}:${t.dependsOn.join(',')}`).join('|'), [tasks])

  useEffect(() => {
    let cancelled = false
    layoutNodes(tasks).then((result) => {
      if (!cancelled) setLayout(result)
    })
    return () => { cancelled = true }
    // Re-layout when the task set or its dependency shape changes — not on
    // every status update, which would re-run ELK on every poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKey])

  // Status/taskRunName changes (live polling) update node data in place
  // without re-running layout — cheap, and keeps node positions stable
  // while a run progresses instead of jittering the graph every few seconds.
  const nodes = useMemo(() => {
    if (!layout) return []
    const byName = new Map(tasks.map((t) => [t.name, t]))
    return layout.nodes.map((n) => ({
      ...n,
      data: { task: byName.get(n.id) ?? (n.data as TektonTaskCardData).task, onClick: onTaskClick },
    }))
  }, [layout, tasks, onTaskClick])

  if (tasks.length === 0) return null

  return (
    <div
      className="h-full overflow-hidden rounded-md border border-theme-border bg-theme-base"
      style={height !== undefined ? { height } : undefined}
    >
      {!layout ? (
        <div className="flex h-full items-center justify-center text-sm text-theme-text-tertiary">
          Laying out task graph…
        </div>
      ) : (
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={layout.edges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.5 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnScroll
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          />
        </ReactFlowProvider>
      )}
    </div>
  )
}
