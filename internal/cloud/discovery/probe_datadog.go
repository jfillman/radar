package discovery

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// datadogAgentGVR is the operator's primary CR. It carries the customer's
// site, cluster name, and a Secret reference for the API key — exactly
// what the cloud upstream's Datadog catalog entry needs to prefill.
var datadogAgentGVR = schema.GroupVersionResource{
	Group:    "datadoghq.com",
	Version:  "v2alpha1",
	Resource: "datadogagents",
}

// ProbeDatadog detects an installed Datadog stack by looking for a
// DatadogAgent CR. If present, it pulls non-secret config (site) and
// reports the location of the API key Secret as evidence — it does NOT
// read the Secret material. The customer pastes the key themselves
// during Install; their Datadog credentials never leave the cluster.
//
// We never prefill api_key or app_key. Reading a cluster Secret and
// shipping its plaintext to an external upstream would exfiltrate
// credentials the customer didn't explicitly consent to share.
func ProbeDatadog(ctx context.Context, env Env) (*Hit, error) {
	if env.Dyn == nil {
		return nil, nil
	}
	list, err := env.Dyn.List(ctx, datadogAgentGVR, "")
	if err != nil {
		// CRD not installed at all → not an error condition, just no
		// Datadog. Distinguishing "no CRD" from "RBAC denied" via the
		// error string is fragile; treat both as "no signal".
		return nil, nil
	}
	if list == nil || len(list.Items) == 0 {
		return nil, nil
	}

	cr := list.Items[0] // first one wins; multi-CR DD installs are unusual
	prefill := map[string]string{}

	if site, found, _ := unstructured.NestedString(cr.Object, "spec", "global", "site"); found && site != "" {
		prefill["site"] = site
	}

	secretName, _, _ := unstructured.NestedString(cr.Object, "spec", "global", "credentials", "apiSecret", "secretName")
	keyName, _, _ := unstructured.NestedString(cr.Object, "spec", "global", "credentials", "apiSecret", "keyName")

	evidence := fmt.Sprintf("DatadogAgent CR in ns/%s", cr.GetNamespace())
	if secretName != "" && keyName != "" {
		evidence += fmt.Sprintf("; api key lives in secret/%s[%s] (not read)", secretName, keyName)
	}

	return &Hit{
		Types:    []string{"datadog", "datadog_mcp"},
		Variant:  "datadog",
		Evidence: evidence,
		Prefill:  prefill,
	}, nil
}
