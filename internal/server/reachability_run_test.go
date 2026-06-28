package server

import (
	"context"
	"testing"

	"github.com/skyhook-io/radar/internal/config"
	"github.com/skyhook-io/radar/internal/reachability"
)

// TestResolveReachabilityImage_Precedence pins the server's image resolution:
// --reachability-image config wins, then RADAR_IMAGE env, then the build default.
// (The probe-Job build, capability gate, fallback command, and timeout diagnostics
// are unit-tested in internal/reachability — the shared runner core.)
func TestResolveReachabilityImage_Precedence(t *testing.T) {
	old := reachability.DefaultImageRef
	reachability.DefaultImageRef = "ghcr.io/skyhook-io/radar:vtest"
	defer func() { reachability.DefaultImageRef = old }()

	// config wins
	s := &Server{effectiveConfig: &config.Config{ReachabilityImage: "myrepo/radar:pin"}}
	t.Setenv("RADAR_IMAGE", "env/radar:x")
	if got := s.resolveReachabilityImage(context.Background()); got != "myrepo/radar:pin" {
		t.Errorf("config should win, got %q", got)
	}
	// env next
	s = &Server{effectiveConfig: &config.Config{}}
	if got := s.resolveReachabilityImage(context.Background()); got != "env/radar:x" {
		t.Errorf("env should win when config empty, got %q", got)
	}
	// default last
	t.Setenv("RADAR_IMAGE", "")
	if got := s.resolveReachabilityImage(context.Background()); got != "ghcr.io/skyhook-io/radar:vtest" {
		t.Errorf("default should apply, got %q", got)
	}
}
