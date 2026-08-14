import { Archive, Clock, HardDrive } from 'lucide-react'
import { clsx } from 'clsx'
import { Section, PropertyList, Property, AlertBanner, ResourceLink } from '../../ui/drawer-components'
import { HEALTH_BADGE_COLORS } from '../../../utils/badge-colors'
import { formatAge } from '../resource-utils'
import {
  getCNPGObjectStoreProvider,
  getCNPGObjectStoreCredentialSecret,
  getCNPGObjectStoreRecoveryWindows,
  getCNPGObjectStoreDestination,
  getCNPGObjectStoreRetention,
  type CNPGObjectStoreRecoveryWindow,
} from '../resource-utils-cnpg'

/**
 * ObjectStore (barmancloud.cnpg.io/v1) — where a plugin-backed CNPG Cluster's
 * backups actually live.
 *
 * The Cluster page already tells operators the recovery window is tracked here,
 * because a plugin-backed Cluster stops publishing recovery-point fields of its
 * own. Until this renderer existed that sentence pointed at a page showing raw
 * fields, so the restorable range was effectively unreachable in the product.
 */
/**
 * A recovery point, stated absolutely with the interval beside it.
 *
 * "1d ago" is the wrong unit for this question. An RPO conversation needs a
 * timestamp — and "Last Successful Backup 1d ago" next to "Last Failed Attempt
 * 1d ago" is the same string for events a week apart in the failure history,
 * which is precisely when you are reading this screen. Same treatment the
 * certificate rows already use.
 */
function RecoveryTime({ at }: { at: string }) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return <>{at}</>
  return (
    <span className="inline-flex items-baseline gap-2 min-w-0">
      <span>{d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</span>
      <span className="text-xs text-theme-text-tertiary shrink-0">{formatAge(at)} ago</span>
    </span>
  )
}

export function CNPGObjectStoreRenderer({
  data,
  clusterNames,
  onNavigate,
}: {
  data: any
  /** Cluster names that exist in this namespace, so a server key is only linked
   *  when there is something behind it. See RecoveryWindowRow. */
  clusterNames?: Set<string>
  onNavigate?: (ref: { kind: string; namespace: string; name: string; group?: string }) => void
}) {
  const windows = getCNPGObjectStoreRecoveryWindows(data)
  const provider = getCNPGObjectStoreProvider(data)
  const retention = getCNPGObjectStoreRetention(data)
  const credentialSecret = getCNPGObjectStoreCredentialSecret(data)
  const cfg = data?.spec?.configuration ?? {}
  const failing = windows.filter((w) => w.failingSinceLastSuccess)

  return (
    <>
      {failing.length > 0 && (
        <AlertBanner
          variant="error"
          title={`Backups failing for ${failing.length === 1 ? failing[0].server : `${failing.length} servers`}`}
          message="The most recent backup attempt failed after the last success, so the recoverable range has stopped moving forward."
        />
      )}

      <Section title="Recovery Window" icon={Clock} defaultExpanded>
        {windows.length === 0 ? (
          // Configured but empty is NOT the same as healthy. Saying nothing here
          // would read as "backups are fine" on a store holding nothing.
          <div className="text-sm text-theme-text-secondary">
            No server has reported a backup yet, so there is nothing to restore from this store.
          </div>
        ) : (
          <div className="space-y-2">
            {windows.map((w) => (
              <RecoveryWindowRow
                clusterNames={clusterNames}
                key={w.server}
                window={w}
                retention={retention}
                namespace={data?.metadata?.namespace ?? ''}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Destination" icon={Archive} defaultExpanded>
        <PropertyList>
          <Property label="Path" value={getCNPGObjectStoreDestination(data)} />
          {cfg.endpointURL && <Property label="Endpoint" value={cfg.endpointURL} />}
          {/* Only when set — a custom CA is the difference between "cannot reach
              the bucket" and "does not trust it", and it is otherwise invisible. */}
          {(cfg.endpointCA?.name || cfg.endpointCA?.key) && (
            <Property
              label="Endpoint CA"
              value={cfg.endpointCA?.name ? `${cfg.endpointCA.name}${cfg.endpointCA.key ? ` · ${cfg.endpointCA.key}` : ''}` : cfg.endpointCA.key}
            />
          )}
          {provider && <Property label="Provider" value={provider} />}
          {credentialSecret && (
            <Property
              label="Credentials"
              value={
                <ResourceLink
                  name={credentialSecret}
                  kind="secrets"
                  namespace={data?.metadata?.namespace ?? ''}
                  onNavigate={onNavigate}
                />
              }
            />
          )}
          {cfg.serverName && <Property label="Server Name" value={cfg.serverName} />}
          {retention && <Property label="Retention" value={retention} />}
        </PropertyList>
      </Section>

      {(cfg.wal || cfg.data) && (
        <Section title="Backup Settings" icon={HardDrive} defaultExpanded={false}>
          <PropertyList>
            {cfg.wal?.compression && <Property label="WAL Compression" value={cfg.wal.compression} />}
            {cfg.wal?.encryption && <Property label="WAL Encryption" value={cfg.wal.encryption} />}
            {cfg.wal?.maxParallel != null && (
              <Property label="WAL Max Parallel" value={String(cfg.wal.maxParallel)} />
            )}
            {cfg.data?.compression && <Property label="Data Compression" value={cfg.data.compression} />}
            {cfg.data?.encryption && <Property label="Data Encryption" value={cfg.data.encryption} />}
            {cfg.data?.jobs != null && <Property label="Data Jobs" value={String(cfg.data.jobs)} />}
            {cfg.data?.immediateCheckpoint != null && (
              <Property label="Immediate Checkpoint" value={cfg.data.immediateCheckpoint ? 'Yes' : 'No'} />
            )}
          </PropertyList>
        </Section>
      )}
    </>
  )
}

/**
 * One server's restorable range. The two timestamps are the answer to "how far
 * back can I go, and how current is it" — the question the whole plugin path
 * moved out of the Cluster.
 */
function RecoveryWindowRow({
  window: w,
  retention,
  namespace,
  clusterNames,
  onNavigate,
}: {
  window: CNPGObjectStoreRecoveryWindow
  retention?: string
  namespace: string
  /** Cluster names that exist in this namespace. The server key usually IS the
   *  cluster name, but the barman-cloud plugin's `serverName` parameter can be
   *  set to anything, and two clusters may share a store under distinct keys —
   *  so a key is only a route when something is actually there. Hosts that
   *  cannot resolve it omit this and the name renders as text, which is still
   *  the truth. */
  clusterNames?: Set<string>
  onNavigate?: (ref: { kind: string; namespace: string; name: string; group?: string }) => void
}) {
  const tone = w.failingSinceLastSuccess ? 'degraded' : w.lastSuccessfulBackupTime ? 'healthy' : 'unknown'
  return (
    <div className="card-inner">
      <div className="flex items-center gap-2 mb-1">
        {/* The server key is usually the Cluster this window belongs to, and
            naming it without a route leaves the reader knowing a cluster is in
            trouble and unable to open it. Only usually, though — see
            `clusterNames`. */}
        <span className="text-sm font-medium text-theme-text-primary">
          {clusterNames && !clusterNames.has(w.server) ? (
            w.server
          ) : (
            <ResourceLink
              name={w.server}
              kind="clusters"
              namespace={namespace}
              group="postgresql.cnpg.io"
              onNavigate={onNavigate}
            />
          )}
        </span>
        <span className={clsx('badge', HEALTH_BADGE_COLORS[tone as keyof typeof HEALTH_BADGE_COLORS])}>
          {w.failingSinceLastSuccess ? 'Backups failing' : w.lastSuccessfulBackupTime ? 'Recoverable' : 'No backups yet'}
        </span>
      </div>
      <PropertyList>
        {w.firstRecoverabilityPoint && (
          <Property
            label="Restorable From"
            value={<RecoveryTime at={w.firstRecoverabilityPoint} />}
          />
        )}
        {w.lastSuccessfulBackupTime ? (
          <Property label="Last Successful Backup" value={<RecoveryTime at={w.lastSuccessfulBackupTime} />} />
        ) : (
          <Property label="Last Successful Backup" value="never" />
        )}
        {w.lastFailedBackupTime && (
          <Property label="Last Failed Attempt" value={<RecoveryTime at={w.lastFailedBackupTime} />} />
        )}
        {retention && <Property label="Retention" value={retention} />}
      </PropertyList>
      {w.failingSinceLastSuccess && (
        <div className="mt-2 pt-2 border-t border-theme-border text-xs text-theme-text-secondary">
          Every backup since the last success has failed. The oldest restorable point will still age
          out under the retention policy, so the window is shrinking from both ends.
        </div>
      )}
    </div>
  )
}
