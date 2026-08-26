import { useEffect, useRef } from 'react'

export function useProgressiveRefresh(
  enabled: boolean,
  refresh?: () => void | Promise<unknown>,
  fastInterval = 2000,
  slowInterval = 15000,
  fastFor = 120000,
) {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const hasRefresh = Boolean(refresh)

  useEffect(() => {
    if (!enabled || !hasRefresh) return
    const startedAt = Date.now()
    let cancelled = false
    let timeout: number | undefined
    const schedule = () => {
      const delay = Date.now() - startedAt < fastFor ? fastInterval : slowInterval
      timeout = window.setTimeout(() => {
        void Promise.resolve()
          .then(() => refreshRef.current?.())
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) schedule()
          })
      }, delay)
    }
    schedule()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [enabled, fastFor, fastInterval, hasRefresh, slowInterval])
}
