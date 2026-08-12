// Kyverno / Policy Report cell components for ResourcesView table

import { clsx } from 'clsx'
import {
  getPolicyReportScope,
  getPolicyReportStatus,
  getPolicyReportSummary,
  getKyvernoPolicyStatus,
  getKyvernoPolicyAction,
  getKyvernoPolicyRuleCount,
} from '../resource-utils-kyverno'

export function PolicyReportCell({ resource, column }: { resource: any; column: string }) {
  switch (column) {
    case 'status': {
      const status = getPolicyReportStatus(resource)
      return (
        <span className={clsx('badge', status.color)}>
          {status.text}
        </span>
      )
    }
    // Kyverno names a per-resource report after the subject's UID, so the Name
    // column reads as a bare UUID. Without the subject the whole table is
    // unidentifiable rows with counts beside them — you cannot tell which of
    // your workloads a failing report belongs to without opening every one.
    case 'scope': {
      const scope = getPolicyReportScope(resource)
      return <span className="truncate text-theme-text-primary" title={scope}>{scope}</span>
    }
    case 'pass': {
      const summary = getPolicyReportSummary(resource)
      return <span className={clsx('text-sm', summary.pass > 0 ? 'text-green-400' : 'text-theme-text-tertiary')}>{summary.pass}</span>
    }
    case 'fail': {
      const summary = getPolicyReportSummary(resource)
      return <span className={clsx('text-sm', summary.fail > 0 ? 'text-red-400 font-medium' : 'text-theme-text-tertiary')}>{summary.fail}</span>
    }
    case 'warn': {
      const summary = getPolicyReportSummary(resource)
      return <span className={clsx('text-sm', summary.warn > 0 ? 'text-yellow-400' : 'text-theme-text-tertiary')}>{summary.warn}</span>
    }
    case 'error': {
      const summary = getPolicyReportSummary(resource)
      return <span className={clsx('text-sm', summary.error > 0 ? 'text-red-400 font-medium' : 'text-theme-text-tertiary')}>{summary.error}</span>
    }
    case 'skip': {
      const summary = getPolicyReportSummary(resource)
      return <span className={clsx('text-sm', summary.skip > 0 ? 'text-blue-400' : 'text-theme-text-tertiary')}>{summary.skip}</span>
    }
    default:
      return <span className="text-sm text-theme-text-tertiary">-</span>
  }
}

export function ClusterPolicyReportCell({ resource, column }: { resource: any; column: string }) {
  // Same rendering logic as PolicyReport
  return <PolicyReportCell resource={resource} column={column} />
}

export function KyvernoPolicyCell({ resource, column }: { resource: any; column: string }) {
  switch (column) {
    case 'status': {
      const status = getKyvernoPolicyStatus(resource)
      return (
        <span className={clsx('badge', status.color)}>
          {status.text}
        </span>
      )
    }
    case 'action': {
      const action = getKyvernoPolicyAction(resource)
      return (
        <span className={clsx(
          'badge',
          action === 'Enforce' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400',
        )}>
          {action}
        </span>
      )
    }
    case 'rules': {
      const count = getKyvernoPolicyRuleCount(resource)
      return <span className="text-sm text-theme-text-secondary">{count}</span>
    }
    default:
      return <span className="text-sm text-theme-text-tertiary">-</span>
  }
}

export function ClusterPolicyCell({ resource, column }: { resource: any; column: string }) {
  // Same rendering logic as KyvernoPolicy
  return <KyvernoPolicyCell resource={resource} column={column} />
}
