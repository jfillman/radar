import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapacityActivityResponse,
  CapacityDemandResponse,
  CapacityMemberListResponse,
  CapacityOverviewResponse,
  CapacityPoolDetailResponse,
  CapacityPoolListResponse,
  CapacityPoolObservation,
  CapacityQuantityObservation,
  CapacityResponseMeta,
  CapacitySourceCoverage,
} from "@skyhook-io/k8s-ui";
import { CapacityView, PoolRow } from "./CapacityView";
import { ApiError } from "../../api/client";

vi.mock("../../context/ConnectionContext", () => ({
  useConnection: () => ({ connection: { state: "connected" } }),
}));

const generatedAt = "2026-07-13T08:00:00Z";

function sourceCoverage(
  status: CapacitySourceCoverage["status"] = "available",
  reason?: string,
  scope: CapacitySourceCoverage["scope"] = "cluster",
): CapacitySourceCoverage {
  return {
    status,
    reason,
    scope,
    observedAt: generatedAt,
    impactFields: [],
  };
}

const meta: CapacityResponseMeta = {
  schemaVersion: "v1alpha1",
  generatedAt,
  clusterContext: { contextName: "radar-test-eks", clusterName: "radar-test" },
  provider: {
    type: "karpenter",
    controllerMode: "self_managed",
    apiVersionsByKind: { NodePool: ["v1"], NodeClaim: ["v1"] },
    nodeClassKinds: [
      {
        group: "karpenter.k8s.aws",
        kind: "EC2NodeClass",
        resource: "ec2nodeclasses",
        versions: ["v1"],
      },
    ],
    features: { staticCapacity: true, metrics: true },
  },
  coverage: {
    nodePools: sourceCoverage(),
    nodeClaims: sourceCoverage(),
    nodeClasses: sourceCoverage(),
    nodes: sourceCoverage(),
    pods: sourceCoverage(),
    workloads: sourceCoverage(),
    nodeMetrics: sourceCoverage(),
    karpenterObjectEvents: sourceCoverage(),
    timeline: sourceCoverage(),
  },
};

function quantity(
  resources: Record<string, string>,
  certainty: CapacityQuantityObservation["certainty"] = "exact",
): CapacityQuantityObservation {
  return {
    resources,
    certainty,
    sources: ["karpenter.status"],
    asOf: generatedAt,
    granularity: "aggregate",
  };
}

const poolSummary: CapacityOverviewResponse["pools"][number] = {
  resource: {
    ref: { group: "karpenter.sh", kind: "NodePool", name: "default" },
    apiVersion: "karpenter.sh/v1",
  },
  mode: "dynamic",
  ready: true,
  nodeClass: {
    group: "karpenter.k8s.aws",
    kind: "EC2NodeClass",
    name: "general",
  },
  ledger: {
    configuredLimit: quantity({ cpu: "20", memory: "80Gi" }),
    provisioned: quantity({ cpu: "10", memory: "40Gi" }),
    scheduledRequests: quantity({ cpu: "6500m", memory: "28Gi" }),
    actualUsage: {
      quantity: quantity({ cpu: "4", memory: "16Gi" }),
      coveredNodes: 4,
      totalNodes: 4,
      coveredAllocatable: quantity({ cpu: "10", memory: "40Gi" }),
      utilization: [
        { resource: "cpu", usage: "4", allocatable: "10", percent: 40 },
        { resource: "memory", usage: "16Gi", allocatable: "40Gi", percent: 40 },
      ],
    },
    limitPressure: [
      {
        resource: "cpu",
        provisioned: "10",
        limit: "20",
        percent: 50,
        overLimit: false,
      },
    ],
  },
  claims: {
    total: 4,
    pending: 0,
    launched: 4,
    registered: 4,
    initialized: 4,
    ready: 4,
    failed: 0,
    terminating: 0,
  },
  nodes: { total: 4, ready: 4, notReady: 0, cordoned: 0, terminating: 0 },
  issueCount: 1,
  factCount: 2,
};

function overview(
  overrides: Partial<CapacityOverviewResponse> = {},
): CapacityOverviewResponse {
  return {
    ...meta,
    state: "available",
    summary: {
      actions: [
        {
          code: "configured_limit_pressure",
          count: 1,
          highestSeverity: "warning",
          pools: [poolSummary.resource],
          demandGroupIds: [],
          truncated: false,
        },
      ],
      aggregateDemand: quantity({ cpu: "6", memory: "24Gi" }),
      poolCount: 1,
      claimCount: 4,
      nodeCount: 4,
      pendingPodCount: 2,
    },
    pools: [poolSummary],
    poolsTruncated: false,
    ...overrides,
  };
}

const poolDetail: CapacityPoolObservation = {
  resource: poolSummary.resource,
  generation: 3,
  observedGeneration: 3,
  specFingerprint: "sha256:fixture",
  createdAt: generatedAt,
  updatedAt: generatedAt,
  mode: "dynamic",
  ready: true,
  conditions: [{ type: "Ready", status: "True" }],
  nodeClass: {
    reference: {
      group: "karpenter.k8s.aws",
      kind: "EC2NodeClass",
      name: "general",
    },
    ready: true,
    conditions: [{ type: "Ready", status: "True" }],
  },
  configuration: {
    weight: 10,
    labels: { team: "platform" },
    requirements: [
      {
        key: "karpenter.sh/capacity-type",
        operator: "In",
        values: ["spot", "on-demand"],
      },
    ],
    taints: [],
    startupTaints: [],
    expireAfter: "720h",
  },
  ledger: poolSummary.ledger,
  disruption: {
    consolidationPolicy: "WhenEmptyOrUnderutilized",
    consolidateAfter: "30s",
    budgets: [],
  },
  claims: poolSummary.claims,
  nodes: poolSummary.nodes,
  issues: [],
  facts: [],
  coverage: {
    ...meta.coverage,
    nodes: sourceCoverage("denied", "Node inventory hidden by permissions"),
    pods: sourceCoverage("denied", "Pod inventory hidden by permissions"),
    workloads: sourceCoverage(
      "denied",
      "Workload attribution hidden by permissions",
    ),
  },
};

function renderCapacity(
  path: string,
  seed: (client: QueryClient) => void,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  seed(client);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <CapacityView onOpenResource={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("CapacityView", () => {
  it("renders the server-authoritative overview and links pool rows to detail routes", () => {
    const html = renderCapacity("/capacity", (client) =>
      client.setQueryData(["capacity", "overview"], overview()),
    );

    expect(html).toContain("Cluster capacity posture");
    expect(html).toContain("Configured limit");
    expect(html).toContain("Scheduled requests");
    expect(html).toContain("Actual usage");
    expect(html).toContain("Active pending requests");
    expect(html).toContain("Priority signals");
    expect(html).toContain("Configured limit pressure");
    expect(html).toContain("Plan from scheduler commitments");
    expect(html).toContain("Open default capacity details");
    expect(html).toContain("6.5 cores");
    expect(html).toContain("width:50%");
  });

  it("passes the selected pool to route navigation when its row is clicked", () => {
    const onOpenPool = vi.fn();
    const row = PoolRow({
      pool: poolSummary,
      coverage: meta.coverage,
      onOpenPool,
    });

    row.props.onClick();

    expect(onOpenPool).toHaveBeenCalledOnce();
    expect(onOpenPool).toHaveBeenCalledWith("default");
  });

  it("offers paginated discovery when the overview pool list is truncated", () => {
    const poolPage: CapacityPoolListResponse = {
      ...meta,
      state: "available",
      items: [poolSummary],
      page: { hasMore: true, nextCursor: "next-page" },
    };
    const response = overview({
      summary: { ...overview().summary, poolCount: 101 },
      poolsTruncated: true,
    });
    const html = renderCapacity("/capacity?poolView=all", (client) => {
      client.setQueryData(["capacity", "overview"], response);
      client.setQueryData(["capacity", "pools", 100, undefined], poolPage);
    });

    expect(html).toContain("Return to posture list");
    expect(html).toContain("Page <!-- -->1");
    expect(html).toContain("Next");
  });

  it("labels namespace-scoped overview demand as a lower bound", () => {
    const response = overview({
      coverage: {
        ...meta.coverage,
        pods: sourceCoverage(
          "available",
          undefined,
          "all_authorized_namespaces",
        ),
      },
    });
    const html = renderCapacity("/capacity", (client) =>
      client.setQueryData(["capacity", "overview"], response),
    );

    expect(html).toContain("lower-bound view");
    expect(html).toContain("all namespaces authorized for this user");
  });

  it("offers investigation controls for demand priority signals", () => {
    const response = overview({
      summary: {
        actions: [
          {
            code: "pending_demand_blocked",
            count: 2,
            highestSeverity: "warning",
            pools: [],
            demandGroupIds: ["blocked-a", "blocked-b"],
            truncated: false,
          },
          {
            code: "pending_demand_resource_pressure",
            count: 1,
            highestSeverity: "info",
            pools: [],
            demandGroupIds: ["pressure-a"],
            truncated: false,
          },
          {
            code: "pending_demand_unclassified",
            count: 1,
            highestSeverity: "info",
            pools: [],
            demandGroupIds: ["unknown-a"],
            truncated: false,
          },
        ],
        aggregateDemand: quantity({ cpu: "6", memory: "24Gi" }),
        poolCount: 1,
        claimCount: 4,
        nodeCount: 4,
        pendingPodCount: 4,
      },
    });
    const html = renderCapacity("/capacity?namespaces=checkout", (client) =>
      client.setQueryData(["capacity", "overview"], response),
    );

    expect(html).toContain("Pending demand blocked");
    expect(html).toContain("Pending demand resource pressure");
    expect(html).toContain("Pending demand unclassified");
    expect(html.match(/>Investigate<\/button>/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Investigate pending demand blocked"');
    expect(html).toContain(
      'aria-label="Investigate pending demand resource pressure"',
    );
    expect(html).toContain(
      'aria-label="Investigate pending demand unclassified"',
    );
  });

  it("surfaces inventory outside live pools as secondary facts", () => {
    const html = renderCapacity("/capacity", (client) =>
      client.setQueryData(
        ["capacity", "overview"],
        overview({
          summary: {
            ...overview().summary,
            orphanedClaimCount: 2,
            unpooledNodeCount: 3,
          },
        }),
      ),
    );

    expect(html).toContain("Inventory outside live pools");
    expect(html).toContain("NodeClaims no longer resolve");
    expect(html).toContain("nodes are<!-- --> outside Karpenter NodePools");
    expect(html).toContain("this may be intentional");
  });

  it("keeps optional counts unknown when their source was not observed", () => {
    const missingCoverage = overview({
      coverage: {
        ...meta.coverage,
        nodes: sourceCoverage("denied", "Node inventory hidden by permissions"),
        nodeClaims: sourceCoverage("syncing", "Claim inventory is syncing"),
        pods: sourceCoverage("unavailable", "Pending pods are unavailable"),
      },
      summary: { actions: [], poolCount: 1 },
      pools: [
        {
          ...poolSummary,
          nodes: undefined,
          claims: undefined,
          ledger: { ...poolSummary.ledger, actualUsage: undefined },
        },
      ],
    });
    const html = renderCapacity("/capacity", (client) =>
      client.setQueryData(["capacity", "overview"], missingCoverage),
    );

    expect(html).toContain("Node inventory hidden by permissions");
    expect(html).toContain("Claim inventory is syncing");
    expect(html).toContain("Pending pods are unavailable");
    expect(html).toContain(">—</span>");
    expect(html).not.toContain("0 nodes");
    expect(html).not.toContain("0 claims");
  });

  it("supports a direct pool URL and explains omitted composition and workload attribution through coverage", () => {
    const response: CapacityPoolDetailResponse = {
      ...meta,
      state: "available",
      pool: poolDetail,
    };
    const html = renderCapacity("/capacity/pools/default", (client) =>
      client.setQueryData(["capacity", "pool", "default"], response),
    );

    expect(html).toContain("Summary");
    expect(html).toContain("Workloads");
    expect(html).toContain("Nodes &amp; claims");
    expect(html).toContain("Configuration");
    expect(html).toContain("Fleet composition");
    expect(html).toContain("Node inventory hidden by permissions");
    expect(html).toContain("Workload attribution hidden by permissions");
    expect(html).not.toContain("No nodes in this bucket");
  });

  it("describes pool-filtered demand as evaluation rather than an eligible-only result", () => {
    const response: CapacityPoolDetailResponse = {
      ...meta,
      state: "available",
      pool: {
        ...poolDetail,
        coverage: {
          ...poolDetail.coverage,
          workloads: sourceCoverage(),
        },
        workloads: {
          scheduledPodCount: 4,
          workloadCount: 2,
          topScheduled: [],
          topScheduledMeta: { total: 0, returned: 0, truncated: false },
          pendingEligibleGroupIds: ["group-a", "group-b"],
          pendingEligibleGroupsMeta: {
            total: 2,
            returned: 2,
            truncated: false,
          },
        },
      },
    };
    const html = renderCapacity("/capacity/pools/default", (client) =>
      client.setQueryData(["capacity", "pool", "default"], response),
    );

    expect(html).toContain("Evaluate pending demand against this pool");
    expect(html).toContain("currently declared compatible");
    expect(html).not.toContain("eligible for this pool");
  });

  it("loads node and claim membership from the URL-backed members view", () => {
    const detail: CapacityPoolDetailResponse = {
      ...meta,
      state: "available",
      pool: poolDetail,
    };
    const nodes: CapacityMemberListResponse = {
      ...meta,
      coverage: {
        ...meta.coverage,
        nodeMetrics: sourceCoverage(
          "denied",
          "Live node metrics hidden by permissions",
        ),
      },
      state: "available",
      pool: poolDetail.resource,
      type: "node",
      page: { hasMore: false },
      items: [
        {
          type: "node",
          resource: {
            ref: { kind: "Node", name: "worker-a" },
            apiVersion: "v1",
          },
          node: {
            ready: true,
            cordoned: false,
            conditions: [{ type: "Ready", status: "True" }],
            capacityType: "spot",
            instanceType: "m7i.large",
            zone: "us-east-1a",
            podCount: 12,
            allocatable: quantity({
              "hugepages-2Mi": "0",
              cpu: "2",
              memory: "8Gi",
              pods: "110",
              "ephemeral-storage": "80Gi",
            }),
            scheduledRequests: quantity({ cpu: "1500m" }),
          },
        },
      ],
    };
    const claims: CapacityMemberListResponse = {
      ...meta,
      state: "available",
      pool: poolDetail.resource,
      type: "claim",
      page: { hasMore: false },
      items: [
        {
          type: "claim",
          resource: {
            ref: { group: "karpenter.sh", kind: "NodeClaim", name: "claim-a" },
          },
          claim: {
            stage: "ready",
            conditions: [{ type: "Ready", status: "True" }],
            node: nodes.items[0].resource,
            capacity: quantity({ cpu: "2" }),
          },
        },
      ],
    };
    const html = renderCapacity("/capacity/pools/default/members", (client) => {
      client.setQueryData(["capacity", "pool", "default"], detail);
      client.setQueryData(
        ["capacity", "pool", "default", "members", "node", 50, undefined],
        nodes,
      );
      client.setQueryData(
        ["capacity", "pool", "default", "members", "claim", 50, undefined],
        claims,
      );
    });

    expect(html).toContain("worker-a");
    expect(html).toContain("claim-a");
    expect(html).toContain("m7i.large");
    expect(html).toContain("spot");
    expect(html).toContain("Live node metrics hidden by permissions");
    expect(html).toContain("DISK");
    expect(html).not.toContain("HUGE");
  });

  it("keeps member pod counts and claim registration honest under partial RBAC", () => {
    const detail: CapacityPoolDetailResponse = {
      ...meta,
      state: "available",
      pool: poolDetail,
    };
    const nodes: CapacityMemberListResponse = {
      ...meta,
      coverage: {
        ...meta.coverage,
        pods: sourceCoverage("denied"),
      },
      state: "available",
      pool: poolDetail.resource,
      type: "node",
      page: { hasMore: false },
      items: [
        {
          type: "node",
          resource: {
            ref: { kind: "Node", name: "worker-hidden-pods" },
            apiVersion: "v1",
          },
          node: {
            ready: true,
            cordoned: false,
            conditions: [],
          },
        },
      ],
    };
    const claims: CapacityMemberListResponse = {
      ...meta,
      coverage: {
        ...meta.coverage,
        nodes: sourceCoverage(
          "denied",
          "Node details are hidden by permissions",
        ),
      },
      state: "available",
      pool: poolDetail.resource,
      type: "claim",
      page: { hasMore: false },
      items: [
        {
          type: "claim",
          resource: {
            ref: { group: "karpenter.sh", kind: "NodeClaim", name: "claim-a" },
          },
          claim: {
            stage: "registered",
            conditions: [],
            nodeName: "hidden-node",
          },
        },
      ],
    };
    const html = renderCapacity("/capacity/pools/default/members", (client) => {
      client.setQueryData(["capacity", "pool", "default"], detail);
      client.setQueryData(
        ["capacity", "pool", "default", "members", "node", 50, undefined],
        nodes,
      );
      client.setQueryData(
        ["capacity", "pool", "default", "members", "claim", 50, undefined],
        claims,
      );
    });

    expect(html).toContain("Pod count is hidden by permissions");
    expect(html).toContain("Scheduled requests is hidden by permissions");
    expect(html).toContain("hidden-node");
    expect(html).toContain("Node details are hidden by permissions");
    expect(html).not.toContain("Not registered");
    expect(html).not.toContain("No quantities reported");
    expect(html).not.toContain("Server-authoritative membership");

    const partialHtml = renderCapacity(
      "/capacity/pools/default/members",
      (client) => {
        client.setQueryData(["capacity", "pool", "default"], detail);
        client.setQueryData(
          ["capacity", "pool", "default", "members", "node", 50, undefined],
          {
            ...nodes,
            coverage: {
              ...nodes.coverage,
              pods: sourceCoverage(
                "partial",
                "Pod inventory is namespace-limited",
                "all_authorized_namespaces",
              ),
            },
            items: [
              {
                ...nodes.items[0],
                node: { ...nodes.items[0].node!, podCount: 7 },
              },
            ],
          },
        );
        client.setQueryData(
          [
            "capacity",
            "pool",
            "default",
            "members",
            "claim",
            50,
            undefined,
          ],
          claims,
        );
      },
    );

    expect(partialHtml).toContain("Per-node values are lower bounds");
    expect(partialHtml).toContain("At least 7 pods");
    expect(partialHtml).toContain("≥<!-- -->7");
  });

  it("distinguishes stale metrics, an empty in-flight set, and extended resources", () => {
    const staleMetrics = {
      ...sourceCoverage("partial"),
      reasonCode: "node_metrics_stale",
    };
    const response: CapacityPoolDetailResponse = {
      ...meta,
      state: "available",
      pool: {
        ...poolDetail,
        ledger: {
          ...poolDetail.ledger,
          inFlightCapacity: undefined,
          scheduledRequests: quantity({
            cpu: "6500m",
            memory: "28Gi",
            "vpc.amazonaws.com/pod-eni": "4",
          }),
        },
        coverage: { ...poolDetail.coverage, nodeMetrics: staleMetrics },
      },
    };
    const html = renderCapacity("/capacity/pools/default", (client) =>
      client.setQueryData(["capacity", "pool", "default"], response),
    );

    expect(html).toContain("No capacity currently in flight");
    expect(html).toContain("latest retained node metrics are stale");
    expect(html).toContain("ENI");
    expect(html).not.toContain("POD-");
    expect(html).not.toContain("lower bound");
  });

  it("shows a pool-local no-sample state when global metrics are available", () => {
    const response: CapacityPoolDetailResponse = {
      ...meta,
      state: "available",
      pool: {
        ...poolDetail,
        ledger: { ...poolDetail.ledger, actualUsage: undefined },
        coverage: {
          ...poolDetail.coverage,
          nodeMetrics: sourceCoverage("available"),
        },
      },
    };
    const html = renderCapacity("/capacity/pools/default", (client) =>
      client.setQueryData(["capacity", "pool", "default"], response),
    );

    expect(html).toContain("No sample");
    expect(html).toContain("No live node samples were reported for this pool");
  });

  it("shows disruption runtime certainty, sources, and observation time", () => {
    const response: CapacityPoolDetailResponse = {
      ...meta,
      state: "available",
      pool: {
        ...poolDetail,
        disruption: {
          ...poolDetail.disruption,
          runtime: {
            allowed: [
              {
                reason: "Underutilized",
                count: 2,
                source: "nodepool-budget",
                asOf: generatedAt,
              },
            ],
            blockers: [],
            certainty: "lower_bound",
            sources: ["nodepools", "poddisruptionbudgets"],
            asOf: generatedAt,
          },
        },
      },
    };
    const html = renderCapacity(
      "/capacity/pools/default/configuration",
      (client) =>
        client.setQueryData(["capacity", "pool", "default"], response),
    );

    expect(html).toContain("Underutilized");
    expect(html).toContain("allowed");
    expect(html).toContain("Lower bound");
    expect(html).toContain("nodepools + poddisruptionbudgets");
    expect(html).toContain("as of");
  });

  it("capitalizes NodeClass signals consistently", () => {
    const response = overview({
      summary: {
        ...overview().summary,
        actions: [
          {
            code: "nodeclass_not_ready",
            count: 1,
            pools: [poolSummary.resource],
            demandGroupIds: [],
            truncated: false,
          },
        ],
      },
    });
    const html = renderCapacity("/capacity", (client) =>
      client.setQueryData(["capacity", "overview"], response),
    );

    expect(html).toContain("NodeClass not ready");
    expect(html).not.toContain("Nodeclass not ready");
  });

  it("renders a friendly direct-link state when a NodePool was removed", () => {
    const html = renderCapacity("/capacity/pools/retired-batch", (client) => {
      const query = client.getQueryCache().build(client, {
        queryKey: ["capacity", "pool", "retired-batch"],
        queryFn: async () => undefined,
      });
      query.setState({
        ...query.state,
        error: new ApiError("NodePool not found", 404),
        errorUpdatedAt: Date.now(),
        fetchStatus: "idle",
        status: "error",
      });
    });

    expect(html).toContain("NodePool not found");
    expect(html).toContain("may have been removed");
    expect(html).toContain("another cluster context");
    expect(html).toContain("Back to capacity overview");
  });

  it("offers to clear a stale NodePool filter on pending demand", () => {
    const html = renderCapacity(
      "/capacity/demand?pool=retired-batch",
      (client) => {
        const query = client.getQueryCache().build(client, {
          queryKey: [
            "capacity",
            "demand",
            25,
            undefined,
            undefined,
            "retired-batch",
          ],
          queryFn: async () => undefined,
        });
        query.setState({
          ...query.state,
          error: new ApiError("NodePool not found", 404),
          errorUpdatedAt: Date.now(),
          fetchStatus: "idle",
          status: "error",
        });
      },
    );

    expect(html).toContain("NodePool not found");
    expect(html).toContain("retired-batch");
    expect(html).toContain("Show all pending demand");
  });

  it("renders pending demand with scheduler and per-pool evaluation evidence", () => {
    const response: CapacityDemandResponse = {
      ...meta,
      coverage: {
        ...meta.coverage,
        pods: sourceCoverage(
          "available",
          undefined,
          "all_authorized_namespaces",
        ),
      },
      state: "available",
      page: { hasMore: false },
      items: [
        {
          id: "demand-1",
          fingerprint: "fingerprint",
          owner: {
            group: "apps",
            kind: "Deployment",
            namespace: "checkout",
            name: "api",
          },
          pods: [
            {
              ref: { kind: "Pod", namespace: "checkout", name: "api-pending" },
            },
          ],
          podsMeta: { total: 3, returned: 1, truncated: true },
          namespace: "checkout",
          firstSeen: generatedAt,
          lastSeen: generatedAt,
          podCount: 3,
          perPodRequests: quantity({ cpu: "2", memory: "8Gi" }),
          aggregateRequests: quantity({ cpu: "6", memory: "24Gi" }),
          schedulingSignature: {
            fingerprint: "signature",
            constraints: [
              {
                predicate: "nodeSelector",
                key: "workload",
                operator: "In",
                values: ["memory"],
                sourcePath: "spec.nodeSelector",
              },
            ],
            constraintsMeta: { total: 1, returned: 1, truncated: false },
            tolerations: [],
            tolerationsMeta: { total: 0, returned: 0, truncated: false },
          },
          state: "blocked",
          schedulerReasons: [
            {
              code: "InsufficientMemory",
              source: "scheduler",
              message: "No existing node has enough memory",
              count: 3,
              firstSeen: generatedAt,
              lastSeen: generatedAt,
            },
          ],
          schedulerReasonsMeta: { total: 1, returned: 1, truncated: false },
          poolEvaluations: [
            {
              pool: {
                group: "karpenter.sh",
                kind: "NodePool",
                name: "default",
              },
              result: "incompatible",
              evidence: [
                {
                  predicate: "requirement",
                  sourcePath: "spec.template.spec.requirements",
                  observedValues: ["general"],
                  expectedValues: ["memory"],
                  confidence: "high",
                  explanation: "workload label is outside the declared values",
                },
              ],
              evidenceMeta: { total: 1, returned: 1, truncated: false },
              unknownPredicates: [],
              unknownPredicatesMeta: {
                total: 0,
                returned: 0,
                truncated: false,
              },
            },
            {
              pool: {
                group: "karpenter.sh",
                kind: "NodePool",
                name: "memory",
              },
              result: "declared_compatible",
              evidence: [],
              evidenceMeta: { total: 0, returned: 0, truncated: false },
              unknownPredicates: [],
              unknownPredicatesMeta: {
                total: 0,
                returned: 0,
                truncated: false,
              },
            },
          ],
          poolEvaluationsMeta: { total: 2, returned: 2, truncated: false },
          poolEvaluationCounts: {
            declaredCompatible: 1,
            incompatible: 1,
            unknown: 0,
          },
          issues: [],
        },
      ],
    };
    const html = renderCapacity("/capacity/demand", (client) =>
      client.setQueryData(
        ["capacity", "demand", 25, undefined, undefined, undefined],
        response,
      ),
    );

    expect(html).toContain("Pending workload demand");
    expect(html).toContain("Deployment<!-- -->/<!-- -->api");
    expect(html).toContain("InsufficientMemory");
    expect(html).toContain("Declared pool compatibility");
    expect(html).toContain("1 declared compatible");
    expect(html).not.toContain("1 compatible");
    expect(html).toContain("Incompatible");
    expect(html).toContain("workload label is outside the declared values");
    expect(html).toContain("lower-bound view");
    expect(html).toContain("all namespaces authorized for this user");
  });

  it("distinguishes pods held by scheduling gates from scheduler and capacity waits", () => {
    const response: CapacityDemandResponse = {
      ...meta,
      state: "available",
      page: { hasMore: false },
      items: [
        {
          id: "demand-held",
          fingerprint: "held-fingerprint",
          pods: [],
          podsMeta: { total: 1, returned: 0, truncated: true },
          namespace: "checkout",
          firstSeen: generatedAt,
          lastSeen: generatedAt,
          podCount: 1,
          perPodRequests: quantity({ cpu: "250m", memory: "256Mi" }),
          aggregateRequests: quantity({ cpu: "250m", memory: "256Mi" }),
          schedulingSignature: {
            fingerprint: "held-signature",
            constraints: [],
            constraintsMeta: { total: 0, returned: 0, truncated: false },
            tolerations: [],
            tolerationsMeta: { total: 0, returned: 0, truncated: false },
          },
          state: "held",
          schedulerReasons: [],
          schedulerReasonsMeta: { total: 0, returned: 0, truncated: false },
          poolEvaluations: [],
          poolEvaluationsMeta: { total: 0, returned: 0, truncated: false },
          poolEvaluationCounts: {
            declaredCompatible: 0,
            incompatible: 0,
            unknown: 0,
          },
          issues: [],
        },
      ],
    };
    const html = renderCapacity("/capacity/demand?state=held", (client) =>
      client.setQueryData(
        ["capacity", "demand", 25, undefined, "held", undefined],
        response,
      ),
    );

    expect(html).toContain("Held by scheduling gate");
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders retained activity episodes and a cursor-gap warning", () => {
    const response: CapacityActivityResponse = {
      ...meta,
      state: "available",
      page: { hasMore: false },
      cursorStatus: "epoch_changed",
      anchorCursor: "new-anchor",
      cursorGap: {
        detectedAt: generatedAt,
        reason: "timeline_epoch_changed",
        newAnchor: "new-anchor",
      },
      observation: {
        startedAt: generatedAt,
        endedAt: generatedAt,
        sources: ["k8s_event", "resource_change"],
        retention: { mode: "memory_bounded", maxEvents: 10000 },
        gaps: [],
      },
      items: [
        {
          id: "episode-1",
          type: "launch_failure",
          state: "failed",
          summary: "NodeClaim launch failed",
          primaryReasonCode: "InsufficientCapacity",
          startedAt: generatedAt,
          durationSeconds: 42,
          pool: poolDetail.resource,
          claim: {
            ref: {
              group: "karpenter.sh",
              kind: "NodeClaim",
              name: "claim-failed",
            },
          },
          evidence: [
            {
              at: generatedAt,
              source: "k8s_event",
              reasonCode: "InsufficientCapacity",
              rawReason: "LaunchFailed",
              rawMessage: "provider had no matching capacity",
              relationship: "direct",
              confidence: "high",
              refs: [],
            },
          ],
          evidenceMeta: { total: 24, returned: 20, truncated: true },
        },
      ],
    };
    const html = renderCapacity("/capacity/activity", (client) =>
      client.setQueryData(
        [
          "capacity",
          "activity",
          50,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ],
        response,
      ),
    );

    expect(html).toContain("Provisioning and disruption activity");
    expect(html).toContain("Launch failure");
    expect(html).toContain("InsufficientCapacity");
    expect(html).toContain("timeline_epoch_changed");
    expect(html).toContain(
      "Showing <!-- -->20<!-- --> of<!-- --> <!-- -->24<!-- --> evidence records",
    );
  });

  it("hydrates Activity filter drafts from a direct URL", () => {
    const response: CapacityActivityResponse = {
      ...meta,
      state: "available",
      page: { hasMore: false },
      cursorStatus: "valid",
      observation: {
        startedAt: generatedAt,
        endedAt: generatedAt,
        sources: [],
        retention: { mode: "memory_bounded", maxEvents: 10000 },
        gaps: [],
      },
      items: [],
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T09:00:00Z"));
    try {
      const html = renderCapacity(
        `/capacity/activity?pool=spot-flex&claim=claim-a&node=worker-a&reason=LaunchFailed&since=${encodeURIComponent(generatedAt)}`,
        (client) =>
          client.setQueryData(
            [
              "capacity",
              "activity",
              50,
              undefined,
              generatedAt,
              "spot-flex",
              "claim-a",
              "worker-a",
              "LaunchFailed",
            ],
            response,
          ),
      );

      expect(html).toContain('value="spot-flex"');
      expect(html).toContain('value="LaunchFailed"');
      expect(html).toContain("Resource filters");
      expect(html).toContain("NodeClaim: claim-a");
      expect(html).toContain("Node: worker-a");
      expect(html).toContain('aria-label="Remove NodeClaim: claim-a filter"');
      expect(html).toMatch(/aria-pressed="true"[^>]*>1h/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers from a malformed Activity window with a clear control", () => {
    const response: CapacityActivityResponse = {
      ...meta,
      state: "available",
      page: { hasMore: false },
      cursorStatus: "valid",
      observation: {
        startedAt: generatedAt,
        endedAt: generatedAt,
        sources: [],
        retention: { mode: "memory_bounded", maxEvents: 10000 },
        gaps: [],
      },
      items: [],
    };
    const html = renderCapacity(
      "/capacity/activity?since=not-a-time",
      (client) =>
        client.setQueryData(
          [
            "capacity",
            "activity",
            50,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
          ],
          response,
        ),
    );

    expect(html).toContain("activity window timestamp is invalid");
    expect(html).toContain("Clear invalid filter");
  });

  it("shows the integration state returned by the server", () => {
    const html = renderCapacity("/capacity", (client) =>
      client.setQueryData(
        ["capacity", "overview"],
        overview({
          state: "not_detected",
          summary: { actions: [], poolCount: 0 },
          pools: [],
        }),
      ),
    );
    expect(html).toContain("Karpenter not detected");
  });
});
