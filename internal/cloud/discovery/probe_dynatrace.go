package discovery

import (
	"context"
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// dynaKubeGVRs are the GVRs the operator has published over time. Probe
// each in order; the customer's cluster has at most one.
var dynaKubeGVRs = []schema.GroupVersionResource{
	{Group: "dynatrace.com", Version: "v1beta3", Resource: "dynakubes"},
	{Group: "dynatrace.com", Version: "v1beta2", Resource: "dynakubes"},
	{Group: "dynatrace.com", Version: "v1beta1", Resource: "dynakubes"},
}

// ProbeDynatrace looks for a Dynatrace OneAgent operator CR (DynaKube)
// and extracts the environment ID from spec.apiUrl. The platform token
// the MCP needs (dt0c01.*) is NOT prefilled — the in-cluster token is
// for OneAgent ingestion, different OAuth scope; the customer mints a
// Platform Token in their Dynatrace UI for read-only MCP access.
func ProbeDynatrace(ctx context.Context, env Env) (*Hit, error) {
	if env.Dyn == nil {
		return nil, nil
	}
	var cr *unstructured.Unstructured
	for _, gvr := range dynaKubeGVRs {
		list, err := env.Dyn.List(ctx, gvr, "")
		if err != nil {
			continue
		}
		if list != nil && len(list.Items) > 0 {
			cr = &list.Items[0]
			break
		}
	}
	if cr == nil {
		return nil, nil
	}

	prefill := map[string]string{}
	apiURL, _, _ := unstructured.NestedString(cr.Object, "spec", "apiUrl")
	// `https://abc12345.live.dynatrace.com/api/v1` →
	// `abc12345`. Be defensive: never panic on unexpected shapes.
	if env := extractDynatraceEnvID(apiURL); env != "" {
		prefill["environment_id"] = env
	}

	evidence := fmt.Sprintf("DynaKube CR in ns/%s", cr.GetNamespace())
	if apiURL != "" {
		evidence += fmt.Sprintf(", apiUrl=%s", apiURL)
	}

	return &Hit{
		Types:    []string{"dynatrace", "dynatrace_mcp"},
		Variant:  "dynatrace",
		Evidence: evidence,
		Prefill:  prefill,
	}, nil
}

// extractDynatraceEnvID pulls the env subdomain out of a Dynatrace API
// URL. Returns "" for shapes we don't recognize.
func extractDynatraceEnvID(apiURL string) string {
	u := strings.TrimPrefix(apiURL, "https://")
	u = strings.TrimPrefix(u, "http://")
	host := strings.SplitN(u, "/", 2)[0]
	parts := strings.SplitN(host, ".", 2)
	if len(parts) != 2 {
		return ""
	}
	// Match the live/apps tenant patterns; ignore unknown shapes.
	if strings.HasSuffix(parts[1], "live.dynatrace.com") || strings.HasSuffix(parts[1], "apps.dynatrace.com") || strings.HasSuffix(parts[1], "dynatrace-managed.com") {
		return parts[0]
	}
	return ""
}
