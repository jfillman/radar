package resourcecontextrefs

import (
	"testing"

	"github.com/skyhook-io/radar/internal/k8s"
)

func TestAppReferencesFromEnvChecks(t *testing.T) {
	if got := AppReferencesFromEnvChecks(nil, nil); got != nil {
		t.Fatalf("empty checks should return nil, got %+v", got)
	}

	got := AppReferencesFromEnvChecks([]k8s.EnvServiceRefCheck{{
		Status:           "port_mismatch",
		Container:        "app",
		EnvName:          "PAYMENTS_URL",
		Value:            "http://payments:8080?password=supersecret",
		ServiceNamespace: "shop",
		ServiceName:      "payments",
		ReferencedPort:   8080,
		ServicePorts:     []string{"80/TCP"},
		Message:          "env var references Service port 8080 with password=supersecret, but Service exposes 80/TCP",
	}}, nil)
	if got == nil || len(got.ServiceEnv) != 1 {
		t.Fatalf("expected one service env reference, got %+v", got)
	}
	ref := got.ServiceEnv[0]
	if ref.Status != "port_mismatch" || ref.Container != "app" || ref.Env != "PAYMENTS_URL" {
		t.Fatalf("basic fields not mapped correctly: %+v", ref)
	}
	if ref.Value == "http://payments:8080?password=supersecret" || ref.Message == "env var references Service port 8080 with password=supersecret, but Service exposes 80/TCP" {
		t.Fatalf("secret-bearing value/message were not redacted: %+v", ref)
	}
	if ref.Service.Kind != "Service" || ref.Service.Namespace != "shop" || ref.Service.Name != "payments" {
		t.Fatalf("service ref not mapped correctly: %+v", ref.Service)
	}
	if ref.ReferencedPort != 8080 || len(ref.ServicePorts) != 1 || ref.ServicePorts[0] != "80/TCP" || ref.Message == "" {
		t.Fatalf("detail fields not mapped correctly: %+v", ref)
	}
}

func TestAppReferencesFromEnvChecks_DuplicateEnv(t *testing.T) {
	got := AppReferencesFromEnvChecks(nil, []k8s.DuplicateEnvVarCheck{{
		Container:         "app",
		EnvName:           "API_TOKEN",
		LastDeclaredValue: "password=second-secret",
		Occurrences: []k8s.DuplicateEnvVarOccurrence{
			{Position: 1, Value: "password=first-secret"},
			{Position: 3, Value: "password=second-secret"},
		},
		Message: "API_TOKEN appears twice: password=first-secret then password=second-secret",
	}})
	if got == nil || len(got.DuplicateEnv) != 1 {
		t.Fatalf("expected one duplicate env reference, got %+v", got)
	}
	ref := got.DuplicateEnv[0]
	if ref.Container != "app" || ref.Env != "API_TOKEN" || ref.Count != 2 {
		t.Fatalf("basic fields not mapped correctly: %+v", ref)
	}
	if len(ref.Occurrences) != 2 || ref.Occurrences[0].Position != 1 || ref.Occurrences[1].Position != 3 {
		t.Fatalf("occurrences not mapped correctly: %+v", ref.Occurrences)
	}
	if ref.Occurrences[0].Value == "password=first-secret" || ref.Occurrences[1].Value == "password=second-secret" || ref.LastDeclaredValue == "password=second-secret" || ref.Message == "API_TOKEN appears twice: password=first-secret then password=second-secret" {
		t.Fatalf("duplicate env values/message were not redacted: %+v", ref)
	}
}

func TestAppReferencesFromEnvChecks_BoundsDuplicateOccurrences(t *testing.T) {
	checks := []k8s.DuplicateEnvVarCheck{{
		Container:         "app",
		EnvName:           "MODE",
		LastDeclaredValue: "seven",
		Message:           "7 declarations; ... and 2 more; last definition seven",
	}}
	for i, value := range []string{"one", "two", "three", "four", "five", "six", "seven"} {
		checks[0].Occurrences = append(checks[0].Occurrences, k8s.DuplicateEnvVarOccurrence{Position: i + 1, Value: value})
	}

	got := AppReferencesFromEnvChecks(nil, checks)
	if got == nil || len(got.DuplicateEnv) != 1 {
		t.Fatalf("expected one duplicate env reference, got %+v", got)
	}
	ref := got.DuplicateEnv[0]
	if ref.Count != 7 || len(ref.Occurrences) != 5 || ref.Occurrences[4].Position != 5 || ref.LastDeclaredValue != "seven" {
		t.Fatalf("unexpected bounded duplicate reference: %+v", ref)
	}
}
