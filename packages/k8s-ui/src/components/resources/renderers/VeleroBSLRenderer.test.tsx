import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { VeleroBSLRenderer } from './VeleroBSLRenderer'

const bsl = (phase: string) => ({
  metadata: { name: 'dr-replica', namespace: 'velero' },
  spec: { provider: 'aws', objectStorage: { bucket: 'dr' } },
  status: { phase },
})

const completed = (name: string, completedAt: string) => ({
  namespace: 'velero',
  name,
  phase: 'Completed',
  completed: completedAt,
})

/**
 * A storage location's phase is a fact about a bucket. What an operator opens the
 * page to learn is what that fact costs them, and the answer is the set of
 * backups they cannot restore from while it holds — every one of which Velero
 * still reports as Completed, accurately, because they did complete.
 */
describe('what a storage location holds', () => {
  it('says what an unavailable location is holding back', () => {
    const html = renderToString(
      <VeleroBSLRenderer
        data={bsl('Unavailable')}
        storedBackups={[completed('dr-nightly', '2026-08-14T01:00:00Z')]}
      />,
    )
    expect(html).toContain('not something you can restore from')
    expect(html).toContain('dr-nightly')
  })

  it('agrees in number', () => {
    const html = renderToString(
      <VeleroBSLRenderer
        data={bsl('Unavailable')}
        storedBackups={[
          completed('a', '2026-08-14T01:00:00Z'),
          completed('b', '2026-08-13T01:00:00Z'),
        ]}
      />,
    )
    expect(html).toContain('2 completed backups are stored here')
    expect(html).toContain('they are not something')
  })

  // The consequence belongs to a broken location. On a healthy one it would be
  // a warning about nothing.
  it('states no consequence when the location is available', () => {
    const html = renderToString(
      <VeleroBSLRenderer
        data={bsl('Available')}
        storedBackups={[completed('nightly', '2026-08-14T01:00:00Z')]}
      />,
    )
    expect(html).not.toContain('not something you can restore from')
    expect(html).toContain('nightly')
  })

  // Only a Completed backup is a restorable point; the rest are stored here but
  // are not something to go back to.
  it('does not count a failed backup as restorable', () => {
    const html = renderToString(
      <VeleroBSLRenderer
        data={bsl('Unavailable')}
        storedBackups={[
          completed('good', '2026-08-14T01:00:00Z'),
          { namespace: 'velero', name: 'bad', phase: 'Failed' },
        ]}
      />,
    )
    expect(html).toContain('1 completed backup is stored here')
  })

  // The distinction the whole feature rests on: not having looked is not the
  // same as having looked and found nothing.
  it('claims nothing while the lookup is unresolved', () => {
    const html = renderToString(<VeleroBSLRenderer data={bsl('Unavailable')} />)
    expect(html).not.toContain('No backup in this namespace names this location')
    expect(html).not.toContain('Stored Here')
  })

  it('says a location genuinely holds nothing when it does', () => {
    const html = renderToString(<VeleroBSLRenderer data={bsl('Available')} storedBackups={[]} />)
    expect(html).toContain('No backup in this namespace names this location')
  })
})
