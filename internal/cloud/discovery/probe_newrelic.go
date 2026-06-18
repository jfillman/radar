package discovery

import (
	"context"
	"fmt"
	"strings"
)

// ProbeNewRelic detects a NewRelic Infrastructure install by scanning
// pods for the well-known `newrelic/*` image prefix. Presence-only: we do
// NOT read the cluster license-key Secret. The account region (US vs EU)
// and the account-read API key are chosen by the customer at Install —
// no cluster credential ever leaves the cluster.
func ProbeNewRelic(ctx context.Context, env Env) (*Hit, error) {
	if env.Kube == nil {
		return nil, nil
	}
	pods, err := env.Kube.ListPods(ctx, "")
	if err != nil || pods == nil {
		return nil, nil
	}
	type found struct{ ns, pod, image string }
	var hits []found
	for _, p := range pods.Items {
		for _, c := range p.Spec.Containers {
			if strings.Contains(strings.ToLower(c.Image), "newrelic/") {
				hits = append(hits, found{ns: p.Namespace, pod: p.Name, image: c.Image})
				break
			}
		}
		if len(hits) >= 3 {
			break
		}
	}
	if len(hits) == 0 {
		return nil, nil
	}

	evidence := fmt.Sprintf("NewRelic agent image on %d workload(s); first: %s/%s (%s)",
		len(hits), hits[0].ns, hits[0].pod, hits[0].image)
	return &Hit{
		Types:    []string{"newrelic", "newrelic_mcp"},
		Variant:  "newrelic",
		Evidence: evidence,
		Prefill:  map[string]string{},
	}, nil
}
