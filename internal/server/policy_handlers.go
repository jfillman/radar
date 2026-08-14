package server

import (
	"net/http"
	"sort"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/pkg/policyreports"
	"github.com/skyhook-io/radar/pkg/resourceid"
)

// The two report families Radar indexes. They share no resource names at all —
// wgpolicyk8s.io serves `policyreports` / `clusterpolicyreports`, openreports.io
// serves `reports` / `clusterreports` — and a cluster may serve either, both
// (mid-migration), or only the newer one, which is where Kyverno 1.15+ writes.
// Authorizing against one name alone asks about a resource that may not exist on
// the cluster in front of us, and the answer to that question is not the answer
// we wanted.
//
// The namespaced/cluster-scoped split matters for the same reason: a grant of
// `policyreports` cluster-wide does not imply `clusterpolicyreports`, so
// authorizing a cluster-scoped finding against the namespaced resource asks
// about the wrong object and Kubernetes answers yes to the wrong question.
var policyReportFamilies = []struct{ group, namespaced, clusterScoped string }{
	{group: "wgpolicyk8s.io", namespaced: "policyreports", clusterScoped: "clusterpolicyreports"},
	{group: "openreports.io", namespaced: "reports", clusterScoped: "clusterreports"},
}

// policyReportResource picks the resource a finding about this namespace would
// have been read from. An empty namespace means a cluster-scoped subject, whose
// findings live in the cluster-scoped report kind.
func policyReportResource(family struct{ group, namespaced, clusterScoped string }, namespace string) string {
	if namespace == "" {
		return family.clusterScoped
	}
	return family.namespaced
}

// readablePolicyReportFamilies reports which families this identity may read at
// the scope implied by namespace. Empty means none, which is a denial.
func (s *Server) readablePolicyReportFamilies(r *http.Request, namespace string) map[string]bool {
	out := map[string]bool{}
	for _, f := range policyReportFamilies {
		if s.canRead(r, f.group, policyReportResource(f, namespace), namespace, "list") {
			out[f.group] = true
		}
	}
	return out
}

// canReadPolicyReports reports whether this identity may read policy results in
// the namespace. Permission on EITHER family is enough: the findings are merged
// from whichever families are served, so being able to read the one that
// actually carries data is what matters.
func (s *Server) canReadPolicyReports(r *http.Request, namespace string) bool {
	return len(s.readablePolicyReportFamilies(r, namespace)) > 0
}

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
	// WithheldByFamily is how many findings were dropped because they came only
	// from a report family this caller cannot read. Counts exclude them too:
	// a total the caller is not entitled to see is not a total we can show.
	WithheldByFamily int `json:"withheldByFamily,omitempty"`
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
	families := s.readablePolicyReportFamilies(r, namespace)
	if len(families) == 0 {
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
	outcomes := index.SourcedFindingsFor(group, goKind, namespace, name)
	if len(outcomes) == 0 && group != "" {
		outcomes = index.SourcedFindingsFor("", goKind, namespace, name)
	}

	for _, o := range outcomes {
		// Same provenance filter as the per-policy view. Being authorized on one
		// family says nothing about the other, and the index merges both — so
		// without this the two views disagree about what this identity may see.
		if !outcomeReadable(o, families) {
			resp.WithheldByFamily++
			continue
		}
		f := o.Finding
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

// maxPolicyCoverageSubjects bounds the per-rule subject list.
//
// Deliberately high. The UI folds the list at ten and expands in place, which is
// the house pattern for related resources, and that pattern is only honest if
// the client actually holds everything it offers to show. This is the backstop
// for a policy matching a whole large cluster, not the display limit — and when
// it does bite, the response says so rather than quietly shortening the list.
// Counts are always exact regardless.
const maxPolicyCoverageSubjects = 200

// maxPolicyCoverageSubjectsHard is the ceiling `?limit=` may raise the list to.
//
// The default exists so an ordinary drawer open stays small; it must not be a
// wall. When the reader asks to see the rest, the list is re-fetched at a
// higher bound rather than pointing them at a view that cannot filter by
// policy. This ceiling is what stops a policy matching a 50k-object cluster
// from serializing all of it into one drawer.
const maxPolicyCoverageSubjectsHard = 5000

// coverageLimit reads ?limit=, clamped. An unparseable or absent value keeps
// the default rather than failing the request — the list is a display concern
// and the counts beside it are exact either way.
func coverageLimit(raw string) int {
	if raw == "" {
		return maxPolicyCoverageSubjects
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return maxPolicyCoverageSubjects
	}
	if n > maxPolicyCoverageSubjectsHard {
		return maxPolicyCoverageSubjectsHard
	}
	return n
}

// PolicyCoverageSubject is one resource this policy recorded an outcome for.
type PolicyCoverageSubject struct {
	Group     string `json:"group,omitempty"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	Result    string `json:"result"`
	Message   string `json:"message,omitempty"`
	// Autogen marks a subject matched through a rule Kyverno synthesised from
	// an authored Pod rule. The UI folds these into the parent rule; the flag
	// exists so it can still say the match came via a controller.
	Autogen bool `json:"autogen,omitempty"`
}

// PolicyCoverageRule groups a policy's outcomes under one authored rule.
// Rule is empty for the modern CEL families, which have no named rules.
type PolicyCoverageRule struct {
	Rule      string                  `json:"rule"`
	Counts    PolicyResourceCounts    `json:"counts"`
	Subjects  []PolicyCoverageSubject `json:"subjects"`
	Total     int                     `json:"total"`
	Truncated bool                    `json:"truncated,omitempty"`
	// HiddenByFilter is how many of Total the namespace view filter held back.
	// Counts still describe every outcome, so the two must be read together.
	HiddenByFilter int `json:"hiddenByFilter,omitempty"`
	// HiddenNotable is the non-passing part of HiddenByFilter. Subjects are
	// listed only when they are non-passing, so without this split the client
	// cannot tell a row the server cap removed from one the view filter held
	// back — and blames the cap, offering to load subjects that no higher limit
	// will ever return.
	HiddenNotable int `json:"hiddenNotable,omitempty"`
}

// PolicyCoverageResponse answers "what did this policy decide about the
// cluster". It carries the same partial-knowledge contract as
// PolicyResourceResponse, plus one the per-resource view never needed: a
// resource may be missing because the caller cannot read its namespace, so an
// absent subject is not evidence of absence.
type PolicyCoverageResponse struct {
	Evaluated    bool     `json:"evaluated"`
	Status       string   `json:"status"`
	ReasonCode   string   `json:"reasonCode,omitempty"`
	DeniedGroups []string `json:"deniedGroups,omitempty"`
	LiveUpdates  bool     `json:"liveUpdates"`
	// Policy is the report-side name that matched, so the UI can show which
	// shape resolved (a namespaced policy reports as "namespace/name").
	Policy string               `json:"policy"`
	Counts PolicyResourceCounts `json:"counts"`
	// ScopeNamespaces counts namespaces represented in the returned subjects;
	// WithheldNamespaces counts those the caller may not read. The headline
	// states scope before numbers, so both are needed to write it.
	ScopeNamespaces    int  `json:"scopeNamespaces"`
	WithheldNamespaces int  `json:"withheldNamespaces"`
	ClusterScoped      bool `json:"clusterScoped,omitempty"`
	// WithheldClusterScoped is separate from WithheldNamespaces: a cluster-scoped
	// subject has no namespace to name.
	WithheldClusterScoped bool `json:"withheldClusterScoped,omitempty"`
	// UnreadableFamilies are report families the CALLER cannot read, distinct from
	// DeniedGroups, which are the ones radar's own probe could not read. Their
	// results are dropped rather than merged, so naming the families is what
	// turns a smaller number into an explained one.
	UnreadableFamilies []string `json:"unreadableFamilies,omitempty"`
	// Examined is how many outcomes back these counts, so the numbers read as a
	// bounded subset rather than an implied cluster total.
	Examined int `json:"examined"`
	// HiddenByFilter is how many subjects the namespace view filter held back
	// across all rules. Counts are unaffected by the filter.
	HiddenByFilter int `json:"hiddenByFilter,omitempty"`
	// WithheldByFamily is how many outcomes were dropped because they came only
	// from a report family this caller cannot read. Unlike HiddenByFilter these
	// are excluded from the counts too — they are not the caller's to see.
	WithheldByFamily int `json:"withheldByFamily,omitempty"`
	// Engines are the normalized engines that wrote these results. More than
	// one means the policy name is ambiguous across producers and the view
	// must not claim it all belongs to Kyverno.
	Engines []string             `json:"engines,omitempty"`
	Rules   []PolicyCoverageRule `json:"rules"`
}

// handlePolicyCoverage returns every resource a policy recorded an outcome for.
// GET /api/policy/policies/{policy}   (optional ?namespace= for namespaced policies)
//
// The inverse of handlePolicyResource. Kyverno writes a bare name for
// cluster-scoped policies and "namespace/name" for namespaced ones, so a lookup
// on the object's metadata.name alone silently returns nothing for every
// namespaced Policy — both shapes are tried.
func (s *Server) handlePolicyCoverage(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	policy := chi.URLParam(r, "policy")
	if policy == "" {
		s.writeError(w, http.StatusBadRequest, "policy name is required")
		return
	}
	namespace := r.URL.Query().Get("namespace")
	limit := coverageLimit(r.URL.Query().Get("limit"))

	status := k8s.GetPolicyReportStatus()
	resp := PolicyCoverageResponse{
		Status:       string(status.Status),
		ReasonCode:   status.ReasonCode,
		DeniedGroups: status.DeniedGroups,
		LiveUpdates:  status.LiveUpdates,
		Policy:       policy,
		Rules:        []PolicyCoverageRule{},
	}

	index := k8s.GetPolicyReportIndex()
	if index == nil || status.Status != k8s.KyvernoStatusReady {
		s.writeJSON(w, resp)
		return
	}

	// Qualified first when a namespace is known. Kyverno permits a ClusterPolicy
	// and a namespaced Policy to share a name, and resolving the bare name first
	// would show the cluster-scoped policy's coverage on the namespaced one's page
	// — wrong data, with nothing on screen to reveal the substitution.
	//
	// And when the policy HAS a namespace, the qualified key is the only correct
	// one — falling back to the bare name would hand a namespaced Policy with no
	// reports yet whatever a same-named ClusterPolicy recorded, with nothing on
	// screen to say so. An empty view is the honest answer there.
	var outcomes []policyreports.PolicyOutcome
	if namespace != "" {
		qualified := namespace + "/" + policy
		outcomes = index.OutcomesForPolicy(qualified)
		if len(outcomes) > 0 {
			resp.Policy = qualified
		}
	} else {
		outcomes = index.OutcomesForPolicy(policy)
	}

	// Authorization is decided per subject scope and memoized: a policy spanning
	// 40 namespaces would otherwise run 40 SubjectAccessReviews per request.
	//
	// Per SUBJECT, not per policy. A ClusterPolicy has no namespace of its own,
	// and asking the question once against "" gates the whole view on
	// cluster-scoped permission — which withholds every finding from a
	// namespace-restricted caller, including the ones in their own namespace
	// that they are entitled to see.
	allowed := map[string]map[string]bool{}
	familiesIn := func(ns string) map[string]bool {
		if v, ok := allowed[ns]; ok {
			return v
		}
		v := s.readablePolicyReportFamilies(r, ns)
		allowed[ns] = v
		return v
	}

	resp.Evaluated = true

	// The header's namespace filter is a DISPLAY preference, not an authorization
	// one — hence the RBAC note above. It still has to apply here, because a
	// cluster-wide policy list is otherwise dominated by kube-system and the
	// engine's own namespace: on a stock cluster roughly three quarters of policy
	// reports describe infrastructure the user neither owns nor can fix, and the
	// per-rule cap is exhausted before their own workloads appear.
	//
	// Counts stay cluster-true so the headline never shrinks to match the filter;
	// only the listed subjects are narrowed, and HiddenByFilter says how many were
	// held back.
	viewFilter := map[string]bool{}
	for _, ns := range s.parseNamespacesForUser(r) {
		viewFilter[ns] = true
	}

	byRule := map[string]*PolicyCoverageRule{}
	ruleOrder := []string{}
	namespaces := map[string]bool{}
	withheld := map[string]bool{}
	engines := map[string]bool{}

	unreadable := map[string]bool{}
	for _, o := range outcomes {
		families := familiesIn(o.Subject.Namespace)
		// No family readable at this subject's scope at all — a permission
		// answer about the namespace, which is what the scope note reports.
		if len(families) == 0 {
			// A cluster-scoped subject has no namespace, so counting it as one
			// would make the UI report "1 namespace is not shown" about something
			// that never had a namespace.
			if o.Subject.Namespace == "" {
				resp.WithheldClusterScoped = true
			} else {
				withheld[o.Subject.Namespace] = true
			}
			continue
		}
		// Provenance filter. An outcome seen in both families is readable by a
		// caller authorized on either; one carrying no group at all predates the
		// provenance tracking and is withheld rather than guessed at.
		if !outcomeReadable(o, families) {
			resp.WithheldByFamily++
			for _, g := range o.Groups {
				if !families[g] {
					unreadable[g] = true
				}
			}
			continue
		}
		if o.Subject.Namespace == "" {
			resp.ClusterScoped = true
		} else {
			namespaces[o.Subject.Namespace] = true
		}
		engines[string(o.Finding.Engine())] = true

		base, autogen := policyreports.BaseRule(o.Finding.Rule)
		bucket, ok := byRule[base]
		if !ok {
			bucket = &PolicyCoverageRule{Rule: base, Subjects: []PolicyCoverageSubject{}}
			byRule[base] = bucket
			ruleOrder = append(ruleOrder, base)
		}
		bucket.Counts.count(o.Finding.Result)
		bucket.Total++
		// Counted before the view filter is applied, deliberately. The filter is a
		// display preference; letting it shrink the totals would make the headline
		// silently describe the user's current filter while reading like a
		// statement about the cluster.
		resp.Counts.count(o.Finding.Result)

		// Cluster-scoped subjects have no namespace to filter on and are always
		// relevant, so they are never hidden by a namespace view filter.
		if len(viewFilter) > 0 && o.Subject.Namespace != "" && !viewFilter[o.Subject.Namespace] {
			bucket.HiddenByFilter++
			if !isPolicyPassResult(o.Finding.Result) {
				bucket.HiddenNotable++
			}
			resp.HiddenByFilter++
			continue
		}
		bucket.Subjects = append(bucket.Subjects, PolicyCoverageSubject{
			Group:     o.Subject.Group,
			Kind:      o.Subject.Kind,
			Namespace: o.Subject.Namespace,
			Name:      o.Subject.Name,
			Result:    o.Finding.Result,
			Message:   o.Finding.Message,
			Autogen:   autogen,
		})
	}

	resp.Examined = resp.Counts.Pass + resp.Counts.Fail + resp.Counts.Warn + resp.Counts.Error + resp.Counts.Skip
	resp.ScopeNamespaces = len(namespaces)
	resp.WithheldNamespaces = len(withheld)
	for e := range engines {
		resp.Engines = append(resp.Engines, e)
	}
	sort.Strings(resp.Engines)

	sort.Strings(ruleOrder)
	// Reported per caller, from what was actually withheld — not from what
	// radar's own probe could reach. A family the caller cannot read but which
	// carried nothing they asked for is not worth mentioning.
	for _, f := range policyReportFamilies {
		if unreadable[f.group] {
			resp.UnreadableFamilies = append(resp.UnreadableFamilies, f.group)
		}
	}

	for _, name := range ruleOrder {
		bucket := byRule[name]
		// Worst first so a truncated list never hides a failure behind passes.
		sort.SliceStable(bucket.Subjects, func(i, j int) bool {
			ri, rj := policyResultRank(bucket.Subjects[i].Result), policyResultRank(bucket.Subjects[j].Result)
			if ri != rj {
				return ri < rj
			}
			if bucket.Subjects[i].Namespace != bucket.Subjects[j].Namespace {
				return bucket.Subjects[i].Namespace < bucket.Subjects[j].Namespace
			}
			return bucket.Subjects[i].Name < bucket.Subjects[j].Name
		})
		if len(bucket.Subjects) > limit {
			bucket.Subjects = bucket.Subjects[:limit]
			bucket.Truncated = true
		}
		resp.Rules = append(resp.Rules, *bucket)
	}

	s.writeJSON(w, resp)
}

// outcomeReadable reports whether the caller may see an outcome, based on the
// report families it was read from.
func outcomeReadable(o policyreports.PolicyOutcome, readable map[string]bool) bool {
	if len(o.Groups) == 0 {
		return false
	}
	for _, g := range o.Groups {
		if readable[g] {
			return true
		}
	}
	return false
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
