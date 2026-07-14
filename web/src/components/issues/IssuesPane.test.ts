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

  it("links pending/unschedulable (scheduling) issues to the Demand queue", () => {
    expect(capacityHrefForIssue(issue({ source: "scheduling" }), true, [])).toBe(
      "/capacity/demand",
    );
  });

  it("preserves namespace scope on the Demand link", () => {
    expect(
      capacityHrefForIssue(issue({ source: "scheduling" }), true, [
        "payments",
        "media",
      ]),
    ).toBe("/capacity/demand?namespaces=payments%2Cmedia");
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
