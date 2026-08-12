package server

import (
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/pkg/resourceid"
)

// The report family authorization is checked against. Both wgpolicyk8s.io and
// openreports.io carry the same resource name, and a caller who can read one
// family in a namespace can in practice read the other, so a single check is
// enough to answer "may this identity see policy results here".
const (
	policyReportGroup    = "wgpolicyk8s.io"
	policyReportResource = "policyreports"
)

// PolicyResourceFinding is one rule outcome for one resource, as rendered.
type PolicyResourceFinding struct {
	Policy   string `json:"policy"`
	Rule     string `json:"rule,omitempty"`
	Result   string `json:"result"`
	Severity string `json:"severity,omitempty"`
	Category string `json:"category,omitempty"`
	Message  string `json:"message,omitempty"`
	// Engine is the normalized producer ("kyverno", "trivy", …). A single
	// report stream carries several raw source strings for one engine, so the
	// raw value is deliberately not what the UI groups on.
	Engine string `json:"engine,omitempty"`
}

// PolicyResourceCounts is the pass/fail breakdown for the resource.
type PolicyResourceCounts struct {
	Pass  int `json:"pass"`
	Fail  int `json:"fail"`
	Warn  int `json:"warn"`
	Error int `json:"error"`
	Skip  int `json:"skip"`
}

// PolicyResourceResponse deliberately reports coverage alongside the findings.
//
// An empty finding list means at least four different things — nothing is
// violated, the engine is not installed, the caller may not read the reports,
// or the index has not warmed up — and a section that renders all four as blank
// space tells the operator "you are compliant" in three cases where we do not
// know that. Status/ReasonCode/DeniedGroups exist so the UI can say which.
type PolicyResourceResponse struct {
	// Evaluated is false whenever the answer is "we could not check", so a
	// consumer that reads nothing else still cannot mistake it for "clean".
	Evaluated  bool   `json:"evaluated"`
	Status     string `json:"status"`
	ReasonCode string `json:"reasonCode,omitempty"`
	// DeniedGroups are report families the caller's identity could not read.
	// Present even on a `ready` status: the index is real but incomplete.
	DeniedGroups []string `json:"deniedGroups,omitempty"`
	// LiveUpdates is false when the index is frozen at its initial contents.
	LiveUpdates bool                    `json:"liveUpdates"`
	Counts      PolicyResourceCounts    `json:"counts"`
	Findings    []PolicyResourceFinding `json:"findings"`
}

// handlePolicyResource returns the policy findings for a single resource.
// GET /api/policy/resource/{kind}/{namespace}/{name}
//
// Mirrors handleAuditResource's shape and kind resolution so the two
// per-resource drill-downs cannot drift on how a URL plural becomes a kind.
func (s *Server) handlePolicyResource(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	kind := chi.URLParam(r, "kind")
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")

	// Authorization is an RBAC question, deliberately NOT parseNamespacesForUser.
	// That helper folds in the header's namespace *view filter*, which is a
	// display preference — denying on it would break this section for every
	// resource outside the user's current filter, reached by deep link, search
	// or topology navigation. What matters here is whether this identity may
	// read policy reports in the resource's namespace.
	//
	// A denial is a 403 rather than an empty list on purpose: an empty list
	// reads as "nothing is violated", which is a claim we have not earned.
	if !s.canRead(r, policyReportGroup, policyReportResource, namespace, "list") {
		s.writeError(w, http.StatusForbidden, "no access to policy reports in this namespace")
		return
	}

	status := k8s.GetPolicyReportStatus()
	resp := PolicyResourceResponse{
		Status:       string(status.Status),
		ReasonCode:   status.ReasonCode,
		DeniedGroups: status.DeniedGroups,
		LiveUpdates:  status.LiveUpdates,
		Findings:     []PolicyResourceFinding{},
	}

	index := k8s.GetPolicyReportIndex()
	if index == nil || status.Status != k8s.KyvernoStatusReady {
		// Not evaluated. Everything above already says why; the empty finding
		// list is not an assertion of compliance.
		s.writeJSON(w, resp)
		return
	}
	resp.Evaluated = true

	goKind := kind
	if mapped := apiResourceToKind(kind); mapped != kind {
		goKind = mapped
	}
	// Reports key their subject by the resource's own API group. Built-in kinds
	// carry theirs ("apps" for Deployment), so a bare "" lookup would miss them
	// exactly the way the audit drill-down once did.
	group := resourceid.GroupForBuiltinKind(goKind)
	findings := index.FindingsFor(group, goKind, namespace, name)
	if len(findings) == 0 && group != "" {
		findings = index.FindingsFor("", goKind, namespace, name)
	}

	for _, f := range findings {
		resp.Counts.count(f.Result)
		// Passing checks are counted but not listed: a workload matched by
		// dozens of policies would bury its two failures in a wall of green.
		// The count still proves the check ran.
		if isPolicyPassResult(f.Result) {
			continue
		}
		resp.Findings = append(resp.Findings, PolicyResourceFinding{
			Policy:   f.Policy,
			Rule:     f.Rule,
			Result:   f.Result,
			Severity: f.Severity,
			Category: f.Category,
			Message:  f.Message,
			Engine:   string(f.Engine()),
		})
	}

	// Stable order so the section does not reshuffle between polls: worst
	// result first, then policy name.
	sort.SliceStable(resp.Findings, func(i, j int) bool {
		ri, rj := policyResultRank(resp.Findings[i].Result), policyResultRank(resp.Findings[j].Result)
		if ri != rj {
			return ri < rj
		}
		return resp.Findings[i].Policy < resp.Findings[j].Policy
	})

	s.writeJSON(w, resp)
}

func (c *PolicyResourceCounts) count(result string) {
	switch normalizePolicyResult(result) {
	case "pass":
		c.Pass++
	case "fail":
		c.Fail++
	case "warn":
		c.Warn++
	case "error":
		c.Error++
	case "skip":
		c.Skip++
	}
}

// normalizePolicyResult lowercases the wgpolicy/openreports result vocabulary.
// Producers are inconsistent about case across report families.
func normalizePolicyResult(result string) string {
	switch result {
	case "pass", "Pass", "PASS":
		return "pass"
	case "fail", "Fail", "FAIL":
		return "fail"
	case "warn", "Warn", "WARN":
		return "warn"
	case "error", "Error", "ERROR":
		return "error"
	case "skip", "Skip", "SKIP":
		return "skip"
	}
	return result
}

func isPolicyPassResult(result string) bool {
	return normalizePolicyResult(result) == "pass"
}

func policyResultRank(result string) int {
	switch normalizePolicyResult(result) {
	case "error":
		return 0
	case "fail":
		return 1
	case "warn":
		return 2
	case "skip":
		return 3
	}
	return 4
}
