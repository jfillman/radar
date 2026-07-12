import { describe, expect, it } from 'vitest'
import type { RightsizingRow } from '../../api/client'
import { getRequestFitExplanation, getRequestFitPresentation } from './RightsizingStrip'

const row = (overrides: Partial<RightsizingRow> = {}): RightsizingRow => ({
  container: 'server',
  resource: 'cpu',
  fit: 'balanced',
  confidence: 'high',
  sampleCount: 2016,
  expectedSamples: 2016,
  coverage: 1,
  hpaManaged: false,
  throttleAvailable: true,
  ...overrides,
})

describe('request-fit presentation', () => {
  it('keeps fit, confidence, and runtime risk as separate concepts', () => {
    expect(getRequestFitPresentation('oversized')).toEqual({ label: 'Oversized', severity: 'info' })
    expect(getRequestFitPresentation('under_requested')).toEqual({ label: 'Under-requested', severity: 'warning' })
    expect(getRequestFitPresentation('insufficient_history')).toEqual({ label: 'Insufficient history', severity: 'neutral' })
  })

  it('labels query failures independently from insufficient history', () => {
    expect(getRequestFitPresentation('insufficient_history', 'usage query failed')).toEqual({ label: 'Query failed', severity: 'error' })
  })

  it('explains why recommendations are withheld without inventing a zero-risk result', () => {
    expect(getRequestFitExplanation(row({ recommendationReason: 'hpa_managed' }))).toContain('HPA manages cpu')
    expect(getRequestFitExplanation(row({ resource: 'memory', recommendationReason: 'oom_evidence' }))).toContain('OOM evidence')
    expect(getRequestFitExplanation(row({ throttleAvailable: false }))).toContain('throttling metrics are unavailable')
  })

  it('does not revive the misleading efficiency vocabulary', () => {
    const copy = [
      getRequestFitPresentation('balanced').label,
      getRequestFitPresentation('oversized').label,
      getRequestFitExplanation(row({ recommendationReason: 'request_within_fit_range' })),
    ].join(' ').toLowerCase()
    expect(copy).not.toContain('efficien')
    expect(copy).not.toContain('waste')
  })
})
