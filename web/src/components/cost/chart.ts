import type { OpenCostTrendDataPoint } from '../../api/client'

export function buildLineChart(points: OpenCostTrendDataPoint[]) {
  if (points.length < 2) return null
  const width = 720
  const height = 240
  const left = 44
  const right = 16
  const top = 14
  const bottom = 28
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const minTs = points[0].timestamp
  const maxTs = points[points.length - 1].timestamp
  if (maxTs <= minTs) return null
  const maxValue = Math.max(...points.map((p) => p.value), 0)
  const yMax = maxValue > 0 ? maxValue * 1.15 : 1
  const toX = (ts: number) => left + ((ts - minTs) / (maxTs - minTs)) * plotWidth
  const toY = (value: number) => top + plotHeight - (value / yMax) * plotHeight
  const coords = points.map((p) => [toX(p.timestamp), toY(p.value)] as const)
  const linePath = coords.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const baseline = top + plotHeight
  const areaPath = `${linePath} L ${coords[coords.length - 1][0].toFixed(1)} ${baseline.toFixed(1)} L ${coords[0][0].toFixed(1)} ${baseline.toFixed(1)} Z`
  const yTicks = [0, 0.5, 1].map((pct) => ({
    value: yMax * pct,
    y: top + plotHeight - pct * plotHeight,
  }))
  return { linePath, areaPath, yTicks }
}

export function formatChartTime(timestamp?: number) {
  if (!timestamp) return ''
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
  })
}
