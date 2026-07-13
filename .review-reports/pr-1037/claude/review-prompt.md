You are performing an independent, READ-ONLY deep code review of skyhook-io/radar PR 1037.

Exact immutable scope:
- base: 1b9ad55632e0e72abcdd28bc4e700b7020753dad
- head: d1face5b31572eb94afcd29920b93684f42281d3
- local ref: origin/pr-1037-review
- inspect with git diff 1b9ad55632e0e72abcdd28bc4e700b7020753dad..d1face5b31572eb94afcd29920b93684f42281d3 and git show d1face5b31572eb94afcd29920b93684f42281d3:path

The current checked-out worktree is main and contains unrelated local changes to .gitignore and .design-sync. Ignore them completely. Do not review current main as if it were the PR.

Hard constraints:
- Do not modify source code, tests, configuration, git state, refs, commits, the PR, or GitHub.
- Do not run builds, tests, package installation, cluster commands, or network probes.
- The only permitted writes are Markdown review artifacts under .review-reports/pr-1037/claude/.
- Findings must be realistic correctness, security, UX, API compatibility, performance, or operability problems. Skip style nits and speculative defensive programming.
- Judge the architecture and product approach before line-level details. A clean implementation of the wrong design is still wrong.
- Do not trust existing tests or the PR description as the specification. Challenge the honesty claims independently.

You MUST delegate four independent subagents and run them in parallel where possible. Each subagent must inspect the exact ref itself and write its own self-contained report to the specified file. Tell each subagent not to return its findings only as chat text. If a subagent is unable to write, preserve its full output in the assigned file yourself before consolidation.

Subagent 1 — Kubernetes path semantics
Write: .review-reports/pr-1037/claude/01-path-semantics.md
Scope: internal/trace/entries.go, findings.go, netpol.go, egress.go, ingress_controller.go, relevant internal/k8s and pkg/k8score changes/tests. Challenge Service, Ingress and Gateway API semantics, cross-namespace references, RBAC redaction, backend/port/selector/endpoints behavior, cache readiness, branches and truncation.

Subagent 2 — probe correctness and mutation security
Write: .review-reports/pr-1037/claude/02-probe-security.md
Scope: pkg/probe, internal/trace/probes.go, internal/reachability, trace REST handlers, cmd/explorer/probe_cmd.go, image/config/Helm wiring. Challenge DNS/TCP/TLS/HTTP classification, real versus indirect vantages, SNI/Host/redirect behavior, target/path boundaries, timeouts, impersonation, Cloud role plus SSAR parity, Job security, cleanup and fallback shell commands. Independently adjudicate the existing cross-namespace name.namespace.svc and path-normalization concerns.

Subagent 3 — honesty and verdict model
Write: .review-reports/pr-1037/claude/03-honesty-model.md
Scope: internal/trace/trace.go, coverage.go, route identity and in-cluster folding, relevant tests. Build an adversarial scenario matrix across static state, outcome, confidence, skipped evidence, sibling routes/ports, partial readiness, scaled-to-zero, RBAC/cache unknowns. Look for false condemnation, overclaim, key collisions, non-idempotence, order dependence and inconsistent counts/headline/verdict/diagnosis.

Subagent 4 — UI, API, MCP and product contract
Write: .review-reports/pr-1037/claude/04-ui-contract.md
Scope: packages/k8s-ui trace/topology/workload changes, web API and WorkloadView wiring, internal/server, internal/mcp, public exports, docs. Read DESIGN.md. Review the operator journey, automatic probes, async/stale-state races, consent and errors, graph/node/edge semantics, Go-versus-TypeScript truth parity, REST/MCP auth and output parity, public package compatibility, theme/accessibility. Also identify integration risks against current main without treating unrelated main changes as PR bugs.

Every subreport must include:
1. reviewed SHAs and exact files
2. altitude/design assessment
3. numbered findings ordered by severity, each with exact PR-head file:line, concrete failure scenario, evidence and fix
4. investigated claims that were rejected or downgraded, with evidence
5. questions and coverage gaps

After all four files exist, independently inspect their evidence and the cross-area seams. Triage skeptically: do not auto-accept subagent claims. Write the final Claude report to:
.review-reports/pr-1037/claude/claude-consolidated.md

The consolidated report must include:
- exact scope and coverage
- high-level architecture/product verdict
- prioritized numbered findings with severity and file:line
- a table mapping each finding to the subreview or seam that found it
- explicit Fix, Skip, or Discuss triage for disputed/rejected claims
- cross-area risks that directory-scoped reviewers can miss
- open questions and recommended verification
- links to the four subordinate Markdown reports
- scoreboard by severity and triage outcome

Before finishing, verify all five required report files exist and are non-empty. Your final stdout response must contain only this exact style of handoff, with no findings prose: WROTE .review-reports/pr-1037/claude/claude-consolidated.md
