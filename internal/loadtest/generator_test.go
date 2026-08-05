package loadtest

import (
	"context"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/tools/cache"
)

func TestAppsForAndPodsInApp(t *testing.T) {
	cases := []struct {
		pods, perApp, wantApps int
	}{
		{0, 200, 0},
		{1, 200, 1},
		{200, 200, 1},
		{201, 200, 2},
		{50000, 200, 250},
	}
	for _, c := range cases {
		if got := appsFor(c.pods, c.perApp); got != c.wantApps {
			t.Errorf("appsFor(%d,%d)=%d want %d", c.pods, c.perApp, got, c.wantApps)
		}
	}
	// pod distribution sums back to the total
	perApp, total := 200, 50000
	sum := 0
	for j := 0; j < appsFor(total, perApp); j++ {
		sum += podsInApp(j, total, perApp)
	}
	if sum != total {
		t.Fatalf("podsInApp sum=%d want %d", sum, total)
	}
}

func TestSeedObjectsTopology(t *testing.T) {
	g := New(Config{Pods: 1005, Nodes: 5, Namespaces: 3, PodsPerApp: 100})
	objs := g.SeedObjects()

	var pods, deploys, rss, svcs, nodes, nss, cms, secrets int
	deployUIDs := map[string]bool{}
	rsUIDs := map[string]bool{}
	for _, o := range objs {
		switch v := o.(type) {
		case *corev1.ConfigMap:
			cms++
		case *corev1.Secret:
			secrets++
		case *appsv1.Deployment:
			deploys++
			deployUIDs[string(v.UID)] = true
		case *appsv1.ReplicaSet:
			rss++
			rsUIDs[string(v.UID)] = true
			if len(v.OwnerReferences) != 1 || !deployUIDs[string(v.OwnerReferences[0].UID)] {
				t.Fatalf("replicaset %s not owned by a generated deployment", v.Name)
			}
		case *corev1.Pod:
			pods++
			if len(v.OwnerReferences) != 1 || v.OwnerReferences[0].Kind != "ReplicaSet" || !rsUIDs[string(v.OwnerReferences[0].UID)] {
				t.Fatalf("pod %s not owned by a generated replicaset", v.Name)
			}
			if v.Spec.NodeName == "" {
				t.Fatalf("pod %s not scheduled to a node", v.Name)
			}
		case *corev1.Service:
			svcs++
		case *corev1.Node:
			nodes++
		case *corev1.Namespace:
			nss++
		}
	}

	wantApps := appsFor(1005, 100) // 11
	if pods != 1005 {
		t.Errorf("pods=%d want 1005", pods)
	}
	if deploys != wantApps || rss != wantApps || svcs != wantApps || cms != wantApps || secrets != wantApps {
		t.Errorf("apps: deploy=%d rs=%d svc=%d cm=%d secret=%d want %d each", deploys, rss, svcs, cms, secrets, wantApps)
	}
	if nodes != 5 || nss != 3 {
		t.Errorf("nodes=%d nss=%d want 5/3", nodes, nss)
	}
}

// TestScaleRoundTripThroughInformer exercises the real fake-clientset watch
// path: a running informer consumes Create/Delete events while the scaler
// paces against the informer's store. It asserts convergence up and down and,
// implicitly, that batching keeps the fake watch channel from panicking.
func TestScaleRoundTripThroughInformer(t *testing.T) {
	g := New(Config{Pods: 300, Nodes: 4, Namespaces: 2, PodsPerApp: 100})
	client := fake.NewClientset(g.SeedObjects()...)

	factory := informers.NewSharedInformerFactory(client, 0)
	podInformer := factory.Core().V1().Pods().Informer()
	deployInformer := factory.Apps().V1().Deployments().Informer()
	stop := make(chan struct{})
	defer close(stop)
	factory.Start(stop)
	if !cache.WaitForCacheSync(stop, podInformer.HasSynced, deployInformer.HasSynced) {
		t.Fatal("informer failed to sync")
	}

	count := func(kind string) int {
		switch kind {
		case "Pod":
			return len(podInformer.GetStore().ListKeys())
		case "Deployment":
			return len(deployInformer.GetStore().ListKeys())
		}
		return 0
	}
	if got := waitCount(func() int { return count("Pod") }, 300, 5*time.Second); got != 300 {
		t.Fatalf("seed count=%d want 300", got)
	}

	ctx := context.Background()
	for _, target := range []int{900, 50, 450, 0, 250} {
		res, err := g.ScaleTo(ctx, client, target, count)
		if err != nil {
			t.Fatalf("ScaleTo(%d): %v", target, err)
		}
		if !res.Converged {
			t.Fatalf("ScaleTo(%d) did not converge; informer=%d", target, count("Pod"))
		}
		if got := count("Pod"); got != target {
			t.Fatalf("after ScaleTo(%d) informer store=%d", target, got)
		}
		// apps track pods: one Deployment per app of PodsPerApp
		wantApps := appsFor(target, g.Config().PodsPerApp)
		if got := count("Deployment"); got != wantApps {
			t.Fatalf("after ScaleTo(%d) deployments=%d want %d", target, got, wantApps)
		}
	}
}

func waitCount(count func() int, want int, timeout time.Duration) int {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if count() == want {
			return want
		}
		time.Sleep(2 * time.Millisecond)
	}
	return count()
}
