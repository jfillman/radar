import { useCallback, useEffect, useMemo, useState } from 'react'
import { LogCore, useLogBuffer, parseLogLine, type DownloadFormat } from '@skyhook-io/k8s-ui'
import { fetchJSON } from '../../api/client'
import { triggerDownload } from '@skyhook-io/k8s-ui/utils/download'
import { useDesktopDownload } from '../../hooks/useDesktopDownload'
import { useToast } from '../ui/Toast'

interface TaskRunLogsTabProps {
  namespace: string
  resource: any
}

// A TaskRun has exactly one pod with one container per step (Tekton names
// them `step-<name>`), running sequentially — the opposite shape of the
// generic MultiPodLogsTab (built for N-pod workloads picking one pod at a
// time). This fetches every step's container in one call and combines them
// into a single sequential view in declared step order, labeling each line
// by step instead of making the user pick a container.
export function TaskRunLogsTab({ namespace, resource }: TaskRunLogsTabProps) {
  const podName = resource?.status?.podName as string | undefined
  const stepNames = useMemo(
    () => ((resource?.status?.steps ?? []) as Array<{ name: string }>).map((s) => `step-${s.name}`),
    [resource],
  )
  const { entries, set, clear } = useLogBuffer()
  const [isLoading, setIsLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const desktopDownload = useDesktopDownload()
  const { showError, showSuccess } = useToast()

  const load = useCallback(async () => {
    if (!podName) return
    setIsLoading(true)
    setFetchError(null)
    try {
      const data = await fetchJSON<{ logs: Record<string, string> }>(`/pods/${namespace}/${podName}/logs`)
      const combined = stepNames.flatMap((container) => {
        const raw = data.logs?.[container]
        if (!raw) return []
        return raw.split('\n').filter(Boolean).map((line) => {
          const { timestamp, content } = parseLogLine(line)
          return { timestamp, content, container }
        })
      })
      set(combined)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to fetch logs')
    } finally {
      setIsLoading(false)
    }
  }, [namespace, podName, stepNames, set])

  useEffect(() => { load() }, [load])

  const downloadLogs = useCallback((format: DownloadFormat) => {
    const filename = `${podName ?? 'taskrun'}-logs.${format}`
    let content: string
    let mime: string
    switch (format) {
      case 'json':
        content = JSON.stringify(entries.map((e) => ({ timestamp: e.timestamp, step: e.container, content: e.content })), null, 2)
        mime = 'application/json'
        break
      case 'csv':
        content = 'timestamp,step,content\n' + entries.map((e) =>
          `${e.timestamp},${e.container},"${e.content.replace(/"/g, '""')}"`).join('\n')
        mime = 'text/csv'
        break
      default:
        content = entries.map((e) => `${e.timestamp} [${e.container}] ${e.content}`).join('\n')
        mime = 'text/plain'
    }
    try {
      triggerDownload(content, mime, filename, desktopDownload)
      if (!desktopDownload) showSuccess('Log download started', `Saving ${filename}. Check your browser Downloads.`)
    } catch (err) {
      showError('Failed to download logs', err instanceof Error ? err.message : 'Unknown download error')
    }
  }, [entries, podName, desktopDownload, showError, showSuccess])

  if (!podName) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-theme-text-tertiary">
        No pod recorded for this TaskRun (it may have been garbage-collected after completion).
      </div>
    )
  }

  return (
    <LogCore
      entries={entries}
      isLoading={isLoading}
      isStreaming={false}
      onStopStream={() => {}}
      onRefresh={load}
      onDownload={downloadLogs}
      onClear={clear}
      showContainerName
      emptyMessage="No step logs available"
      errorMessage={fetchError}
    />
  )
}
