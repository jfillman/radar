import { describe, expect, it, vi } from 'vitest'
import { fetchVersionInfo, type VersionInfo } from './client'

const VERSION: VersionInfo = {
  currentVersion: '1.2.3',
  latestVersion: '1.3.0',
  updateAvailable: true,
  installMethod: 'direct',
}

function dependencies(options: { report?: { reportDay: string; reportId: string } | null; failBrowser?: boolean } = {}) {
  const calls: Array<{ path: string; options?: RequestInit }> = []
  const complete = vi.fn()
  return {
    calls,
    complete,
    value: {
      fetch: async (path: string, requestOptions?: RequestInit) => {
        calls.push({ path, options: requestOptions })
        if (options.failBrowser && path === '/version-check/browser') throw new Error('offline')
        return VERSION
      },
      claim: async () => options.report ?? null,
      complete,
    },
  }
}

describe('fetchVersionInfo', () => {
  it('keeps local checks on the legacy cached endpoint', async () => {
    const deps = dependencies()
    await fetchVersionInfo('local', deps.value)
    expect(deps.calls.map(call => call.path)).toEqual(['/version-check'])
  })

  it('posts a claimed in-cluster report and completes it after success', async () => {
    const report = { reportDay: '2026-08-29', reportId: 'c66ce4e8-fb90-4e0e-a2af-2172bb868b9e' }
    const deps = dependencies({ report })
    await fetchVersionInfo('in-cluster', deps.value)
    expect(deps.calls.map(call => call.path)).toEqual(['/version-check/browser'])
    expect(deps.calls[0].options?.body).toBe(JSON.stringify(report))
    expect(deps.complete).toHaveBeenCalledWith(report)
  })

  it('uses release-only checks when already reported or when reporting fails', async () => {
    const withoutClaim = dependencies()
    await fetchVersionInfo('in-cluster', withoutClaim.value)
    expect(withoutClaim.calls.map(call => call.path)).toEqual(['/version-check/release'])

    const withFailure = dependencies({
      report: { reportDay: '2026-08-29', reportId: 'c66ce4e8-fb90-4e0e-a2af-2172bb868b9e' },
      failBrowser: true,
    })
    await fetchVersionInfo('in-cluster', withFailure.value)
    expect(withFailure.calls.map(call => call.path)).toEqual([
      '/version-check/browser',
      '/version-check/release',
    ])
    expect(withFailure.complete).not.toHaveBeenCalled()
  })
})
