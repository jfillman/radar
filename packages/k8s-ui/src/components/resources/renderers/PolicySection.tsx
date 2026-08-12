import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { clsx } from 'clsx'
import { Section } from '../../ui/drawer-components'
import { SEVERITY_BADGE } from '../../../utils/badge-colors'
import { isForbiddenError } from '../../../types/fetch-error'
import type { PolicyResourceResponse, PolicyResourceFinding } from '../../../types/policy'

interface PolicySectionProps {
  data: PolicyResourceResponse | null
  loading?: boolean
  error?: Error | null
}

const TITLE = 'Policy'

// Result → badge tone. `error` means the engine could not evaluate the rule,
// which is not the same as the rule failing, so it does not share fail's red.
function resultTone(result: string): { badge: string; label: string } {
  switch (result.toLowerCase()) {
    case 'fail':
      return { badge: SEVERITY_BADGE.error, label: 'Fail' }
    case 'warn':
      return { badge: SEVERITY_BADGE.warning, label: 'Warn' }
    case 'error':
      return { badge: SEVERITY_BADGE.alert, label: 'Error' }
    case 'skip':
      return { badge: SEVERITY_BADGE.neutral, label: 'Skipped' }
    default:
      return { badge: SEVERITY_BADGE.neutral, label: result }
  }
}

/**
 * PolicySection reports what the cluster's policy engine says about this one
 * resource.
 *
 * The unhappy paths carry the weight here. An empty finding list means one of
 * several unrelated things, and rendering them all as blank space would tell an
 * operator they are compliant in the cases where nothing was actually checked —
 * the failure mode this section exists to avoid. Each state therefore says which
 * one it is, in its own words, and the red treatment is reserved for genuine
 * faults. Same division the RBAC sections already draw.
 */
export function PolicySection({ data, loading, error }: PolicySectionProps) {
  if (loading) {
    return (
      <Section title={TITLE} icon={ShieldQuestion}>
        <div className="text-sm text-theme-text-tertiary">Loading policy results…</div>
      </Section>
    )
  }

  if (error) {
    // A denial is an expected state on a namespace-scoped account, not a fault.
    if (isForbiddenError(error)) {
      return (
        <Section title={TITLE} icon={ShieldQuestion}>
          <div className="text-sm text-theme-text-tertiary">
            You don’t have permission to view policy results in this namespace.
          </div>
        </Section>
      )
    }
    return (
      <Section title={TITLE} icon={ShieldAlert}>
        <div className="text-sm text-red-400">{`Could not load policy results: ${error.message}`}</div>
      </Section>
    )
  }

  // No engine installed — the section is genuinely not applicable, so it is
  // absent rather than showing a reassuring "nothing to report". A disclaimer on
  // every cluster without a policy engine would be noise.
  if (!data || data.status === 'not_installed') return null

  if (!data.evaluated) {
    return (
      <Section title={TITLE} icon={ShieldQuestion}>
        <div className="text-sm text-theme-text-tertiary">
          {(data.status === 'warmup'
            ? 'Policy results are still loading from the cluster.'
            : 'Policy results are unavailable, so this resource has not been checked.') +
            (data.reasonCode ? ` (${data.reasonCode})` : '')}
        </div>
      </Section>
    )
  }

  const { counts, findings } = data
  const checked = counts.pass + counts.fail + counts.warn + counts.error + counts.skip

  // Evaluated, but no policy selected this resource at all. Distinct from
  // "passing everything": nothing examined it, so there is nothing to pass.
  if (checked === 0) {
    return (
      <Section title={TITLE} icon={ShieldQuestion}>
        <div className="text-sm text-theme-text-tertiary">
          No policy applies to this resource.
        </div>
        <PartialCoverageNote data={data} />
      </Section>
    )
  }

  const failing = findings.length

  return (
    <Section
      title={TITLE}
      icon={failing > 0 ? ShieldAlert : ShieldCheck}
      defaultExpanded={failing > 0}
    >
      {failing === 0 ? (
        <div className="text-sm text-theme-text-secondary">
          {`All ${counts.pass} ${counts.pass === 1 ? 'check' : 'checks'} passing.`}
        </div>
      ) : (
        <div className="space-y-2">
          {findings.map((f, i) => (
            <PolicyFindingRow key={`${f.policy}/${f.rule}/${i}`} finding={f} />
          ))}
          {counts.pass > 0 && (
            <div className="text-xs text-theme-text-tertiary pt-1">
              {`${counts.pass} other ${counts.pass === 1 ? 'check' : 'checks'} passing`}
            </div>
          )}
        </div>
      )}
      <PartialCoverageNote data={data} />
    </Section>
  )
}

function PolicyFindingRow({ finding }: { finding: PolicyResourceFinding }) {
  const tone = resultTone(finding.result)
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className={clsx('badge shrink-0', tone.badge)}>{tone.label}</span>
      <div className="min-w-0">
        <div className="text-sm text-theme-text-primary truncate" title={finding.policy}>
          {finding.policy}
          {finding.rule && finding.rule !== finding.policy && (
            <span className="text-theme-text-tertiary"> · {finding.rule}</span>
          )}
        </div>
        {finding.message && (
          <div className="text-xs text-theme-text-secondary">{finding.message}</div>
        )}
      </div>
    </div>
  )
}

/**
 * A result can be real and incomplete at the same time: some report families
 * may be unreadable by this identity, or the index may be frozen. Saying
 * "all checks passing" without mentioning that claims coverage we do not have.
 */
function PartialCoverageNote({ data }: { data: PolicyResourceResponse }) {
  const denied = data.deniedGroups ?? []
  if (denied.length === 0 && data.liveUpdates) return null
  return (
    <div className="mt-2 pt-2 border-t border-theme-border text-xs text-theme-text-tertiary">
      {denied.length > 0 && (
        <div>{`Some policy results could not be read (${denied.join(', ')}), so this list may be incomplete.`}</div>
      )}
      {!data.liveUpdates && <div>These results are not updating live.</div>}
    </div>
  )
}
