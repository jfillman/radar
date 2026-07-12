import type { RequestFit, RequestFitScanResponse, RightsizingRow } from '../../api/client'

export type ScanClass = 'needs_review' | 'potential_reduction' | 'in_range' | 'need_data'
export type ScanSignal = 'hpa' | 'oom' | 'throttling' | 'query_error' | 'scaled_zero'

export interface RequestFitScanRow {
  id: string
  kind: string
  namespace: string
  name: string
  container: string
  cpu?: RightsizingRow
  memory?: RightsizingRow
  classification: ScanClass
  signals: Set<ScanSignal>
  scaledToZero: boolean
}

const CLASS_RANK: Record<ScanClass, number> = {
  needs_review: 0,
  potential_reduction: 1,
  need_data: 2,
  in_range: 3,
}

export function classifyRows(rows: RightsizingRow[]): ScanClass {
  if (rows.some((row) => row.fit === 'under_requested' || row.fit === 'missing_request' || row.hpaManaged || row.currentPodOOM || row.windowOomEvidence || row.limitConflict || (row.throttleRatio ?? 0) >= 0.1)) return 'needs_review'
  if (rows.some((row) => row.fit === 'oversized' && row.recommendedRequest)) return 'potential_reduction'
  if (rows.some((row) => row.queryError || row.fit === 'insufficient_history' || row.recommendationReason === 'hpa_evidence_unavailable' || row.recommendationReason === 'oom_evidence_unavailable')) return 'need_data'
  return 'in_range'
}

export function flattenScanResults(scan: RequestFitScanResponse): RequestFitScanRow[] {
  const result: RequestFitScanRow[] = []
  for (const workload of scan.workloads ?? []) {
    const byContainer = new Map<string, RightsizingRow[]>()
    for (const row of workload.rows ?? []) {
      const rows = byContainer.get(row.container) ?? []
      rows.push(row)
      byContainer.set(row.container, rows)
    }
    for (const [container, rows] of byContainer) {
      const signals = new Set<ScanSignal>()
      if (rows.some((row) => row.hpaManaged)) signals.add('hpa')
      if (rows.some((row) => row.currentPodOOM || row.windowOomEvidence)) signals.add('oom')
      if (rows.some((row) => (row.throttleRatio ?? 0) >= 0.1)) signals.add('throttling')
      if (rows.some((row) => row.queryError)) signals.add('query_error')
      if (workload.scaledToZero) signals.add('scaled_zero')
      result.push({
        id: `${workload.kind}/${workload.namespace}/${workload.name}/${container}`,
        kind: workload.kind,
        namespace: workload.namespace,
        name: workload.name,
        container,
        cpu: rows.find((row) => row.resource === 'cpu'),
        memory: rows.find((row) => row.resource === 'memory'),
        classification: classifyRows(rows),
        signals,
        scaledToZero: workload.scaledToZero,
      })
    }
  }
  return result.sort((a, b) => CLASS_RANK[a.classification] - CLASS_RANK[b.classification]
    || a.namespace.localeCompare(b.namespace)
    || a.name.localeCompare(b.name)
    || a.container.localeCompare(b.container))
}

export function scanClassCounts(rows: RequestFitScanRow[]): Record<ScanClass, number> {
  const counts: Record<ScanClass, number> = { needs_review: 0, potential_reduction: 0, in_range: 0, need_data: 0 }
  for (const row of rows) counts[row.classification]++
  return counts
}

export function fitLabel(fit?: RequestFit): string {
  if (!fit) return 'No result'
  return {
    balanced: 'In range',
    oversized: 'Oversized',
    under_requested: 'Under-requested',
    missing_request: 'Missing request',
    insufficient_history: 'Need data',
  }[fit]
}
