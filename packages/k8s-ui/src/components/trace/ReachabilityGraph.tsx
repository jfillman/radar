import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { PILL_MAX_PX, type GraphModel, type GraphNode, type GraphEdge, type LaneBox } from './reachGraphModel'
import { markStyle, glyphStyle, SEV_COLOR, MARK_LEGEND, type Mark } from './reachMarks'

/** Upper bound on scale-up. Past this the graph stops reading as a diagram and
 *  starts reading as zoomed-in text. */
const MAX_SCALE = 1.5
/** Lower bound on scale-down. Shrinking a dense graph to fit a narrow column
 *  makes every label illegible, which is a worse outcome than a scrollbar - so
 *  below this the canvas keeps its size and the column scrolls instead. */
const MIN_SCALE = 0.82

/**
 * Fits the fixed design canvas to whatever width the column actually has.
 *
 * The geometry is hand-laid and must stay proportional - reflowing node
 * positions per breakpoint would destroy the spatial mapping the view teaches.
 * Scaling the whole canvas keeps that mapping while still using the full
 * column, in both directions: narrow columns shrink it instead of showing a
 * scrollbar, wide ones grow it instead of stranding dead space.
 */
function useFit(canvasW: number, canvasH: number): [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Subtract the inset the canvas is positioned at, so a scaled-up graph does
    // not run under the column's edges.
    const measure = () => setBox({ w: el.clientWidth - 16, h: el.clientHeight - 12 })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Fit to whichever axis binds, so a tall pane grows the graph instead of
  // leaving the space empty.
  const raw = box.w > 0 && box.h > 0 ? Math.min(box.w / canvasW, box.h / canvasH) : 1
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw))
  // Available height expressed in canvas units, so the dataplane band can be
  // stretched to fill the pane rather than hugging its content.
  return [ref, scale, box.h > 0 ? box.h / scale : canvasH]
}

/**
 * The laned canvas. Nodes are absolutely positioned HTML over an SVG edge layer
 * so they can carry real typography and pinned anomalies - an all-SVG graph
 * would force text metrics we cannot control across themes.
 *
 * The canvas is a fixed design size inside a scroll container rather than a
 * fluid one: the layout encodes reading order (origin left, delivery right) and
 * a responsive reflow would break the very spatial mapping it exists to teach.
 */
export function ReachabilityGraph({
  model,
  selected,
  onSelect,
}: {
  model: GraphModel
  selected?: string
  onSelect: (id: string) => void
}) {
  const { canvas, laneControl, laneData } = model
  const [fitRef, scale, availH] = useFit(canvas.w, canvas.h)
  // A lane is "these nodes", not "this region" - stretching it to the pane left
  // a tall empty box with the path pinned to its top edge. The card fills the
  // height; the graph is optically centred within its column instead.
  void availH
  return (
    <div className="flex h-full min-w-0 flex-col bg-theme-base">
      {/* The path is wide and short, so the space is used by SCALING the graph
          up to whichever axis binds - not by stretching the lane, which just
          floats the content in an empty band. Whatever height is left over is
          split evenly by centring.

          No minHeight on the measured element: the ResizeObserver watches it,
          so sizing it from a scale derived from its own height was a feedback
          loop that ratcheted the graph up to the cap. flex-1 inside a
          full-height column already gives it a definite height. */}
      <div
        ref={fitRef}
        className="flex min-h-0 min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden px-2 py-1.5"
      >
        <div className="relative shrink-0" style={{ width: canvas.w * scale, height: canvas.h * scale }}>
        <div
          className="absolute left-0 top-0"
          style={{ width: canvas.w, height: canvas.h, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
        {laneControl && <Lane box={laneControl} />}
        {laneData && <Lane box={laneData} />}
        <div>
        <svg width={canvas.w} height={canvas.h} viewBox={`0 0 ${canvas.w} ${canvas.h}`} className="absolute inset-0" style={{ overflow: 'visible' }}>
          {model.brackets.map((b, i) => (
            <path key={i} d={b.d} fill="none" stroke="var(--border-default)" strokeWidth={1} strokeDasharray="3 3" />
          ))}
          {model.edges.map((e) => {
            const s = markStyle(e.mark)
            return (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                stroke={s.color}
                strokeWidth={selected === e.id ? s.strokeWidth + 1 : s.strokeWidth}
                strokeDasharray={s.dash}
                strokeOpacity={s.strokeOpacity}
                strokeLinecap="round"
              />
            )
          })}
        </svg>
        {model.edges.map((e) => (
          <EdgePill key={e.id} edge={e} />
        ))}
        {model.nodes.map((n) => (
          <Node key={n.id} node={n} selected={selected === n.id} onSelect={onSelect} />
        ))}
        </div>
        </div>
        </div>
      </div>
      <Legend model={model} />
    </div>
  )
}

function Lane({ box }: { box: LaneBox }) {
  return (
    <>
      <div
        className="absolute rounded-[10px]"
        style={{
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          border: box.dashed ? '1px dashed var(--border-default)' : '1px solid var(--border-subtle)',
          background: `color-mix(in srgb, ${box.color} 4%, transparent)`,
          zIndex: 0,
        }}
      />
      {/* Sibling of the box, not a child: a lane that bounds one narrow node is
          far narrower than its label, and as a child the label was clipped by
          the box. */}
      <span
        className="absolute whitespace-nowrap px-1.5 text-[9px] font-bold tracking-[0.06em] bg-theme-base"
        style={{ left: box.x + 12, top: box.y - 8, color: box.color, zIndex: 4 }}
      >
        {box.label}
      </span>
    </>
  )
}

/** Passive. There is no segment-local evidence behind an edge, so clicking one
 *  could only repeat the path result the sidebar already shows permanently. */
function EdgePill({ edge }: { edge: GraphEdge }) {
  const s = markStyle(edge.mark)
  return (
    <div
      title={edge.title}
      className="absolute flex items-center gap-1 rounded-full border border-theme-border bg-theme-surface px-2 py-0.5 text-[10px] font-semibold text-theme-text-secondary"
      style={{
        left: edge.px,
        top: edge.py,
        transform: 'translate(-50%,-50%)',
        zIndex: 3,
        maxWidth: PILL_MAX_PX,
        boxShadow: '0 1px 2px rgba(0,0,0,.05)',
      }}
    >
      <span style={glyphStyle(edge.mark)}>{s.glyph}</span>
      <span className="truncate">{edge.label}</span>
    </div>
  )
}

function Node({ node, selected, onSelect }: { node: GraphNode; selected: boolean; onSelect: (id: string) => void }) {
  const isOrigin = node.isOrigin
  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.w,
    // Pin to the height the layout reserved, so a box can never grow past its
    // slot and collide with the row beneath it.
    minHeight: node.h,
    zIndex: isOrigin ? 3 : 2,
    background: isOrigin ? 'var(--bg-elevated)' : 'var(--bg-surface)',
    // The origin is a vantage point, not a Kubernetes object. The dashed
    // capsule is what keeps those two categories from reading as one kind.
    borderRadius: isOrigin ? 22 : 9,
    border: selected
      ? '1.5px solid var(--accent)'
      : isOrigin
        ? `1.5px dashed ${node.lane === 'control' ? 'var(--color-info)' : 'var(--accent)'}`
        : '1px solid var(--border-default)',
    boxShadow: selected ? '0 0 0 3px var(--accent-muted)' : isOrigin ? 'none' : '0 1px 2px rgba(0,0,0,.05)',
    opacity: node.dim ? 0.5 : 1,
  }
  return (
    <button type="button" onClick={() => onSelect(node.id)} className="absolute cursor-pointer px-2.5 py-1.5 text-left" style={style}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[8.5px] font-bold tracking-[0.06em] text-theme-text-tertiary">{node.kind}</span>
        {node.tag && <TinyTag text={node.tag} tone={node.lane === 'control' ? 'var(--color-info)' : 'var(--color-warning-dark)'} />}
        {!isOrigin && (
          <span
            className="inline-block shrink-0 rounded-full"
            style={{ width: 8, height: 8, background: SEV_COLOR[node.tone] }}
            aria-label={`health ${node.tone}`}
          />
        )}
      </div>
      <div className="mt-0.5 truncate font-mono text-[11.5px] font-semibold text-theme-text-primary">{node.name}</div>
      <div className="mt-px text-[10px] leading-[1.35] text-theme-text-tertiary">{node.sub}</div>
      {node.anomalies && node.anomalies.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5 border-t border-theme-border-subtle pt-1.5">
          {node.anomalies.map((a, i) => (
            <div key={i} className="flex items-baseline gap-1.5">
              <span style={glyphStyle(a.mark)}>{markStyle(a.mark).glyph}</span>
              <span className="text-[9.5px] leading-[1.35] text-theme-text-secondary">{a.text}</span>
            </div>
          ))}
        </div>
      )}
      {/* Per-endpoint delivery, as rows rather than a column of boxes - same
          truth, a fraction of the width, and more of them visible at once. */}
      {node.podRows && node.podRows.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5 border-t border-theme-border-subtle pt-1.5">
          {node.podRows.map((r) => (
            <div key={r.name} className="flex items-baseline gap-1.5" title={`${r.name} — ${r.detail}`}>
              <span style={glyphStyle(r.mark)}>{markStyle(r.mark).glyph}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-theme-text-secondary">{r.name}</span>
              <span className="shrink-0 text-[9px] text-theme-text-tertiary">{r.detail}</span>
            </div>
          ))}
          {!!node.moreRows && <div className="text-[9px] text-theme-text-tertiary">+{node.moreRows} more not shown</div>}
        </div>
      )}
    </button>
  )
}

export function TinyTag({ text, tone }: { text: string; tone: string }) {
  return (
    <span
      className="whitespace-nowrap rounded-full px-1.5 py-px text-[8.5px] font-bold tracking-[0.05em]"
      style={{
        color: tone,
        border: `1px solid ${tone}`,
        // Opaque, not tinted-transparent: the origin capsule's dashed border ran
        // straight through the tag when this let the backdrop show.
        background: `color-mix(in srgb, ${tone} 10%, var(--bg-elevated))`,
      }}
    >
      {text}
    </span>
  )
}

/** Only the marks actually on screen. The full vocabulary is nine symbols;
 *  listing marks this trace never uses is vocabulary the reader has to skip. */
function Legend({ model }: { model: GraphModel }) {
  const present = new Set<Mark>([
    ...model.edges.map((e) => e.mark),
    ...model.nodes.flatMap((n) => [...(n.anomalies ?? []).map((a) => a.mark), ...(n.podRows ?? []).map((r) => r.mark)]),
  ])
  const shown = MARK_LEGEND.filter((l) => present.has(l.mark))
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-theme-border-subtle px-3.5 py-2 text-[10.5px] text-theme-text-tertiary">
      {shown.map((l) => (
        <span key={l.mark} className="inline-flex items-baseline gap-1">
          <span style={glyphStyle(l.mark as Mark)}>{markStyle(l.mark as Mark).glyph}</span>
          {l.text}
        </span>
      ))}
      <div className="flex-1" />
      <span className="italic">dot = is the resource healthy · line = did traffic get through, from the selected vantage</span>
    </div>
  )
}
