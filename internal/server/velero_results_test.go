package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

// The shape below is copied from a file Velero actually wrote on a kind cluster,
// not from the struct definition. It matters: the restore controller filed its
// cluster-scoped warning under `namespaces` with the key "cluster" rather than
// in the top-level `cluster` field, so a parser that only read the documented
// top-level buckets would have shown one warning where Velero reported two —
// and the count beside it would have said 2.
const realResultsJSON = `{
  "errors": {},
  "warnings": {
    "namespaces": {
      "cluster": ["failed to list stub VolumeGroupSnapshotContents: no matches for kind \"VolumeGroupSnapshotContent\""],
      "demo-app": ["could not restore, ConfigMap:kube-root-ca.crt already exists. Warning: the in-cluster version is different than the backed-up version"]
    }
  }
}`

func gzipped(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(body)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func serveResults(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchVeleroResultsReadsWhatVeleroWrote(t *testing.T) {
	srv := serveResults(t, gzipped(t, realResultsJSON))

	got, err := fetchVeleroResults(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(got.Warnings) != 2 {
		t.Fatalf("warnings = %d, want 2 — the count on the object says 2: %+v", len(got.Warnings), got.Warnings)
	}
	if len(got.Errors) != 0 {
		t.Errorf("errors = %d, want 0", len(got.Errors))
	}
	// Scope is kept, not flattened away: "could not restore X" against a
	// namespace is a different problem from the same words against the install.
	if got.Warnings[0].Scope != "cluster" || got.Warnings[1].Scope != "demo-app" {
		t.Errorf("scopes = %q/%q, want cluster/demo-app (sorted, so the order is stable)",
			got.Warnings[0].Scope, got.Warnings[1].Scope)
	}
}

// Errors come before warnings, and both keep a stable order across clicks. A
// list that reshuffles reads as data that changed.
func TestFetchVeleroResultsIsOrdered(t *testing.T) {
	body := `{
      "errors":   {"namespaces": {"zeta": ["e-zeta"], "alpha": ["e-alpha"]}},
      "warnings": {"velero": ["w-velero"], "cluster": ["w-cluster"], "namespaces": {"beta": ["w-beta"]}}
    }`
	srv := serveResults(t, gzipped(t, body))

	got, err := fetchVeleroResults(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(got.Errors) != 2 || got.Errors[0].Scope != "alpha" || got.Errors[1].Scope != "zeta" {
		t.Errorf("errors = %+v, want alpha then zeta", got.Errors)
	}
	// velero, then cluster, then namespaces — Velero's own order of specificity.
	wantScopes := []string{"velero", "cluster", "beta"}
	if len(got.Warnings) != len(wantScopes) {
		t.Fatalf("warnings = %+v, want %d", got.Warnings, len(wantScopes))
	}
	for i, want := range wantScopes {
		if got.Warnings[i].Scope != want {
			t.Errorf("warning %d scope = %q, want %q", i, got.Warnings[i].Scope, want)
		}
	}
}

// The URL is whatever the cluster's storage location was configured to hand out.
// That is the same trust boundary as every other field read here, but it still
// gets bounded — a results fetch has no business following a file:// or gopher://
// link out of the process.
func TestFetchVeleroResultsRefusesNonHTTP(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "gopher://example.com/", "ftp://example.com/x"} {
		if _, err := fetchVeleroResults(context.Background(), raw); err == nil {
			t.Errorf("fetching %q was allowed", raw)
		}
	}
}

// A results file that is not what it claims must fail loudly. Returning an empty
// list would render as "Velero reported 2 messages but the file holds none",
// which blames Velero for a parse failure here.
func TestFetchVeleroResultsRejectsGarbage(t *testing.T) {
	t.Run("not gzip", func(t *testing.T) {
		srv := serveResults(t, []byte("plain text, not gzip"))
		if _, err := fetchVeleroResults(context.Background(), srv.URL); err == nil {
			t.Error("a non-gzip body was accepted")
		}
	})
	t.Run("not json", func(t *testing.T) {
		srv := serveResults(t, gzipped(t, "<html>404</html>"))
		if _, err := fetchVeleroResults(context.Background(), srv.URL); err == nil {
			t.Error("a non-JSON body was accepted")
		}
	})
	t.Run("storage says no", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer srv.Close()
		if _, err := fetchVeleroResults(context.Background(), srv.URL); err == nil {
			t.Error("a 403 from object storage was treated as success")
		}
	})
}

// A run with thousands of per-item warnings must not be reported as though the
// screen showed all of them.
func TestFlattenVeleroResultReportsTruncation(t *testing.T) {
	msgs := make([]string, maxMessages+10)
	for i := range msgs {
		msgs[i] = "warning"
	}
	got, truncated := flattenVeleroResult(veleroResults{Velero: msgs})
	if !truncated {
		t.Error("truncated = false after capping the list")
	}
	if len(got) != maxMessages {
		t.Errorf("returned %d messages, want the cap of %d", len(got), maxMessages)
	}
}

// Go's default client follows redirects anywhere, including to another host.
// Radar does not always run where the cluster runs, so a storage location's URL
// is a way to point this process at a host the caller never named. Object
// storage answers a pre-signed GET directly; a redirect is not something to
// honour, and the scheme check alone does not stop one.
func TestFetchVeleroResultsDoesNotFollowRedirects(t *testing.T) {
	var elsewhereHit bool
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		elsewhereHit = true
		_, _ = w.Write(gzipped(t, realResultsJSON))
	}))
	defer elsewhere.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL, http.StatusFound)
	}))
	defer redirector.Close()

	_, err := fetchVeleroResults(context.Background(), redirector.URL)
	if err == nil {
		t.Fatal("a redirect was followed and the response accepted")
	}
	if elsewhereHit {
		t.Error("the redirect target was fetched")
	}
	// The handler collapses every fetch failure into one message for the caller,
	// so this is what reaches the server log — the only place a redirect can be
	// told apart from storage simply being unreachable.
	if !strings.Contains(err.Error(), "redirected") {
		t.Errorf("error = %q, want it to name the redirect", err)
	}
}

// awaitDownloadURL is the half of this endpoint that decides whether the reader
// is told "Velero is not answering" — the message that sends someone to look at
// the controller. Each branch below routes to a different answer, so a wrong one
// sends them to the wrong place.
func TestAwaitDownloadURL(t *testing.T) {
	req := func(status map[string]interface{}) *unstructured.Unstructured {
		obj := map[string]interface{}{
			"apiVersion": "velero.io/v1",
			"kind":       "DownloadRequest",
			"metadata":   map[string]interface{}{"name": "backup-abc", "namespace": "velero"},
		}
		if status != nil {
			obj["status"] = status
		}
		return &unstructured.Unstructured{Object: obj}
	}
	scheme := runtime.NewScheme()
	client := func(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
		return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme,
			map[schema.GroupVersionResource]string{downloadRequestGVR: "DownloadRequestList"}, objs...)
	}

	t.Run("returns the URL the controller filled in", func(t *testing.T) {
		got, err := awaitDownloadURL(context.Background(),
			client(req(map[string]interface{}{"downloadURL": "https://store.example/results.gz", "phase": "Processed"})),
			"velero", "backup-abc", time.Minute)
		if err != nil {
			t.Fatalf("await: %v", err)
		}
		if got != "https://store.example/results.gz" {
			t.Errorf("url = %q, want the one in status", got)
		}
	})

	// A controller that never fills the URL in is the case this endpoint exists
	// to report. The phase travels with the error so the log says what Velero
	// was doing rather than only that it took too long.
	t.Run("names the phase it gave up in", func(t *testing.T) {
		_, err := awaitDownloadURL(context.Background(),
			client(req(map[string]interface{}{"phase": "New"})), "velero", "backup-abc", 0)
		if err == nil {
			t.Fatal("err = nil, want a timeout once the deadline has passed")
		}
		if !strings.Contains(err.Error(), "New") {
			t.Errorf("err = %q, want the phase it was stuck in", err)
		}
	})

	// A DownloadRequest with no status at all is the controller never having
	// touched it — the strongest form of "Velero is not running". Saying
	// "still  after 20s" would lose that.
	t.Run("says so when the controller never touched it", func(t *testing.T) {
		_, err := awaitDownloadURL(context.Background(),
			client(req(nil)), "velero", "backup-abc", 0)
		if err == nil || !strings.Contains(err.Error(), "no status at all") {
			t.Errorf("err = %v, want the absent status called out", err)
		}
	})

	// A caller who can create but not read back a DownloadRequest must reach the
	// 403 branch in the handler, not the "Velero is down" one. That routing is
	// errors.IsForbidden on exactly this error, so the error has to survive
	// unwrapped.
	t.Run("passes a denial back as a denial", func(t *testing.T) {
		c := client()
		c.PrependReactor("get", "downloadrequests", func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewForbidden(
				schema.GroupResource{Group: veleroGroup, Resource: "downloadrequests"}, "backup-abc", errors.New("nope"))
		})
		_, err := awaitDownloadURL(context.Background(), c, "velero", "backup-abc", time.Minute)
		if !apierrors.IsForbidden(err) {
			t.Errorf("err = %v, want a Forbidden the handler can route to 403", err)
		}
	})

	t.Run("stops when the caller goes away", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := awaitDownloadURL(ctx, client(req(map[string]interface{}{"phase": "New"})),
			"velero", "backup-abc", time.Minute); !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	})
}
