export function formatCostAxis(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 1000) return `$${(value / 1000).toFixed(0)}k`
  if (value >= 1) return `$${value.toFixed(1)}`
  if (value >= 0.01) return `$${value.toFixed(2)}`
  if (value >= 0.0001) return `$${value.toFixed(4)}`
  if (value >= 0.00001) return `$${value.toFixed(5)}`
  return '<$0.00001'
}
