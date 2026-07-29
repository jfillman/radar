package issues

import "strings"

func applyFilters(in []Issue, f Filters) []Issue {
	if len(f.Severities) == 0 && len(f.Kinds) == 0 {
		return in
	}
	wantSev := map[Severity]bool{}
	for _, s := range f.Severities {
		wantSev[s] = true
	}
	wantKind := map[string]bool{}
	for _, k := range f.Kinds {
		wantKind[strings.ToLower(k)] = true
	}
	out := in[:0]
	for _, i := range in {
		if len(wantSev) > 0 && !wantSev[i.Severity] {
			continue
		}
		if len(wantKind) > 0 && !wantKind[strings.ToLower(i.Kind)] {
			continue
		}
		out = append(out, i)
	}
	return out
}

func applyClusterScopedAccess(in []Issue, f Filters) []Issue {
	if f.CanReadClusterScoped == nil {
		return in
	}
	out := make([]Issue, 0, len(in))
	for _, i := range in {
		if i.Namespace != "" {
			out = append(out, i)
			continue
		}
		// Namespace-less issue: must be cluster-scoped (a namespaced
		// resource without a namespace would be invalid wire data). Don't
		// pre-gate on a static cluster-scoped kind list here: dynamically
		// discovered cluster-scoped CRDs (e.g. Karpenter NodePool), already
		// classified cluster-scoped by their emitter, would be dropped for
		// authenticated users. CanReadClusterScoped (SAR-backed) is the
		// authoritative access gate; no pre-classification is needed.
		if f.CanReadClusterScoped(i.Kind, i.Group) {
			out = append(out, i)
		}
	}
	return out
}

// applyCrossKindEvidenceAccess gates issues whose evidence exposes a kind the
// subject-reader may not be able to read. Issues are otherwise namespace-gated
// only, so a Pod-reader receives evidence a detector derived (as the cache SA)
// from a Secret / Node / etc. it references. Runs on flat rows after
// applyClusterScopedAccess. nil CanRead disables it (auth off / tests).
//
// StaleSecretEnv is entirely derived from a referenced Secret's change history
// (the Secret's existence, its data key names for envFrom consumers, and the
// rotation timing) — none of which is in the Pod's own readable spec. Drop it
// for callers who can't read Secrets in the issue's namespace.
func applyCrossKindEvidenceAccess(in []Issue, f Filters) []Issue {
	if f.CanRead == nil {
		return in
	}
	out := in[:0]
	for _, i := range in {
		if i.Reason == "StaleSecretEnv" && !f.CanRead("", "secrets", i.Namespace) {
			continue
		}
		out = append(out, i)
	}
	return out
}

// SeverityRank orders the normalized issue severity, higher = worse. Shared by
// the grouping comparators here and by the per-resource summary rollups in the
// server/MCP layers, so all three rank off one function.
func SeverityRank(s Severity) int {
	switch s {
	case SeverityCritical:
		return 3
	case SeverityWarning:
		return 2
	}
	return 0
}
