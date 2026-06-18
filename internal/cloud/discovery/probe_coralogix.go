package discovery

import (
	"context"
	"fmt"
	"strings"
)

// ProbeCoralogix detects Coralogix by scanning workloads for the
// well-known CORALOGIX_DOMAIN env var. The domain encodes the region
// (e.g. `us2.coralogix.com` → `us2`), which we DO prefill into the
// `region` config field. The MCP API key (Personal Key) is different
// from the in-cluster ingest key, so credential prefill is skipped.
func ProbeCoralogix(ctx context.Context, env Env) (*Hit, error) {
	if env.Kube == nil {
		return nil, nil
	}
	pods, err := env.Kube.ListPods(ctx, "")
	if err != nil || pods == nil {
		return nil, nil
	}
	type found struct{ ns, pod, domain string }
	var hits []found
	for _, p := range pods.Items {
		matched := found{ns: p.Namespace, pod: p.Name}
		for _, c := range p.Spec.Containers {
			for _, e := range c.Env {
				if e.Name == "CORALOGIX_DOMAIN" && e.Value != "" {
					matched.domain = e.Value
					break
				}
			}
			if matched.domain != "" {
				break
			}
		}
		if matched.domain != "" {
			hits = append(hits, matched)
		}
		if len(hits) >= 3 {
			break
		}
	}
	if len(hits) == 0 {
		return nil, nil
	}
	prefill := map[string]string{}
	// `us2.coralogix.com` → `us2`. Be defensive.
	if region := strings.SplitN(hits[0].domain, ".", 2)[0]; region != "" {
		prefill["region"] = region
	}
	evidence := fmt.Sprintf("CORALOGIX_DOMAIN=%q on %d workload(s); first: %s/%s",
		hits[0].domain, len(hits), hits[0].ns, hits[0].pod)
	return &Hit{
		Types:    []string{"coralogix", "coralogix_mcp"},
		Variant:  "coralogix",
		Evidence: evidence,
		Prefill:  prefill,
	}, nil
}
