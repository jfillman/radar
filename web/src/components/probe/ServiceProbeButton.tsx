import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Activity, Loader2, X, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { apiFetch } from '../../api/client'
import { apiUrl } from '../../api/config'
import { Tooltip } from '../ui/Tooltip'

// A port is "probe-able" only if it plausibly speaks HTTP — probing a raw TCP
// port (Postgres, Redis) with a GET returns noise, so we don't offer it there
// (that's the local-client TCP path's job). Heuristic over name/appProtocol/number.
const HTTP_PORT_NUMBERS = new Set([80, 443, 8080, 8443, 8000, 8081, 3000, 5000, 9090, 9091, 9093, 9100, 15000, 15090])
const HTTP_NAME_RE = /(^|[-_])(http|https|web|ui|console|dashboard|metrics|api|admin)([-_]|$)/i

export function isHttpishPort(port: number, name?: string, appProtocol?: string, protocol?: string): boolean {
  // HTTP rides TCP — a UDP port is never a GET target (e.g. statsd "metrics-udp").
  if ((protocol || '').toUpperCase() === 'UDP') return false
  const proto = (appProtocol || '').toLowerCase()
  if (proto === 'http' || proto === 'https' || proto === 'http2') return true
  if (proto && proto !== 'tcp') {
    // explicit non-HTTP appProtocol (grpc, redis, postgres, …) → not a GET target
    return false
  }
  if (name && HTTP_NAME_RE.test(name)) return true
  return HTTP_PORT_NUMBERS.has(port)
}

export function defaultScheme(port: number, name?: string, appProtocol?: string): 'http' | 'https' {
  if ((appProtocol || '').toLowerCase() === 'https') return 'https'
  if (port === 443 || port === 8443) return 'https'
  if (name && /https/i.test(name)) return 'https'
  return 'http'
}

interface ProbeResult {
  status: number
  durationMs: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  bodyBytes: number
  error?: string
}

function statusTone(status: number): string {
  if (status >= 200 && status < 300) return 'text-emerald-400'
  if (status >= 300 && status < 400) return 'text-blue-400'
  if (status >= 400 && status < 500) return 'text-amber-400'
  return 'text-red-400'
}

// Small toggle button rendered in a port row's action slot. The panel itself
// renders inline within the port card (see ProbePanel), not as an overlay.
export function ProbeButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <Tooltip content="Probe this endpoint — GET from inside the cluster">
      <button
        onClick={(e) => { e.stopPropagation(); onClick() }}
        aria-expanded={active}
        className={clsx(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors',
          active ? 'bg-accent-muted text-blue-400' : 'bg-theme-elevated hover:bg-accent-muted',
        )}
      >
        Probe
        <Activity className="w-3 h-3" />
      </button>
    </Tooltip>
  )
}

// Inline probe form + response. Renders in the drawer flow (inside the port
// card) rather than as a centered modal — the action is scoped to this port, so
// it stays in context instead of taking over the screen.
export function ProbePanel({
  namespace,
  serviceName,
  port,
  initialScheme,
  onClose,
}: {
  namespace: string
  serviceName: string
  port: number
  initialScheme: 'http' | 'https'
  onClose: () => void
}) {
  const [scheme, setScheme] = useState<'http' | 'https'>(initialScheme)
  const [path, setPath] = useState('/')
  const [showHeaders, setShowHeaders] = useState(false)

  const probe = useMutation<ProbeResult>({
    mutationFn: async () => {
      const res = await apiFetch(apiUrl('/probe/service'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace, name: serviceName, port: String(port), scheme, path }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
      return data as ProbeResult
    },
  })

  const result = probe.data

  return (
    <div className="mt-3 pt-3 border-t border-theme-border space-y-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-theme-text-secondary">
          <Activity className="w-3.5 h-3.5 text-blue-400" />
          Probe — GET from inside the cluster
        </span>
        <button
          onClick={onClose}
          aria-label="Close probe"
          className="p-0.5 text-theme-text-tertiary hover:text-theme-text-primary hover:bg-theme-elevated rounded"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <form className="flex items-stretch gap-2" onSubmit={(e) => { e.preventDefault(); probe.mutate() }}>
        <select
          value={scheme}
          onChange={(e) => setScheme(e.target.value as 'http' | 'https')}
          className="bg-theme-base border border-theme-border rounded px-2 py-1 text-xs text-theme-text-primary font-mono"
          aria-label="Scheme"
        >
          <option value="http">http</option>
          <option value="https">https</option>
        </select>
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/healthz"
          aria-label="Request path"
          className="flex-1 min-w-0 bg-theme-base border border-theme-border rounded px-2 py-1 text-xs text-theme-text-primary font-mono"
        />
        <button
          type="submit"
          disabled={probe.isPending}
          className="shrink-0 px-3 py-1 btn-brand text-xs rounded-lg flex items-center gap-1.5 disabled:opacity-50"
        >
          {probe.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
          Send
        </button>
      </form>

      {probe.isError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
          {(probe.error as Error).message}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs">
            <span className={clsx('font-mono font-semibold', statusTone(result.status))}>{result.status}</span>
            <span className="text-theme-text-tertiary">{result.durationMs} ms</span>
            <span className="text-theme-text-tertiary">{result.bodyBytes.toLocaleString()} bytes{result.truncated ? ' (truncated)' : ''}</span>
            <button
              type="button"
              onClick={() => setShowHeaders((v) => !v)}
              className="ml-auto flex items-center gap-1 text-theme-text-secondary hover:text-theme-text-primary"
            >
              Headers <ChevronDown className={clsx('w-3 h-3 transition-transform', showHeaders && 'rotate-180')} />
            </button>
          </div>

          {result.error && (
            <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
              {result.error}
            </div>
          )}

          {showHeaders && (
            <pre className="text-xs bg-theme-base rounded p-2 overflow-auto max-h-40 text-theme-text-secondary font-mono">
              {Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n') || '(no headers)'}
            </pre>
          )}

          {!result.error && (
            <pre className="text-xs bg-theme-base rounded p-2 overflow-auto max-h-64 text-theme-text-primary font-mono whitespace-pre-wrap break-words">
              {result.body || '(empty response body)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
