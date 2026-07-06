package trace

import (
	"testing"

	"github.com/skyhook-io/radar/pkg/probe"
)

func TestGuessConcretePath(t *testing.T) {
	cases := []struct {
		in        string
		wantPath  string
		wantGuess bool
	}{
		{"", "/", false},
		{"/", "/", false},
		{"/api", "/api", false},    // Exact / Prefix literal - verbatim
		{"api", "/api", false},     // ensures leading slash
		{"/api/.*", "/api/", true}, // regex tail stripped to leading literal
		{"/v1/[0-9]+", "/v1/", true},
		{"/shop(/.*)?", "/shop", true},
		{".*", "/", true}, // pure pattern → root guess
	}
	for _, c := range cases {
		p, g := guessConcretePath(c.in)
		if p != c.wantPath || g != c.wantGuess {
			t.Errorf("guessConcretePath(%q) = (%q,%v), want (%q,%v)", c.in, p, g, c.wantPath, c.wantGuess)
		}
	}
}

func TestSchemeForPort(t *testing.T) {
	cases := []struct {
		port PortMap
		want string
	}{
		{PortMap{Port: 80}, "http"},
		{PortMap{Port: 8080}, "http"},
		{PortMap{Port: 443}, "https"},
		{PortMap{Port: 8443, AppProtocol: "https"}, "https"},
		{PortMap{Port: 8443, AppProtocol: "HTTPS2"}, "https"},
		{PortMap{Port: 9000, Name: "https-alt"}, "https"},
		{PortMap{Port: 9000, Name: "http2"}, "http"}, // http2 is not https
	}
	for _, c := range cases {
		if got := schemeForPort(c.port); got != c.want {
			t.Errorf("schemeForPort(%+v) = %q, want %q", c.port, got, c.want)
		}
	}
}

func TestConcreteHost(t *testing.T) {
	if got := concreteHost("*.example.com"); got != "www.example.com" {
		t.Errorf("wildcard host = %q, want www.example.com", got)
	}
	if got := concreteHost("shop.example.com"); got != "shop.example.com" {
		t.Errorf("concrete host changed = %q", got)
	}
	if got := concreteHost(""); got != "" {
		t.Errorf("empty host = %q, want empty", got)
	}
}

// A Service subject (no route, single port) gets a root request, scheme from its
// port. An https-named port yields an https guess.
func TestBuildRoutes_AttachesInClusterRequest_ServiceSubject(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Service", Namespace: "prod", Name: "api"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Service", Name: "api"}, Edge: "entry:Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 443, Name: "https"}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Port: 443, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy}}},
			{Resource: ResourceRef{Kind: "Pods"}, Edge: "Service->Pods"},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 || tr.Routes[0].InClusterRequest == nil {
		t.Fatalf("want 1 route with an in-cluster request, got %+v", tr.Routes)
	}
	req := tr.Routes[0].InClusterRequest
	if req.Scheme != "https" || req.Path != "/" || req.PathGuessed {
		t.Errorf("service-subject request = %+v, want https / not-guessed", req)
	}
}

// An Ingress route whose path is a regex pattern produces a guessed concrete
// path on the route's in-cluster request, with the declared host as the Host
// header and scheme from the BACKEND service port (plain http here).
func TestBuildRoutes_AttachesInClusterRequest_RegexRoute(t *testing.T) {
	tr := &Trace{
		Subject:  ResourceRef{Kind: "Ingress", Name: "shop"},
		BrokenAt: -1,
		Downstream: []Hop{
			{Resource: ResourceRef{Kind: "Ingress", Name: "shop"}, Edge: "entry:Ingress",
				Config: &HopConfig{Hostnames: []string{"shop.example.com"}, Rules: []RouteRule{
					{Hosts: []string{"shop.example.com"}, Paths: []string{"/api/.*"}, Backends: []BackendRef{{Kind: "Service", Name: "api"}}},
				}}},
			{Resource: ResourceRef{Kind: "Service", Name: "api"}, Edge: "Ingress->Service",
				Config: &HopConfig{Ports: []PortMap{{Port: 8080}}},
				Probes: []probe.Result{{Layer: probe.LayerHTTP, Port: 8080, Path: probe.PathData, OK: true, Tone: probe.ToneHealthy}}},
		},
	}
	computeCoverage(tr)
	if len(tr.Routes) != 1 || tr.Routes[0].InClusterRequest == nil {
		t.Fatalf("want 1 route with an in-cluster request, got %+v", tr.Routes)
	}
	req := tr.Routes[0].InClusterRequest
	if req.Scheme != "http" || req.Host != "shop.example.com" || req.Path != "/api/" || !req.PathGuessed {
		t.Errorf("regex-route request = %+v, want http shop.example.com /api/ guessed", req)
	}
}
