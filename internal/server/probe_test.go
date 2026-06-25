package server

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"k8s.io/client-go/rest"
)

// A probed Service must not be able to drive Radar's credentialed client to a
// redirect target: the client-go transport would re-attach the cluster bearer
// token + Impersonate-* headers to the followed request, leaking them to an
// attacker-chosen host. probeHTTPClient must therefore not follow redirects.
func TestProbeHTTPClientDoesNotFollowRedirects(t *testing.T) {
	var downstreamHits int32
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&downstreamHits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer downstream.Close()

	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, downstream.URL+"/stolen", http.StatusFound)
	}))
	defer proxy.Close()

	client, err := probeHTTPClient(&rest.Config{Host: proxy.URL})
	if err != nil {
		t.Fatalf("probeHTTPClient: %v", err)
	}
	resp, err := client.Get(proxy.URL + "/x")
	if err != nil {
		t.Fatalf("unexpected request error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Errorf("expected the 302 to be returned (not followed), got %d", resp.StatusCode)
	}
	if hits := atomic.LoadInt32(&downstreamHits); hits != 0 {
		t.Errorf("redirect was followed — downstream host hit %d time(s); credentials could leak", hits)
	}
}

func TestProbeNameValidation(t *testing.T) {
	valid := []string{"kube-system", "kube-dns", "my-svc", "a", "svc.with.dots", "argocd-server"}
	for _, s := range valid {
		if !probeNameRe.MatchString(s) {
			t.Errorf("expected %q to be a valid name", s)
		}
	}
	// Anything that could escape the services/{ns|name}/proxy path must be rejected.
	invalid := []string{"", "x/../../etc", "a:b", "UPPER", "-leading", "trailing-", "has space", "name/sub", "a%2f"}
	for _, s := range invalid {
		if probeNameRe.MatchString(s) {
			t.Errorf("expected %q to be rejected as a name", s)
		}
	}
}

func TestProxyStatusError(t *testing.T) {
	noEndpoints := `{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"no endpoints available for service \"x\"","reason":"ServiceUnavailable","code":503}`
	if msg, ok := proxyStatusError([]byte(noEndpoints)); !ok || msg != "No ready endpoints — this Service has no running pods behind it." {
		t.Errorf("no-endpoints: ok=%v msg=%q", ok, msg)
	}
	otherFailure := `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"dial tcp: connection refused","reason":"ServiceUnavailable"}`
	if msg, ok := proxyStatusError([]byte(otherFailure)); !ok || msg == "" {
		t.Errorf("other-failure: ok=%v msg=%q", ok, msg)
	}
	// A normal application response must NOT be treated as a proxy error.
	for _, appBody := range []string{`{"status":"ok"}`, `<html>503 from app</html>`, `{"kind":"Pod"}`, ``} {
		if _, ok := proxyStatusError([]byte(appBody)); ok {
			t.Errorf("app body %q wrongly classified as proxy error", appBody)
		}
	}
}

func TestProbePortValidation(t *testing.T) {
	valid := []string{"80", "9153", "http", "web-ui", "https"}
	for _, s := range valid {
		if !probePortRe.MatchString(s) {
			t.Errorf("expected %q to be a valid port", s)
		}
	}
	invalid := []string{"", "80:proxy/secrets", "a/b", "a:b", "port name", "this-port-name-is-way-too-long"}
	for _, s := range invalid {
		if probePortRe.MatchString(s) {
			t.Errorf("expected %q to be rejected as a port", s)
		}
	}
}
