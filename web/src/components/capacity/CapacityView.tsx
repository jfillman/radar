import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Boxes,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Cpu,
  Gauge,
  Layers3,
  Server,
  Settings2,
  Shield,
  Waypoints,
  Workflow,
} from "lucide-react";
import {
  FreshnessControl,
  formatDuration,
  PaneLoader,
  ResourceBar,
  type CapacityCoverageBySource,
  type CapacityCoverageSource,
  type CapacityActivityEpisode,
  type CapacityActivityResponse,
  type CapacityClaimStage,
  type CapacityCondition,
  type CapacityDemandGroup,
  type CapacityDemandResponse,
  type CapacityDemandState,
  type CapacityIntegrationState,
  type CapacityMemberListResponse,
  type CapacityMemberType,
  type CapacityOverviewResponse,
  type CapacityOverviewSummary,
  type CapacityPoolMember,
  type CapacityPoolListResponse,
  type CapacityPoolObservation,
  type CapacityPoolSummary,
  type CapacityQuantityObservation,
  type CapacityResourceIdentity,
  type CapacityResponseMeta,
  type CapacitySourceCoverage,
  type CapacityUsageObservation,
} from "@skyhook-io/k8s-ui";
import { Badge } from "@skyhook-io/k8s-ui/components/ui/Badge";
import {
  formatCPUString,
  formatMemoryString,
} from "@skyhook-io/k8s-ui/utils/format";
import {
  isCapacityCursorInvalidError,
  isForbiddenError,
  isNotFoundError,
  useCapacityActivity,
  useCapacityDemand,
  useCapacityOverview,
  useCapacityPools,
  useCapacityPoolDetail,
  useCapacityPoolMembers,
} from "../../api/client";
import { useConnection } from "../../context/ConnectionContext";
import type { SelectedResource } from "../../types";
import { refToSelectedResource } from "../../utils/navigation";

interface CapacityViewProps {
  onOpenResource: (resource: SelectedResource) => void;
}

type CapacityTopTab = "overview" | "demand" | "activity";
type PoolSection = "summary" | "workloads" | "members" | "configuration";

interface CapacityRoute {
  topTab: CapacityTopTab;
  poolName?: string;
  poolSection: PoolSection;
}

const TOP_TABS: { id: CapacityTopTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "demand", label: "Demand" },
  { id: "activity", label: "Activity" },
];

const POOL_SECTIONS: { id: PoolSection; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "workloads", label: "Workloads" },
  { id: "members", label: "Nodes & claims" },
  { id: "configuration", label: "Configuration" },
];

export function CapacityView({ onOpenResource }: CapacityViewProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const route = parseCapacityRoute(location.pathname);
  const overview = useCapacityOverview({
    enabled: !route.poolName && route.topTab === "overview",
  });
  const { connection } = useConnection();

  const navigateCapacity = (target: string) => {
    const [pathname, rawSearch = ""] = target.split("?", 2);
    const params = new URLSearchParams(rawSearch);
    const namespaces = new URLSearchParams(location.search).get("namespaces");
    if (namespaces && !params.has("namespaces"))
      params.set("namespaces", namespaces);
    navigate({
      pathname,
      search: params.toString() ? `?${params.toString()}` : "",
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-theme-base">
      <div className="shrink-0 border-b border-theme-border bg-theme-base">
        <div className="flex items-start justify-between gap-6 px-5 pb-3 pt-4 xl:px-7">
          <div>
            <div className="flex items-center gap-2.5">
              <Gauge className="h-5 w-5 text-accent-text" />
              <h1 className="text-xl font-semibold text-theme-text-primary">
                Capacity
              </h1>
              <Badge tone="structural">Karpenter</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-theme-text-secondary">
              Plan from scheduler commitments and configured ceilings; use live
              usage as an efficiency signal, not as scheduler headroom.
            </p>
          </div>
        </div>
        <CapacityTabs
          active={route.topTab}
          onChange={(tab) =>
            navigateCapacity(
              tab === "overview" ? "/capacity" : `/capacity/${tab}`,
            )
          }
        />
      </div>

      {route.poolName ? (
        <PoolDetailView
          key={route.poolName}
          name={route.poolName}
          section={route.poolSection}
          connectionState={connection.state}
          onNavigate={navigateCapacity}
          onOpenResource={onOpenResource}
        />
      ) : route.topTab === "overview" ? (
        <OverviewView
          query={overview}
          connectionState={connection.state}
          onOpenPool={(name) => navigateCapacity(capacityPoolPath(name))}
          onInvestigateDemand={(state) =>
            navigateCapacity(
              `/capacity/demand?state=${encodeURIComponent(state)}`,
            )
          }
        />
      ) : route.topTab === "demand" ? (
        <DemandView
          connectionState={connection.state}
          onOpenPool={(name) => navigateCapacity(capacityPoolPath(name))}
          onOpenResource={onOpenResource}
        />
      ) : (
        <ActivityView
          connectionState={connection.state}
          onOpenPool={(name) => navigateCapacity(capacityPoolPath(name))}
          onOpenResource={onOpenResource}
        />
      )}
    </div>
  );
}

function CapacityTabs({
  active,
  onChange,
}: {
  active: CapacityTopTab;
  onChange: (tab: CapacityTopTab) => void;
}) {
  return (
    <div
      className="flex gap-1 px-5 xl:px-7"
      role="tablist"
      aria-label="Capacity views"
    >
      {TOP_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            active === tab.id
              ? "border-skyhook-500 text-theme-text-primary"
              : "border-transparent text-theme-text-secondary hover:border-theme-border-light hover:text-theme-text-primary"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function OverviewView({
  query,
  connectionState,
  onOpenPool,
  onInvestigateDemand,
}: {
  query: ReturnType<typeof useCapacityOverview>;
  connectionState: "connected" | "disconnected" | "connecting";
  onOpenPool: (name: string) => void;
  onInvestigateDemand: (state: CapacityDemandState) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
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
  const unavailableRefresh = query.error ? errorMessage(query.error) : null;
  const nearLimit =
    data.summary.actions.find(
      (action) => action.code === "configured_limit_pressure",
    )?.count ?? 0;
  const visiblePools = showAllPools && poolPage ? poolPage.items : data.pools;
  const visiblePoolCoverage = poolPage?.coverage ?? data.coverage;
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

  return (
    <ScrollableContent>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium text-theme-text-primary">
              Cluster capacity posture
            </h2>
            <Badge tone="structural" size="sm">
              {providerLabel(data)}
            </Badge>
          </div>
          <p className="text-xs text-theme-text-tertiary">
            Server-computed inventory, commitments, pressure, and observation
            coverage.
          </p>
        </div>
        <FreshnessControl
          mode="auto"
          dataUpdatedAt={generatedAtMillis(
            data.generatedAt,
            query.dataUpdatedAt,
          )}
          isFetching={query.isFetching}
          onRefresh={() => query.refetch()}
          connectionState={connectionState}
        />
      </div>

      {unavailableRefresh && <RefreshError message={unavailableRefresh} />}

      {coverageIsLowerBound(data.coverage.pods) && (
        <Notice>
          Pending pod counts and demand are a lower-bound view of{" "}
          {namespaceCoverageDescription(data.coverage.pods)}.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryStat
          label="NodePools"
          value={data.summary.poolCount}
          detail={poolReadinessDetail(data.pools, data.poolsTruncated)}
          attention={data.pools.some((pool) => pool.ready === false)}
        />
        <SummaryStat
          label="Nodes"
          value={optionalCount(data.summary.nodeCount)}
          detail={optionalCountDetail(
            data.summary.nodeCount,
            data.coverage.nodes,
            "Node inventory",
          )}
          attention={
            data.coverage.nodes?.status === "partial" ||
            data.coverage.nodes?.status === "error"
          }
        />
        <SummaryStat
          label="NodeClaims"
          value={optionalCount(data.summary.claimCount)}
          detail={optionalCountDetail(
            data.summary.claimCount,
            data.coverage.nodeClaims,
            "Claim inventory",
          )}
          attention={
            data.coverage.nodeClaims?.status === "partial" ||
            data.coverage.nodeClaims?.status === "error"
          }
        />
        <SummaryStat
          label="Pending pods"
          value={optionalCount(data.summary.pendingPodCount)}
          detail={optionalCountDetail(
            data.summary.pendingPodCount,
            data.coverage.pods,
            "Pending demand",
          )}
          attention={
            data.summary.pendingPodCount !== undefined &&
            data.summary.pendingPodCount > 0
          }
        />
      </div>

      <OverviewInventoryFacts summary={data.summary} />

      <OverviewSignals
        summary={data.summary}
        onOpenPool={onOpenPool}
        onInvestigateDemand={onInvestigateDemand}
      />

      {nearLimit > 0 && (
        <Notice>
          {nearLimit} {nearLimit === 1 ? "pool is" : "pools are"} at or above
          80% of at least one configured NodePool limit.
        </Notice>
      )}

      <section className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
        <div className="border-b-subtle px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-medium text-theme-text-primary">NodePools</h2>
              <p className="text-xs text-theme-text-tertiary">
                Open a pool for workload attribution, members, and its effective
                configuration.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {showAllPools && (
                <Badge tone="structural" size="sm">
                  Page {poolPagination.history.length + 1}
                </Badge>
              )}
              {data.poolsTruncated && !showAllPools && (
                <Badge severity="warning" size="sm">
                  Showing first {data.pools.length} of {data.summary.poolCount}
                </Badge>
              )}
              {(data.poolsTruncated || showAllPools) && (
                <button
                  type="button"
                  className="rounded-lg border border-theme-border px-2.5 py-1 text-xs font-medium text-accent-text transition-colors hover:bg-theme-hover"
                  onClick={() => setShowAllPools(!showAllPools)}
                >
                  {showAllPools
                    ? "Return to posture list"
                    : "Browse all NodePools"}
                </button>
              )}
            </div>
          </div>
        </div>
        {recoveredPoolCursor && (
          <div className="border-b-subtle px-4 py-2">
            <Notice>Pool inventory changed; showing the latest results.</Notice>
          </div>
        )}
        {showAllPools &&
          poolQuery.error &&
          !isCapacityCursorInvalidError(poolQuery.error) && (
            <div className="border-b-subtle px-4 py-2">
              <RefreshError message={errorMessage(poolQuery.error)} />
            </div>
          )}
        {showAllPools && poolQuery.isLoading && (
          <div className="border-b-subtle px-4 py-2 text-xs text-theme-text-tertiary">
            Loading paginated NodePool inventory…
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left">
            <thead className="border-b border-theme-border bg-theme-base/60 text-[11px] uppercase tracking-wide text-theme-text-tertiary">
              <tr>
                <th className="px-4 py-2.5 font-medium">Pool</th>
                <th className="px-3 py-2.5 font-medium">Nodes & claims</th>
                <th className="w-[220px] px-3 py-2.5 font-medium">
                  Configured limit
                </th>
                <th className="px-3 py-2.5 font-medium">Scheduled requests</th>
                <th className="w-[210px] px-3 py-2.5 font-medium">
                  Actual usage
                </th>
                <th className="px-3 py-2.5 font-medium">Signals</th>
                <th className="w-10 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="table-divide-subtle">
              {visiblePools.map((pool) => (
                <PoolRow
                  key={pool.resource.ref.name}
                  pool={pool}
                  coverage={visiblePoolCoverage}
                  onOpenPool={onOpenPool}
                />
              ))}
            </tbody>
          </table>
        </div>
        {showAllPools &&
          poolPage &&
          (poolPagination.history.length > 0 || poolPage.page.hasMore) && (
            <div className="border-t border-theme-border px-4 py-3">
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
            </div>
          )}
      </section>

      {visiblePools.length === 0 && (
        <InlineEmpty
          title="No NodePools"
          detail="Karpenter is available, but no NodePools are visible to this user."
        />
      )}
    </ScrollableContent>
  );
}

function OverviewInventoryFacts({
  summary,
}: {
  summary: CapacityOverviewSummary;
}) {
  const orphanedClaims = summary.orphanedClaimCount ?? 0;
  const unpooledNodes = summary.unpooledNodeCount ?? 0;
  if (orphanedClaims === 0 && unpooledNodes === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-theme-border bg-theme-surface px-4 py-3 text-sm shadow-theme-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
        Inventory outside live pools
      </span>
      {orphanedClaims > 0 && (
        <span className="flex items-center gap-2 text-theme-text-secondary">
          <Badge severity="warning" size="sm">
            {orphanedClaims}
          </Badge>
          {orphanedClaims === 1
            ? "NodeClaim no longer resolves"
            : "NodeClaims no longer resolve"}{" "}
          to a live NodePool
        </span>
      )}
      {unpooledNodes > 0 && (
        <span className="flex items-center gap-2 text-theme-text-secondary">
          <Badge tone="structural" size="sm">
            {unpooledNodes}
          </Badge>
          {unpooledNodes === 1 ? "node is" : "nodes are"} outside Karpenter
          NodePools; this may be intentional
        </span>
      )}
    </div>
  );
}

function OverviewSignals({
  summary,
  onOpenPool,
  onInvestigateDemand,
}: {
  summary: CapacityOverviewSummary;
  onOpenPool: (name: string) => void;
  onInvestigateDemand: (state: CapacityDemandState) => void;
}) {
  if (!summary.aggregateDemand && summary.actions.length === 0) return null;
  return (
    <section className="grid gap-3 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
      {summary.aggregateDemand && (
        <div className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-theme-sm">
          <div className="text-xs font-medium text-theme-text-tertiary">
            Active pending requests
          </div>
          <div className="mt-2">
            <QuantityInline
              observation={summary.aggregateDemand}
              empty="No pending quantities reported"
            />
          </div>
          <div className="mt-1 text-[11px] text-theme-text-tertiary">
            {certaintyLabel(summary.aggregateDemand)} ·{" "}
            {sourceLabel(summary.aggregateDemand.sources)} · as of{" "}
            {formatTimestamp(summary.aggregateDemand.asOf)}
          </div>
          <div className="mt-1 text-[11px] text-theme-text-tertiary">
            Excludes DaemonSet and scheduling-gated pods.
          </div>
        </div>
      )}
      {summary.actions.length > 0 && (
        <div
          className={`rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-theme-sm ${summary.aggregateDemand ? "" : "lg:col-span-2"}`}
        >
          <div className="text-xs font-medium text-theme-text-tertiary">
            Priority signals
          </div>
          <div className="mt-2 space-y-2">
            {summary.actions.map((action) => {
              const demandState: CapacityDemandState | undefined =
                action.code === "pending_demand_blocked"
                  ? "blocked"
                  : action.code === "pending_demand_resource_pressure"
                    ? "awaiting_capacity"
                    : action.code === "pending_demand_unclassified"
                      ? "unknown"
                      : undefined;

              return (
                <div
                  key={action.code}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      severity={actionSeverity(action.highestSeverity)}
                      size="sm"
                    >
                      {action.count}
                    </Badge>
                    <span className="text-sm font-medium text-theme-text-primary">
                      {humanizeCode(action.code)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {demandState && (
                      <button
                        type="button"
                        className="rounded-lg border border-theme-border px-2.5 py-1 text-xs font-medium text-accent-text transition-colors hover:bg-theme-hover"
                        onClick={() => onInvestigateDemand(demandState)}
                        aria-label={`Investigate ${humanizeCode(action.code).toLowerCase()}`}
                      >
                        Investigate
                      </button>
                    )}
                    {action.pools.slice(0, 5).map((pool) => (
                      <Badge
                        key={identityKey(pool)}
                        tone="structural"
                        size="sm"
                        onClick={() => onOpenPool(pool.ref.name)}
                      >
                        {pool.ref.name}
                      </Badge>
                    ))}
                    {(action.truncated || action.pools.length > 5) && (
                      <Badge tone="structural" size="sm">
                        more
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export function PoolRow({
  pool,
  coverage,
  onOpenPool,
}: {
  pool: CapacityPoolSummary;
  coverage: CapacityCoverageBySource;
  onOpenPool: (name: string) => void;
}) {
  const openPool = () => onOpenPool(pool.resource.ref.name);
  const highestPressure = [...pool.ledger.limitPressure].sort((left, right) => {
    if (left.overLimit !== right.overLimit) return left.overLimit ? -1 : 1;
    return (right.percent ?? -1) - (left.percent ?? -1);
  })[0];

  return (
    <tr
      className="cursor-pointer transition-colors hover:bg-theme-hover/50"
      onClick={openPool}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPool();
        }
      }}
      tabIndex={0}
      aria-label={`Open ${pool.resource.ref.name} capacity details`}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-theme-text-primary">
            {pool.resource.ref.name}
          </span>
          <PoolReadyBadge ready={pool.ready} />
          {pool.mode !== "unknown" && (
            <Badge tone="structural" size="sm">
              {pool.mode}
            </Badge>
          )}
        </div>
        <div className="mt-1 text-xs text-theme-text-tertiary">
          {pool.nodeClass
            ? `${pool.nodeClass.kind}/${pool.nodeClass.name}`
            : "NodeClass reference not reported"}
        </div>
      </td>
      <td className="px-3 py-3">
        <LifecycleCell
          nodes={pool.nodes}
          claims={pool.claims}
          coverage={coverage}
        />
      </td>
      <td className="px-3 py-3">
        <PressureCell
          pressure={highestPressure}
          hasConfiguredLimit={Boolean(pool.ledger.configuredLimit)}
        />
      </td>
      <td className="px-3 py-3">
        <QuantityInline
          observation={pool.ledger.scheduledRequests}
          empty={
            coverageHasObservations(coverage.pods)
              ? "No scheduled requests"
              : coverageMessage(coverage.pods, "Pod requests")
          }
        />
      </td>
      <td className="px-3 py-3">
        <ActualUsageInline
          usage={pool.ledger.actualUsage}
          coverage={coverage.nodeMetrics}
        />
      </td>
      <td className="px-3 py-3">
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
          <span className="text-xs text-theme-text-tertiary">No signals</span>
        )}
      </td>
      <td className="px-3 py-3">
        <ChevronRight className="h-4 w-4 text-theme-text-tertiary" />
      </td>
    </tr>
  );
}

function PoolDetailView({
  name,
  section,
  connectionState,
  onNavigate,
  onOpenResource,
}: {
  name: string;
  section: PoolSection;
  connectionState: "connected" | "disconnected" | "connecting";
  onNavigate: (path: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  const query = useCapacityPoolDetail(name);
  if (isNotFoundError(query.error)) {
    return (
      <ScrollableContent>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
          onClick={() => onNavigate("/capacity")}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to capacity overview
        </button>
        <section className="rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
          <InlineEmpty
            title="NodePool not found"
            detail={`${name} may have been removed or may belong to another cluster context.`}
          />
        </section>
      </ScrollableContent>
    );
  }
  const blocked = integrationBlock(
    query.data,
    query.error,
    query.isLoading,
    `Loading ${name}…`,
  );
  if (blocked) return blocked;

  const response = query.data;
  const pool = response?.pool;
  if (response && !coverageHasObservations(response.coverage.nodePools)) {
    return (
      <EmptyState
        icon={Layers3}
        title="NodePool inventory unavailable"
        detail={coverageMessage(
          response.coverage.nodePools,
          "NodePool inventory",
        )}
      />
    );
  }
  if (!response || !pool) {
    return (
      <EmptyState
        icon={CircleHelp}
        title="NodePool not found"
        detail={`${name} is not visible in the current cluster context.`}
      />
    );
  }

  const poolPath = `/capacity/pools/${encodeURIComponent(name)}`;
  const openPool = () =>
    onOpenResource(identityToSelectedResource(pool.resource));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1600px] space-y-4 px-5 py-5 xl:px-7">
        {query.error && <RefreshError message={errorMessage(query.error)} />}

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              aria-label="Back to capacity overview"
              className="mt-0.5 rounded-lg p-1.5 text-theme-text-tertiary transition-colors hover:bg-theme-hover hover:text-theme-text-primary"
              onClick={() => onNavigate("/capacity")}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-semibold text-theme-text-primary">
                  {name}
                </h2>
                <Badge kind="NodePool" size="sm">
                  NodePool
                </Badge>
                <PoolReadyBadge ready={pool.ready} />
                {pool.mode !== "unknown" && (
                  <Badge tone="structural" size="sm">
                    {pool.mode}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-theme-text-tertiary">
                Generation {pool.generation}
                {pool.observedGeneration !== undefined
                  ? ` · observed ${pool.observedGeneration}`
                  : " · observed generation unknown"}{" "}
                · {providerLabel(response)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <FreshnessControl
              mode="auto"
              dataUpdatedAt={generatedAtMillis(
                response.generatedAt,
                query.dataUpdatedAt,
              )}
              isFetching={query.isFetching}
              onRefresh={() => query.refetch()}
              connectionState={connectionState}
            />
            <button
              type="button"
              className="rounded-lg border border-theme-border px-3 py-1.5 text-sm font-medium text-theme-text-secondary hover:bg-theme-hover"
              onClick={() =>
                onNavigate(
                  `/capacity/activity?pool=${encodeURIComponent(name)}`,
                )
              }
            >
              View activity
            </button>
            <button
              type="button"
              className="btn-brand px-3 py-1.5 text-sm"
              onClick={openPool}
            >
              Open NodePool
            </button>
          </div>
        </header>

        <PoolTabs
          active={section}
          onChange={(next) =>
            onNavigate(next === "summary" ? poolPath : `${poolPath}/${next}`)
          }
        />

        {section === "summary" && (
          <PoolSummaryView pool={pool} onOpenResource={onOpenResource} />
        )}
        {section === "workloads" && (
          <PoolWorkloadsView name={name} onOpenResource={onOpenResource} />
        )}
        {section === "members" && (
          <PoolMembersView name={name} onOpenResource={onOpenResource} />
        )}
        {section === "configuration" && (
          <PoolConfigurationView pool={pool} onOpenResource={onOpenResource} />
        )}
      </div>
    </div>
  );
}

function PoolTabs({
  active,
  onChange,
}: {
  active: PoolSection;
  onChange: (section: PoolSection) => void;
}) {
  return (
    <div
      className="flex gap-1 overflow-x-auto border-b border-theme-border"
      role="tablist"
      aria-label="NodePool details"
    >
      {POOL_SECTIONS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            active === tab.id
              ? "border-skyhook-500 text-theme-text-primary"
              : "border-transparent text-theme-text-secondary hover:border-theme-border-light hover:text-theme-text-primary"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function PoolSummaryView({
  pool,
  onOpenResource,
}: {
  pool: CapacityPoolObservation;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InspectorCard
        icon={Shield}
        title="Capacity ledger"
        detail="Each figure retains its server-reported certainty, source, and observation time."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <ObservationCard
            label="Configured limit"
            observation={pool.ledger.configuredLimit}
            empty="No NodePool limit configured"
          />
          <ObservationCard
            label="Provisioned"
            observation={pool.ledger.provisioned}
            empty={coverageMessage(
              pool.coverage.nodeClaims,
              "Provisioned capacity",
            )}
          />
          <ObservationCard
            label="Allocatable"
            observation={pool.ledger.allocatable}
            empty={coverageMessage(pool.coverage.nodes, "Allocatable capacity")}
          />
          <ObservationCard
            label="Scheduled requests"
            observation={pool.ledger.scheduledRequests}
            empty={coverageMessage(pool.coverage.pods, "Pod requests")}
          />
          <ObservationCard
            label="Capacity in flight"
            observation={pool.ledger.inFlightCapacity}
            empty={
              pool.coverage.nodeClaims?.status === "available"
                ? "No capacity currently in flight"
                : coverageMessage(
                    pool.coverage.nodeClaims,
                    "In-flight capacity",
                  )
            }
          />
          <ObservationCard
            label="Configured-limit headroom"
            observation={pool.ledger.limitHeadroom}
            empty={
              pool.ledger.configuredLimit
                ? "Headroom is not comparable to provisioned status"
                : "No NodePool limit configured"
            }
          />
          <ObservationCard
            label="Aggregate unallocated (not bin-packed)"
            observation={pool.ledger.aggregateUnallocatedRequests}
            empty="Allocatable or pod requests were not observed"
          />
        </div>
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-theme-text-secondary">
            Configured-limit pressure
          </div>
          {pool.ledger.limitPressure.length > 0 ? (
            <div className="space-y-3">
              {pool.ledger.limitPressure.map((pressure) => (
                <PressureDetail key={pressure.resource} pressure={pressure} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-theme-text-secondary">
              No NodePool limits are configured; provider quotas remain the
              external ceiling.
            </p>
          )}
        </div>
      </InspectorCard>

      <InspectorCard
        icon={Activity}
        title="Actual usage"
        detail="Point-in-time efficiency across nodes with a live sample; Karpenter schedules from requests."
      >
        <ActualUsageDetail
          usage={pool.ledger.actualUsage}
          coverage={pool.coverage.nodeMetrics}
        />
      </InspectorCard>

      <InspectorCard
        icon={AlertTriangle}
        title="Signals"
        detail="Capacity-specific issues and explanatory posture facts from the server."
      >
        <SignalsView pool={pool} />
      </InspectorCard>

      <InspectorCard
        icon={Server}
        title="Lifecycle"
        detail="Claims and nodes are shown only when their inventories were observed."
      >
        <LifecycleSummary pool={pool} />
      </InspectorCard>

      <InspectorCard
        icon={Waypoints}
        title="Fleet composition"
        detail="The concrete capacity Karpenter has provisioned for this pool."
      >
        {pool.nodes && pool.composition ? (
          <div className="grid grid-cols-2 gap-4">
            <Breakdown
              title="Purchase"
              values={pool.composition.capacityTypes}
              meta={pool.composition.capacityTypesMeta}
            />
            <Breakdown
              title="Zones"
              values={pool.composition.zones}
              meta={pool.composition.zonesMeta}
            />
            <Breakdown
              title="Instance types"
              values={pool.composition.instanceTypes}
              meta={pool.composition.instanceTypesMeta}
            />
            <Breakdown
              title="Architecture"
              values={pool.composition.architectures}
              meta={pool.composition.architecturesMeta}
            />
          </div>
        ) : (
          <CoverageText
            coverage={pool.coverage.nodes}
            subject="Fleet composition"
          />
        )}
      </InspectorCard>

      <InspectorCard
        icon={Workflow}
        title="Workload attribution"
        detail="Owners and pod requests currently placed on this NodePool."
      >
        <WorkloadSummaryView pool={pool} onOpenResource={onOpenResource} />
      </InspectorCard>

      <InspectorCard
        icon={CircleHelp}
        title="Conditions"
        detail="Controller-reported readiness reasons and messages for this NodePool."
      >
        <ConditionsView conditions={pool.conditions} />
      </InspectorCard>
    </div>
  );
}

function PoolWorkloadsView({
  name,
  onOpenResource,
}: {
  name: string;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  return (
    <MemberPage
      name={name}
      type="workload"
      title="Workloads scheduled on this pool"
      empty="No workloads were observed on this NodePool."
      render={(items) => (
        <WorkloadMembersTable items={items} onOpenResource={onOpenResource} />
      )}
    />
  );
}

function PoolMembersView({
  name,
  onOpenResource,
}: {
  name: string;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  return (
    <div className="space-y-4">
      <MemberPage
        name={name}
        type="node"
        title="Nodes"
        empty="No Nodes were observed for this NodePool."
        render={(items, coverage) => (
          <NodeMembersTable
            items={items}
            podCoverage={coverage.pods}
            nodeMetricsCoverage={coverage.nodeMetrics}
            onOpenResource={onOpenResource}
          />
        )}
      />
      <MemberPage
        name={name}
        type="claim"
        title="NodeClaims"
        empty="No NodeClaims were observed for this NodePool."
        render={(items, coverage) => (
          <ClaimMembersTable
            items={items}
            nodeCoverage={coverage.nodes}
            onOpenResource={onOpenResource}
          />
        )}
      />
    </div>
  );
}

function MemberPage({
  name,
  type,
  title,
  empty,
  render,
}: {
  name: string;
  type: CapacityMemberType;
  title: string;
  empty: string;
  render: (
    items: CapacityPoolMember[],
    coverage: CapacityCoverageBySource,
  ) => ReactNode;
}) {
  const pagination = useCapacityPagination<CapacityMemberListResponse>(
    `${name}\u0000${type}`,
  );
  const query = useCapacityPoolMembers(name, type, {
    limit: 50,
    cursor: pagination.cursor,
  });
  const recoveringCursor = useCapacityCursorRecovery(
    query.error,
    pagination.cursor,
    pagination.recover,
  );
  const recoveredCursor = pagination.recovered || recoveringCursor;
  const response =
    query.data ?? (recoveredCursor ? pagination.retainedPage : undefined);
  const sourceCoverage = response?.coverage[memberCoverageSource(type)];

  return (
    <section className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
      <div className="flex items-center justify-between gap-3 border-b-subtle px-4 py-3">
        <div>
          <h3 className="font-medium text-theme-text-primary">{title}</h3>
          <p className="text-xs text-theme-text-tertiary">
            Observed membership, refreshed every 30 seconds.
          </p>
        </div>
        {response && (
          <Badge tone="structural" size="sm">
            Page {pagination.history.length + 1}
          </Badge>
        )}
      </div>

      {recoveredCursor && (
        <div className="p-3">
          <Notice>Capacity data changed; showing the latest results.</Notice>
        </div>
      )}
      {query.error &&
        response &&
        !isCapacityCursorInvalidError(query.error) && (
          <div className="p-3">
            <RefreshError message={errorMessage(query.error)} />
          </div>
        )}
      {!response && query.isLoading && (
        <div className="px-4 py-8 text-center text-sm text-theme-text-secondary">
          Loading {title.toLowerCase()}…
        </div>
      )}
      {!response && query.error && (
        <InlineEmpty
          title={`${title} unavailable`}
          detail={errorMessage(query.error)}
        />
      )}
      {response?.state === "syncing" && (
        <InlineEmpty
          title="Inventory is syncing"
          detail={`${title} will appear when the relevant cache is ready.`}
        />
      )}
      {response?.state === "denied" && (
        <InlineEmpty
          title="Inventory denied"
          detail={`This user cannot read the resources required for ${title.toLowerCase()}.`}
        />
      )}
      {response?.state === "not_detected" && (
        <InlineEmpty
          title="Karpenter not detected"
          detail="The provider is not available in this cluster context."
        />
      )}
      {response?.state === "available" &&
        response.items.length === 0 &&
        !coverageHasObservations(sourceCoverage) && (
          <InlineEmpty
            title={`${title} unavailable`}
            detail={coverageMessage(sourceCoverage, title)}
          />
        )}
      {response?.state === "available" &&
        response.items.length === 0 &&
        coverageHasObservations(sourceCoverage) && (
          <InlineEmpty title={`No ${title}`} detail={empty} />
        )}
      {response?.state === "available" &&
        response.items.length > 0 &&
        coverageIsLowerBound(sourceCoverage) && (
          <div className="p-3">
            <Notice>{coverageMessage(sourceCoverage, title)}.</Notice>
          </div>
        )}
      {response?.state === "available" &&
        response.items.length > 0 &&
        render(response.items, response.coverage)}

      {response?.state === "available" &&
        (pagination.history.length > 0 || response.page.hasMore) && (
          <div className="flex items-center justify-end gap-2 border-t border-theme-border px-4 py-3">
            <button
              type="button"
              className="rounded-lg border border-theme-border px-3 py-1.5 text-xs font-medium text-theme-text-secondary hover:bg-theme-hover disabled:opacity-50"
              disabled={pagination.history.length === 0 || query.isFetching}
              onClick={() => pagination.goBack(response)}
            >
              <ChevronLeft className="mr-1 inline h-3.5 w-3.5" />
              Previous
            </button>
            <button
              type="button"
              className="rounded-lg border border-theme-border px-3 py-1.5 text-xs font-medium text-theme-text-secondary hover:bg-theme-hover disabled:opacity-50"
              disabled={
                !response.page.hasMore ||
                !response.page.nextCursor ||
                query.isFetching
              }
              onClick={() =>
                response.page.nextCursor &&
                pagination.goNext(response.page.nextCursor, response)
              }
            >
              Next
              <ChevronRight className="ml-1 inline h-3.5 w-3.5" />
            </button>
          </div>
        )}
    </section>
  );
}

function NodeMembersTable({
  items,
  podCoverage,
  nodeMetricsCoverage,
  onOpenResource,
}: {
  items: CapacityPoolMember[];
  podCoverage?: CapacitySourceCoverage;
  nodeMetricsCoverage?: CapacitySourceCoverage;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  return (
    <div>
      {coverageIsLowerBound(podCoverage) && (
        <div className="border-b-subtle p-3">
          <Notice>
            {coverageMessage(
              podCoverage,
              "Pod counts and scheduled requests",
            )}
            . Per-node values are lower bounds.
          </Notice>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="bg-theme-base/60 text-[11px] uppercase tracking-wide text-theme-text-tertiary">
          <tr>
            <th className="px-4 py-2.5 font-medium">Node</th>
            <th className="px-3 py-2.5 font-medium">State</th>
            <th className="px-3 py-2.5 font-medium">Purchase</th>
            <th className="px-3 py-2.5 font-medium">Instance / zone</th>
            <th className="px-3 py-2.5 font-medium">Pods</th>
            <th className="px-3 py-2.5 font-medium">Allocatable</th>
            <th className="px-3 py-2.5 font-medium">Scheduled requests</th>
            <th className="px-3 py-2.5 font-medium">Actual usage</th>
          </tr>
        </thead>
        <tbody className="table-divide-subtle">
          {items.map((item) => {
            const node = item.node;
            return (
              <tr
                key={identityKey(item.resource)}
                className="hover:bg-theme-hover/40"
              >
                <td className="px-4 py-3">
                  <ResourceLink
                    identity={item.resource}
                    onOpenResource={onOpenResource}
                  />
                </td>
                <td className="px-3 py-3">
                  <NodeReadyBadge
                    ready={node?.ready}
                    cordoned={node?.cordoned ?? false}
                  />
                </td>
                <td className="px-3 py-3">
                  {node?.capacityType ? (
                    <Badge tone="accent1" size="sm">
                      {node.capacityType}
                    </Badge>
                  ) : (
                    <UnknownValue />
                  )}
                </td>
                <td className="px-3 py-3 text-theme-text-secondary">
                  <div>{node?.instanceType ?? "Unknown instance type"}</div>
                  <div className="text-xs text-theme-text-tertiary">
                    {node?.zone ?? "Unknown zone"}
                  </div>
                </td>
                <td className="px-3 py-3 font-mono tabular-nums text-theme-text-primary">
                  {node?.podCount !== undefined ? (
                    coverageIsLowerBound(podCoverage) ? (
                      <span aria-label={`At least ${node.podCount} pods`}>
                        ≥{node.podCount}
                      </span>
                    ) : (
                      node.podCount
                    )
                  ) : (
                    <UnknownValue
                      label={coverageMessage(podCoverage, "Pod count")}
                    />
                  )}
                </td>
                <td className="px-3 py-3">
                  <QuantityInline
                    observation={node?.allocatable}
                    empty="Not observed"
                  />
                </td>
                <td className="px-3 py-3">
                  <QuantityInline
                    observation={node?.scheduledRequests}
                    empty={
                      coverageHasObservations(podCoverage)
                        ? "No scheduled requests"
                        : coverageMessage(podCoverage, "Scheduled requests")
                    }
                  />
                </td>
                <td className="px-3 py-3">
                  <ActualUsageInline
                    usage={node?.actualUsage}
                    coverage={nodeMetricsCoverage}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
    </div>
  );
}

function ClaimMembersTable({
  items,
  nodeCoverage,
  onOpenResource,
}: {
  items: CapacityPoolMember[];
  nodeCoverage?: CapacitySourceCoverage;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-theme-base/60 text-[11px] uppercase tracking-wide text-theme-text-tertiary">
          <tr>
            <th className="px-4 py-2.5 font-medium">NodeClaim</th>
            <th className="px-3 py-2.5 font-medium">Stage</th>
            <th className="px-3 py-2.5 font-medium">Node</th>
            <th className="px-3 py-2.5 font-medium">Capacity</th>
            <th className="px-3 py-2.5 font-medium">Conditions</th>
          </tr>
        </thead>
        <tbody className="table-divide-subtle">
          {items.map((item) => (
            <tr
              key={identityKey(item.resource)}
              className="hover:bg-theme-hover/40"
            >
              <td className="px-4 py-3">
                <ResourceLink
                  identity={item.resource}
                  onOpenResource={onOpenResource}
                />
              </td>
              <td className="px-3 py-3">
                <ClaimStageBadge stage={item.claim?.stage} />
              </td>
              <td className="px-3 py-3">
                {item.claim?.node ? (
                  <ResourceLink
                    identity={item.claim.node}
                    onOpenResource={onOpenResource}
                  />
                ) : item.claim?.nodeName ? (
                  <div>
                    <span className="font-medium text-theme-text-primary">
                      {item.claim.nodeName}
                    </span>
                    {!coverageHasObservations(nodeCoverage) && (
                      <div className="text-xs text-theme-text-tertiary">
                        {coverageMessage(nodeCoverage, "Node details")}
                      </div>
                    )}
                  </div>
                ) : coverageHasObservations(nodeCoverage) ? (
                  <UnknownValue label="Not registered" />
                ) : (
                  <UnknownValue
                    label={coverageMessage(nodeCoverage, "Node registration")}
                  />
                )}
              </td>
              <td className="px-3 py-3">
                <QuantityInline
                  observation={item.claim?.capacity}
                  empty="Not reported"
                />
              </td>
              <td className="px-3 py-3 text-xs text-theme-text-secondary">
                {conditionSummary(item.claim?.conditions)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkloadMembersTable({
  items,
  onOpenResource,
}: {
  items: CapacityPoolMember[];
  onOpenResource: (resource: SelectedResource) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="bg-theme-base/60 text-[11px] uppercase tracking-wide text-theme-text-tertiary">
          <tr>
            <th className="px-4 py-2.5 font-medium">Workload</th>
            <th className="px-3 py-2.5 font-medium">Namespace</th>
            <th className="px-3 py-2.5 font-medium">Pods</th>
            <th className="px-3 py-2.5 font-medium">Requests</th>
            <th className="px-3 py-2.5 font-medium">Nodes</th>
          </tr>
        </thead>
        <tbody className="table-divide-subtle">
          {items.map((item) => {
            const workload = item.workload;
            const owner = workload?.owner;
            return (
              <tr
                key={identityKey(item.resource)}
                className="hover:bg-theme-hover/40"
              >
                <td className="px-4 py-3">
                  {owner ? (
                    <button
                      type="button"
                      className="font-medium text-accent-text hover:underline"
                      onClick={() =>
                        onOpenResource(refToSelectedResource(owner))
                      }
                    >
                      {owner.kind}/{owner.name}
                    </button>
                  ) : (
                    <ResourceLink
                      identity={item.resource}
                      onOpenResource={onOpenResource}
                    />
                  )}
                </td>
                <td className="px-3 py-3 text-theme-text-secondary">
                  {owner?.namespace ??
                    item.resource.ref.namespace ??
                    "Cluster-scoped"}
                </td>
                <td className="px-3 py-3 font-mono tabular-nums text-theme-text-primary">
                  {workload ? workload.podCount : <UnknownValue />}
                </td>
                <td className="px-3 py-3">
                  <QuantityInline
                    observation={workload?.requests}
                    empty="Not observed"
                  />
                </td>
                <td className="px-3 py-3">
                  {workload && workload.nodes.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {workload.nodes.slice(0, 4).map((node) => (
                        <Badge
                          key={identityKey(node)}
                          tone="structural"
                          size="sm"
                          onClick={() =>
                            onOpenResource(identityToSelectedResource(node))
                          }
                        >
                          {node.ref.name}
                        </Badge>
                      ))}
                      {workload.nodesMeta.total > 4 && (
                        <Badge tone="structural" size="sm">
                          +{workload.nodesMeta.total - 4}
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <UnknownValue label="No nodes reported" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PoolConfigurationView({
  pool,
  onOpenResource,
}: {
  pool: CapacityPoolObservation;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  const config = pool.configuration;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InspectorCard
        icon={Settings2}
        title="Provisioning policy"
        detail="The effective NodePool fields that shape candidate capacity."
      >
        <KeyValueRows
          rows={[
            ["Mode", pool.mode],
            [
              "Weight",
              config.weight !== undefined
                ? String(config.weight)
                : "Not configured",
            ],
            [
              "Static replicas",
              config.replicas !== undefined
                ? String(config.replicas)
                : "Not configured",
            ],
            ["Expire after", config.expireAfter || "Not configured"],
            [
              "Termination grace",
              config.terminationGracePeriod || "Not configured",
            ],
          ]}
        />
        <div className="mt-4 border-t border-theme-border pt-3">
          <div className="mb-2 text-xs font-medium text-theme-text-tertiary">
            NodeClass
          </div>
          {pool.nodeClass ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-theme-text-primary">
                  {pool.nodeClass.reference.kind}/
                  {pool.nodeClass.reference.name}
                  <PoolReadyBadge ready={pool.nodeClass.ready} />
                </div>
                <div className="text-xs text-theme-text-tertiary">
                  {pool.nodeClass.reference.group}
                  {pool.nodeClass.ready === undefined
                    ? ` · ${coverageMessage(pool.coverage.nodeClasses, "NodeClass readiness")}`
                    : ""}
                </div>
              </div>
              <button
                type="button"
                className="text-sm font-medium text-accent-text hover:underline"
                onClick={() =>
                  onOpenResource(
                    refToSelectedResource(pool.nodeClass!.reference),
                  )
                }
              >
                Open
              </button>
            </div>
          ) : (
            <p className="text-sm text-theme-text-secondary">
              No NodeClass reference was reported.
            </p>
          )}
          {pool.nodeClass && pool.nodeClass.conditions.length > 0 && (
            <div className="mt-3">
              <ConditionsView conditions={pool.nodeClass.conditions} />
            </div>
          )}
        </div>
      </InspectorCard>

      <InspectorCard
        icon={Shield}
        title="Disruption"
        detail="Consolidation behavior, active allowances, and known blockers."
      >
        <KeyValueRows
          rows={[
            [
              "Consolidation",
              pool.disruption.consolidationPolicy || "Not configured",
            ],
            [
              "Consolidate after",
              pool.disruption.consolidateAfter || "Not configured",
            ],
            ["Budgets", String(pool.disruption.budgets.length)],
          ]}
        />
        {pool.disruption.budgets.length > 0 && (
          <div className="mt-3 space-y-2">
            {pool.disruption.budgets.map((budget, index) => (
              <div
                key={`${budget.nodes}-${index}`}
                className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2 text-xs text-theme-text-secondary"
              >
                <span className="font-medium text-theme-text-primary">
                  {budget.nodes}
                </span>{" "}
                nodes ·{" "}
                {budget.reasons.length > 0
                  ? budget.reasons.join(", ")
                  : "all reasons"}
                {budget.schedule ? ` · ${budget.schedule}` : ""}
                {budget.duration ? ` for ${budget.duration}` : ""}
              </div>
            ))}
          </div>
        )}
        {pool.disruption.runtime &&
          pool.disruption.runtime.allowed.length > 0 && (
            <div className="mt-3 space-y-2">
              {pool.disruption.runtime.allowed.map((allowance) => (
                <div
                  key={`${allowance.reason}-${allowance.source}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2 text-xs"
                >
                  <span className="text-theme-text-secondary">
                    {allowance.reason}{" "}
                    <span className="text-theme-text-tertiary">
                      · {allowance.source}
                    </span>
                  </span>
                  <Badge tone="structural" size="sm">
                    {allowance.count} allowed
                  </Badge>
                </div>
              ))}
            </div>
          )}
        {pool.disruption.runtime &&
          pool.disruption.runtime.blockers.length > 0 && (
            <div className="mt-3 space-y-2">
              {pool.disruption.runtime.blockers.map((blocker) => (
                <Notice key={`${blocker.code}-${blocker.message}`}>
                  {blocker.message}
                </Notice>
              ))}
            </div>
          )}
        {pool.disruption.runtime &&
          pool.disruption.runtime.allowed.length === 0 &&
          pool.disruption.runtime.blockers.length === 0 && (
            <p className="mt-3 text-xs text-theme-text-tertiary">
              No active disruption allowances or known blockers were reported.
            </p>
          )}
        {pool.disruption.runtime && (
          <p className="mt-3 text-xs text-theme-text-tertiary">
            {certaintyValueLabel(pool.disruption.runtime.certainty)} · sources:{" "}
            {sourceLabel(pool.disruption.runtime.sources)} · as of{" "}
            {formatTimestamp(pool.disruption.runtime.asOf)}
          </p>
        )}
        {!pool.disruption.runtime && (
          <p className="mt-3 text-xs text-theme-text-tertiary">
            Live disruption allowance and blocker evaluation is not observed.
          </p>
        )}
      </InspectorCard>

      <InspectorCard
        icon={Layers3}
        title="Requirements"
        detail="Declared scheduling constraints; no compatibility is inferred in the browser."
      >
        {config.requirements.length > 0 ? (
          <div className="space-y-2">
            {config.requirements.map((requirement) => (
              <div
                key={`${requirement.key}-${requirement.operator}`}
                className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
              >
                <div className="text-xs font-medium text-theme-text-primary">
                  {requirement.key}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-theme-text-secondary">
                  <Badge tone="structural" size="sm">
                    {requirement.operator}
                  </Badge>
                  {requirement.values.map((value) => (
                    <Badge key={value} tone="structural" size="sm">
                      {value}
                    </Badge>
                  ))}
                  {requirement.minValues !== undefined && (
                    <span>
                      minimum distinct values: {requirement.minValues}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-theme-text-secondary">
            No requirements are configured.
          </p>
        )}
      </InspectorCard>

      <InspectorCard
        icon={Boxes}
        title="Labels & taints"
        detail="Template metadata and placement controls applied to capacity from this pool."
      >
        <div className="space-y-4">
          <TokenGroup
            title="Labels"
            values={Object.entries(config.labels).map(
              ([key, value]) => `${key}=${value}`,
            )}
            empty="No labels configured"
          />
          <TokenGroup
            title="Taints"
            values={config.taints.map(formatTaint)}
            empty="No taints configured"
          />
          <TokenGroup
            title="Startup taints"
            values={config.startupTaints.map(formatTaint)}
            empty="No startup taints configured"
          />
        </div>
      </InspectorCard>
    </div>
  );
}

function DemandView({
  connectionState,
  onOpenPool,
  onOpenResource,
}: {
  connectionState: "connected" | "disconnected" | "connecting";
  onOpenPool: (name: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
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
        detail={`The ${poolFilter} NodePool may have been removed or belongs to another cluster context.`}
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
  return (
    <ScrollableContent>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-theme-text-primary">
            Pending workload demand
          </h2>
          <p className="text-xs text-theme-text-tertiary">
            Server-grouped scheduling signatures, requests, and declared pool
            compatibility.
          </p>
        </div>
        <FreshnessControl
          mode="auto"
          dataUpdatedAt={generatedAtMillis(
            response.generatedAt,
            query.dataUpdatedAt,
          )}
          isFetching={query.isFetching}
          onRefresh={() => query.refetch()}
          connectionState={connectionState}
        />
      </div>
      {recoveredCursor && (
        <Notice>Capacity data changed; showing the latest results.</Notice>
      )}
      {query.error && !isCapacityCursorInvalidError(query.error) && (
        <RefreshError message={errorMessage(query.error)} />
      )}
      {coverageIsLowerBound(response.coverage.pods) && (
        <Notice>
          {coverageMessage(response.coverage.pods, "Pending pod demand")}.
          Counts and groups are a lower-bound view of{" "}
          {namespaceCoverageDescription(response.coverage.pods)}.
        </Notice>
      )}
      {poolFilter && (
        <Notice>
          Showing demand evaluated against NodePool{" "}
          <span className="font-medium text-theme-text-primary">
            {poolFilter}
          </span>
          .
          <button
            type="button"
            className="ml-1 font-medium text-accent-text hover:underline"
            onClick={clearPoolFilter}
          >
            Show all pools
          </button>
        </Notice>
      )}

      <div
        className="flex flex-wrap gap-1.5"
        aria-label="Filter demand by state"
      >
        {(
          [
            [undefined, "All"],
            ["waiting_for_scheduler", "Waiting for scheduler"],
            ["held", "Held by scheduling gate"],
            ["awaiting_capacity", "Awaiting capacity"],
            ["blocked", "Blocked"],
            ["unknown", "Unknown"],
          ] as [CapacityDemandState | undefined, string][]
        ).map(([state, label]) => (
          <button
            key={state ?? "all"}
            type="button"
            aria-pressed={stateFilter === state}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${stateFilter === state ? "selection border-theme-border text-theme-text-primary" : "border-theme-border text-theme-text-secondary hover:bg-theme-hover"}`}
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
          title="No matching demand"
          detail={
            stateFilter
              ? `No pending pod groups are currently in “${demandStateLabel(stateFilter)}”.`
              : "No pending pod demand is currently visible."
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
  return (
    <article className="rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DemandStateBadge state={group.state} />
            {group.owner ? (
              <button
                type="button"
                className="truncate font-medium text-accent-text hover:underline"
                onClick={() =>
                  onOpenResource(refToSelectedResource(group.owner!))
                }
              >
                {group.owner.kind}/{group.owner.name}
              </button>
            ) : (
              <span className="font-medium text-theme-text-primary">
                Unowned pods
              </span>
            )}
            <Badge tone="structural" size="sm">
              {group.podCount} {group.podCount === 1 ? "pod" : "pods"}
            </Badge>
            {group.poolEvaluationCounts.declaredCompatible > 0 && (
              <Badge severity="success" size="sm">
                {`${group.poolEvaluationCounts.declaredCompatible} declared compatible`}
              </Badge>
            )}
            {group.poolEvaluationCounts.incompatible > 0 && (
              <Badge severity="error" size="sm">
                {group.poolEvaluationCounts.incompatible} incompatible
              </Badge>
            )}
            {group.poolEvaluationCounts.unknown > 0 && (
              <Badge severity="neutral" size="sm">
                {group.poolEvaluationCounts.unknown} unknown
              </Badge>
            )}
          </div>
          <div className="mt-1 text-xs text-theme-text-tertiary">
            {group.namespace} · first seen {formatTimestamp(group.firstSeen)} ·
            last seen {formatTimestamp(group.lastSeen)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="min-w-[180px] text-right">
            <div className="text-[11px] font-medium uppercase tracking-wide text-theme-text-tertiary">
              Aggregate requests
            </div>
            <QuantityInline
              observation={group.aggregateRequests}
              empty="No requests reported"
            />
          </div>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} demand details`}
            className="rounded-lg p-1.5 text-theme-text-tertiary hover:bg-theme-hover hover:text-theme-text-primary"
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronRight
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <>
          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                  Per-pod requests
                </h3>
                <div className="mt-2">
                  <QuantityInline
                    observation={group.perPodRequests}
                    empty="No requests reported"
                  />
                </div>
              </div>
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                  Scheduler evidence
                </h3>
                {group.schedulerReasons.length > 0 ? (
                  <div className="mt-2 space-y-2">
                    {group.schedulerReasons.map((reason) => (
                      <div
                        key={`${reason.source}-${reason.code}`}
                        className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-theme-text-primary">
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
                          {reason.source} · {formatTimestamp(reason.lastSeen)}
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
                  <p className="mt-2 text-xs text-theme-text-tertiary">
                    Showing {group.schedulerReasonsMeta.returned} of{" "}
                    {group.schedulerReasonsMeta.total} scheduler reasons.
                  </p>
                )}
              </div>

              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                  Scheduling signature
                </h3>
                <div className="mt-2 flex flex-wrap gap-1">
                  {group.schedulingSignature.constraints.length > 0 ? (
                    group.schedulingSignature.constraints.map((constraint) => (
                      <Badge
                        key={`${constraint.predicate}-${constraint.sourcePath}`}
                        tone="structural"
                        size="sm"
                      >
                        {constraint.key || constraint.predicate}{" "}
                        {constraint.operator} {constraint.values.join(", ")}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-theme-text-secondary">
                      No explicit constraints reported.
                    </span>
                  )}
                </div>
                {group.schedulingSignature.constraintsMeta.truncated && (
                  <p className="mt-2 text-xs text-theme-text-tertiary">
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
                      No tolerations reported.
                    </span>
                  )}
                </div>
                {group.schedulingSignature.tolerationsMeta.truncated && (
                  <p className="mt-2 text-xs text-theme-text-tertiary">
                    Showing {group.schedulingSignature.tolerationsMeta.returned}{" "}
                    of {group.schedulingSignature.tolerationsMeta.total}{" "}
                    tolerations.
                  </p>
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                  Declared pool compatibility
                </h3>
                {group.poolEvaluationsMeta.truncated && (
                  <span className="text-xs text-theme-text-tertiary">
                    Showing {group.poolEvaluationsMeta.returned} of{" "}
                    {group.poolEvaluationsMeta.total}
                  </span>
                )}
              </div>
              {group.poolEvaluations.length > 0 ? (
                <div className="mt-2 divide-y divide-theme-border overflow-hidden rounded-lg border border-theme-border">
                  {group.poolEvaluations.map((evaluation) => (
                    <div
                      key={`${evaluation.pool.group ?? ""}/${evaluation.pool.name}`}
                      className="bg-theme-base/40 px-3 py-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          className="text-sm font-medium text-accent-text hover:underline"
                          onClick={() => onOpenPool(evaluation.pool.name)}
                        >
                          {evaluation.pool.name}
                        </button>
                        <PoolEvaluationBadge result={evaluation.result} />
                      </div>
                      {evaluation.evidence.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {evaluation.evidence.map((evidence, index) => (
                            <p
                              key={`${evidence.predicate}-${index}`}
                              className="text-xs text-theme-text-secondary"
                            >
                              <span className="font-medium text-theme-text-primary">
                                {evidence.predicate}:
                              </span>{" "}
                              {evidence.explanation}{" "}
                              <span className="text-theme-text-tertiary">
                                ({evidence.confidence} confidence)
                              </span>
                            </p>
                          ))}
                        </div>
                      )}
                      {evaluation.evidenceMeta.truncated && (
                        <p className="mt-1 text-xs text-theme-text-tertiary">
                          Showing {evaluation.evidenceMeta.returned} of{" "}
                          {evaluation.evidenceMeta.total} incompatibility
                          checks.
                        </p>
                      )}
                      {evaluation.unknownPredicates.length > 0 && (
                        <p className="mt-1 text-xs text-theme-text-tertiary">
                          Unknown: {evaluation.unknownPredicates.join(", ")}
                        </p>
                      )}
                      {evaluation.unknownPredicatesMeta.truncated && (
                        <p className="mt-1 text-xs text-theme-text-tertiary">
                          Showing {evaluation.unknownPredicatesMeta.returned} of{" "}
                          {evaluation.unknownPredicatesMeta.total} unknown
                          predicates.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-theme-text-secondary">
                  No NodePools were available for evaluation.
                </p>
              )}
            </div>
          </div>

          {(group.pods.length > 0 || group.podsMeta.truncated) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-theme-border px-4 py-3 text-xs text-theme-text-tertiary">
              {group.pods.length > 0 && (
                <>
                  <span>Pods:</span>
                  {group.pods.slice(0, 5).map((pod) => (
                    <Badge
                      key={identityKey(pod)}
                      tone="structural"
                      size="sm"
                      onClick={() =>
                        onOpenResource(identityToSelectedResource(pod))
                      }
                    >
                      {pod.ref.name}
                    </Badge>
                  ))}
                </>
              )}
              {group.podsMeta.truncated && (
                <span>
                  Pod identities bounded: showing {group.podsMeta.returned} of{" "}
                  {group.podsMeta.total}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function ActivityView({
  connectionState,
  onOpenPool,
  onOpenResource,
}: {
  connectionState: "connected" | "disconnected" | "connecting";
  onOpenPool: (name: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const search = new URLSearchParams(location.search);
  const poolFilter = search.get("pool") || undefined;
  const claimFilter = search.get("claim") || undefined;
  const nodeFilter = search.get("node") || undefined;
  const reasonFilter = search.get("reason") || undefined;
  const sinceFilter = search.get("since") || undefined;
  const invalidSinceFilter = Boolean(
    sinceFilter && !Number.isFinite(Date.parse(sinceFilter)),
  );
  const requestSinceFilter = invalidSinceFilter ? undefined : sinceFilter;
  const selectedWindow = activityWindowPreset(requestSinceFilter);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("workload")) return;
    params.delete("workload");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true },
    );
  }, [location.pathname, location.search, navigate]);
  const [activityDrafts, setActivityDrafts] = useState(() => ({
    key: location.search,
    pool: poolFilter ?? "",
    reason: reasonFilter ?? "",
  }));
  const drafts =
    activityDrafts.key === location.search
      ? activityDrafts
      : {
          key: location.search,
          pool: poolFilter ?? "",
          reason: reasonFilter ?? "",
        };
  const poolDraft = drafts.pool;
  const reasonDraft = drafts.reason;
  const pagination = useCapacityPagination<CapacityActivityResponse>(
    location.search,
  );
  const query = useCapacityActivity({
    limit: 50,
    cursor: pagination.cursor,
    pool: poolFilter,
    claim: claimFilter,
    node: nodeFilter,
    reason: reasonFilter,
    since: requestSinceFilter,
  });
  const recoveringCursor = useCapacityCursorRecovery(
    query.error,
    pagination.cursor,
    pagination.recover,
  );
  const recoveredCursor = pagination.recovered || recoveringCursor;
  const responseData =
    query.data ?? (recoveredCursor ? pagination.retainedPage : undefined);
  const blocked = integrationBlock(
    responseData,
    query.error,
    query.isLoading,
    "Loading capacity activity…",
  );
  if (blocked) return blocked;
  const response = responseData as CapacityActivityResponse;
  const updateFilters = (pool: string, reason: string, since?: string) => {
    const params = new URLSearchParams(location.search);
    params.delete("workload");
    if (pool.trim()) params.set("pool", pool.trim());
    else params.delete("pool");
    if (reason.trim()) params.set("reason", reason.trim());
    else params.delete("reason");
    if (since) params.set("since", since);
    else params.delete("since");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true },
    );
  };
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    updateFilters(poolDraft, reasonDraft, sinceFilter);
  };
  const clearFilters = () => {
    const params = new URLSearchParams(location.search);
    ["pool", "claim", "node", "workload", "reason", "since"].forEach((key) =>
      params.delete(key),
    );
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true },
    );
  };
  const removeFilter = (key: "claim" | "node" | "since") => {
    const params = new URLSearchParams(location.search);
    params.delete(key);
    params.delete("workload");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true },
    );
  };
  const setWindowHours = (hours: number | undefined, now: number) => {
    updateFilters(
      poolDraft,
      reasonDraft,
      hours ? new Date(now - hours * 60 * 60 * 1000).toISOString() : undefined,
    );
  };

  return (
    <ScrollableContent>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-theme-text-primary">
            Provisioning and disruption activity
          </h2>
          <p className="text-xs text-theme-text-tertiary">
            Correlated episodes backed by retained conditions, events, and
            resource changes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pagination.cursor && (
            <button
              type="button"
              className="rounded-lg border border-theme-border px-3 py-1.5 text-xs font-medium text-theme-text-secondary hover:bg-theme-hover"
              onClick={pagination.reset}
            >
              Jump to newest
            </button>
          )}
          <FreshnessControl
            mode="auto"
            dataUpdatedAt={generatedAtMillis(
              response.generatedAt,
              query.dataUpdatedAt,
            )}
            isFetching={query.isFetching}
            onRefresh={() => query.refetch()}
            connectionState={connectionState}
          />
        </div>
      </div>
      {recoveredCursor && (
        <Notice>Capacity data changed; showing the latest results.</Notice>
      )}
      {query.error && !isCapacityCursorInvalidError(query.error) && (
        <RefreshError message={errorMessage(query.error)} />
      )}
      {invalidSinceFilter && (
        <Notice>
          The activity window timestamp is invalid, so the retained window is
          shown instead.
          <button
            type="button"
            className="ml-1 font-medium text-accent-text hover:underline"
            onClick={() => removeFilter("since")}
          >
            Clear invalid filter
          </button>
        </Notice>
      )}
      {response.cursorStatus !== "valid" && (
        <Notice>
          The retained activity boundary changed (
          {response.cursorGap?.reason ?? response.cursorStatus}). The previous
          cursor can no longer produce a continuous history.
          <button
            type="button"
            className="ml-1 font-medium text-accent-text hover:underline"
            onClick={pagination.reset}
          >
            Return to newest activity
          </button>
        </Notice>
      )}
      {coverageIsLowerBound(response.coverage.karpenterObjectEvents) && (
        <Notice>
          {coverageMessage(
            response.coverage.karpenterObjectEvents,
            "Activity evidence",
          )}
          . Episodes may omit events outside this user’s authorized namespaces.
        </Notice>
      )}

      <form
        className="flex flex-wrap items-end gap-2 rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-theme-sm"
        onSubmit={applyFilters}
      >
        <label className="min-w-[180px] flex-1 text-xs font-medium text-theme-text-tertiary">
          NodePool
          <input
            value={poolDraft}
            onChange={(event) =>
              setActivityDrafts({ ...drafts, pool: event.target.value })
            }
            placeholder="Any pool"
            className="mt-1 w-full rounded-lg border border-theme-border bg-theme-base px-3 py-1.5 text-sm text-theme-text-primary outline-none focus:border-skyhook-500"
          />
        </label>
        <label className="min-w-[220px] flex-[1.4] text-xs font-medium text-theme-text-tertiary">
          Reason or message
          <input
            value={reasonDraft}
            onChange={(event) =>
              setActivityDrafts({ ...drafts, reason: event.target.value })
            }
            placeholder="LaunchFailed, interruption…"
            className="mt-1 w-full rounded-lg border border-theme-border bg-theme-base px-3 py-1.5 text-sm text-theme-text-primary outline-none focus:border-skyhook-500"
          />
        </label>
        <button type="submit" className="btn-brand px-3 py-1.5 text-sm">
          Apply
        </button>
        {(poolFilter ||
          claimFilter ||
          nodeFilter ||
          reasonFilter ||
          sinceFilter) && (
          <button
            type="button"
            className="rounded-lg border border-theme-border px-3 py-1.5 text-sm text-theme-text-secondary hover:bg-theme-hover"
            onClick={clearFilters}
          >
            Clear
          </button>
        )}
        {(claimFilter || nodeFilter) && (
          <div
            className="flex basis-full flex-wrap items-center gap-1.5 pt-1"
            aria-label="Active resource filters"
          >
            <span className="text-xs text-theme-text-tertiary">
              Resource filters
            </span>
            {claimFilter && (
              <ActivityFilterChip
                label={`NodeClaim: ${claimFilter}`}
                onRemove={() => removeFilter("claim")}
              />
            )}
            {nodeFilter && (
              <ActivityFilterChip
                label={`Node: ${nodeFilter}`}
                onRemove={() => removeFilter("node")}
              />
            )}
          </div>
        )}
        <div className="flex basis-full flex-wrap items-center gap-1.5 pt-1 text-xs text-theme-text-tertiary">
          <span>Window</span>
          {([undefined, 1, 6, 24] as (number | undefined)[]).map((hours) => (
            <button
              key={hours ?? "retained"}
              type="button"
              aria-pressed={selectedWindow === hours}
              className={`rounded-md border px-2 py-1 ${selectedWindow === hours ? "selection border-theme-border text-theme-text-primary" : "border-transparent hover:bg-theme-hover"}`}
              onClick={() => setWindowHours(hours, Date.now())}
            >
              {hours ? `${hours}h` : "Retained"}
            </button>
          ))}
          {sinceFilter && <span>Since {formatTimestamp(sinceFilter)}</span>}
        </div>
      </form>

      <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-theme-sm">
        {coverageHasObservations(response.coverage.timeline) ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
                Observation window
              </div>
              <div className="mt-1 text-sm text-theme-text-primary">
                {formatTimestamp(response.observation.startedAt)} →{" "}
                {formatTimestamp(response.observation.endedAt)}
              </div>
              <div className="mt-0.5 text-xs text-theme-text-tertiary">
                {retentionLabel(response)} ·{" "}
                {response.observation.sources.length > 0
                  ? response.observation.sources.join(", ")
                  : "No evidence sources observed"}
              </div>
            </div>
            <CoverageBadge coverage={response.coverage.timeline} />
          </div>
        ) : (
          <CoverageText
            coverage={response.coverage.timeline}
            subject="Retained activity"
          />
        )}
      </section>

      {response.items.length > 0 ? (
        <div className="space-y-3">
          {response.items.map((episode, index) => (
            <ActivityEpisodeCard
              key={episode.id}
              episode={episode}
              defaultExpanded={index === 0}
              onOpenPool={onOpenPool}
              onOpenResource={onOpenResource}
            />
          ))}
        </div>
      ) : coverageHasObservations(response.coverage.timeline) ? (
        <InlineEmpty
          title="No capacity activity"
          detail={
            pagination.cursor
              ? "No activity episodes were retained on this page."
              : "No provisioning or disruption episodes were observed in the retained window."
          }
        />
      ) : (
        <InlineEmpty
          title="Activity unavailable"
          detail={coverageMessage(
            response.coverage.timeline,
            "Retained activity",
          )}
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

function ActivityFilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="rounded-md border border-theme-border bg-theme-base px-2 py-1 text-xs text-theme-text-secondary hover:bg-theme-hover"
      onClick={onRemove}
      aria-label={`Remove ${label} filter`}
    >
      {label} <span aria-hidden="true">×</span>
    </button>
  );
}

function ActivityEpisodeCard({
  episode,
  defaultExpanded,
  onOpenPool,
  onOpenResource,
}: {
  episode: CapacityActivityEpisode;
  defaultExpanded: boolean;
  onOpenPool: (name: string) => void;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const subjects = [
    episode.pool,
    episode.claim,
    episode.node,
    episode.workload,
  ].filter((identity): identity is CapacityResourceIdentity =>
    Boolean(identity),
  );
  return (
    <article className="rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ActivityStateBadge state={episode.state} />
            <span className="font-medium text-theme-text-primary">
              {activityTypeLabel(episode.type)}
            </span>
            {subjects.map((subject) => (
              <Badge
                key={identityKey(subject)}
                tone="structural"
                size="sm"
                onClick={() =>
                  subject.ref.kind === "NodePool"
                    ? onOpenPool(subject.ref.name)
                    : onOpenResource(identityToSelectedResource(subject))
                }
              >
                {subject.ref.kind}/{subject.ref.name}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-xs text-theme-text-secondary">
            {episode.summary}
            {episode.primaryReasonCode ? ` · ${episode.primaryReasonCode}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs text-theme-text-tertiary">
            <div>{formatTimestamp(episode.startedAt)}</div>
            <div>
              {episode.durationSeconds !== undefined
                ? formatDuration(episode.durationSeconds * 1000, true)
                : episode.state === "open"
                  ? "In progress"
                  : episode.state === "observed"
                    ? "Point observation"
                    : "Duration not reported"}
            </div>
          </div>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} activity evidence`}
            className="rounded-lg p-1.5 text-theme-text-tertiary hover:bg-theme-hover hover:text-theme-text-primary"
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronRight
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="p-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary">
            Evidence
          </h3>
          {episode.evidence.length > 0 ? (
            <div className="mt-2 space-y-2">
              {episode.evidence.map((evidence, index) => (
                <div
                  key={`${evidence.at}-${evidence.reasonCode}-${index}`}
                  className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge severity="info" size="sm">
                      {evidence.source.replace("_", " ")}
                    </Badge>
                    <span className="text-sm font-medium text-theme-text-primary">
                      {evidence.reasonCode}
                    </span>
                    <span className="text-xs text-theme-text-tertiary">
                      {evidence.relationship} · {evidence.confidence} confidence
                      · {formatTimestamp(evidence.at)}
                    </span>
                  </div>
                  {(evidence.rawReason || evidence.rawMessage) && (
                    <p className="mt-1 text-xs text-theme-text-secondary">
                      {evidence.rawReason ? `${evidence.rawReason}: ` : ""}
                      {evidence.rawMessage}
                    </p>
                  )}
                  {evidence.refs.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {evidence.refs.map((ref) => (
                        <Badge
                          key={identityKey(ref)}
                          tone="structural"
                          size="sm"
                          onClick={() =>
                            ref.ref.kind === "NodePool"
                              ? onOpenPool(ref.ref.name)
                              : onOpenResource(identityToSelectedResource(ref))
                          }
                        >
                          {ref.ref.kind}/{ref.ref.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-theme-text-secondary">
              No evidence records were retained for this episode.
            </p>
          )}
          {episode.evidenceMeta.truncated && (
            <p className="mt-2 text-xs text-theme-text-tertiary">
              Showing {episode.evidenceMeta.returned} of{" "}
              {episode.evidenceMeta.total} evidence records.
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function ObservationCard({
  label,
  observation,
  empty,
}: {
  label: string;
  observation?: CapacityQuantityObservation;
  empty: string;
}) {
  return (
    <div className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-theme-text-tertiary">
        {label}
      </div>
      {observation ? (
        <>
          <div className="mt-1">
            <QuantityInline
              observation={observation}
              empty="No quantities reported"
            />
          </div>
          <div className="mt-1 text-[11px] text-theme-text-tertiary">
            {certaintyLabel(observation)} · {sourceLabel(observation.sources)} ·
            as of {formatTimestamp(observation.asOf)}
          </div>
        </>
      ) : (
        <div className="mt-1 text-xs text-theme-text-secondary">{empty}</div>
      )}
    </div>
  );
}

function PressureCell({
  pressure,
  hasConfiguredLimit,
}: {
  pressure?: CapacityPoolSummary["ledger"]["limitPressure"][number];
  hasConfiguredLimit: boolean;
}) {
  if (!pressure)
    return (
      <span className="text-xs text-theme-text-tertiary">
        {hasConfiguredLimit
          ? "No comparable status value"
          : "No configured limits"}
      </span>
    );
  if (pressure.percent === undefined) {
    return (
      <div>
        <div className="font-mono text-xs text-theme-text-primary">
          {formatQuantity(pressure.resource, pressure.provisioned)} /{" "}
          {formatQuantity(pressure.resource, pressure.limit)}
        </div>
        <div className="text-xs text-theme-text-tertiary">
          {resourceLabel(pressure.resource)} · ratio unavailable
        </div>
      </div>
    );
  }
  return (
    <ResourceBar
      used={formatQuantity(pressure.resource, pressure.provisioned)}
      total={formatQuantity(pressure.resource, pressure.limit)}
      percent={pressure.percent}
      colorScheme="quiet"
      layout="inline"
      label={shortResourceLabel(pressure.resource)}
      tooltip={`${resourceLabel(pressure.resource)} provisioned: ${formatQuantity(pressure.resource, pressure.provisioned)} of ${formatQuantity(pressure.resource, pressure.limit)} configured limit`}
    />
  );
}

function PressureDetail({
  pressure,
}: {
  pressure: CapacityPoolObservation["ledger"]["limitPressure"][number];
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-theme-text-secondary">
        <span>{resourceLabel(pressure.resource)}</span>
        {pressure.overLimit && (
          <Badge severity="warning" size="sm">
            Over limit
          </Badge>
        )}
      </div>
      {pressure.percent === undefined ? (
        <div className="font-mono text-xs text-theme-text-primary">
          {formatQuantity(pressure.resource, pressure.provisioned)} /{" "}
          {formatQuantity(pressure.resource, pressure.limit)} · ratio
          unavailable
        </div>
      ) : (
        <ResourceBar
          used={formatQuantity(pressure.resource, pressure.provisioned)}
          total={formatQuantity(pressure.resource, pressure.limit)}
          percent={pressure.percent}
          colorScheme="quiet"
        />
      )}
    </div>
  );
}

function ActualUsageInline({
  usage,
  coverage,
}: {
  usage?: CapacityUsageObservation;
  coverage?: CapacitySourceCoverage;
}) {
  if (!usage)
    return (
      <span className="text-xs text-theme-text-tertiary">
        {missingUsageMessage(coverage)}
      </span>
    );
  if (usage.utilization.length === 0)
    return (
      <div className="space-y-1">
        {nodeMetricsAreStale(coverage) && (
          <Badge severity="warning" size="sm">
            Stale sample
          </Badge>
        )}
        <div className="text-xs text-theme-text-tertiary">
          No utilization values reported
        </div>
      </div>
    );
  const primary = usage.utilization.filter(
    (entry) => entry.resource === "cpu" || entry.resource === "memory",
  );
  const visible = primary.length > 0 ? primary : usage.utilization.slice(0, 2);
  return (
    <div className="space-y-1">
      {nodeMetricsAreStale(coverage) && (
        <div className="flex items-center gap-1.5">
          <Badge severity="warning" size="sm">
            Stale sample
          </Badge>
          <span className="text-xs text-theme-text-tertiary">
            {formatTimestamp(usage.quantity.asOf)}
          </span>
        </div>
      )}
      {visible.map((entry) => (
        <ResourceBar
          key={entry.resource}
          used={formatQuantity(entry.resource, entry.usage)}
          total={formatQuantity(entry.resource, entry.allocatable)}
          percent={entry.percent}
          colorScheme="quiet"
          layout="inline"
          label={shortResourceLabel(entry.resource)}
          tooltip={`Actual ${resourceLabel(entry.resource).toLowerCase()} usage across ${usage.coveredNodes} of ${usage.totalNodes} nodes with samples`}
        />
      ))}
    </div>
  );
}

function ActualUsageDetail({
  usage,
  coverage,
}: {
  usage?: CapacityUsageObservation;
  coverage?: CapacitySourceCoverage;
}) {
  if (!usage)
    return (
      <div className="flex items-start gap-2">
        <UsageCoverageBadge coverage={coverage} />
        <p className="text-sm text-theme-text-secondary">
          {missingUsageMessage(coverage)}
        </p>
      </div>
    );
  return (
    <div>
      {nodeMetricsAreStale(coverage) && (
        <div className="mb-3">
          <Notice>
            The latest retained node metrics are stale. Values below were last
            sampled {formatTimestamp(usage.quantity.asOf)}.
          </Notice>
        </div>
      )}
      {usage.utilization.length > 0 ? (
        <div className="space-y-3">
          {usage.utilization.map((entry) => (
            <div key={entry.resource}>
              <div className="mb-1 text-xs font-medium text-theme-text-secondary">
                {resourceLabel(entry.resource)}
              </div>
              <ResourceBar
                used={formatQuantity(entry.resource, entry.usage)}
                total={formatQuantity(entry.resource, entry.allocatable)}
                percent={entry.percent}
                colorScheme="quiet"
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-theme-text-secondary">
          The usage source returned no comparable utilization values.
        </p>
      )}
      <p className="mt-3 text-xs text-theme-text-tertiary">
        Coverage: {usage.coveredNodes} of {usage.totalNodes} nodes · sampled{" "}
        {formatTimestamp(usage.quantity.asOf)}. Percentages include only nodes
        with samples.
      </p>
    </div>
  );
}

function LifecycleSummary({ pool }: { pool: CapacityPoolObservation }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs font-medium text-theme-text-tertiary">
          Nodes
        </div>
        {pool.nodes ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <MiniCount label="Total" value={pool.nodes.total} />
            <MiniCount label="Ready" value={pool.nodes.ready} />
            <MiniCount label="Not ready" value={pool.nodes.notReady} />
            <MiniCount label="Cordoned" value={pool.nodes.cordoned} />
            <MiniCount label="Terminating" value={pool.nodes.terminating} />
          </div>
        ) : (
          <CoverageText
            coverage={pool.coverage.nodes}
            subject="Node lifecycle"
          />
        )}
      </div>
      <div>
        <div className="mb-2 text-xs font-medium text-theme-text-tertiary">
          NodeClaims
        </div>
        {pool.claims ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniCount label="Total" value={pool.claims.total} />
            <MiniCount label="Pending" value={pool.claims.pending} />
            <MiniCount label="Ready" value={pool.claims.ready} />
            <MiniCount label="Failed" value={pool.claims.failed} />
            <MiniCount label="Launched" value={pool.claims.launched} />
            <MiniCount label="Registered" value={pool.claims.registered} />
            <MiniCount label="Initialized" value={pool.claims.initialized} />
            <MiniCount label="Terminating" value={pool.claims.terminating} />
          </div>
        ) : (
          <CoverageText
            coverage={pool.coverage.nodeClaims}
            subject="Claim lifecycle"
          />
        )}
      </div>
    </div>
  );
}

function WorkloadSummaryView({
  pool,
  onOpenResource,
}: {
  pool: CapacityPoolObservation;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const workloadCoverage = pool.coverage.workloads;
  if (!coverageHasObservations(workloadCoverage) || !pool.workloads)
    return (
      <CoverageText
        coverage={workloadCoverage}
        subject="Workload attribution"
      />
    );
  const workloads = pool.workloads;
  const openEligibleDemand = () => {
    const params = new URLSearchParams();
    params.set("pool", pool.resource.ref.name);
    const namespaces = new URLSearchParams(location.search).get("namespaces");
    if (namespaces) params.set("namespaces", namespaces);
    navigate({ pathname: "/capacity/demand", search: `?${params.toString()}` });
  };
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <MiniCount label="Workloads" value={workloads.workloadCount} />
        <MiniCount label="Scheduled pods" value={workloads.scheduledPodCount} />
      </div>
      {coverageIsLowerBound(workloadCoverage) && (
        <p className="mt-2 text-xs text-theme-text-tertiary">
          Counts are a lower-bound view of{" "}
          {namespaceCoverageDescription(workloadCoverage)}.
        </p>
      )}
      {workloads.pendingEligibleGroupsMeta.total > 0 && (
        <button
          type="button"
          className="mt-3 w-full rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2 text-left text-sm font-medium text-accent-text hover:bg-theme-hover"
          onClick={openEligibleDemand}
        >
          Evaluate pending demand against this pool
          <span className="ml-2 text-xs font-normal text-theme-text-tertiary">
            {workloads.pendingEligibleGroupsMeta.total}{" "}
            {workloads.pendingEligibleGroupsMeta.total === 1
              ? "group"
              : "groups"}{" "}
            currently declared compatible
          </span>
        </button>
      )}
      {workloads.topScheduled.length > 0 && (
        <div className="mt-3 space-y-2">
          {workloads.topScheduled.map((workload) => (
            <button
              key={`${workload.owner.kind}/${workload.owner.namespace ?? ""}/${workload.owner.name}`}
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2 text-left hover:bg-theme-hover"
              onClick={() =>
                onOpenResource(refToSelectedResource(workload.owner))
              }
            >
              <span>
                <span className="text-sm font-medium text-theme-text-primary">
                  {workload.owner.kind}/{workload.owner.name}
                </span>
                <span className="ml-2 text-xs text-theme-text-tertiary">
                  {workload.owner.namespace}
                </span>
              </span>
              <Badge tone="structural" size="sm">
                {workload.podCount} pods
              </Badge>
            </button>
          ))}
        </div>
      )}
      {workloads.topScheduledMeta.truncated && (
        <p className="mt-2 text-xs text-theme-text-tertiary">
          Showing {workloads.topScheduledMeta.returned} of{" "}
          {workloads.topScheduledMeta.total} attributed workloads.
        </p>
      )}
    </div>
  );
}

function SignalsView({ pool }: { pool: CapacityPoolObservation }) {
  if (pool.issues.length === 0 && pool.facts.length === 0)
    return (
      <p className="text-sm text-theme-text-secondary">
        No capacity-specific issues or posture facts were reported.
      </p>
    );
  return (
    <div className="space-y-2">
      {pool.issues.map((issue) => (
        <div
          key={issue.id}
          className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Badge
              severity={issue.severity === "critical" ? "error" : "warning"}
              size="sm"
            >
              {issue.severity}
            </Badge>
            <span className="text-sm font-medium text-theme-text-primary">
              {issue.reason}
            </span>
          </div>
          {issue.message && (
            <p className="mt-1 text-xs text-theme-text-secondary">
              {issue.message}
            </p>
          )}
        </div>
      ))}
      {pool.facts.map((fact) => (
        <div
          key={`${fact.code}-${fact.summary}`}
          className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Badge severity="info" size="sm">
              Fact
            </Badge>
            <span className="text-sm font-medium text-theme-text-primary">
              {fact.summary}
            </span>
          </div>
          {fact.detail && (
            <p className="mt-1 text-xs text-theme-text-secondary">
              {fact.detail}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ConditionsView({ conditions }: { conditions: CapacityCondition[] }) {
  if (conditions.length === 0)
    return (
      <p className="text-sm text-theme-text-secondary">
        No conditions were reported by the controller.
      </p>
    );
  return (
    <div className="space-y-2">
      {conditions.map((condition) => (
        <div
          key={condition.type}
          className="rounded-lg border border-theme-border bg-theme-base/50 px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <ConditionBadge status={condition.status} />
            <span className="text-sm font-medium text-theme-text-primary">
              {condition.type}
            </span>
            {condition.reason && (
              <span className="text-xs text-theme-text-tertiary">
                {condition.reason}
              </span>
            )}
          </div>
          {condition.message && (
            <p className="mt-1 text-xs text-theme-text-secondary">
              {condition.message}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  detail,
  attention = false,
}: {
  label: string;
  value: string | number;
  detail: string;
  attention?: boolean;
}) {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-theme-sm">
      <div className="text-xs font-medium text-theme-text-tertiary">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-theme-text-primary">
          {value}
        </span>
        {attention && (
          <Badge severity="warning" size="sm">
            Attention
          </Badge>
        )}
      </div>
      <div className="mt-1 text-xs text-theme-text-secondary">{detail}</div>
    </div>
  );
}

function LifecycleCell({
  nodes,
  claims,
  coverage,
}: {
  nodes?: CapacityPoolSummary["nodes"];
  claims?: CapacityPoolSummary["claims"];
  coverage: CapacityCoverageBySource;
}) {
  if (!nodes && !claims)
    return (
      <span className="text-xs text-theme-text-tertiary">
        {coverageMessage(coverage.nodes, "Node inventory")} ·{" "}
        {coverageMessage(coverage.nodeClaims, "Claim inventory")}
      </span>
    );
  const nodeDetail = nodes
    ? `${nodes.ready} nodes ready${nodes.cordoned > 0 ? ` · ${nodes.cordoned} cordoned` : ""}`
    : coverageMessage(coverage.nodes, "Nodes");
  const claimDetail = claims
    ? `${claims.ready} claims ready${claims.pending > 0 ? ` · ${claims.pending} pending` : ""}${claims.failed > 0 ? ` · ${claims.failed} failed` : ""}`
    : coverageMessage(coverage.nodeClaims, "Claims");
  return (
    <div>
      <div className="font-mono text-sm tabular-nums text-theme-text-primary">
        {nodes ? `${nodes.total} nodes` : "— nodes"} ·{" "}
        {claims ? `${claims.total} claims` : "— claims"}
      </div>
      <div className="text-xs text-theme-text-tertiary">
        {nodeDetail} · {claimDetail}
      </div>
    </div>
  );
}

function QuantityInline({
  observation,
  empty,
}: {
  observation?: CapacityQuantityObservation;
  empty: string;
}) {
  if (!observation)
    return <span className="text-xs text-theme-text-tertiary">{empty}</span>;
  const entries = Object.entries(observation.resources).sort(
    ([left], [right]) =>
      quantityResourceRank(left) - quantityResourceRank(right) ||
      left.localeCompare(right),
  );
  if (entries.length === 0)
    return (
      <span className="text-xs text-theme-text-tertiary">{empty}</span>
    );
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-xs text-theme-text-secondary">
      {entries.slice(0, 4).map(([resource, value]) => (
        <span key={resource}>
          <span className="text-theme-text-tertiary">
            {shortResourceLabel(resource)}
          </span>{" "}
          {formatQuantity(resource, value)}
        </span>
      ))}
      {entries.length > 4 && (
        <span className="text-theme-text-tertiary">+{entries.length - 4}</span>
      )}
    </div>
  );
}

function InspectorCard({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: typeof Cpu;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <section className="card-inner-lg">
      <div className="mb-3 flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" />
        <div>
          <h3 className="text-sm font-medium text-theme-text-primary">
            {title}
          </h3>
          <p className="text-xs text-theme-text-tertiary">{detail}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Breakdown({
  title,
  values,
  meta,
}: {
  title: string;
  values: NonNullable<CapacityPoolObservation["composition"]>["capacityTypes"];
  meta: { total: number; returned: number; truncated: boolean };
}) {
  const visible = values.slice(0, 6);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-theme-text-tertiary">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {visible.length > 0 ? (
          visible.map((item) => (
            <Badge key={item.value} tone="structural" size="sm">
              {item.value} · {item.count}
            </Badge>
          ))
        ) : (
          <span className="text-xs text-theme-text-tertiary">
            No nodes in this bucket
          </span>
        )}
        {meta.total > visible.length && (
          <span className="self-center text-[11px] text-theme-text-tertiary">
            Top {visible.length} of {meta.total}
          </span>
        )}
      </div>
    </div>
  );
}

function MiniCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-theme-border bg-theme-base/50 px-2.5 py-2">
      <div className="font-mono text-base font-semibold tabular-nums text-theme-text-primary">
        {value}
      </div>
      <div className="text-[11px] text-theme-text-tertiary">{label}</div>
    </div>
  );
}

function KeyValueRows({ rows }: { rows: [string, string][] }) {
  return (
    <div className="divide-y divide-theme-border">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0"
        >
          <span className="text-sm text-theme-text-secondary">{label}</span>
          <span className="text-right font-mono text-sm text-theme-text-primary">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function TokenGroup({
  title,
  values,
  empty,
}: {
  title: string;
  values: string[];
  empty: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-theme-text-tertiary">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {values.length > 0 ? (
          values.map((value) => (
            <Badge key={value} tone="structural" size="sm">
              {value}
            </Badge>
          ))
        ) : (
          <span className="text-sm text-theme-text-secondary">{empty}</span>
        )}
      </div>
    </div>
  );
}

function PoolReadyBadge({ ready }: { ready?: boolean }) {
  return ready === true ? (
    <Badge severity="success" size="sm">
      Ready
    </Badge>
  ) : ready === false ? (
    <Badge severity="error" size="sm">
      Not Ready
    </Badge>
  ) : (
    <Badge severity="neutral" size="sm">
      Status unknown
    </Badge>
  );
}

function NodeReadyBadge({
  ready,
  cordoned,
}: {
  ready?: boolean;
  cordoned: boolean;
}) {
  if (ready === false)
    return (
      <Badge severity="error" size="sm">
        Not Ready
      </Badge>
    );
  if (ready === undefined)
    return (
      <Badge severity="neutral" size="sm">
        Unknown
      </Badge>
    );
  if (cordoned)
    return (
      <Badge severity="warning" size="sm">
        Cordoned
      </Badge>
    );
  return (
    <Badge severity="success" size="sm">
      Ready
    </Badge>
  );
}

function ClaimStageBadge({ stage }: { stage?: CapacityClaimStage }) {
  if (!stage || stage === "unknown")
    return (
      <Badge severity="neutral" size="sm">
        Unknown
      </Badge>
    );
  const severity =
    stage === "failed"
      ? "error"
      : stage === "terminating" || stage === "pending"
        ? "warning"
        : stage === "ready"
          ? "success"
          : "info";
  return (
    <Badge severity={severity} size="sm">
      {stage}
    </Badge>
  );
}

function DemandStateBadge({ state }: { state: CapacityDemandState }) {
  const severity =
    state === "blocked"
      ? "error"
      : state === "held"
        ? "info"
        : state === "awaiting_capacity"
          ? "warning"
          : "neutral";
  return (
    <Badge severity={severity} size="sm">
      {demandStateLabel(state)}
    </Badge>
  );
}

function PoolEvaluationBadge({
  result,
}: {
  result: CapacityDemandGroup["poolEvaluations"][number]["result"];
}) {
  const severity =
    result === "declared_compatible"
      ? "success"
      : result === "incompatible"
        ? "warning"
        : "neutral";
  return (
    <Badge severity={severity} size="sm">
      {result === "declared_compatible"
        ? "Declared compatible"
        : result === "incompatible"
          ? "Incompatible"
          : "Unknown"}
    </Badge>
  );
}

function ActivityStateBadge({
  state,
}: {
  state: CapacityActivityEpisode["state"];
}) {
  const severity =
    state === "failed"
      ? "error"
      : state === "open"
        ? "info"
        : state === "observed"
          ? "neutral"
          : state === "completed"
            ? "success"
            : "neutral";
  return (
    <Badge severity={severity} size="sm">
      {state}
    </Badge>
  );
}

function ConditionBadge({ status }: { status: CapacityCondition["status"] }) {
  const severity =
    status === "True" ? "success" : status === "False" ? "warning" : "neutral";
  return (
    <Badge severity={severity} size="sm">
      {status}
    </Badge>
  );
}

function CoverageBadge({ coverage }: { coverage?: CapacitySourceCoverage }) {
  if (!coverage)
    return (
      <Badge severity="neutral" size="sm">
        Not reported
      </Badge>
    );
  const lowerBound = coverageIsLowerBound(coverage);
  const severity = lowerBound
    ? "warning"
    : coverage.status === "available"
      ? "success"
      : coverage.status === "partial"
        ? "warning"
        : coverage.status === "error" || coverage.status === "denied"
          ? "error"
          : coverage.status === "syncing"
            ? "info"
            : "neutral";
  return (
    <Badge severity={severity} size="sm">
      {lowerBound ? "lower bound" : coverage.status.replace("_", " ")}
    </Badge>
  );
}

function UsageCoverageBadge({
  coverage,
}: {
  coverage?: CapacitySourceCoverage;
}) {
  if (nodeMetricsAreStale(coverage))
    return (
      <Badge severity="warning" size="sm">
        Stale metrics
      </Badge>
    );
  if (coverage?.status === "available")
    return (
      <Badge severity="neutral" size="sm">
        No sample
      </Badge>
    );
  return <CoverageBadge coverage={coverage} />;
}

function CoverageText({
  coverage,
  subject,
}: {
  coverage?: CapacitySourceCoverage;
  subject: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <CoverageBadge coverage={coverage} />
      <p className="text-sm text-theme-text-secondary">
        {coverageMessage(coverage, subject)}
      </p>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text-secondary">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-theme-text-tertiary" />
      {children}
    </div>
  );
}

interface CapacityPaginationState<T> {
  key: string;
  cursor?: string;
  history: (string | undefined)[];
  retainedPage?: T;
  recovered: boolean;
}

function useCapacityPagination<T>(key: string) {
  const [state, setState] = useState<CapacityPaginationState<T>>(() => ({
    key,
    history: [],
    recovered: false,
  }));
  const emptyPage = (): CapacityPaginationState<T> => ({
    key,
    history: [],
    recovered: false,
  });
  const active = state.key === key ? state : emptyPage();
  const reset = useCallback(
    () => setState({ key, history: [], recovered: false }),
    [key],
  );
  const recover = useCallback(
    () =>
      setState((current) => ({
        key,
        history: [],
        retainedPage: current.key === key ? current.retainedPage : undefined,
        recovered: true,
      })),
    [key],
  );
  const goNext = useCallback(
    (nextCursor: string, retainedPage?: T) => {
      setState((current) => {
        const page =
          current.key === key
            ? current
            : {
                key,
                history: [] as (string | undefined)[],
                recovered: false,
              };
        return {
          key,
          cursor: nextCursor,
          history: [...page.history, page.cursor],
          retainedPage,
          recovered: false,
        };
      });
    },
    [key],
  );
  const goBack = useCallback(
    (retainedPage?: T) => {
      setState((current) => {
        const page =
          current.key === key
            ? current
            : {
                key,
                history: [] as (string | undefined)[],
                recovered: false,
              };
        if (page.history.length === 0) return page;
        return {
          key,
          cursor: page.history[page.history.length - 1],
          history: page.history.slice(0, -1),
          retainedPage,
          recovered: false,
        };
      });
    },
    [key],
  );

  return {
    cursor: active.cursor,
    history: active.history,
    retainedPage: active.retainedPage,
    recovered: active.recovered,
    reset,
    recover,
    goNext,
    goBack,
  };
}

function useCapacityCursorRecovery(
  error: unknown,
  cursor: string | undefined,
  recover: () => void,
): boolean {
  const invalid = Boolean(cursor && isCapacityCursorInvalidError(error));

  useEffect(() => {
    if (!invalid) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) recover();
    });
    return () => {
      cancelled = true;
    };
  }, [invalid, recover]);

  return invalid;
}

function PageControls({
  page,
  hasPrevious,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="mr-1 text-xs text-theme-text-tertiary">Page {page}</span>
      <button
        type="button"
        className="rounded-lg border border-theme-border px-3 py-1.5 text-xs font-medium text-theme-text-secondary hover:bg-theme-hover disabled:opacity-50"
        disabled={!hasPrevious || busy}
        onClick={onPrevious}
      >
        <ChevronLeft className="mr-1 inline h-3.5 w-3.5" />
        Previous
      </button>
      <button
        type="button"
        className="rounded-lg border border-theme-border px-3 py-1.5 text-xs font-medium text-theme-text-secondary hover:bg-theme-hover disabled:opacity-50"
        disabled={!hasNext || busy}
        onClick={onNext}
      >
        Next
        <ChevronRight className="ml-1 inline h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function RefreshError({ message }: { message: string }) {
  return (
    <Notice>
      Refresh failed; showing the last successful capacity snapshot. {message}
    </Notice>
  );
}

function ResourceLink({
  identity,
  onOpenResource,
}: {
  identity: CapacityResourceIdentity;
  onOpenResource: (resource: SelectedResource) => void;
}) {
  return (
    <button
      type="button"
      className="font-medium text-accent-text hover:underline"
      onClick={() => onOpenResource(identityToSelectedResource(identity))}
    >
      {identity.ref.name}
    </button>
  );
}

function UnknownValue({ label = "—" }: { label?: string }) {
  return <span className="text-xs text-theme-text-tertiary">{label}</span>;
}

function InlineEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="text-sm font-medium text-theme-text-primary">{title}</div>
      <p className="mt-1 text-sm text-theme-text-secondary">{detail}</p>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: typeof Gauge;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-theme-base p-6">
      <div className="max-w-md text-center">
        <Icon className="mx-auto h-9 w-9 text-theme-text-tertiary/50" />
        <h2 className="mt-3 text-lg font-medium text-theme-text-primary">
          {title}
        </h2>
        <p className="mt-1 text-sm text-theme-text-secondary">{detail}</p>
        {action}
      </div>
    </div>
  );
}

function ScrollableContent({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1600px] space-y-5 px-5 py-5 xl:px-7">
        {children}
      </div>
    </div>
  );
}

function integrationBlock(
  response: { state: CapacityIntegrationState } | undefined,
  error: Error | null,
  isLoading: boolean,
  loadingLabel: string,
): ReactNode | null {
  if (!response && isLoading)
    return <PaneLoader label={loadingLabel} className="min-h-0 flex-1" />;
  if (!response && error) {
    return isForbiddenError(error) ? (
      <EmptyState
        icon={Shield}
        title="Capacity access denied"
        detail={errorMessage(error)}
      />
    ) : (
      <EmptyState
        icon={AlertTriangle}
        title="Capacity unavailable"
        detail={errorMessage(error)}
      />
    );
  }
  if (!response)
    return <PaneLoader label={loadingLabel} className="min-h-0 flex-1" />;
  if (response.state === "syncing")
    return (
      <PaneLoader
        label="Capacity data is syncing…"
        className="min-h-0 flex-1"
      />
    );
  if (response.state === "not_detected")
    return (
      <EmptyState
        icon={Gauge}
        title="Karpenter not detected"
        detail="Capacity appears automatically when this cluster exposes Karpenter NodePools."
      />
    );
  if (response.state === "denied")
    return (
      <EmptyState
        icon={Shield}
        title="Capacity access denied"
        detail="This user cannot read the Karpenter resources required for capacity planning."
      />
    );
  return null;
}

function parseCapacityRoute(pathname: string): CapacityRoute {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments[0] !== "capacity")
    return { topTab: "overview", poolSection: "summary" };
  if (segments[1] === "pools" && segments[2]) {
    const section = segments[3];
    return {
      topTab: "overview",
      poolName: decodePathSegment(segments[2]),
      poolSection:
        section === "workloads" ||
        section === "members" ||
        section === "configuration"
          ? section
          : "summary",
    };
  }
  if (segments[1] === "demand" || segments[1] === "activity")
    return { topTab: segments[1], poolSection: "summary" };
  return { topTab: "overview", poolSection: "summary" };
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identityToSelectedResource(
  identity: CapacityResourceIdentity,
): SelectedResource {
  return refToSelectedResource(identity.ref);
}

function capacityPoolPath(name: string): string {
  return `/capacity/pools/${encodeURIComponent(name)}`;
}

function identityKey(identity: CapacityResourceIdentity): string {
  return `${identity.ref.group ?? ""}/${identity.ref.kind}/${identity.ref.namespace ?? ""}/${identity.ref.name}`;
}

function optionalCount(value: number | undefined): number | string {
  return value === undefined ? "—" : value;
}

function optionalCountDetail(
  value: number | undefined,
  coverage: CapacitySourceCoverage | undefined,
  subject: string,
): string {
  if (value === undefined) return coverageMessage(coverage, subject);
  if (coverageIsLowerBound(coverage))
    return (
      coverage?.reason ||
      `Lower bound across ${namespaceCoverageDescription(coverage)}`
    );
  return coverage?.observedAt
    ? `Observed ${new Date(coverage.observedAt).toLocaleTimeString()}`
    : "Observed by the Capacity API";
}

function poolReadinessDetail(
  pools: CapacityPoolSummary[],
  truncated: boolean,
): string {
  const notReady = pools.filter((pool) => pool.ready === false).length;
  const unknown = pools.filter((pool) => pool.ready === undefined).length;
  if (notReady > 0) return `${notReady} not ready`;
  if (unknown > 0) return `${unknown} status unknown`;
  if (pools.length === 0) return "No pools visible";
  return truncated
    ? `First ${pools.length} reported ready`
    : "All reported ready";
}

function providerLabel(
  response: Pick<CapacityResponseMeta, "provider">,
): string {
  const mode =
    response.provider.controllerMode === "self_managed"
      ? "self-managed"
      : response.provider.controllerMode === "eks_auto"
        ? "EKS Auto Mode"
        : "controller mode unknown";
  return mode;
}

function demandStateLabel(state: CapacityDemandState): string {
  if (state === "waiting_for_scheduler") return "Waiting for scheduler";
  if (state === "held") return "Held by scheduling gate";
  if (state === "awaiting_capacity") return "Awaiting capacity";
  if (state === "blocked") return "Blocked";
  return "Unknown";
}

function activityTypeLabel(type: CapacityActivityEpisode["type"]): string {
  if (type === "launch_failure") return "Launch failure";
  if (type === "registration_failure") return "Registration failure";
  if (type === "initialization_failure") return "Initialization failure";
  if (type === "config_change") return "Configuration change";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function actionSeverity(
  severity?: string,
): "error" | "warning" | "info" | "neutral" {
  if (severity === "critical" || severity === "error") return "error";
  if (severity === "warning" || severity === "alert") return "warning";
  if (severity === "info") return "info";
  return "neutral";
}

function humanizeCode(code: string): string {
  const words = code.replaceAll("_", " ");
  if (!words) return "Capacity signal";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`.replaceAll(
    "Nodeclass",
    "NodeClass",
  );
}

function retentionLabel(response: CapacityActivityResponse): string {
  const retention = response.observation.retention;
  const details: string[] = [retention.mode.replaceAll("_", " ")];
  if (retention.maxAgeSeconds !== undefined)
    details.push(`up to ${formatDuration(retention.maxAgeSeconds * 1000)}`);
  if (retention.maxEvents !== undefined)
    details.push(`${retention.maxEvents} events max`);
  return details.join(" · ");
}

function activityWindowPreset(
  since: string | undefined,
  now = Date.now(),
): number | "custom" | undefined {
  if (!since) return undefined;
  const timestamp = Date.parse(since);
  if (!Number.isFinite(timestamp)) return "custom";
  const age = now - timestamp;
  const tolerance = 10 * 60 * 1000;
  const preset = [1, 6, 24].find(
    (hours) => Math.abs(age - hours * 60 * 60 * 1000) <= tolerance,
  );
  return preset ?? "custom";
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : value;
}

function coverageHasObservations(coverage?: CapacitySourceCoverage): boolean {
  return coverage?.status === "available" || coverage?.status === "partial";
}

function coverageIsLowerBound(coverage?: CapacitySourceCoverage): boolean {
  return Boolean(
    coverageHasObservations(coverage) &&
    ((coverage?.status === "partial" && !nodeMetricsAreStale(coverage)) ||
      coverage?.scope !== "cluster"),
  );
}

function nodeMetricsAreStale(coverage?: CapacitySourceCoverage): boolean {
  return coverage?.reasonCode === "node_metrics_stale";
}

function namespaceCoverageDescription(
  coverage: CapacitySourceCoverage | undefined,
): string {
  if (coverage?.scope === "explicit_namespaces") {
    const count = coverage.namespaces?.length ?? 0;
    return count > 0
      ? `${count} selected ${count === 1 ? "namespace" : "namespaces"}`
      : "the selected namespaces";
  }
  if (coverage?.scope === "all_authorized_namespaces")
    return "all namespaces authorized for this user";
  return "the observed inventory";
}

function memberCoverageSource(
  type: CapacityMemberType,
): CapacityCoverageSource {
  if (type === "node") return "nodes";
  if (type === "claim") return "nodeClaims";
  return "workloads";
}

function coverageMessage(
  coverage: CapacitySourceCoverage | undefined,
  subject: string,
): string {
  if (!coverage) return `${subject} coverage was not reported`;
  if (coverage.reason) return coverage.reason;
  if (coverageIsLowerBound(coverage))
    return `${subject} is a lower-bound view of ${namespaceCoverageDescription(coverage)}`;
  if (coverage.status === "available") return `${subject} observed`;
  if (coverage.status === "partial") return `${subject} has partial coverage`;
  if (coverage.status === "denied")
    return `${subject} is hidden by permissions`;
  if (coverage.status === "syncing") return `${subject} is still syncing`;
  if (coverage.status === "error") return `${subject} could not be observed`;
  return `${subject} is unavailable`;
}

function missingUsageMessage(coverage?: CapacitySourceCoverage): string {
  if (nodeMetricsAreStale(coverage))
    return "The retained node metrics are stale and this pool has no sample";
  if (coverage?.status === "available")
    return "No live node samples were reported for this pool";
  if (coverage?.status === "partial" && !coverage.reason)
    return "No live sample was present in the partially observed nodes";
  return coverageMessage(coverage, "Live usage");
}

function certaintyValueLabel(
  certainty: CapacityQuantityObservation["certainty"],
): string {
  if (certainty === "exact") return "Exact";
  if (certainty === "lower_bound") return "Lower bound";
  if (certainty === "upper_bound") return "Upper bound";
  return "Unknown certainty";
}

function certaintyLabel(observation: CapacityQuantityObservation): string {
  return certaintyValueLabel(observation.certainty);
}

function sourceLabel(sources: string[]): string {
  return sources.length > 0 ? sources.join(" + ") : "source not reported";
}

function conditionSummary(
  conditions: { type: string; status: string; reason?: string }[] | undefined,
): string {
  if (!conditions || conditions.length === 0) return "No conditions reported";
  const failing = conditions.find((condition) => condition.status === "False");
  const unknown = conditions.find(
    (condition) => condition.status === "Unknown",
  );
  const selected =
    failing ??
    unknown ??
    conditions.find((condition) => condition.status === "True") ??
    conditions[0];
  return `${selected.type}: ${selected.reason || selected.status}`;
}

function resourceLabel(resource: string): string {
  if (resource === "cpu") return "CPU";
  if (resource === "memory") return "Memory";
  if (resource === "ephemeral-storage") return "Ephemeral storage";
  if (resource === "nvidia.com/gpu") return "GPU";
  return resource;
}

function quantityResourceRank(resource: string): number {
  if (resource === "cpu") return 0;
  if (resource === "memory") return 1;
  if (resource.includes("gpu") || resource.includes("accelerator")) return 2;
  if (resource.includes("/")) return 3;
  if (resource === "pods" || resource === "nodes") return 4;
  if (resource === "ephemeral-storage") return 5;
  if (resource.startsWith("hugepages-")) return 7;
  return 6;
}

function shortResourceLabel(resource: string): string {
  if (resource === "memory") return "MEM";
  if (resource === "ephemeral-storage") return "DISK";
  if (resource === "nvidia.com/gpu") return "GPU";
  if (resource.includes("/")) {
    const suffix = resource.split("/").at(-1);
    if (!suffix) return "EXT";
    return (suffix.startsWith("pod-") ? suffix.slice(4) : suffix)
      .slice(0, 4)
      .toUpperCase();
  }
  return resource.slice(0, 4).toUpperCase();
}

function formatQuantity(resource: string, quantity: string): string {
  if (resource === "cpu") return formatCPUString(quantity);
  if (resource === "memory" || resource === "ephemeral-storage")
    return formatMemoryString(quantity);
  return quantity;
}

function formatTaint(taint: {
  key: string;
  value?: string;
  effect: string;
}): string {
  return `${taint.key}${taint.value ? `=${taint.value}` : ""}:${taint.effect}`;
}

function generatedAtMillis(generatedAt: string, fallback: number): number {
  const value = Date.parse(generatedAt);
  return Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}
