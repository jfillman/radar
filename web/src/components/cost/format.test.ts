import { describe, expect, it } from 'vitest'
import {
  formatCostPerHour,
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
})
