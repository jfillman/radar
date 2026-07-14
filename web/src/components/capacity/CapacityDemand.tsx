import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import {
  Collapse,
  CollapseChevron,
  type CapacityDemandGroup,
  type CapacityDemandResponse,
  type CapacityDemandState,
  type CapacityEvaluationEvidence,
  type CapacityPoolEvaluation,
} from "@skyhook-io/k8s-ui";
import { Badge } from "@skyhook-io/k8s-ui/components/ui/Badge";
import {
  isCapacityCursorInvalidError,
  isNotFoundError,
  useCapacityDemand,
} from "../../api/client";
import type { SelectedResource } from "../../types";
import { refToSelectedResource } from "../../utils/navigation";
import {
  CapacityFreshness,
  DemandStateBadge,
  EmptyState,
  InlineEmpty,
  LinkButton,
  Notice,
  PageControls,
  PoolEvaluationBadge,
  QuantityInline,
  ResourceLink,
  ROW_HOVER,
  ScopeBadges,
  ScrollableContent,
  TABLE_HEAD,
  TABLE_WRAP,
  TBODY,
  TD,
  TH,
  coverageHasObservations,
  coverageIsLowerBound,
  coverageMessage,
  demandStateLabel,
  errorMessage,
  formatTimestamp,
  identityKey,
  integrationBlock,
  namespaceCoverageDescription,
  quantityText,
  useCapacityCursorRecovery,
  useCapacityPagination,
} from "./shared";

const STATE_PILLS: [CapacityDemandState | undefined, string][] = [
  [undefined, "All states"],
  ["waiting_for_scheduler", "Waiting for scheduler"],
  ["held", "Held by scheduling gate"],
  ["awaiting_capacity", "Awaiting capacity"],
  ["blocked", "Blocked"],
  ["unknown", "Unknown"],
];

export function CapacityDemand({
  connectionState,
  onOpenPool,
  onOpenResource,
  onNavigate,
}: {
  connectionState: "connected" | "disconnected" | "connecting";
  onOpenPool: (name: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
  onNavigate: (path: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const search = new URLSearchParams(location.search);
  const stateValue = search.get("state");
  const stateFilter =
    stateValue &&
    [
      "waiting_for_scheduler",
      "held",
      "awaiting_capacity",
      "blocked",
      "unknown",
    ].includes(stateValue)
      ? (stateValue as CapacityDemandState)
      : undefined;
  const poolFilter = search.get("pool") || undefined;
  const pagination = useCapacityPagination<CapacityDemandResponse>(
    location.search,
  );
  const query = useCapacityDemand({
    limit: 25,
    cursor: pagination.cursor,
    state: stateFilter,
    pool: poolFilter,
  });
  const recoveringCursor = useCapacityCursorRecovery(
    query.error,
    pagination.cursor,
    pagination.recover,
  );
  const recoveredCursor = pagination.recovered || recoveringCursor;
  const responseData =
    query.data ?? (recoveredCursor ? pagination.retainedPage : undefined);
  const clearPoolFilter = () => {
    const params = new URLSearchParams(location.search);
    params.delete("pool");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true },
    );
  };
  if (poolFilter && !responseData && isNotFoundError(query.error)) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="NodePool not found"
        detail={`This link filters by pool “${poolFilter}”, which no longer exists. It may have been removed or belongs to another cluster context.`}
        action={
          <button
            type="button"
            className="btn-brand mt-4 rounded-lg px-3 py-1.5 text-sm"
            onClick={clearPoolFilter}
          >
            Show all pending demand
          </button>
        }
      />
    );
  }
  const blocked = integrationBlock(
    responseData,
    query.error,
    query.isLoading,
    "Loading pending capacity demand…",
  );
  if (blocked) return blocked;
  const response = responseData as CapacityDemandResponse;

  const changeFilter = (next: CapacityDemandState | undefined) => {
    const params = new URLSearchParams(location.search);
    if (next) params.set("state", next);
    else params.delete("state");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true },
    );
  };

  const visiblePods = response.items.reduce(
    (total, group) => total + group.podCount,
    0,
  );
  const groupCount = response.items.length;
  const summary = `${visiblePods} ${visiblePods === 1 ? "pod" : "pods"} in ${groupCount} ${groupCount === 1 ? "group" : "groups"}`;

  return (
    <ScrollableContent>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-3">
            <LinkButton onClick={() => onNavigate("/capacity")}>
              ← Capacity
            </LinkButton>
            <h1 className="text-lg font-semibold text-theme-text-primary">
              Demand
            </h1>
            <span className="text-xs text-theme-text-tertiary">
              Pending pods grouped by scheduling signature · {summary}
            </span>
          </div>
          <div className="mt-2">
            <ScopeBadges coverage={response.coverage} />
          </div>
        </div>
        <CapacityFreshness
          meta={response}
          query={query}
          connectionState={connectionState}
        />
      </div>

      {recoveredCursor && (
        <Notice>Capacity data changed; showing the latest results.</Notice>
      )}
      {query.error && !isCapacityCursorInvalidError(query.error) && (
        <Notice>
          Refresh failed; showing the last successful capacity snapshot.{" "}
          {errorMessage(query.error)}
        </Notice>
      )}
      {coverageIsLowerBound(response.coverage.pods) && (
        <Notice>
          ≥ {coverageMessage(response.coverage.pods, "Pending pod demand")}.
          Groups outside {namespaceCoverageDescription(response.coverage.pods)}{" "}
          are invisible — every count on this page is a lower bound, not a total.
        </Notice>
      )}
      {poolFilter && (
        <Notice>
          Showing demand evaluated against NodePool{" "}
          <span className="font-medium text-theme-text-primary">
            {poolFilter}
          </span>
          .{" "}
          <LinkButton
            className="inline"
            onClick={clearPoolFilter}
          >
            Clear pool filter
          </LinkButton>
        </Notice>
      )}

      <div
        className="flex flex-wrap gap-1.5"
        aria-label="Filter demand by state"
      >
        {STATE_PILLS.map(([state, label]) => (
          <button
            key={state ?? "all"}
            type="button"
            aria-pressed={stateFilter === state}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              stateFilter === state
                ? "selection border-theme-border text-theme-text-primary"
                : "border-theme-border text-theme-text-secondary hover:bg-theme-hover"
            }`}
            onClick={() => changeFilter(state)}
          >
            {label}
          </button>
        ))}
      </div>

      {response.items.length > 0 ? (
        <div className="space-y-3">
          {response.items.map((group, index) => (
            <DemandGroupCard
              key={group.id}
              group={group}
              defaultExpanded={index === 0}
              onOpenPool={onOpenPool}
              onOpenResource={onOpenResource}
            />
          ))}
        </div>
      ) : coverageHasObservations(response.coverage.pods) ? (
        <InlineEmpty
          title="No demand groups match these filters"
          detail={
            stateFilter
              ? `A true zero here means every readable pending pod is excluded by the current filters — not that data is missing. No pending groups are in “${demandStateLabel(stateFilter)}”.`
              : "A true zero here means every readable pending pod is excluded by the current filters — not that data is missing."
          }
        />
      ) : (
        <InlineEmpty
          title="Demand unavailable"
          detail={coverageMessage(response.coverage.pods, "Pending pod demand")}
        />
      )}

      {(pagination.history.length > 0 || response.page.hasMore) && (
        <PageControls
          page={pagination.history.length + 1}
          hasPrevious={pagination.history.length > 0}
          hasNext={response.page.hasMore && Boolean(response.page.nextCursor)}
          busy={query.isFetching}
          onPrevious={() => pagination.goBack(response)}
          onNext={() =>
            response.page.nextCursor &&
            pagination.goNext(response.page.nextCursor, response)
          }
        />
      )}
    </ScrollableContent>
  );
}

function DemandGroupCard({
  group,
  defaultExpanded,
  onOpenPool,
  onOpenResource,
}: {
  group: CapacityDemandGroup;
  defaultExpanded: boolean;
  onOpenPool: (name: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const counts = group.poolEvaluationCounts;
  const compatSummary = `${counts.declaredCompatible} compatible · ${counts.incompatible} incompatible · ${counts.unknown} unknown`;

  return (
    <article className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
      <button
        type="button"
        aria-expanded={expanded}
        className={`flex w-full items-start gap-2 px-4 py-3 text-left ${ROW_HOVER}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <CollapseChevron open={expanded} className="mt-0.5 h-4 w-4" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-[90px]">
              <DemandStateBadge state={group.state} />
            </span>
            {group.owner ? (
              <>
                <Badge tone="structural" size="sm">
                  {group.owner.kind}
                </Badge>
                <span
                  role="link"
                  tabIndex={0}
                  className="truncate font-medium text-accent-text hover:underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenResource(refToSelectedResource(group.owner!));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenResource(refToSelectedResource(group.owner!));
                    }
                  }}
                >
                  {group.owner.name}
                </span>
              </>
            ) : (
              <span className="font-medium text-theme-text-primary">
                Pod without a workload owner
              </span>
            )}
            <span className="font-mono text-xs text-theme-text-tertiary">
              ns/{group.namespace}
            </span>
            <Badge tone="structural" size="sm">
              {group.podCount} {group.podCount === 1 ? "pod" : "pods"}
            </Badge>
            <span className="font-mono text-xs text-theme-text-secondary">
              {quantityText(group.aggregateRequests) ?? "No requests reported"}
            </span>
          </div>
          <div className="mt-1 text-xs text-theme-text-tertiary">
            first {formatTimestamp(group.firstSeen)} · last{" "}
            {formatTimestamp(group.lastSeen)}
          </div>
        </div>
      </button>

      <Collapse open={expanded}>
        <div className="border-t border-theme-border">
          <div className="px-4 pt-3 text-xs text-theme-text-tertiary">
            Pools:{" "}
            <span className="text-theme-text-secondary">{compatSummary}</span>{" "}
            <span
              title="Declared-compatible means the pool's declared requirements, taints and resources do not rule out these pods. It is not a scheduling, capacity or availability guarantee."
              className="cursor-help text-theme-text-tertiary"
            >
              — declared compatibility, not a scheduling guarantee
            </span>
          </div>

          <div className="grid gap-x-6 gap-y-4 px-4 py-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                  Scheduling signature
                </h3>
                <div className="mt-1.5 font-mono text-[11px] text-theme-text-tertiary">
                  {group.fingerprint}
                </div>
                <div className="mt-2 text-xs font-medium text-theme-text-tertiary">
                  Per pod
                </div>
                <div className="mt-1">
                  <QuantityInline
                    observation={group.perPodRequests}
                    empty="No requests reported"
                  />
                </div>
                <div className="mt-3 text-xs font-medium text-theme-text-tertiary">
                  Selectors
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {group.schedulingSignature.constraints.length > 0 ? (
                    group.schedulingSignature.constraints.map((constraint) => (
                      <Badge
                        key={`${constraint.predicate}-${constraint.sourcePath}`}
                        tone="structural"
                        size="sm"
                      >
                        {constraint.key || constraint.predicate}
                        {constraint.operator ? ` ${constraint.operator}` : ""}
                        {constraint.values.length > 0
                          ? ` ${constraint.values.join(", ")}`
                          : ""}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-theme-text-secondary">
                      None
                    </span>
                  )}
                </div>
                {group.schedulingSignature.constraintsMeta.truncated && (
                  <p className="mt-1.5 text-[11px] text-theme-text-tertiary">
                    Showing {group.schedulingSignature.constraintsMeta.returned}{" "}
                    of {group.schedulingSignature.constraintsMeta.total}{" "}
                    constraints.
                  </p>
                )}
                <div className="mt-3 text-xs font-medium text-theme-text-tertiary">
                  Tolerations
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {group.schedulingSignature.tolerations.length > 0 ? (
                    group.schedulingSignature.tolerations.map(
                      (toleration, index) => (
                        <Badge
                          key={`${toleration.key ?? "*"}-${toleration.effect ?? "*"}-${index}`}
                          tone="structural"
                          size="sm"
                        >
                          {toleration.key || "*"}
                          {toleration.value ? `=${toleration.value}` : ""}
                          {toleration.effect ? ` · ${toleration.effect}` : ""}
                        </Badge>
                      ),
                    )
                  ) : (
                    <span className="text-sm text-theme-text-secondary">
                      None
                    </span>
                  )}
                </div>
                {group.schedulingSignature.tolerationsMeta.truncated && (
                  <p className="mt-1.5 text-[11px] text-theme-text-tertiary">
                    Showing {group.schedulingSignature.tolerationsMeta.returned}{" "}
                    of {group.schedulingSignature.tolerationsMeta.total}{" "}
                    tolerations.
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                  Evidence
                </h3>
                {group.schedulerReasons.length > 0 ? (
                  <div className="mt-2 space-y-2">
                    {group.schedulerReasons.map((reason) => (
                      <div
                        key={`${reason.source}-${reason.code}`}
                        className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-medium text-theme-text-primary">
                            {reason.code}
                          </span>
                          <Badge tone="structural" size="sm">
                            {reason.count}{" "}
                            {reason.count === 1 ? "event" : "events"}
                          </Badge>
                        </div>
                        {reason.message && (
                          <p className="mt-1 text-xs text-theme-text-secondary">
                            {reason.message}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] text-theme-text-tertiary">
                          {reason.source} · latest{" "}
                          {formatTimestamp(reason.lastSeen)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-theme-text-secondary">
                    No scheduler reason was observed for this group.
                  </p>
                )}
                {group.schedulerReasonsMeta.truncated && (
                  <p className="mt-1.5 text-[11px] text-theme-text-tertiary">
                    Showing {group.schedulerReasonsMeta.returned} of{" "}
                    {group.schedulerReasonsMeta.total} scheduler reasons.
                  </p>
                )}
              </div>

              {(group.pods.length > 0 || group.podsMeta.truncated) && (
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                    Pods
                  </h3>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {group.pods.map((pod) => (
                      <ResourceLink
                        key={identityKey(pod)}
                        identity={pod}
                        onOpenResource={onOpenResource}
                      />
                    ))}
                    {group.podsMeta.truncated && (
                      <span className="text-[11px] text-theme-text-tertiary">
                        showing {group.podsMeta.returned} of{" "}
                        {group.podsMeta.total}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-theme-border-subtle px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                Pool evaluations
              </h3>
              <span className="text-[11px] text-theme-text-tertiary">
                — declared compatibility, with evidence
              </span>
            </div>
              {group.poolEvaluations.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {group.poolEvaluations.map((evaluation) => (
                    <PoolEvaluationCard
                      key={`${evaluation.pool.group ?? ""}/${evaluation.pool.name}`}
                      evaluation={evaluation}
                      onOpenPool={onOpenPool}
                    />
                  ))}
                  {group.poolEvaluationsMeta.truncated && (
                    <p className="text-[11px] text-theme-text-tertiary">
                      Showing {group.poolEvaluationsMeta.returned} of{" "}
                      {group.poolEvaluationsMeta.total} evaluations.
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-sm text-theme-text-secondary">
                  No NodePools were available for evaluation.
                </p>
              )}
          </div>
        </div>
      </Collapse>
    </article>
  );
}

function PoolEvaluationCard({
  evaluation,
  onOpenPool,
}: {
  evaluation: CapacityPoolEvaluation;
  onOpenPool: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const predicateCount =
    evaluation.evidence.length + evaluation.unknownPredicates.length;
  return (
    <div className="overflow-hidden rounded-lg border border-theme-border bg-theme-base/40">
      <button
        type="button"
        aria-expanded={expanded}
        className={`flex w-full items-center gap-2 px-3 py-2.5 text-left ${ROW_HOVER}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <CollapseChevron open={expanded} className="h-4 w-4" />
        <span
          role="link"
          tabIndex={0}
          className="font-mono text-sm font-medium text-accent-text hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            onOpenPool(evaluation.pool.name);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onOpenPool(evaluation.pool.name);
            }
          }}
        >
          {evaluation.pool.name}
        </span>
        <PoolEvaluationBadge result={evaluation.result} />
        <span className="ml-auto text-[11px] text-theme-text-tertiary">
          {predicateCount} {predicateCount === 1 ? "predicate" : "predicates"}
          {evaluation.evidenceMeta.truncated ? " · truncated" : ""}
        </span>
      </button>
      <Collapse open={expanded}>
        <div className="border-t border-theme-border">
          {evaluation.evidence.length > 0 ||
          evaluation.unknownPredicates.length > 0 ? (
            <div className={TABLE_WRAP}>
              <table className="w-full text-left">
                <thead className={TABLE_HEAD}>
                  <tr>
                    <th className={TH}>Predicate</th>
                    <th className={TH}>Observed</th>
                    <th className={TH}>Expected</th>
                    <th className={TH}>Confidence</th>
                    <th className={TH}>Explanation</th>
                    <th className={TH}>Source</th>
                  </tr>
                </thead>
                <tbody className={TBODY}>
                  {evaluation.evidence.map((evidence, index) => (
                    <EvidenceRow
                      key={`${evidence.predicate}-${index}`}
                      evidence={evidence}
                    />
                  ))}
                  {evaluation.unknownPredicates.map((predicate) => (
                    <tr key={`unknown-${predicate}`} className={ROW_HOVER}>
                      <td className={`${TD} font-mono`}>{predicate}</td>
                      <td
                        className={`${TD} font-mono text-theme-text-tertiary`}
                        colSpan={4}
                      >
                        ? unknown — not evaluated
                      </td>
                      <td className={`${TD} text-theme-text-tertiary`}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-3 py-2.5 text-sm text-theme-text-secondary">
              No incompatibility evidence was recorded.
            </p>
          )}
          {evaluation.evidenceMeta.truncated && (
            <p className="px-3 py-2 text-[11px] text-theme-text-tertiary">
              Showing {evaluation.evidenceMeta.returned} of{" "}
              {evaluation.evidenceMeta.total} incompatibility checks.
            </p>
          )}
          {evaluation.unknownPredicatesMeta.truncated && (
            <p className="px-3 pb-2 text-[11px] text-theme-text-tertiary">
              Showing {evaluation.unknownPredicatesMeta.returned} of{" "}
              {evaluation.unknownPredicatesMeta.total} unknown predicates.
            </p>
          )}
        </div>
      </Collapse>
    </div>
  );
}

function EvidenceRow({ evidence }: { evidence: CapacityEvaluationEvidence }) {
  return (
    <tr className={ROW_HOVER}>
      <td className={`${TD} font-mono`}>{evidence.predicate}</td>
      <td className={`${TD} font-mono text-theme-text-secondary`}>
        {evidence.observedValues.length > 0
          ? evidence.observedValues.join(", ")
          : "—"}
      </td>
      <td className={`${TD} font-mono text-theme-text-secondary`}>
        {evidence.expectedValues.length > 0
          ? evidence.expectedValues.join(", ")
          : "—"}
      </td>
      <td className={TD}>
        <Badge tone="structural" size="sm">
          {evidence.confidence}
        </Badge>
      </td>
      <td className={`${TD} text-theme-text-secondary`}>
        {evidence.explanation}
      </td>
      <td className={`${TD} font-mono text-theme-text-tertiary`}>
        {evidence.sourcePath || "—"}
      </td>
    </tr>
  );
}
