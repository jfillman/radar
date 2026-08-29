import { describe, expect, it } from 'vitest'
import {
  claimDailyUpdateReport,
  completeDailyUpdateReport,
  createReportID,
  utcDay,
} from './update-report'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('daily browser update reports', () => {
  it('uses UTC days', () => {
    expect(utcDay(new Date('2026-08-29T23:59:59-07:00'))).toBe('2026-08-30')
  })

  it('creates a UUID when randomUUID is unavailable on plain HTTP origins', () => {
    const reportID = createReportID({
      fillRandom: array => {
        array.fill(0)
      },
    })
    expect(reportID).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('reports once after completion and starts a new report the next day', () => {
    const storage = memoryStorage()
    const first = claimDailyUpdateReport(storage, new Date('2026-08-29T10:00:00Z'), () => 'first')
    expect(first).toEqual({ reportDay: '2026-08-29', reportId: 'first' })
    completeDailyUpdateReport(storage, first!)

    expect(claimDailyUpdateReport(storage, new Date('2026-08-29T20:00:00Z'), () => 'unused')).toBeNull()
    expect(claimDailyUpdateReport(storage, new Date('2026-08-30T10:00:00Z'), () => 'second')).toEqual({
      reportDay: '2026-08-30',
      reportId: 'second',
    })
  })

  it('retries an unfinished report with the same id after ten minutes', () => {
    const storage = memoryStorage()
    const first = claimDailyUpdateReport(storage, new Date('2026-08-29T10:00:00Z'), () => 'stable-id')
    expect(claimDailyUpdateReport(storage, new Date('2026-08-29T10:05:00Z'), () => 'unused')).toBeNull()
    expect(claimDailyUpdateReport(storage, new Date('2026-08-29T10:11:00Z'), () => 'unused')).toEqual(first)
  })
})
