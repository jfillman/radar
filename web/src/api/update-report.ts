const STORAGE_KEY = 'radar-browser-update-report'
const RETRY_AFTER_MS = 10 * 60 * 1000
const LOCK_NAME = 'radar-browser-update-report'

interface StoredUpdateReport {
  day: string
  id: string
  state: 'pending' | 'done'
  lastAttemptAt: number
}

export interface DailyUpdateReport {
  reportDay: string
  reportId: string
}

interface RandomSource {
  randomUUID?: () => string
  fillRandom: (array: Uint8Array<ArrayBuffer>) => void
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function createReportID(source: RandomSource): string {
  if (source.randomUUID) return source.randomUUID()

  const bytes = new Uint8Array(16)
  source.fillRandom(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

export function claimDailyUpdateReport(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  now: Date,
  createID: () => string,
): DailyUpdateReport | null {
  const day = utcDay(now)
  const nowMs = now.getTime()

  let existing: StoredUpdateReport | undefined
  const raw = storage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      existing = JSON.parse(raw) as StoredUpdateReport
    } catch {
      existing = undefined
    }
  }

  if (existing?.day === day) {
    if (existing.state === 'done' || nowMs - existing.lastAttemptAt < RETRY_AFTER_MS) {
      return null
    }
    existing.lastAttemptAt = nowMs
    storage.setItem(STORAGE_KEY, JSON.stringify(existing))
    return { reportDay: day, reportId: existing.id }
  }

  const report: StoredUpdateReport = {
    day,
    id: createID(),
    state: 'pending',
    lastAttemptAt: nowMs,
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(report))
  return { reportDay: day, reportId: report.id }
}

export function completeDailyUpdateReport(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  report: DailyUpdateReport,
): void {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return

  const existing = JSON.parse(raw) as StoredUpdateReport
  if (existing.day !== report.reportDay || existing.id !== report.reportId) return
  existing.state = 'done'
  storage.setItem(STORAGE_KEY, JSON.stringify(existing))
}

export async function claimBrowserUpdateReport(): Promise<DailyUpdateReport | null> {
  const claim = () => {
    try {
      return claimDailyUpdateReport(localStorage, new Date(), () => createReportID({
        randomUUID: crypto.randomUUID?.bind(crypto),
        fillRandom: bytes => crypto.getRandomValues(bytes),
      }))
    } catch (error) {
      console.debug('[update-check] Browser report unavailable:', error)
      return null
    }
  }

  if (navigator.locks) {
    return navigator.locks.request(LOCK_NAME, claim)
  }
  return claim()
}

export function completeBrowserUpdateReport(report: DailyUpdateReport): void {
  try {
    completeDailyUpdateReport(localStorage, report)
  } catch {
    // Storage is best-effort. A later page load may retry this report.
  }
}
