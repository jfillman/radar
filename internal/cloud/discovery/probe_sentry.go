package discovery

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// ProbeSentry detects Sentry instrumentation by the presence of SENTRY_*
// env vars on a workload. We never read the SENTRY_DSN value (it's
// credential-bearing); presence of any SENTRY_* var is enough to badge.
// SENTRY_ENVIRONMENT (a non-secret prod/staging tag) is surfaced in the
// evidence text only. `org_slug` / `auth_token` live in the customer's
// Sentry account, not the cluster, so nothing is prefilled — the badge
// just tells the user "yes you use Sentry, click here to wire it up."
func ProbeSentry(ctx context.Context, env Env) (*Hit, error) {
	if env.Kube == nil {
		return nil, nil
	}
	pods, err := env.Kube.ListPods(ctx, "")
	if err != nil {
		return nil, nil
	}
	if pods == nil || len(pods.Items) == 0 {
		return nil, nil
	}

	type instrumented struct {
		ns     string
		name   string
		envTag string
	}
	var found []instrumented
	for _, pod := range pods.Items {
		for _, c := range pod.Spec.Containers {
			rec := instrumented{ns: pod.Namespace, name: pod.Name}
			any := false
			for _, e := range c.Env {
				if !strings.HasPrefix(e.Name, "SENTRY_") {
					continue
				}
				any = true
				// Only the non-secret environment tag is captured (for
				// evidence). SENTRY_DSN's value is never read.
				if e.Name == "SENTRY_ENVIRONMENT" {
					rec.envTag = e.Value
				}
			}
			if any {
				found = append(found, rec)
				break // one record per pod is enough
			}
		}
	}
	if len(found) == 0 {
		return nil, nil
	}

	// Stable order so the evidence string doesn't churn between runs.
	sort.Slice(found, func(i, j int) bool {
		if found[i].ns != found[j].ns {
			return found[i].ns < found[j].ns
		}
		return found[i].name < found[j].name
	})

	first := found[0]
	evidence := fmt.Sprintf("SENTRY_* env vars on %d workload(s); first: %s/%s",
		len(found), first.ns, first.name)
	if first.envTag != "" {
		evidence += fmt.Sprintf(" (env=%q)", first.envTag)
	}

	return &Hit{
		Types:    []string{"sentry"},
		Variant:  "sentry",
		Evidence: evidence,
		Prefill:  map[string]string{},
	}, nil
}
