import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { VeleroBackupRenderer } from './VeleroBackupRenderer'

const backup = (location: string) => ({
  metadata: { name: 'nightly', namespace: 'velero' },
  spec: { storageLocation: location, ttl: '720h0m0s' },
  status: { phase: 'Completed', startTimestamp: '2026-08-14T01:00:00Z' },
})

/**
 * A backup cannot see the bucket behind it. Its own status says Completed and
 * keeps saying it after the storage location goes Unavailable, which is exactly
 * when someone opens this page to ask whether they can restore to this point.
 */
describe('a backup whose storage location is unreachable', () => {
  it('says so on the backup, not one screen away', () => {
    const html = renderToString(
      <VeleroBackupRenderer data={backup('dr-replica')} storageLocationPhase="Unavailable" />,
    )
    expect(html).toContain('nothing here to restore from')
    expect(html).toContain('Unavailable')
  })

  // On a healthy location this would be a warning about nothing, on every backup
  // in the cluster.
  it('stays quiet when the location is fine', () => {
    const html = renderToString(
      <VeleroBackupRenderer data={backup('default')} storageLocationPhase="Available" />,
    )
    expect(html).not.toContain('nothing here to restore from')
  })

  // The distinction that matters: a location we have not read is not a healthy
  // one, and must not render as one.
  it('claims nothing while the lookup is unresolved', () => {
    const html = renderToString(<VeleroBackupRenderer data={backup('default')} />)
    expect(html).not.toContain('nothing here to restore from')
    expect(html).not.toContain('Unavailable')
  })
})
