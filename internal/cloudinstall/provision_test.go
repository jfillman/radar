package cloudinstall

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestCloudInstallValues(t *testing.T) {
	v := cloudInstallValues("wss://api.radarhq.io/agent", "k3Fg-9pA")
	cloud, _ := v["cloud"].(map[string]any)
	if cloud["enabled"] != true {
		t.Error("cloud.enabled must be true")
	}
	if cloud["url"] != "wss://api.radarhq.io/agent" {
		t.Errorf("cloud.url = %v", cloud["url"])
	}
	if cloud["clusterName"] != "k3Fg-9pA" {
		t.Errorf("cloud.clusterName must carry the cluster id, got %v", cloud["clusterName"])
	}
	if cloud["existingSecret"] != CloudTokenSecretName {
		t.Errorf("cloud.existingSecret = %v", cloud["existingSecret"])
	}
	// Token must never appear in helm values (it lives in the Secret).
	if _, ok := cloud["token"]; ok {
		t.Error("cloud.token must NOT be set in values — token goes in the Secret")
	}
	if auth, _ := v["auth"].(map[string]any); auth["mode"] != "proxy" {
		t.Errorf("auth.mode must be proxy, got %v", v["auth"])
	}
}

func TestUpsertTokenSecret_CreateThenUpdate(t *testing.T) {
	kc := fake.NewSimpleClientset()
	ctx := context.Background()

	if err := upsertTokenSecret(ctx, kc, "radar", "rhc_first"); err != nil {
		t.Fatal(err)
	}
	got, err := kc.CoreV1().Secrets("radar").Get(ctx, CloudTokenSecretName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got.StringData[cloudTokenSecretKey] != "rhc_first" {
		t.Errorf("first token = %q", got.StringData[cloudTokenSecretKey])
	}

	// Re-run with a rotated token — must update in place, not error.
	if err := upsertTokenSecret(ctx, kc, "radar", "rhc_second"); err != nil {
		t.Fatalf("upsert on existing secret must not fail: %v", err)
	}
	got, _ = kc.CoreV1().Secrets("radar").Get(ctx, CloudTokenSecretName, metav1.GetOptions{})
	if got.StringData[cloudTokenSecretKey] != "rhc_second" {
		t.Errorf("rotated token not applied, got %q", got.StringData[cloudTokenSecretKey])
	}
}

func TestEnsureNamespace(t *testing.T) {
	ctx := context.Background()
	// Missing → created.
	kc := fake.NewSimpleClientset()
	if err := ensureNamespace(ctx, kc, "radar"); err != nil {
		t.Fatal(err)
	}
	if _, err := kc.CoreV1().Namespaces().Get(ctx, "radar", metav1.GetOptions{}); err != nil {
		t.Fatalf("namespace not created: %v", err)
	}
	// Already exists → no error.
	kc2 := fake.NewSimpleClientset(&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "radar"}})
	if err := ensureNamespace(ctx, kc2, "radar"); err != nil {
		t.Fatalf("existing namespace must be a no-op: %v", err)
	}
}

func TestProvision_RequiresFields(t *testing.T) {
	kc := fake.NewSimpleClientset()
	// nil helm client but valid fields → still errors on nil helm.
	if err := Provision(context.Background(), nil, kc, ProvisionConfig{Token: "t", CloudURL: "u", ClusterID: "c"}); err == nil {
		t.Error("expected error on nil helm client")
	}
}
