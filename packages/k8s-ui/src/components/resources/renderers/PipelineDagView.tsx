// Embedded task-dependency DAG for a Tekton Pipeline or PipelineRun, shown
// inside the resource drawer rather than as a full-page topology. Reuses
// @xyflow/react (already loaded for the main Topology / GitOps tree views)
// at a small, fixed-height scale — a static diagram, not a pannable/zoomable
// canvas, since it lives inside a scrolling drawer rather than its own page.
//
// Layout is a hand-rolled longest-path rank/row placement (Kahn's algorithm),
// not ELK: Pipeline DAGs are shallow (a handful of ranks, rarely more than a
// dozen tasks), so pulling in ELK's async/worker layout engine for a widget
// this small would add complexity — nested-provider timing, a second layout
// pass — for no visible benefit over a synchronous longest-path placement.

import { memo, useMemo } from 'react'
import { Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CheckCircle2, CircleDashed, Loader2, MinusCircle, XCircle } from 'lucide-react'
import { clsx } from 'clsx'
import type { TektonTaskNode, TektonTaskNodeStatus } from '../resource-utils-tekton'

const RANK_GAP = 190
const ROW_GAP = 64
const NODE_WIDTH = 152

const STATUS_ICON: Record<TektonTaskNodeStatus, typeof CheckCircle2> = {
  succeeded: CheckCircle2,
  failed: XCircle,
  running: Loader2,
  pending: CircleDashed,
  skipped: MinusCircle,
  unknown: CircleDashed,
}

const STATUS_CLASS: Record<TektonTaskNodeStatus, string> = {
  succeeded: 'border-emerald-500/50 text-emerald-500',
  failed: 'border-red-500/50 text-red-500',
  running: 'border-sky-500/50 text-sky-500',
  pending: 'border-theme-border text-theme-text-tertiary',
  skipped: 'border-amber-500/50 text-amber-500',
  unknown: 'border-theme-border text-theme-text-tertiary',
}

// Longest-path ranking: a task's rank is one past the deepest dependency it
// has within this task set. Dependencies naming a task outside the set
// (shouldn't happen for a valid Pipeline, but the data is user-authored
// YAML) are ignored rather than crashing the layout.
function computeRanks(tasks: TektonTaskNode[]): Map<string, number> {
  const byName = new Map(tasks.map((t) => [t.name, t]))
  const rank = new Map<string, number>()
  const visiting = new Set<string>()

  function rankOf(name: string): number {
    const cached = rank.get(name)
    if (cached !== undefined) return cached
    const task = byName.get(name)
    if (!task) return 0
    if (visiting.has(name)) return 0 // cycle guard — Tekton rejects cyclic pipelines, but don't hang on bad data
    visiting.add(name)
    const deps = task.dependsOn.filter((d) => byName.has(d))
    const r = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(rankOf))
    visiting.delete(name)
    rank.set(name, r)
    return r
  }

  for (const t of tasks) rankOf(t.name)
  return rank
}

function layoutNodes(tasks: TektonTaskNode[]): { nodes: Node[]; edges: Edge[] } {
  const ranks = computeRanks(tasks)
  const rowByRank = new Map<number, number>()
  const nodes: Node[] = tasks.map((task) => {
    const r = ranks.get(task.name) ?? 0
    const row = rowByRank.get(r) ?? 0
    rowByRank.set(r, row + 1)
    return {
      id: task.name,
      type: 'tektonTask',
      position: { x: r * RANK_GAP, y: row * ROW_GAP },
      data: { task },
      draggable: false,
      selectable: false,
    }
  })
  const edges: Edge[] = tasks.flatMap((task) =>
    task.dependsOn
      .filter((dep) => ranks.has(dep))
      .map((dep) => ({
        id: `${dep}->${task.name}`,
        source: dep,
        target: task.name,
        type: 'smoothstep',
        style: { stroke: '#64748b' },
      })),
  )
  return { nodes, edges }
}

const TektonTaskNodeView = memo(function TektonTaskNodeView({ data }: NodeProps<Node<{ task: TektonTaskNode }>>) {
  const { task } = data
  const status = task.status ?? 'unknown'
  const Icon = STATUS_ICON[status]
  return (
    <div
      className={clsx(
        'rounded-md border bg-theme-surface px-2.5 py-1.5 shadow-sm',
        STATUS_CLASS[status],
      )}
      style={{ width: NODE_WIDTH }}
      title={task.reason ? `${task.name} — ${task.reason}` : task.name}
    >
      <Handle type="target" position={Position.Left} className="!h-0 !w-0 !border-0 !bg-transparent" />
      <div className="flex items-center gap-1.5">
        <Icon className={clsx('h-3.5 w-3.5 shrink-0', status === 'running' && 'animate-spin')} />
        <span className="truncate text-[11px] font-medium text-theme-text-primary">{task.name}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!h-0 !w-0 !border-0 !bg-transparent" />
    </div>
  )
})

const NODE_TYPES: NodeTypes = { tektonTask: TektonTaskNodeView }

export interface PipelineDagViewProps {
  tasks: TektonTaskNode[]
  height?: number
}

export function PipelineDagView({ tasks, height = 280 }: PipelineDagViewProps) {
  const { nodes, edges } = useMemo(() => layoutNodes(tasks), [tasks])

  if (tasks.length === 0) return null

  return (
    <div className="overflow-hidden rounded-md border border-theme-border" style={{ height }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.25 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </div>
  )
}
