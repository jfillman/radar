package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Pusher ships a Report to the cloud upstream's discovery ingest endpoint.
//
// Auth: a static bearer token shared via env (HUB_INTEGRATIONS_DISCOVERY_TOKEN
// on both sides). This is the demo-only auth. The production path will
// piggyback on the existing yamux cloud tunnel — radar already
// authenticates there per-cluster, so the cloud upstream knows which (org, cluster)
// a discovery report belongs to without a separate token. Until that
// land, the demo path keeps the auth shape (Bearer token) so we can swap
// the transport later without touching probes/handlers.
type Pusher struct {
	UpstreamURL    string // e.g. http://host.docker.internal:8080/api/internal/discovery
	Token     string
	Client    *http.Client
	UserAgent string
}

// New returns a Pusher with sensible defaults. The 10s timeout matches
// what we use elsewhere for outbound HTTP from the agent — long enough
// for a cold hub on a tired laptop, short enough that a stuck request
// doesn't pile up behind the discovery ticker.
func New(hubURL, token string) *Pusher {
	return &Pusher{
		UpstreamURL:    strings.TrimRight(hubURL, "/"),
		Token:     token,
		Client:    &http.Client{Timeout: 10 * time.Second},
		UserAgent: "radar-discovery/1",
	}
}

// Push sends one Report. Returns a wrapped error so the caller can log
// "discovery push failed: %v" without losing detail.
func (p *Pusher) Push(ctx context.Context, r Report) error {
	if p.UpstreamURL == "" {
		return fmt.Errorf("discovery: upstream URL is empty")
	}
	body, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("marshal report: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.UpstreamURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", p.UserAgent)
	if p.Token != "" {
		req.Header.Set("Authorization", "Bearer "+p.Token)
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("hub returned %s", resp.Status)
	}
	return nil
}
