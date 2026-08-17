import type React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NetworkPolicyCoverageCard } from "./NetworkPolicyCoverageCard";

// React separates adjacent text nodes with comment markers. Strip them so an
// assertion matches the text a reader sees instead of a style-attribute value
// that happens to contain the same characters.
const render = (element: React.ReactElement) =>
  renderToString(element).replaceAll("<!-- -->", "");

describe("NetworkPolicyCoverageCard", () => {
  it("shows enforced and staged preview coverage separately", () => {
    const html = render(
      <NetworkPolicyCoverageCard
        data={{
          totalPolicies: 6,
          stagedPolicies: 2,
          coveredWorkloads: 3,
          coveredWorkloadsIfStaged: 5,
          totalWorkloads: 10,
        }}
        onNavigate={() => {}}
      />,
    );

    expect(html).toContain("30%");
    expect(html).toContain("50");
    expect(html).toContain("% if staged applied)");
    expect(html).toContain("Covered workloads");
    expect(html).toContain("Covered if staged");
    expect(html).toContain("Uncovered workloads");
    expect(html).toContain("Uncovered if staged");
    expect(html).toContain("repeating-linear-gradient");
    expect(html).toContain(
      "2 more workloads covered if staged policies are applied",
    );
  });

  it("shows coverage going down when a staged policy stages a deletion", () => {
    const html = render(
      <NetworkPolicyCoverageCard
        data={{
          totalPolicies: 6,
          stagedPolicies: 1,
          coveredWorkloads: 8,
          coveredWorkloadsIfStaged: 5,
          totalWorkloads: 10,
        }}
        onNavigate={() => {}}
      />,
    );

    expect(html).toContain("80%");
    expect(html).toContain("(50% if staged applied)");
    expect(html).toContain(
      "3 workloads lose coverage if staged policies are applied",
    );
    // The projected figure must not be clamped up to today's coverage.
    expect(html).toContain("5/10");
  });

  it("keeps the original enforced-only presentation without staged policies", () => {
    const html = render(
      <NetworkPolicyCoverageCard
        data={{ totalPolicies: 2, coveredWorkloads: 2, totalWorkloads: 4 }}
        onNavigate={() => {}}
      />,
    );

    expect(html).toContain("50%");
    expect(html).not.toContain("if staged");
    expect(html).not.toContain("repeating-linear-gradient");
  });
});
