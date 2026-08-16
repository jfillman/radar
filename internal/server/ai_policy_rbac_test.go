package server

import (
	"net/http/httptest"
	"testing"

	"github.com/skyhook-io/radar/internal/auth"
	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/pkg/resourcecontext"
)

// The policy findings attached to /api/ai/* are the same rows the UI withholds
// per report family. Two surfaces over one index must answer identically about
// who may see what — the per-resource and per-policy views already drifted once,
// and an agent surface that skips the gate is the same bug with a wider blast
// radius, since it is the surface a restricted user can drive directly.

// aiPolicyAdapter builds the lookup exactly as buildAIResourceContext does, for
// a request carrying `user`.
func aiPolicyAdapter(t *testing.T, env *authTestEnv, user, namespace string) policyReportLookupAdapter {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/ai/resources/pods/"+namespace+"/web", nil)
	r = r.WithContext(auth.ContextWithUser(r.Context(), &auth.User{Username: user}))
	return policyReportLookupAdapter{
		idx:      k8s.GetPolicyReportIndex(),
		status:   k8s.GetPolicyReportStatus(),
		families: env.srv.readablePolicyReportFamilies(r, namespace),
	}
}

func TestAIResourceContext_WithholdsTheFamilyTheCallerCannotRead(t *testing.T) {
	env := newAuthTestServer(t)
	publishIndex(t,
		report("wgpolicyk8s.io", "app", "require-limits", podSubject("web"), "fail"),
		report("openreports.io", "app", "require-probes", podSubject("web"), "fail"),
	)
	perms := &auth.UserPermissions{AllowedNamespaces: []string{"app"}}
	allow(perms, "wgpolicyk8s.io", "policyreports", "app", true)
	allow(perms, "openreports.io", "reports", "app", false)
	env.srv.permCache.Set("half", perms)

	got := aiPolicyAdapter(t, env, "half", "app").FindingsFor("", "Pod", "app", "web")
	if len(got) != 1 {
		t.Fatalf("findings = %d, want 1 (only the readable family): %+v", len(got), got)
	}
	if got[0].Policy != "require-limits" {
		t.Errorf("policy = %q, want require-limits — the unreadable family leaked", got[0].Policy)
	}
}

// No findings and no explanation is indistinguishable from a clean resource.
func TestAIResourceContext_SaysDeniedRatherThanClean(t *testing.T) {
	env := newAuthTestServer(t)
	publishIndex(t, report("wgpolicyk8s.io", "app", "require-limits", podSubject("web"), "fail"))
	perms := &auth.UserPermissions{AllowedNamespaces: []string{"app"}}
	allow(perms, "wgpolicyk8s.io", "policyreports", "app", false)
	allow(perms, "openreports.io", "reports", "app", false)
	env.srv.permCache.Set("none", perms)

	a := aiPolicyAdapter(t, env, "none", "app")
	if got := a.FindingsFor("", "Pod", "app", "web"); len(got) != 0 {
		t.Fatalf("findings = %d, want 0 for a caller entitled to neither family", len(got))
	}
	reason, omitted := a.Unavailable()
	if !omitted || reason != resourcecontext.OmittedRBACDenied {
		t.Errorf("omitted=%v reason=%q, want true/%q — silence reads as compliant",
			omitted, reason, resourcecontext.OmittedRBACDenied)
	}
}

// A cluster-scoped subject is authorized against the cluster-scoped report kind,
// which is a different grant. Reading the namespaced name for it asks a question
// about a resource the finding was never in.
func TestAIResourceContext_AuthorizesClusterScopedSubjectsAgainstTheClusterKind(t *testing.T) {
	env := newAuthTestServer(t)
	publishIndex(t, report("wgpolicyk8s.io", "", "require-labels",
		map[string]any{"apiVersion": "v1", "kind": "Namespace", "name": "shop"}, "fail"))
	perms := &auth.UserPermissions{AllowedNamespaces: []string{"shop"}}
	// Granted on the namespaced kind only — which must NOT unlock the other.
	allow(perms, "wgpolicyk8s.io", "policyreports", "", true)
	allow(perms, "wgpolicyk8s.io", "clusterpolicyreports", "", false)
	allow(perms, "openreports.io", "clusterreports", "", false)
	env.srv.permCache.Set("cluster", perms)

	a := aiPolicyAdapter(t, env, "cluster", "")
	if got := a.FindingsFor("", "Namespace", "", "shop"); len(got) != 0 {
		t.Fatalf("findings = %d, want 0 — authorized against the wrong resource name: %+v", len(got), got)
	}
}

func TestAIResourceContext_KeepsEverythingForAFullyAuthorizedCaller(t *testing.T) {
	env := newAuthTestServer(t)
	publishIndex(t,
		report("wgpolicyk8s.io", "app", "require-limits", podSubject("web"), "fail"),
		report("openreports.io", "app", "require-probes", podSubject("web"), "fail"),
	)
	perms := &auth.UserPermissions{AllowedNamespaces: []string{"app"}}
	allow(perms, "wgpolicyk8s.io", "policyreports", "app", true)
	allow(perms, "openreports.io", "reports", "app", true)
	env.srv.permCache.Set("full", perms)

	a := aiPolicyAdapter(t, env, "full", "app")
	if got := a.FindingsFor("", "Pod", "app", "web"); len(got) != 2 {
		t.Fatalf("findings = %d, want 2: %+v", len(got), got)
	}
	if _, omitted := a.Unavailable(); omitted {
		t.Error("nothing was withheld, so nothing should be reported as omitted")
	}
}
