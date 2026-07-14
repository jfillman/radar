import { describe, expect, it } from "vitest";
import type { Issue } from "@skyhook-io/k8s-ui";
import { capacityHrefForIssue } from "./IssuesPane";

function issue(partial: Partial<Issue>): Issue {
  return {
    id: "1",
    severity: "critical",
    source: "problem",
    category: "x",
    category_group: "x",
    grouping_scope: "x",
    kind: "Pod",
    name: "p",
    reason: "r",
    ...partial,
  } as Issue;
}

describe("capacityHrefForIssue", () => {
  it("returns null when Karpenter is not detected", () => {
    expect(capacityHrefForIssue(issue({ source: "scheduling" }), false, [])).toBeNull();
    expect(
      capacityHrefForIssue(
        issue({ kind: "NodePool", group: "karpenter.sh", name: "core" }),
        false,
        [],
      ),
    ).toBeNull();
  });

  it("links a pod that requires a Karpenter NodePool to the Demand queue", () => {
    const msg =
      "Unschedulable — no node has karpenter.sh/nodepool=retired-batch — 7 node(s) carry karpenter.sh/nodepool: [core-on-demand]";
    expect(
      capacityHrefForIssue(issue({ source: "scheduling", message: msg }), true, []),
    ).toBe("/capacity/demand");
  });

  it("preserves namespace scope on the Demand link", () => {
    const msg = "no node has karpenter.sh/nodepool=retired-batch";
    expect(
      capacityHrefForIssue(issue({ source: "scheduling", message: msg }), true, [
        "payments",
        "media",
      ]),
    ).toBe("/capacity/demand?namespaces=payments%2Cmedia");
  });

  it("does NOT link a generic scheduling failure (not Karpenter's to solve)", () => {
    // Insufficient resources / node-pinned / zonal — no Karpenter NodePool
    // requirement in the message → no link, even in a Karpenter cluster.
    expect(
      capacityHrefForIssue(
        issue({
          source: "scheduling",
          message: "Unschedulable — Insufficient cpu (0/9 nodes available)",
        }),
        true,
        [],
      ),
    ).toBeNull();
  });

  it("does NOT trigger on the 'N node(s) carry karpenter.sh/nodepool' context line", () => {
    // The pod requires a NON-Karpenter label; the message only *mentions*
    // karpenter.sh/nodepool as context about existing nodes. Must not link.
    expect(
      capacityHrefForIssue(
        issue({
          source: "scheduling",
          message:
            "no node has kubernetes.io/arch=arm64 — 7 node(s) carry karpenter.sh/nodepool: [core-on-demand]",
        }),
        true,
        [],
      ),
    ).toBeNull();
  });

  it("links a NodePool-subject issue to its pool detail", () => {
    expect(
      capacityHrefForIssue(
        issue({
          kind: "NodePool",
          group: "karpenter.sh",
          name: "core-on-demand",
          source: "condition",
        }),
        true,
        [],
      ),
    ).toBe("/capacity/pools/core-on-demand");
  });

  it("does not link non-Karpenter issues even when Karpenter is present", () => {
    expect(
      capacityHrefForIssue(issue({ source: "problem", kind: "Service" }), true, []),
    ).toBeNull();
    // A NodePool from a different API group must not be treated as Karpenter's.
    expect(
      capacityHrefForIssue(
        issue({ kind: "NodePool", group: "example.com", name: "x" }),
        true,
        [],
      ),
    ).toBeNull();
  });
});
