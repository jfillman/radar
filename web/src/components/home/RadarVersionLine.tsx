import { ArrowUpCircle } from 'lucide-react'
import { gitOpsRouteForResource } from '@skyhook-io/k8s-ui'
import type { CloudConnectSelf, VersionInfo } from '../../api/client'
import { isMinorOrMajorUpdate } from '../../utils/version'
import { Tooltip } from '../ui/Tooltip'

interface RadarVersionLineProps {
  version: VersionInfo
  manager?: CloudConnectSelf
  managerLoading?: boolean
  onNavigateToHelmRelease?: (namespace: string, release: string) => void
  onNavigateToGitOps?: (path: string) => void
}

function displayVersion(version: string): string {
  return version === 'dev' || version.startsWith('v') ? version : `v${version}`
}

export function RadarVersionLine({
  version,
  manager,
  managerLoading = false,
  onNavigateToHelmRelease,
  onNavigateToGitOps,
}: RadarVersionLineProps) {
  const latestVersion = version.latestVersion
  const showUpgrade = version.updateAvailable
    && !!latestVersion
    && isMinorOrMajorUpdate(version.currentVersion, latestVersion)

  if (!showUpgrade) {
    return <span>Radar <span className="font-mono">{displayVersion(version.currentVersion)}</span></span>
  }

  const controller = manager?.controllerRef
  const gitOpsPath = controller
    ? gitOpsRouteForResource({
        apiVersion: controller.group ? `${controller.group}/v1` : undefined,
        kind: controller.kind,
        metadata: { namespace: controller.namespace, name: controller.name },
      })
    : null

  let detail = managerLoading
    ? 'Checking how this installation is managed.'
    : 'The installation manager could not be confirmed. Open the release notes for upgrade guidance.'
  let onClick: (() => void) | undefined
  const actionClassName = 'group inline-flex items-center gap-1 text-amber-600 transition-colors hover:text-amber-500 dark:text-amber-400'

  if (manager?.ownership === 'helm' && manager.namespace && manager.release) {
    detail = `Managed by Helm release ${manager.namespace}/${manager.release}. Open the release to upgrade.`
    if (onNavigateToHelmRelease) {
      onClick = () => onNavigateToHelmRelease(manager.namespace!, manager.release!)
    }
  } else if (manager?.controllerVerified && controller && gitOpsPath) {
    const objectName = `${controller.namespace ? `${controller.namespace}/` : ''}${controller.name}`
    detail = `Managed by ${controller.kind} ${objectName}. Open it to upgrade through GitOps.`
    if (onNavigateToGitOps) {
      onClick = () => onNavigateToGitOps(gitOpsPath)
    }
  } else if (manager?.ownership === 'gitops') {
    detail = manager.controller
      ? `This installation appears to be managed by ${manager.controller}. Open the release notes and upgrade through its source of truth.`
      : 'This installation appears to be managed through GitOps. Open the release notes and upgrade through its source of truth.'
  }

  const accessibleLabel = `Radar ${displayVersion(latestVersion)} is available. ${detail}`
  const action = onClick ? (
    <button
      type="button"
      className={actionClassName}
      onClick={onClick}
      aria-label={accessibleLabel}
    >
      <UpgradeLabel version={latestVersion} />
    </button>
  ) : version.releaseUrl ? (
    <a
      href={version.releaseUrl}
      target="_blank"
      rel="noreferrer"
      className={actionClassName}
      aria-label={accessibleLabel}
    >
      <UpgradeLabel version={latestVersion} />
    </a>
  ) : (
    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400" aria-label={accessibleLabel}>
      <UpgradeLabel version={latestVersion} />
    </span>
  )

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <span>Radar <span className="font-mono">{displayVersion(version.currentVersion)}</span></span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden>·</span>
        <Tooltip
          content={accessibleLabel}
          className="!whitespace-normal !max-w-sm"
        >
          {action}
        </Tooltip>
      </span>
    </span>
  )
}

function UpgradeLabel({ version }: { version: string }) {
  return (
    <>
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span><span className="font-mono">{displayVersion(version)}</span> available</span>
    </>
  )
}
