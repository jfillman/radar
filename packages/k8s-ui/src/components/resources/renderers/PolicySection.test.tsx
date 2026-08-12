import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { PolicySection } from './PolicySection'
import type { PolicyResourceResponse } from '../../../types/policy'

const base: PolicyResourceResponse = {
  evaluated: true,
  status: 'ready',
  liveUpdates: true,
  counts: { pass: 0, fail: 0, warn: 0, error: 0, skip: 0 },
  findings: [],
}
const resp = (over: Partial<PolicyResourceResponse>): PolicyResourceResponse => ({ ...base, ...over })

// React's server renderer splits interpolated values with <!-- --> markers, so
// assert on the visible text rather than raw markup.
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

// The unhappy paths carry this section. An empty finding list means several
// unrelated things, and rendering them all as blank space would tell an
// operator they are compliant in the cases where nothing was checked.
describe('PolicySection — what an empty result means', () => {
  it('says which rules failed when there are violations', () => {
    const html = renderToString(<PolicySection data={resp({
      counts: { pass: 2, fail: 1, warn: 0, error: 0, skip: 0 },
      findings: [{ policy: 'require-run-as-nonroot', result: 'fail', message: 'must set runAsNonRoot' }],
    })} />)
    expect(text(html)).toContain('require-run-as-nonroot')
    expect(text(html)).toContain('must set runAsNonRoot')
    // The passing checks are counted, not listed — otherwise two failures drown
    // in a wall of green on a heavily-policed workload.
    expect(text(html)).toContain('2 other checks passing')
  })

  it('distinguishes "everything passed" from "nothing was checked"', () => {
    const passing = renderToString(<PolicySection data={resp({
      counts: { pass: 5, fail: 0, warn: 0, error: 0, skip: 0 },
    })} />)
    expect(text(passing)).toContain('All 5 checks passing')

    const unchecked = renderToString(<PolicySection data={resp({})} />)
    expect(text(unchecked)).toContain('No policy applies')
    expect(text(unchecked)).not.toContain('passing')
  })

  it('never claims compliance when the results could not be read', () => {
    const html = renderToString(<PolicySection data={resp({
      evaluated: false, status: 'deferred', reasonCode: 'rbac_denied',
    })} />)
    expect(text(html)).toContain('has not been checked')
    expect(text(html)).toContain('rbac_denied')
    expect(text(html)).not.toContain('passing')
  })

  it('says results are still loading during warmup rather than reporting clean', () => {
    const html = renderToString(<PolicySection data={resp({ evaluated: false, status: 'warmup' })} />)
    expect(text(html)).toContain('still loading')
  })

  it('renders nothing at all when no policy engine is installed', () => {
    // A disclaimer on every cluster without a policy engine is pure noise.
    expect(renderToString(<PolicySection data={resp({ evaluated: false, status: 'not_installed' })} />)).toBe('')
    expect(renderToString(<PolicySection data={null} />)).toBe('')
  })
})

describe('PolicySection — partial coverage', () => {
  it('admits when some report families were unreadable, even while passing', () => {
    // "All checks passing" plus an unreadable family is a claim of coverage we
    // do not have.
    const html = renderToString(<PolicySection data={resp({
      counts: { pass: 3, fail: 0, warn: 0, error: 0, skip: 0 },
      deniedGroups: ['openreports.io'],
    })} />)
    expect(text(html)).toContain('All 3 checks passing')
    expect(text(html)).toContain('may be incomplete')
    expect(text(html)).toContain('openreports.io')
  })

  it('admits when the results are frozen', () => {
    const html = renderToString(<PolicySection data={resp({
      counts: { pass: 1, fail: 0, warn: 0, error: 0, skip: 0 }, liveUpdates: false,
    })} />)
    expect(text(html)).toContain('not updating live')
  })
})

describe('PolicySection — request states', () => {
  it('shows loading rather than an empty result', () => {
    expect(renderToString(<PolicySection data={null} loading />)).toContain('Loading policy results')
  })

  it('treats a permission denial as an expected state, not a red failure', () => {
    const denied = Object.assign(new Error('forbidden'), { status: 403 })
    const html = renderToString(<PolicySection data={null} error={denied} />)
    expect(text(html)).toContain('don’t have permission')
    expect(html).not.toContain('text-red')
  })

  it('keeps a genuine fault loud', () => {
    const html = renderToString(<PolicySection data={null} error={new Error('connection reset')} />)
    expect(text(html)).toContain('connection reset')
    expect(html).toContain('text-red')
  })
})
