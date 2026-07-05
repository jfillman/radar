package main

import "testing"

// TestIsKubeconfigOverrideArg pins the guard that keeps maybeResumeCloud from
// serving cluster B under context A's saved Cloud identity: any kubeconfig
// selection flag must count as an override so auto-resume declines.
func TestIsKubeconfigOverrideArg(t *testing.T) {
	overrides := []string{
		"--kubeconfig", "--kubeconfig=/tmp/kc", "-kubeconfig", "-kubeconfig=/tmp/kc",
		"--kubeconfig-dir", "--kubeconfig-dir=/tmp/kcs", "-kubeconfig-dir",
	}
	for _, a := range overrides {
		if !isKubeconfigOverrideArg(a) {
			t.Errorf("%q should be treated as a kubeconfig override", a)
		}
	}
	nonOverrides := []string{
		"--port", "--port=9300", "--namespace=foo", "--no-browser",
		"--cloud-url=wss://x", "kubeconfig", "--kube", "",
	}
	for _, a := range nonOverrides {
		if isKubeconfigOverrideArg(a) {
			t.Errorf("%q should NOT be treated as a kubeconfig override", a)
		}
	}
}
