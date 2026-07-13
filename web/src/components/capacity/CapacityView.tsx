import { useLocation, useNavigate } from "react-router-dom";
import { Gauge } from "lucide-react";
import { Badge } from "@skyhook-io/k8s-ui/components/ui/Badge";
import { useCapacityOverview } from "../../api/client";
import { useConnection } from "../../context/ConnectionContext";
import type { SelectedResource } from "../../types";
import { CapacityActivity } from "./CapacityActivity";
import { CapacityDemand } from "./CapacityDemand";
import { CapacityOverview } from "./CapacityOverview";
import { CapacityPoolDetail } from "./CapacityPoolDetail";
import {
  capacityPoolPath,
  parseCapacityRoute,
  TOP_TABS,
  type CapacityTopTab,
} from "./shared";

interface CapacityViewProps {
  onOpenResource: (resource: SelectedResource) => void;
}

export function CapacityView({ onOpenResource }: CapacityViewProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const route = parseCapacityRoute(location.pathname);
  const { connection } = useConnection();
  const overview = useCapacityOverview({
    enabled: !route.poolName && route.topTab === "overview",
  });

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

  const openPool = (name: string) => navigateCapacity(capacityPoolPath(name));

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-theme-base">
      <div className="shrink-0 border-b border-theme-border bg-theme-surface">
        <div className="flex items-center gap-2.5 px-5 pb-1 pt-3 xl:px-7">
          <Gauge className="h-5 w-5 text-accent-text" />
          <h1 className="text-base font-semibold text-theme-text-primary">
            Capacity
          </h1>
          <Badge
            tone="structural"
            size="sm"
            title="Shown because Karpenter APIs were detected in this cluster"
          >
            Karpenter
          </Badge>
        </div>
        <div
          className="flex gap-1 px-5 xl:px-7"
          role="tablist"
          aria-label="Capacity views"
        >
          {TOP_TABS.map((tab) => (
            <CapacityTab
              key={tab.id}
              label={tab.label}
              active={route.topTab === tab.id}
              onClick={() =>
                navigateCapacity(
                  tab.id === "overview" ? "/capacity" : `/capacity/${tab.id}`,
                )
              }
            />
          ))}
        </div>
      </div>

      {route.poolName ? (
        <CapacityPoolDetail
          key={route.poolName}
          name={route.poolName}
          section={route.poolSection}
          connectionState={connection.state}
          onNavigate={navigateCapacity}
          onOpenResource={onOpenResource}
        />
      ) : route.topTab === "overview" ? (
        <CapacityOverview
          query={overview}
          connectionState={connection.state}
          onOpenPool={openPool}
          onOpenResource={onOpenResource}
          onNavigate={navigateCapacity}
        />
      ) : route.topTab === "demand" ? (
        <CapacityDemand
          connectionState={connection.state}
          onOpenPool={openPool}
          onOpenResource={onOpenResource}
        />
      ) : (
        <CapacityActivity
          connectionState={connection.state}
          onOpenPool={openPool}
          onOpenResource={onOpenResource}
        />
      )}
    </div>
  );
}

function CapacityTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-skyhook-500 text-theme-text-primary"
          : "border-transparent text-theme-text-secondary hover:border-theme-border-light hover:text-theme-text-primary"
      }`}
    >
      {label}
    </button>
  );
}

export type { CapacityTopTab };
