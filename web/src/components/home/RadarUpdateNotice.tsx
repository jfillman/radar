import { ExternalLink, GitBranch, Info, PackageOpen } from 'lucide-react'
import { gitOpsRouteForResource } from '@skyhook-io/k8s-ui'
import type { ReactNode } from 'react'
import type { CloudConnectSelf, VersionInfo } from '../../api/client'

interface RadarUpdateNoticeProps {
  version: VersionInfo
  manager?: CloudConnectSelf
  managerLoading?: boolean
  onNavigateToHelmRelease?: (namespace: string, release: string) => void
  onNavigateToGitOps?: (path: string) => void
}

export function RadarUpdateNotice({
  version,
  manager,
  managerLoading = false,
  onNavigateToHelmRelease,
  onNavigateToGitOps,
}: RadarUpdateNoticeProps) {
  const controller = manager?.controllerRef
  const gitOpsPath = controller
    ? gitOpsRouteForResource({
        apiVersion: controller.group ? `${controller.group}/v1` : undefined,
        kind: controller.kind,
        metadata: { namespace: controller.namespace, name: controller.name },
      })
    : null

  let managerText = managerLoading
    ? 'Checking how this installation is managed…'
    : 'The installation manager could not be confirmed.'
  let managerAction: ReactNode = null
  if (manager?.ownership === 'helm' && manager.namespace && manager.release) {
    managerText = `Managed by Helm release ${manager.namespace}/${manager.release}.`
    managerAction = onNavigateToHelmRelease ? (
      <button
        type="button"
        className="btn-brand-muted inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
        onClick={() => onNavigateToHelmRelease(manager.namespace!, manager.release!)}
      >
        <PackageOpen className="h-3.5 w-3.5" />
        Open Helm release
      </button>
    ) : null
  } else if (manager?.controllerVerified && controller && gitOpsPath) {
    const objectName = `${controller.namespace ? `${controller.namespace}/` : ''}${controller.name}`
    managerText = `Managed by ${controller.kind} ${objectName}.`
    managerAction = onNavigateToGitOps ? (
      <button
        type="button"
        className="btn-brand-muted inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
        onClick={() => onNavigateToGitOps(gitOpsPath)}
      >
        <GitBranch className="h-3.5 w-3.5" />
        Open {controller.kind}
      </button>
    ) : null
  } else if (manager?.ownership === 'gitops') {
    managerText = manager.controller
      ? `This installation appears to be managed by ${manager.controller}.`
      : 'This installation appears to be managed through GitOps.'
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-theme-border bg-theme-surface px-4 py-3 shadow-theme-sm">
      <Info className="h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-theme-text-primary">
          Radar {version.latestVersion} is available
        </p>
        <p className="mt-0.5 text-xs text-theme-text-secondary">
          This shared installation is running {version.currentVersion}. {managerText}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {managerAction}
        {version.releaseUrl && (
          <a
            href={version.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-theme-text-secondary transition-colors hover:text-theme-text-primary"
          >
            View release notes
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  )
}
