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

/**
 * FailedValidation is the one outcome where Velero usually explains itself, in
 * status.failureReason. Radar's own sentence is the fallback for when it does
 * not — a run rejected before it started leaves no errors, no warnings and no
 * item counts, so without either the page is an empty red banner.
 */
describe('a run Velero refused to start', () => {
  const rejected = (failureReason?: string) => ({
    metadata: { name: 'live-rejected', namespace: 'velero' },
    spec: { storageLocation: 'dr-replica' },
    status: {
      phase: 'FailedValidation',
      ...(failureReason ? { failureReason } : {}),
      validationErrors: ['Backup storage location "dr-replica" is unavailable'],
    },
  })

  // Velero's own words beat ours whenever it supplies them.
  it('leads with the reason Velero gave', () => {
    const html = renderToString(
      <VeleroBackupRenderer data={rejected('backup storage location is in read-only mode')} />,
    )
    expect(html).toContain('backup storage location is in read-only mode')
    expect(html).not.toContain('Velero rejected this backup before it started')
  })

  it('says nothing was backed up when Velero gave no reason', () => {
    const html = renderToString(<VeleroBackupRenderer data={rejected()} />)
    expect(html).toContain('nothing was backed up')
    // The validation errors are the actionable half either way.
    expect(html).toContain('dr-replica&quot; is unavailable')
  })
})

/**
 * Velero resolves an unset spec.storageLocation to whichever location carries
 * spec.default, which is a flag and not a name. An install that renamed its
 * default location has no object called "default" at all, so resolving by name
 * finds nothing: the unavailable-location warning never appears and the link
 * points at something that does not exist.
 */
describe('a backup that names no location', () => {
  const unset = {
    metadata: { name: 'nightly', namespace: 'velero' },
    spec: { ttl: '720h0m0s' },
    status: { phase: 'Completed' },
  }

  it('links the location that actually holds it', () => {
    const html = renderToString(
      <VeleroBackupRenderer data={unset} storageLocationName="primary" onNavigate={() => {}} />,
    )
    expect(html).toContain('primary')
  })

  it('still warns when that location is the unavailable one', () => {
    const html = renderToString(
      <VeleroBackupRenderer data={unset} storageLocationName="primary" storageLocationPhase="Unavailable" />,
    )
    expect(html).toContain('nothing here to restore from')
  })

  // A host that does not resolve gets Velero's by-name fallback, which is right
  // on every install that did not rename it.
  it('falls back to the conventional name when the host does not resolve', () => {
    const html = renderToString(<VeleroBackupRenderer data={unset} onNavigate={() => {}} />)
    expect(html).toContain('default')
  })
})
