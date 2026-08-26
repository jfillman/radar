import { describe, expect, it } from 'vitest'

import { ErrorBoundary } from './ErrorBoundary'

// The reset contract, exercised through the static lifecycle hooks so it runs
// without a DOM. What this pins down is that navigating clears a caught error:
// React re-renders the same boundary instance rather than remounting it, so a
// boundary that only latched would keep the fallback on screen forever.
const derive = (resetKey: unknown, state: { hasError: boolean; error: Error | null; resetKey: unknown }) =>
  (ErrorBoundary as unknown as {
    getDerivedStateFromProps: (
      p: { children: null; resetKey: unknown },
      s: typeof state,
    ) => typeof state | null
  }).getDerivedStateFromProps({ children: null, resetKey }, state)

const caught = (resetKey: unknown) => ({
  hasError: true,
  error: new Error("Cannot read properties of undefined (reading 'nodeCount')"),
  resetKey,
})

describe('ErrorBoundary reset', () => {
  it('clears a caught error when resetKey changes', () => {
    const next = derive('/topology', caught('/'))
    expect(next).toEqual({ hasError: false, error: null, resetKey: '/topology' })
  })

  it('clears it when only a later path segment changes', () => {
    // mainView is just the first segment, so /resources/pods and
    // /resources/services are the same view. Keying on the view alone would
    // leave a crash under /resources trapping the user as they switch kinds.
    const next = derive('/resources/services', caught('/resources/pods'))
    expect(next?.hasError).toBe(false)
  })

  it('holds the error while resetKey is unchanged', () => {
    expect(derive('/', caught('/'))).toBeNull()
  })

  it('records the error', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('boom'))).toEqual({
      hasError: true,
      error: new Error('boom'),
    })
  })
})
