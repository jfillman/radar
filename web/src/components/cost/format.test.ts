import { describe, expect, it } from 'vitest'
import {
  formatCostPerHour,
  formatHistoricalSpend,
  formatProjectedDailyRate,
  formatProjectedMonthlyCost,
  formatProjectedMonthlyRate,
} from './format'

describe('cost formatters', () => {
  it('formats projected run rates from hourly allocation', () => {
    expect(formatProjectedDailyRate(0.1)).toBe('~$2.40/day')
    expect(formatProjectedMonthlyCost(1)).toBe('~$730.00')
    expect(formatProjectedMonthlyRate(0.1)).toBe('~$73.00/mo')
  })

  it('keeps hourly rates explicit', () => {
    expect(formatCostPerHour(0.1)).toBe('$0.100/hr')
  })

  it('does not turn insufficient history into zero spend', () => {
    expect(formatHistoricalSpend(1, 0, false)).toBe('—')
    expect(formatHistoricalSpend(2, 0, false)).toBe('$0.00')
    expect(formatHistoricalSpend(2, 1.25, false)).toBe('~$1.25')
    expect(formatHistoricalSpend(2, 1.25, true)).toBe('—')
  })
})
