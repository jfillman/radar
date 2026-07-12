import { describe, expect, it } from 'vitest'
import type { RequestFitScanResponse, RightsizingRow } from '../../api/client'
import { classifyRows, flattenScanResults, scanClassCounts } from './model'

function metric(overrides: Partial<RightsizingRow> = {}): RightsizingRow {
  return {
    container: 'app', resource: 'cpu', fit: 'balanced', confidence: 'high',
    sampleCount: 2016, expectedSamples: 2016, coverage: 1, hpaManaged: false,
    hpaEvidenceAvailable: true, oomEvidenceAvailable: true,
    ...overrides,
  }
}

function response(rows: RightsizingRow[]): RequestFitScanResponse {
  return {
    state: 'complete', scannedAt: '2026-07-12T10:00:00Z', window: '7d', source: 'radar',
    summary: { workloads: 1, actionableWorkloads: 0, recommendations: 0, fit: { balanced: 2, oversized: 0, underRequested: 0, missingRequest: 0, insufficientHistory: 0, queryErrors: 0, throttled: 0, oomEvidence: 0 } },
    coverage: { workloadsDiscovered: 1, workloadsEvaluated: 1, workloadsWithData: 1, batches: 1, completedBatches: 1 },
    workloads: [{ kind: 'Deployment', namespace: 'shop', name: 'api', scaledToZero: false, rows }],
  }
}

describe('request-fit scan model', () => {
  it('prioritizes safety and missing requests over reductions', () => {
    expect(classifyRows([metric({ fit: 'oversized' }), metric({ resource: 'memory', fit: 'missing_request' })])).toBe('needs_review')
    expect(classifyRows([metric({ fit: 'oversized', recommendedRequest: '115m' })])).toBe('potential_reduction')
  })

  it('keeps incomplete evidence out of the in-range bucket', () => {
    expect(classifyRows([metric({ fit: 'insufficient_history' })])).toBe('need_data')
    expect(classifyRows([metric({ queryError: 'query failed' })])).toBe('need_data')
    expect(classifyRows([metric({ fit: 'oversized', recommendationReason: 'hpa_evidence_unavailable' })])).toBe('need_data')
    expect(classifyRows([metric({ resource: 'memory', fit: 'oversized', recommendationReason: 'oom_evidence_unavailable' })])).toBe('need_data')
    expect(classifyRows([metric({ fit: 'oversized', hpaManaged: true })])).toBe('needs_review')
  })

  it('groups CPU and memory into one container result and records safety signals', () => {
    const rows = flattenScanResults(response([
      metric({ throttleRatio: 0.2 }),
      metric({ resource: 'memory', currentPodOOM: true }),
    ]))
    expect(rows).toHaveLength(1)
    expect(rows[0].cpu?.resource).toBe('cpu')
    expect(rows[0].memory?.resource).toBe('memory')
    expect(rows[0].signals).toEqual(new Set(['oom', 'throttling']))
    expect(scanClassCounts(rows).needs_review).toBe(1)
  })
})
