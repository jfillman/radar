package server

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Host renderers live in the app, and the rule they have to keep is one the app
// cannot check for itself: web's tsconfig type-checks its own tests and carries
// no Node types, so a test that reads files off disk does not compile there, and
// the shared package must not reach up into the app to inspect it. Go already
// reads frontend source for exactly this reason — see TestSetupDialogCoversAllTools
// on the MCP tool catalogue — so the guard lives on this side of the line.
const hostRenderersDir = "../../web/src/components/resources/renderers"

// A `const { ... } = useResources(...)` whose bindings are captured for inspection.
var lookupDestructure = regexp.MustCompile(
	`const\s*\{([^}]*)\}\s*=\s*use(?:Resources|RBACSubject|RBACRole|RBACNamespace|PolicyCoverage)\b`)

// Ratchet: files whose lookup destructure still discards the error.
// This set may SHRINK. It must never GROW.
var lookupErrorBaseline = map[string]string{
	"ServiceRenderer.tsx": "pre-existing: endpoint slices behind the Service Endpoints section",
	"CNPGDeclarativeRenderer.tsx": "the name resolver degrades to plain text instead of a link, " +
		"which is its documented fallback; the list beside it carries its own error note",
}

// TestReverseLookupsSurfaceTheirFailures keeps a failed or forbidden lookup from
// rendering as an established absence.
//
// A renderer that takes only `data` from its query throws the error away, and
// from that point an empty list, a denied list and a broken fetch all draw the
// same screen: "nothing here". That is a claim the page never earned, and it is
// invisible in review because the happy path looks perfect — which is why this
// is mechanical rather than a convention.
//
// When it fails because you added one: keep `error` from the hook and render
// <LookupFailureNote errors={[...]} what="..." />, passing `incomplete` when rows
// are already on screen. Hide an expected 403 only where the section is a bonus
// on someone else's page, as RBACErrorSection's callers do.
func TestReverseLookupsSurfaceTheirFailures(t *testing.T) {
	entries, err := os.ReadDir(hostRenderersDir)
	if err != nil {
		t.Fatalf("read host renderers: %v", err)
	}

	var offenders []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".tsx") || strings.HasSuffix(name, ".test.tsx") {
			continue
		}
		src, readErr := os.ReadFile(filepath.Join(hostRenderersDir, name))
		if readErr != nil {
			t.Fatalf("read %s: %v", name, readErr)
		}
		for _, m := range lookupDestructure.FindAllStringSubmatch(string(src), -1) {
			if !strings.Contains(m[1], "error") {
				offenders = append(offenders, name)
				break
			}
		}
	}
	sort.Strings(offenders)

	var added []string
	found := map[string]bool{}
	for _, o := range offenders {
		found[o] = true
		if _, allowed := lookupErrorBaseline[o]; !allowed {
			added = append(added, o)
		}
	}
	if len(added) > 0 {
		t.Errorf("these keep only `data` from a lookup, so a failed or denied fetch renders as "+
			"\"nothing here\": %s", strings.Join(added, ", "))
	}

	// Without this the baseline quietly turns into a permanent allowance.
	var stale []string
	for name := range lookupErrorBaseline {
		if !found[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("fixed — remove from lookupErrorBaseline: %s", strings.Join(stale, ", "))
	}
}
