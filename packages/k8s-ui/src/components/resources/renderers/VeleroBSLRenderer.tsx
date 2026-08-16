import { HardDrive, Clock, Archive } from 'lucide-react'
import { Section, PropertyList, Property, ConditionsSection, RelationshipGroup } from '../../ui/drawer-components'
import { TimeValue } from '../../ui/ScheduleValue'
import {
  getBSLStatus,
  getBSLProvider,
  getBSLBucket,
  getBSLPrefix,
  getBSLRegion,
  getBSLDefault,
  getBSLAccessMode,
  getBSLLastValidation,
  getBSLLastSynced,
} from '../resource-utils-velero'
import { VeleroPhaseValue } from './velero-cells'

/** One Backup held in this location, from the stored-backups lookup. */
export interface VeleroStoredBackup {
  namespace: string
  name: string
  phase?: string
  expiration?: string
  completed?: string
}

interface VeleroBSLRendererProps {
  data: any
  /**
   * What this location holds. Undefined means the lookup is unresolved — still
   * loading, failed, or not wired by this host — which is not the same as a
   * location holding nothing, and must not render as it.
   */
  storedBackups?: VeleroStoredBackup[]
  /** Rendered by the host when the lookup failed, so a denial is not silence. */
  lookupNote?: React.ReactNode
  onNavigate?: (ref: { kind: string; namespace: string; name: string; group?: string }) => void
}

export function VeleroBSLRenderer({ data, storedBackups, lookupNote, onNavigate }: VeleroBSLRendererProps) {
  const status = data.status || {}
  const conditions = status.conditions || []
  const bslStatus = getBSLStatus(data)
  const config = data.spec?.config || {}
  // Only a Completed backup is something to restore from; the rest are in the
  // list because they are stored here, not because they are usable.
  const restorable = (storedBackups ?? []).filter((b) => b.phase === 'Completed').length
  const newest = (storedBackups ?? [])
    .filter((b) => b.phase === 'Completed' && b.completed)
    .map((b) => b.completed as string)
    .sort()
    .pop()

  return (
    <>
      {/* Status section */}
      <Section title="Status" icon={Clock} defaultExpanded>
        <PropertyList>
          <Property label="Phase" value={
            <VeleroPhaseValue status={bslStatus} phase={status.phase || ''} />
          } />
          <Property label="Last Validation" value={getBSLLastValidation(data)} />
          <Property label="Last Synced" value={getBSLLastSynced(data)} />
          {status.lastSyncedRevision && (
            <Property label="Last Synced Revision" value={
              <span className="text-sm font-mono text-theme-text-secondary break-all">{status.lastSyncedRevision}</span>
            } />
          )}
        </PropertyList>
      </Section>

      {/* Provider section */}
      <Section title="Provider" icon={HardDrive} defaultExpanded>
        <PropertyList>
          <Property label="Provider" value={getBSLProvider(data)} />
          <Property label="Bucket" value={getBSLBucket(data)} />
          <Property label="Prefix" value={getBSLPrefix(data)} />
          <Property label="Region" value={getBSLRegion(data)} />
          <Property label="Access Mode" value={getBSLAccessMode(data)} />
          <Property label="Default" value={getBSLDefault(data) ? 'Yes' : 'No'} />
        </PropertyList>
        {Object.keys(config).length > 0 && (
          <div className="mt-2 pt-2 border-t border-theme-border">
            <div className="text-xs font-medium text-theme-text-secondary uppercase tracking-wider mb-1">Config</div>
            <div className="flex flex-wrap gap-1">
              {Object.entries(config).map(([k, v]) => (
                <span key={k} className="badge-sm bg-theme-hover text-theme-text-secondary">
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          </div>
        )}
      </Section>


      {/* What depends on this location.
          "Unavailable" is a fact about the bucket; the reason anyone opens this
          page is what it costs them, and that is the list of backups they cannot
          restore from while it stays that way. Velero keeps reporting those
          backups as Completed — accurately, they did complete — so the phase
          alone never shows the cost. */}
      {(storedBackups !== undefined || lookupNote) && (
        <Section title="Stored Here" icon={Archive} defaultExpanded={bslStatus.level !== 'healthy'}>
          {lookupNote}
          {storedBackups !== undefined && storedBackups.length === 0 && !lookupNote && (
            <div className="text-sm text-theme-text-tertiary">
              No backup in this namespace names this location.
            </div>
          )}
          {storedBackups !== undefined && storedBackups.length > 0 && (
            <>
              {bslStatus.level !== 'healthy' && restorable > 0 && (
                <div className="text-xs text-warning-text mb-2">
                  {`${restorable} completed ${restorable === 1 ? 'backup is' : 'backups are'} stored here. While this location is ${bslStatus.text}, ${restorable === 1 ? 'it is' : 'they are'} not something you can restore from.`}
                </div>
              )}
              <RelationshipGroup
                label="Backups"
                refs={storedBackups.map((b) => ({
                  kind: 'Backup',
                  namespace: b.namespace,
                  name: b.name,
                  group: 'velero.io',
                }))}
                onNavigate={onNavigate}
              />
              {newest && (
                <div className="mt-2 pt-2 border-t border-theme-border text-xs text-theme-text-secondary">
                  {/* The question this page is opened to answer. */}
                  Most recent restorable point: <TimeValue timestamp={newest} /> ago
                </div>
              )}
            </>
          )}
        </Section>
      )}

      <ConditionsSection conditions={conditions} />
    </>
  )
}
