import { Check, X, AlertTriangle, Minus, Clock } from 'lucide-react'
import { clsx } from 'clsx'
import { canaryStepLabel, canaryStepTemplateRefs } from '../RolloutRenderer'

export interface StepAnalysisStatus {
  name?: string
  status?: string
  message?: string
}

interface CanaryStepTimelineProps {
  steps: any[]
  currentStepIndex?: number
  // The live "Step analysis" slot from rolloutAnalysisRuns(status) — shown
  // inline on the current step when it's an analysis step, instead of only
  // in the separate Analysis section above.
  stepAnalysisStatus?: StepAnalysisStatus
  onNavigate?: (ref: { kind: string; namespace: string; name: string }) => void
  namespace?: string
}

type StepState = 'completed' | 'current' | 'pending'

function stepDotTone(state: StepState, analysisTone?: 'ok' | 'warning' | 'fail') {
  if (state === 'current' && analysisTone) {
    if (analysisTone === 'fail') return 'bg-red-500/25 text-red-500 dark:bg-red-500/35'
    if (analysisTone === 'warning') return 'bg-amber-500/25 text-amber-600 dark:text-amber-400 dark:bg-amber-500/35'
  }
  switch (state) {
    case 'completed':
      return 'bg-emerald-500/20 text-emerald-500 dark:bg-emerald-500/30'
    case 'current':
      return 'bg-blue-500/20 text-blue-400 dark:bg-blue-500/30'
    default:
      return 'bg-theme-hover text-theme-text-tertiary'
  }
}

function StepDot({ state, analysisTone }: { state: StepState; analysisTone?: 'ok' | 'warning' | 'fail' }) {
  const tone = stepDotTone(state, analysisTone)
  let Icon = Minus
  if (state === 'current' && analysisTone === 'fail') Icon = X
  else if (state === 'current' && analysisTone === 'warning') Icon = AlertTriangle
  else if (state === 'completed') Icon = Check
  else if (state === 'current') Icon = Clock
  return (
    <span className={clsx('z-10 mt-1 flex h-3 w-3 shrink-0 items-center justify-center rounded-full ring-2 ring-theme-surface', tone)}>
      <Icon className="h-2 w-2" strokeWidth={4} />
    </span>
  )
}

// Vertical connected stepper for a Rollout's canary steps — a linear
// sequence (no branching), so a simple top-to-bottom timeline reads more
// naturally than a graph. Same connecting-line visual as ConditionsSection.
export function CanaryStepTimeline({ steps, currentStepIndex, stepAnalysisStatus, onNavigate, namespace }: CanaryStepTimelineProps) {
  if (steps.length === 0) return null

  return (
    <div className="relative">
      <div className="absolute bottom-2 left-[9px] top-2 w-px bg-theme-border" />
      <div className="space-y-0.5">
        {steps.map((step, index) => {
          const state: StepState =
            currentStepIndex === undefined ? 'pending' : index < currentStepIndex ? 'completed' : index === currentStepIndex ? 'current' : 'pending'
          const isCurrent = state === 'current'
          const label = canaryStepLabel(step)
          const templateRefs = step.analysis ? canaryStepTemplateRefs(step) : []
          const showAnalysisStatus = isCurrent && step.analysis && stepAnalysisStatus?.status
          const analysisTone: 'ok' | 'warning' | 'fail' | undefined = showAnalysisStatus
            ? stepAnalysisStatus!.status === 'Successful'
              ? 'ok'
              : stepAnalysisStatus!.status === 'Failed' || stepAnalysisStatus!.status === 'Error'
                ? 'fail'
                : stepAnalysisStatus!.status === 'Inconclusive'
                  ? 'warning'
                  : undefined
            : undefined

          return (
            <div key={index} className="relative flex items-start gap-2 py-1.5 pr-1 text-sm">
              <StepDot state={state} analysisTone={analysisTone} />
              <div className="min-w-0 flex-1 pl-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-theme-text-tertiary">#{index}</span>
                  <span className={clsx(isCurrent ? 'font-medium text-theme-text-primary' : state === 'completed' ? 'text-theme-text-secondary' : 'text-theme-text-tertiary')}>
                    {label}
                  </span>
                  {showAnalysisStatus && (
                    <span
                      className={clsx(
                        'badge-sm',
                        analysisTone === 'ok' ? 'status-healthy' : analysisTone === 'fail' ? 'status-unhealthy' : 'status-alert'
                      )}
                    >
                      {stepAnalysisStatus!.status}
                    </span>
                  )}
                </div>
                {templateRefs.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {templateRefs.map((ref) => (
                      <button
                        key={ref.name}
                        onClick={() =>
                          onNavigate?.({
                            kind: ref.clusterScoped ? 'ClusterAnalysisTemplate' : 'AnalysisTemplate',
                            namespace: ref.clusterScoped ? '' : namespace ?? '',
                            name: ref.name,
                          })
                        }
                        disabled={!onNavigate}
                        className={clsx(
                          'font-mono text-[11px]',
                          onNavigate ? 'text-brand hover:underline' : 'text-theme-text-tertiary'
                        )}
                      >
                        {ref.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export interface BlueGreenPhase {
  label: string
  state: 'completed' | 'current' | 'pending'
}

// Same connected-dot visual as CanaryStepTimeline, for blueGreenPhases()'s
// derived phase list — blueGreen has no steps[] array to iterate, so there's
// nothing to reuse structurally, but the "linear sequence, top to bottom"
// visual language should match.
export function BlueGreenTimeline({ phases }: { phases: BlueGreenPhase[] }) {
  if (phases.length === 0) return null
  return (
    <div className="relative">
      <div className="absolute bottom-2 left-[9px] top-2 w-px bg-theme-border" />
      <div className="space-y-0.5">
        {phases.map((phase, index) => (
          <div key={index} className="relative flex items-start gap-2 py-1.5 pr-1 text-sm">
            <StepDot state={phase.state} />
            <span
              className={clsx(
                'pl-1',
                phase.state === 'current'
                  ? 'font-medium text-theme-text-primary'
                  : phase.state === 'completed'
                    ? 'text-theme-text-secondary'
                    : 'text-theme-text-tertiary'
              )}
            >
              {phase.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
