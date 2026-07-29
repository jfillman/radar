package issues

import "testing"

// A StaleSecretEnv issue is entirely derived from a referenced Secret's change
// history, so it must be dropped for callers who can't read Secrets in its
// namespace — while unrelated issues and callers with access are untouched, and
// a nil CanRead (auth off) changes nothing.
func TestApplyCrossKindEvidenceAccess_StaleSecretEnv(t *testing.T) {
	in := []Issue{
		{Reason: "StaleSecretEnv", Namespace: "team-a", Kind: "Pod", Name: "web"},
		{Reason: "CrashLoop", Namespace: "team-a", Kind: "Pod", Name: "api"},
		{Reason: "StaleSecretEnv", Namespace: "team-b", Kind: "Pod", Name: "job"},
	}

	// nil CanRead (auth off): passthrough.
	if got := applyCrossKindEvidenceAccess(in, Filters{}); len(got) != 3 {
		t.Fatalf("nil CanRead must keep all, got %d", len(got))
	}

	// Can read secrets only in team-a: the team-b StaleSecretEnv drops, team-a
	// StaleSecretEnv + the unrelated CrashLoop survive.
	f := Filters{CanRead: func(group, resource, namespace string) bool {
		return !(resource == "secrets") || namespace == "team-a"
	}}
	got := applyCrossKindEvidenceAccess(append([]Issue(nil), in...), f)
	if len(got) != 2 {
		t.Fatalf("want 2 issues (team-b StaleSecretEnv dropped), got %d: %+v", len(got), got)
	}
	for _, i := range got {
		if i.Reason == "StaleSecretEnv" && i.Namespace == "team-b" {
			t.Fatalf("StaleSecretEnv leaked for a namespace without secret read: %+v", i)
		}
	}
}
