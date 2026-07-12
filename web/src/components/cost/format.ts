export const COST_HOURS_PER_DAY = 24
export const COST_HOURS_PER_MONTH = 730

export function formatCostAxis(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 1000) return `$${(value / 1000).toFixed(0)}k`
  if (value >= 1) return `$${value.toFixed(1)}`
  if (value >= 0.01) return `$${value.toFixed(2)}`
  if (value >= 0.0001) return `$${value.toFixed(4)}`
  if (value >= 0.00001) return `$${value.toFixed(5)}`
  return '<$0.00001'
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(3)}`
  if (value >= 0.0001) return `$${value.toFixed(4)}`
  return formatCostAxis(value)
}

export function formatCostPerHour(value: number): string {
  return `${formatCost(value)}/hr`
}

export function formatHistoricalSpend(pointCount: number, windowTotalCost: number, unavailable: boolean): string {
  if (unavailable || pointCount < 2) return '—'
  return windowTotalCost > 0 ? `~${formatCost(windowTotalCost)}` : formatCost(0)
}

export function formatProjectedDailyCost(hourlyCost: number): string {
  return `~${formatCost(hourlyCost * COST_HOURS_PER_DAY)}`
}

export function formatProjectedDailyRate(hourlyCost: number): string {
  return `${formatProjectedDailyCost(hourlyCost)}/day`
}

export function formatProjectedMonthlyCost(hourlyCost: number): string {
  return `~${formatCost(hourlyCost * COST_HOURS_PER_MONTH)}`
}

export function formatProjectedMonthlyRate(hourlyCost: number): string {
  return `${formatProjectedMonthlyCost(hourlyCost)}/mo`
}
