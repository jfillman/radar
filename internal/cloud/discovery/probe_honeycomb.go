package discovery

import (
	"context"
	"fmt"
	"strings"
)

// ProbeHoneycomb detects Honeycomb instrumentation by scanning pods for
// HONEYCOMB_* env vars OR images named `honeycombio/*`. We don't prefill
// the API key — the in-cluster ingestion key is sometimes the same key
// the MCP needs and sometimes a write-only ingest key, depends on how
// the customer minted it. Presence-only badge keeps us honest.
func ProbeHoneycomb(ctx context.Context, env Env) (*Hit, error) {
	if env.Kube == nil {
		return nil, nil
	}
	pods, err := env.Kube.ListPods(ctx, "")
	if err != nil || pods == nil {
		return nil, nil
	}
	type found struct{ ns, pod, reason string }
	var hits []found
	for _, p := range pods.Items {
		matched := ""
		for _, c := range p.Spec.Containers {
			if strings.Contains(strings.ToLower(c.Image), "honeycombio/") {
				matched = "image " + c.Image
			}
			for _, e := range c.Env {
				if strings.HasPrefix(e.Name, "HONEYCOMB_") {
					matched = "env " + e.Name
					break
				}
			}
			if matched != "" {
				break
			}
		}
		if matched != "" {
			hits = append(hits, found{ns: p.Namespace, pod: p.Name, reason: matched})
		}
		if len(hits) >= 3 {
			break
		}
	}
	if len(hits) == 0 {
		return nil, nil
	}
	evidence := fmt.Sprintf("Honeycomb signature on %d workload(s); first: %s/%s (%s)",
		len(hits), hits[0].ns, hits[0].pod, hits[0].reason)
	return &Hit{
		Types:    []string{"honeycomb", "honeycomb_mcp"},
		Variant:  "honeycomb",
		Evidence: evidence,
		Prefill:  map[string]string{},
	}, nil
}
