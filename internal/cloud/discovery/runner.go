package discovery

import (
	"context"
	"log/slog"
	"time"
)

// RunnerConfig is what cmd/explorer hands the discovery loop on
// startup. Empty `UpstreamURL` disables the loop entirely — radar runs fine
// without discovery, the cloud upstream just won't badge any cards.
type RunnerConfig struct {
	UpstreamURL string
	Token       string
	Interval    time.Duration // 0 → 60s
}

// Start kicks off the discovery loop in a goroutine. Returns
// immediately. Cancel via the supplied ctx.
//
// First push runs ~3s after start to give the kube client time to warm
// its informer caches; otherwise the first probe sweep tends to come
// back empty even when there ARE vendors installed. After that the
// ticker takes over.
// kubeFn/dynFn/clusterFn are resolved fresh on EVERY sweep rather than
// captured once: after a kubeconfig context switch the global clients +
// cluster identity change, and a stale capture would keep listing the old
// API server and pushing under the old cluster id.
func Start(ctx context.Context, cfg RunnerConfig, kubeFn func() KubeReader, dynFn func() DynReader, clusterFn func() (id, name string)) {
	if cfg.UpstreamURL == "" {
		slog.Info("discovery: UpstreamURL empty, loop disabled")
		return
	}
	interval := cfg.Interval
	if interval <= 0 {
		interval = 60 * time.Second
	}
	pusher := New(cfg.UpstreamURL, cfg.Token)

	go func() {
		warmup := time.NewTimer(3 * time.Second)
		defer warmup.Stop()
		select {
		case <-ctx.Done():
			return
		case <-warmup.C:
		}
		sweep := func() {
			// Re-resolve clients + cluster identity each sweep so a context
			// switch is picked up. Run applies a per-probe timeout internally,
			// so we hand it the long-lived loop ctx rather than one shared
			// sweep deadline that later probes could find already expired.
			id, name := clusterFn()
			env := Env{ClusterID: id, ClusterName: name, Kube: kubeFn(), Dyn: dynFn()}
			r := Run(ctx, env, DefaultProbes(), func(msg string, args ...any) {
				slog.Warn("discovery: "+msg, args...)
			})
			pushCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := pusher.Push(pushCtx, r); err != nil {
				slog.Warn("discovery: push failed", "err", err)
				return
			}
			slog.Info("discovery: pushed", "hits", len(r.Hits), "cluster", name)
		}
		sweep()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				sweep()
			}
		}
	}()
}
