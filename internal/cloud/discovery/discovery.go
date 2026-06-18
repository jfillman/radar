// Package discovery scans the cluster for observability-vendor
// signatures and produces a Report the cloud upstream uses to badge + prefill the
// SPA Catalog cards.
//
// Mental model: radar is a discovery oracle. It does NOT own the
// integration; the user still installs it through the cloud upstream's normal flow.
// We just save them N field-fills by pre-populating what we can pull
// from their cluster's own Secrets/CRs.
//
// Trust boundary: every value here came from a Secret/CR the customer's
// own RBAC already let radar read. Returning it to the customer's SPA
// (via their hub, sealed on Install) doesn't widen anything.
package discovery

import (
	"context"
	"time"
)

// perProbeTimeout bounds each probe individually so one slow vendor probe
// (e.g. a cluster-wide List on a large cluster) can't exhaust a single
// shared sweep deadline and starve the probes that run after it.
const perProbeTimeout = 15 * time.Second

// Hit is one detected installation of a catalog type in this cluster.
//
// `Prefill` is keyed by the catalog entry's config-schema property name
// (e.g. "site", "api_key"). The SPA's IntegrationFormDialog reads these
// when opening Install, dropping each value into the matching field.
//
// `Evidence` is human-readable copy the SPA renders next to the badge so
// the user can sanity-check what radar found before clicking Install.
type Hit struct {
	// Types is the list of catalog entry ids this vendor detection
	// flags. Same vendor can have multiple catalog entries (handler vs
	// vendor-MCP-proxy); we flag all of them so the SPA shows a Detected
	// chip on every applicable card. The customer picks which to install.
	Types    []string          `json:"types"`
	Variant  string            `json:"variant,omitempty"`
	Evidence string            `json:"evidence"`
	Prefill  map[string]string `json:"prefill"`
}

// Report is the per-cluster discovery payload pushed from radar to the cloud upstream.
type Report struct {
	ClusterID   string `json:"cluster_id"`
	ClusterName string `json:"cluster_name"`
	Hits        []Hit  `json:"hits"`
}

// Probe is a single vendor-detection function. Returns nil if nothing
// was found (not an error — most clusters won't have most vendors).
type Probe func(ctx context.Context, env Env) (*Hit, error)

// Env bundles the cluster-side handles each Probe needs. We pass it in
// rather than reaching into k8s package globals so probes stay easy to
// unit-test with fakes.
type Env struct {
	ClusterID   string
	ClusterName string
	Kube        KubeReader
	Dyn         DynReader
}

// Run executes every probe in order, collects hits, and returns the
// assembled Report. A failing probe never fails the whole sweep — radar
// just logs and moves on, so one broken signature can't blind the rest.
func Run(ctx context.Context, env Env, probes []Probe, log func(string, ...any)) Report {
	// Non-nil so an empty sweep marshals as "hits": [] rather than null.
	r := Report{ClusterID: env.ClusterID, ClusterName: env.ClusterName, Hits: []Hit{}}
	for _, p := range probes {
		pctx, cancel := context.WithTimeout(ctx, perProbeTimeout)
		hit, err := p(pctx, env)
		cancel()
		if err != nil {
			if log != nil {
				log("discovery probe error: %v", err)
			}
			continue
		}
		if hit != nil {
			r.Hits = append(r.Hits, *hit)
		}
	}
	return r
}

// DefaultProbes is the curated list we run today. Order is irrelevant —
// each probe is independent.
func DefaultProbes() []Probe {
	return []Probe{
		ProbeDatadog,
		ProbeSentry,
		ProbeNewRelic,
		ProbeHoneycomb,
		ProbeDynatrace,
		ProbeCoralogix,
	}
}
