import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Layers3 } from "lucide-react";
import {
  Collapse,
  CollapseChevron,
  WithTooltip,
  type CapacityCertainty,
  type CapacityCoverageBySource,
  type CapacityDemandState,
  type CapacityOverviewResponse,
  type CapacityOverviewSummary,
  type CapacityPoolListResponse,
  type CapacityPoolSummary,
  type CapacitySourceCoverage,
} from "@skyhook-io/k8s-ui";
import { Badge } from "@skyhook-io/k8s-ui/components/ui/Badge";
import type { useCapacityOverview } from "../../api/client";
import {
  isCapacityCursorInvalidError,
  useCapacityPools,
} from "../../api/client";
import type { SelectedResource } from "../../types";
import {
  actionSeverity,
  ActualUsageInline,
  CapacityFreshness,
  coverageHasObservations,
  coverageIsDenied,
  coverageIsLowerBound,
  coverageMessage,
  DeniedBadge,
  EmptyState,
  errorMessage,
  humanizeCode,
  identityToSelectedResource,
  InlineEmpty,
  integrationBlock,
  KpiTile,
  LimitPressureCell,
  LinkButton,
  Notice,
  PageControls,
  pickWorstPressure,
  PoolReadyBadge,
  poolReadinessDetail,
  QuantityInline,
  RefreshError,
  ROW_HOVER,
  ScopeBadges,
  ScrollableContent,
  SectionCard,
  shortResourceLabel,
  sortedResourceEntries,
  TABLE_HEAD,
  TABLE_WRAP,
  TBODY,
  TD,
  TH,
  useCapacityCursorRecovery,
  useCapacityPagination,
  type CapacityConnectionState,
} from "./shared";

const EXPLAIN_CARDS: { term: string; body: string }[] = [
  {
    term: "Configured limit",
    body: "A ceiling declared on the NodePool. Says nothing about what exists right now. A missing limit is not unlimited capacity — provider quota still applies.",
  },
  {
    term: "Provisioned / allocatable",
    body: "Capacity of nodes that exist. Allocatable is what the kubelet offers to the scheduler after reservations.",
  },
  {
    term: "Scheduled requests",
    body: "What the scheduler has placed. This is what consumes scheduling capacity — not live usage.",
  },
  {
    term: "Actual usage",
    body: "Point-in-time consumption from metrics. An efficiency signal. Never scheduler headroom.",
  },
  {
    term: "Unallocated",
    body: "Allocatable minus requests, summed across nodes. Not bin-packed: it does not prove another pod can schedule.",
  },
];

const SEVERITY_RANK: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
  neutral: 3,
};

function coverageCertainty(coverage?: CapacitySourceCoverage): CapacityCertainty {
  if (coverageIsDenied(coverage)) return "unknown";
  if (coverageIsLowerBound(coverage)) return "lower_bound";
  return "exact";
}

interface OverviewSignal {
  key: string;
  severity: "error" | "warning" | "info" | "neutral";
  title: string;
  detail: string;
  action?: { label: string; run: () => void };
}

export function CapacityOverview({
  query,
  connectionState,
  onOpenPool,
  onOpenResource,
  onNavigate,
}: {
  query: ReturnType<typeof useCapacityOverview>;
  connectionState: CapacityConnectionState;
  onOpenPool: (name: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
  onNavigate: (path: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [showExplain, setShowExplain] = useState(false);

  const showAllPools =
    new URLSearchParams(location.search).get("poolView") === "all";
  const poolPagination = useCapacityPagination<CapacityPoolListResponse>(
    `overview-pools:${location.search}`,
  );
  const poolQuery = useCapacityPools({
    enabled: showAllPools,
    limit: 100,
    cursor: poolPagination.cursor,
  });
  const recoveringPoolCursor = useCapacityCursorRecovery(
    poolQuery.error,
    poolPagination.cursor,
    poolPagination.recover,
  );
  const recoveredPoolCursor = poolPagination.recovered || recoveringPoolCursor;
  const poolPage =
    poolQuery.data ??
    (recoveredPoolCursor ? poolPagination.retainedPage : undefined);

  const blocked = integrationBlock(
    query.data,
    query.error,
    query.isLoading,
    "Loading capacity overview…",
  );
  if (blocked) return blocked;

  const data = query.data as CapacityOverviewResponse;
  if (!coverageHasObservations(data.coverage.nodePools)) {
    return (
      <EmptyState
        icon={Layers3}
        title="NodePool inventory unavailable"
        detail={coverageMessage(data.coverage.nodePools, "NodePool inventory")}
      />
    );
  }

  const summary = data.summary;
  const coverage = data.coverage;
  const podsDeniedFlag = coverageIsDenied(coverage.pods);
  const unavailableRefresh = query.error ? errorMessage(query.error) : null;

  const visiblePools = showAllPools && poolPage ? poolPage.items : data.pools;
  const visiblePoolCoverage = poolPage?.coverage ?? coverage;

  const setShowAllPools = (show: boolean) => {
    const params = new URLSearchParams(location.search);
    if (show) params.set("poolView", "all");
    else params.delete("poolView");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true },
    );
  };

  const signals = buildSignals(summary, { onOpenPool, onNavigate });

  return (
    <ScrollableContent>
      <div>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-lg font-semibold text-theme-text-primary">
                Capacity overview
              </h1>
              <span className="text-xs text-theme-text-tertiary">
                Karpenter posture for this cluster · read-only diagnosis
              </span>
            </div>
            <button
              type="button"
              aria-expanded={showExplain}
              onClick={() => setShowExplain((value) => !value)}
              className="mt-1 flex items-center gap-1 text-xs font-medium text-accent-text hover:underline"
            >
              <CollapseChevron open={showExplain} className="h-3.5 w-3.5" />
              Scheduling capacity ≠ actual usage — how to read these numbers
            </button>
          </div>
          <div className="flex items-center gap-2">
            <ScopeBadges coverage={coverage} />
            <CapacityFreshness
              meta={data}
              query={query}
              connectionState={connectionState}
            />
          </div>
        </div>
        <Collapse open={showExplain}>
          <div className="mt-3 grid gap-3 rounded-xl border border-theme-border bg-theme-surface p-4 shadow-theme-sm sm:grid-cols-2 xl:grid-cols-3">
            {EXPLAIN_CARDS.map((card) => (
              <div key={card.term} className="text-xs leading-relaxed">
                <div className="font-semibold text-theme-text-primary">
                  {card.term}
                </div>
                <div className="mt-0.5 text-theme-text-tertiary">
                  {card.body}
                </div>
              </div>
            ))}
          </div>
        </Collapse>
      </div>

      {unavailableRefresh && <RefreshError message={unavailableRefresh} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="NodePools"
          value={summary.poolCount}
          sub={poolReadinessDetail(data.pools, data.poolsTruncated)}
          certainty="exact"
          certaintyTitle="Exact — cluster-scoped watch on Karpenter NodePools."
          attention={data.pools.some((pool) => pool.ready === false)}
        />
        <KpiTile
          label="Nodes"
          value={summary.nodeCount ?? "—"}
          sub={
            summary.unpooledNodeCount
              ? `+${summary.unpooledNodeCount} outside Karpenter pools`
              : coverageMessage(coverage.nodes, "Node inventory")
          }
          certainty={coverageCertainty(coverage.nodes)}
          certaintyTitle={coverageMessage(coverage.nodes, "Node inventory")}
        />
        <KpiTile
          label="NodeClaims"
          value={summary.claimCount ?? "—"}
          sub={
            summary.orphanedClaimCount
              ? `+${summary.orphanedClaimCount} orphaned (deleted NodePool)`
              : coverageMessage(coverage.nodeClaims, "Claim inventory")
          }
          certainty={coverageCertainty(coverage.nodeClaims)}
          certaintyTitle={coverageMessage(coverage.nodeClaims, "Claim inventory")}
        />
        {podsDeniedFlag ? (
          <KpiTile
            label="Pending pods"
            value="Unavailable"
            sub="Pod access denied — not zero"
            certainty="unknown"
            certaintyTitle="Unknown — the current identity cannot list Pods. Absence of data is not zero."
          />
        ) : (
          <KpiTile
            label="Pending pods"
            value={summary.pendingPodCount ?? "—"}
            sub="scheduling demand, not usage"
            certainty={coverageCertainty(coverage.pods)}
            certaintyTitle={coverageMessage(coverage.pods, "Pending demand")}
            attention={(summary.pendingPodCount ?? 0) > 0}
            linkLabel="Open Demand →"
            onClick={() => onNavigate("/capacity/demand")}
          />
        )}
      </div>

      <PendingDemandChips summary={summary} podsDenied={podsDeniedFlag} />

      <SectionCard
        title="Operational signals"
        subtitle="prioritized · each links to its diagnosis"
        actions={
          <div className="flex items-center gap-4">
            <LinkButton onClick={() => onNavigate("/capacity/demand")}>
              {summary.pendingPodCount !== undefined && !podsDeniedFlag
                ? `All demand · ${summary.pendingPodCount} →`
                : "All demand →"}
            </LinkButton>
            <LinkButton onClick={() => onNavigate("/capacity/activity")}>
              Activity timeline →
            </LinkButton>
          </div>
        }
        bodyClassName="divide-y divide-theme-border-subtle"
      >
        {signals.length === 0 ? (
          <InlineEmpty
            title="No operational signals"
            detail="Radar reported no capacity-affecting actions for this cluster."
          />
        ) : (
          signals.map((signal) => (
            <div
              key={signal.key}
              className="flex items-start gap-3 px-4 py-2.5 hover:bg-theme-hover/40"
            >
              <Badge
                severity={signal.severity}
                size="sm"
                className="min-w-[3rem] justify-center"
              >
                {signalSeverityLabel(signal.severity)}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-theme-text-primary">
                  {signal.title}
                </div>
                <div className="text-xs text-theme-text-secondary">
                  {signal.detail}
                </div>
              </div>
              {signal.action && (
                <LinkButton onClick={signal.action.run} className="shrink-0">
                  {signal.action.label} →
                </LinkButton>
              )}
            </div>
          ))
        )}
      </SectionCard>

      <SectionCard
        title="NodePool inventory"
        subtitle="cluster-scoped · scales from a handful of pools to hundreds via pagination"
        actions={
          (data.poolsTruncated || showAllPools) && (
            <button
              type="button"
              className="rounded-lg border border-theme-border px-2.5 py-1 text-xs font-medium text-accent-text transition-colors hover:bg-theme-hover"
              onClick={() => setShowAllPools(!showAllPools)}
            >
              {showAllPools ? "Return to posture list" : "Browse all NodePools"}
            </button>
          )
        }
        bodyClassName=""
      >
        {recoveredPoolCursor && (
          <div className="border-b border-theme-border-subtle px-4 py-2">
            <Notice>Pool inventory changed; showing the latest results.</Notice>
          </div>
        )}
        {showAllPools &&
          poolQuery.error &&
          !isCapacityCursorInvalidError(poolQuery.error) && (
            <div className="border-b border-theme-border-subtle px-4 py-2">
              <RefreshError message={errorMessage(poolQuery.error)} />
            </div>
          )}
        {showAllPools && poolQuery.isLoading && (
          <div className="border-b border-theme-border-subtle px-4 py-2 text-xs text-theme-text-tertiary">
            Loading paginated NodePool inventory…
          </div>
        )}
        <div className={TABLE_WRAP}>
          <table className="w-full min-w-[1180px] text-left">
            <thead className={TABLE_HEAD}>
              <tr>
                <th className={TH}>Pool</th>
                <th className={TH}>Readiness</th>
                <th className={TH}>Mode</th>
                <th className={TH}>NodeClass</th>
                <th className={TH}>Nodes · claims</th>
                <th className={`${TH} w-[190px]`}>
                  <WithTooltip tip="Provisioned capacity as a share of the configured NodePool limit">
                    <span>Limit pressure</span>
                  </WithTooltip>
                </th>
                <th className={TH}>
                  <WithTooltip tip="Sum of scheduled pod requests on this pool's nodes">
                    <span>Scheduled requests</span>
                  </WithTooltip>
                </th>
                <th className={`${TH} w-[210px]`}>
                  <WithTooltip tip="Point-in-time usage from the metrics API — an efficiency signal, not headroom">
                    <span>Usage (live)</span>
                  </WithTooltip>
                </th>
                <th className={TH}>Signals</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody className={TBODY}>
              {visiblePools.map((pool) => (
                <InventoryRow
                  key={pool.resource.ref.name}
                  pool={pool}
                  coverage={visiblePoolCoverage}
                  podsDenied={coverageIsDenied(visiblePoolCoverage.pods)}
                  onOpenPool={onOpenPool}
                  onOpenResource={onOpenResource}
                />
              ))}
            </tbody>
          </table>
        </div>
        {visiblePools.length === 0 && (
          <InlineEmpty
            title="No NodePools"
            detail="Karpenter is available, but no NodePools are visible to this user."
          />
        )}
        <div className="flex items-center gap-3 border-t border-theme-border-subtle px-4 py-2.5 text-xs text-theme-text-tertiary">
          <span>
            {summary.poolCount} {summary.poolCount === 1 ? "pool" : "pools"} ·
            cluster-scoped watch (exact)
          </span>
          <div className="flex-1" />
          {showAllPools &&
            poolPage &&
            (poolPagination.history.length > 0 || poolPage.page.hasMore) && (
              <PageControls
                page={poolPagination.history.length + 1}
                hasPrevious={poolPagination.history.length > 0}
                hasNext={
                  poolPage.page.hasMore && Boolean(poolPage.page.nextCursor)
                }
                busy={poolQuery.isFetching}
                onPrevious={() => poolPagination.goBack(poolPage)}
                onNext={() =>
                  poolPage.page.nextCursor &&
                  poolPagination.goNext(poolPage.page.nextCursor, poolPage)
                }
              />
            )}
        </div>
      </SectionCard>
    </ScrollableContent>
  );
}

function InventoryRow({
  pool,
  coverage,
  podsDenied,
  onOpenPool,
  onOpenResource,
}: {
  pool: CapacityPoolSummary;
  coverage: CapacityCoverageBySource;
  podsDenied: boolean;
  onOpenPool: (name: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  const nodes = pool.nodes;
  const claims = pool.claims;
  return (
    <tr className={ROW_HOVER}>
      <td className={TD}>
        <LinkButton
          onClick={() => onOpenPool(pool.resource.ref.name)}
          className="font-mono text-xs font-medium text-accent-text hover:underline"
        >
          {pool.resource.ref.name}
        </LinkButton>
      </td>
      <td className={TD}>
        <PoolReadyBadge ready={pool.ready} />
      </td>
      <td className={`${TD} whitespace-nowrap text-theme-text-secondary`}>
        {pool.mode === "unknown" ? "—" : pool.mode}
      </td>
      <td className={`${TD} font-mono text-xs`}>
        {pool.nodeClass
          ? `${pool.nodeClass.kind}/${pool.nodeClass.name}`
          : "—"}
      </td>
      <td className={`${TD} whitespace-nowrap text-theme-text-secondary`}>
        {nodes ? `${nodes.total} nodes` : "— nodes"} ·{" "}
        {claims ? `${claims.total} claims` : "— claims"}
      </td>
      <td className={TD}>
        <LimitPressureCell
          pressure={pickWorstPressure(pool.ledger.limitPressure)}
          hasConfiguredLimit={Boolean(pool.ledger.configuredLimit)}
        />
      </td>
      <td className={TD}>
        {podsDenied ? (
          <DeniedBadge />
        ) : (
          <QuantityInline
            observation={pool.ledger.scheduledRequests}
            empty={
              coverageHasObservations(coverage.pods)
                ? "0"
                : coverageMessage(coverage.pods, "Pod requests")
            }
          />
        )}
      </td>
      <td className={TD}>
        <ActualUsageInline
          usage={pool.ledger.actualUsage}
          coverage={coverage.nodeMetrics}
        />
      </td>
      <td className={TD}>
        {pool.issueCount > 0 || pool.factCount > 0 ? (
          <div className="flex flex-wrap gap-1">
            {pool.issueCount > 0 && (
              <Badge severity="warning" size="sm">
                {pool.issueCount} {pool.issueCount === 1 ? "issue" : "issues"}
              </Badge>
            )}
            {pool.factCount > 0 && (
              <Badge severity="info" size="sm">
                {pool.factCount} {pool.factCount === 1 ? "fact" : "facts"}
              </Badge>
            )}
          </div>
        ) : (
          <span className="text-xs text-theme-text-tertiary">—</span>
        )}
      </td>
      <td className={`${TD} text-right`}>
        <LinkButton
          onClick={() =>
            onOpenResource(identityToSelectedResource(pool.resource))
          }
          title="Open the raw NodePool in the resource drawer"
        >
          Inspect
        </LinkButton>
      </td>
    </tr>
  );
}

function PendingDemandChips({
  summary,
  podsDenied,
}: {
  summary: CapacityOverviewSummary;
  podsDenied: boolean;
}) {
  const entries = summary.aggregateDemand
    ? sortedResourceEntries(summary.aggregateDemand.resources)
    : [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-theme-text-tertiary">
        Active pending requests (scheduling demand, not usage):
      </span>
      {podsDenied ? (
        <DeniedBadge />
      ) : entries.length === 0 ? (
        <span className="text-xs text-theme-text-tertiary">
          None reported
        </span>
      ) : (
        <>
          {entries.map(([resource, value]) => (
            <Badge key={resource} tone="structural" size="sm">
              <span className="font-mono">{`${shortResourceLabel(resource)} ${value}`}</span>
            </Badge>
          ))}
          {summary.pendingPodCount !== undefined && (
            <Badge tone="structural" size="sm">
              <span className="font-mono">{`Pod slots ${summary.pendingPodCount}`}</span>
            </Badge>
          )}
        </>
      )}
    </div>
  );
}

function signalSeverityLabel(
  severity: OverviewSignal["severity"],
): string {
  if (severity === "error") return "Alert";
  if (severity === "warning") return "Warn";
  if (severity === "info") return "Info";
  return "Note";
}

function buildSignals(
  summary: CapacityOverviewSummary,
  handlers: {
    onOpenPool: (name: string) => void;
    onNavigate: (path: string) => void;
  },
): OverviewSignal[] {
  const signals: OverviewSignal[] = summary.actions.map((action) => {
    const demandState: CapacityDemandState | undefined =
      action.code === "pending_demand_blocked"
        ? "blocked"
        : action.code === "pending_demand_resource_pressure"
          ? "awaiting_capacity"
          : action.code === "pending_demand_unclassified"
            ? "unknown"
            : undefined;
    const poolNames = action.pools.map((pool) => pool.ref.name);
    const detailParts: string[] = [];
    if (poolNames.length > 0)
      detailParts.push(
        poolNames.slice(0, 3).join(", ") +
          (poolNames.length > 3 ? ` +${poolNames.length - 3} more` : ""),
      );
    if (action.count > 0)
      detailParts.push(
        `${action.count} ${action.count === 1 ? "occurrence" : "occurrences"}`,
      );
    const firstPool = action.pools[0];
    const action_: OverviewSignal["action"] = demandState
      ? {
          label: "View demand",
          run: () =>
            handlers.onNavigate(
              `/capacity/demand?state=${encodeURIComponent(demandState)}`,
            ),
        }
      : firstPool
        ? {
            label: "Diagnose pool",
            run: () => handlers.onOpenPool(firstPool.ref.name),
          }
        : undefined;
    return {
      key: `action:${action.code}`,
      severity: actionSeverity(action.highestSeverity),
      title: humanizeCode(action.code),
      detail:
        detailParts.join(" · ") ||
        "Reported by the Capacity API for this cluster.",
      action: action_,
    };
  });

  const orphaned = summary.orphanedClaimCount ?? 0;
  const unpooled = summary.unpooledNodeCount ?? 0;
  if (orphaned > 0 || unpooled > 0) {
    const parts: string[] = [];
    if (orphaned > 0)
      parts.push(
        `${orphaned} ${orphaned === 1 ? "claim references" : "claims reference"} a deleted NodePool`,
      );
    if (unpooled > 0)
      parts.push(
        `${unpooled} ${unpooled === 1 ? "node is" : "nodes are"} outside Karpenter pools`,
      );
    signals.push({
      key: "inventory:outside-pools",
      severity: "neutral",
      title: "Inventory outside live pools",
      detail: `${parts.join("; ")}. Both may be intentional.`,
    });
  }

  return signals.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity],
  );
}
