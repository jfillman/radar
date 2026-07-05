package main

// `radar cloud <sub>` subcommands — the first subcommand family in Radar's
// otherwise flat-flag CLI. Dispatched from main() before flag.Parse (see the
// os.Args[1]=="cloud" check there).
//
//	radar cloud connect     device-flow connect this cluster to Radar Cloud
//	radar cloud status      show the current context's cloud connection
//	radar cloud disconnect  forget the current context's cloud connection
//
// `connect` performs the browser device flow, persists the minted token to
// ~/.radar/credentials.json (0600), then rewrites os.Args so the normal main()
// flow brings up the server + cloud dialer with the obtained token. status and
// disconnect are terminal (they exit).

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/skyhook-io/radar/internal/app"
	"github.com/skyhook-io/radar/internal/cloud"
	"github.com/skyhook-io/radar/internal/config"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// signalContext returns a context cancelled on Ctrl-C / SIGTERM so a long poll
// wait can be interrupted cleanly.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

const defaultHubBase = "https://api.radarhq.io"

// runCloudSubcommand handles `radar cloud …`. For `connect` it returns after
// rewriting os.Args so main() proceeds; status/disconnect/help exit directly.
func runCloudSubcommand() {
	if len(os.Args) < 3 {
		cloudUsage(os.Stderr)
		os.Exit(2)
	}
	sub := os.Args[2]
	rest := os.Args[3:]
	switch sub {
	case "connect":
		cloudConnect(rest)
	case "status":
		cloudStatus()
		os.Exit(0)
	case "disconnect":
		cloudDisconnect(rest)
		os.Exit(0)
	case "-h", "--help", "help":
		cloudUsage(os.Stdout)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "radar cloud: unknown subcommand %q\n\n", sub)
		cloudUsage(os.Stderr)
		os.Exit(2)
	}
}

func cloudUsage(w *os.File) {
	fmt.Fprint(w, `Connect this cluster to Radar Cloud.

Usage:
  radar cloud connect [--hub-url URL] [--name NAME] [--no-browser]
  radar cloud status
  radar cloud disconnect

Flags (connect):
  --hub-url URL   Radar Cloud hub API (default `+defaultHubBase+`; set for self-hosted)
  --name NAME     Cluster name shown in Cloud (default: current kubecontext)
  --no-browser    Print the approval URL instead of opening a browser
`)
}

func cloudConnect(args []string) {
	fs := flag.NewFlagSet("cloud connect", flag.ExitOnError)
	hubURL := fs.String("hub-url", defaultHubBase, "Radar Cloud hub API origin")
	name := fs.String("name", "", "Cluster name shown in Cloud (default: current kubecontext)")
	noBrowser := fs.Bool("no-browser", false, "Print the approval URL instead of opening a browser")
	browserPref := fs.String("browser", "", "Browser to open the approval URL with")
	_ = fs.Parse(args)

	ctxName := currentKubeContextName()
	clusterName := *name
	if clusterName == "" {
		clusterName = ctxName
	}
	if clusterName == "" {
		clusterName = "my-cluster"
	}

	meta := gatherConnectMetadata(clusterName)

	ctx, cancel := signalContext()
	defer cancel()

	client := cloud.NewConnectClient(*hubURL)
	var open func(string)
	if !*noBrowser {
		open = func(u string) { go app.OpenBrowser(u, *browserPref) }
	}

	fmt.Printf("Connecting %q to Radar Cloud (%s)…\n", clusterName, *hubURL)
	res, err := client.RunFlow(ctx, meta, os.Stdout, open)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\nconnect failed: %v\n", err)
		os.Exit(1)
	}

	// Persist the token (0600) keyed by kubecontext so status/disconnect and a
	// later resume can find it.
	keyCtx := ctxName
	if keyCtx == "" {
		keyCtx = res.ClusterID
	}
	if err := cloud.SaveClusterCredential(keyCtx, cloud.ClusterCredential{
		HubBase:     *hubURL,
		ClusterID:   res.ClusterID,
		ClusterName: clusterName,
		Token:       res.Token,
		WSSURL:      res.WSSURL,
		ServerURL:   currentClusterServerURL(),
	}); err != nil {
		// Non-fatal: we can still serve this session; the user just won't get
		// auto-resume next time. Warn and continue.
		fmt.Fprintf(os.Stderr, "warning: couldn't save credentials: %v\n", err)
	}

	fmt.Printf("\n  ✓ Connected. Starting Radar and serving to Cloud — Ctrl-C to stop.\n\n")

	// Rewrite os.Args so the normal main() flow starts the server + dialer with
	// the obtained connection. --no-browser suppresses the LOCAL UI tab (the
	// user already has the Cloud page open).
	os.Args = []string{
		os.Args[0],
		"--cloud-url=" + res.WSSURL,
		"--cloud-token=" + res.Token,
		"--cluster-name=" + res.ClusterID,
		"--no-browser",
	}
}

func cloudStatus() {
	ctxName := currentKubeContextName()
	creds := cloud.LoadCredentials()
	if len(creds.Clusters) == 0 {
		fmt.Println("No clusters connected to Radar Cloud.")
		fmt.Println("Run `radar cloud connect` to connect this cluster.")
		return
	}
	fmt.Printf("Radar Cloud connections (%s):\n\n", cloud.CredentialsPath())
	for ctx, c := range creds.Clusters {
		marker := "  "
		if ctx == ctxName {
			marker = "* " // current kubecontext
		}
		fmt.Printf("%s%s\n      cluster: %s (%s)\n      hub:     %s\n",
			marker, ctx, c.ClusterName, c.ClusterID, c.HubBase)
	}
	if ctxName != "" {
		fmt.Printf("\n(* = current kubecontext)\n")
	}
}

func cloudDisconnect(args []string) {
	fs := flag.NewFlagSet("cloud disconnect", flag.ExitOnError)
	ctxFlag := fs.String("context", "", "Kubecontext to disconnect (default: current)")
	_ = fs.Parse(args)
	ctxName := *ctxFlag
	if ctxName == "" {
		ctxName = currentKubeContextName()
	}
	if ctxName == "" {
		fmt.Fprintln(os.Stderr, "no current kubecontext; pass --context NAME")
		os.Exit(1)
	}
	removed, err := cloud.RemoveClusterCredential(ctxName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "disconnect failed: %v\n", err)
		os.Exit(1)
	}
	if !removed {
		fmt.Printf("No Radar Cloud connection stored for context %q.\n", ctxName)
		return
	}
	fmt.Printf("Disconnected %q from Radar Cloud (credentials removed).\n", ctxName)
	fmt.Println("The cluster still exists in Cloud until you remove it there.")
}

// maybeResumeCloud auto-injects cloud flags when a plain `radar` runs on a
// kubecontext that has a saved Cloud connection, so `radar cloud connect` once
// makes future `radar` runs resume the tunnel. Explicit cloud config (a
// --cloud-url flag or RADAR_CLOUD_URL env — the in-cluster/Helm path) always
// wins and short-circuits this. `radar cloud disconnect` removes the saved
// credential, turning resume off.
func maybeResumeCloud(fileCfg config.Config) {
	if os.Getenv("RADAR_CLOUD_URL") != "" {
		return
	}
	for _, a := range os.Args[1:] {
		if a == "--cloud-url" || strings.HasPrefix(a, "--cloud-url=") {
			return
		}
	}
	// Auto-resume ONLY when the served cluster is unambiguously the default
	// kubecontext. Saved credentials are keyed by the default context name; if a
	// non-default kubeconfig is selected (--kubeconfig / --kubeconfig-dir flag,
	// or a persisted path in config), the cluster actually served could differ
	// from that context — resuming then would serve cluster B under context A's
	// Cloud identity. In those cases require an explicit `radar cloud connect`.
	if fileCfg.Kubeconfig != "" || len(fileCfg.KubeconfigDirs) > 0 {
		return
	}
	for _, a := range os.Args[1:] {
		if isKubeconfigOverrideArg(a) {
			return
		}
	}
	ctxName := currentKubeContextName()
	if ctxName == "" {
		return
	}
	cred, ok := cloud.GetClusterCredential(ctxName)
	if !ok || cred.Token == "" || cred.WSSURL == "" {
		return
	}
	// Bind the credential to the cluster: if the saved server URL differs from
	// the current context's, this is a same-named context in a different
	// kubeconfig pointing at a different cluster — don't resume (would serve
	// the wrong cluster under this cred's Cloud identity). Empty saved URL
	// (legacy cred) falls back to name-only matching.
	if cred.ServerURL != "" {
		if cur := currentClusterServerURL(); cur != "" && cur != cred.ServerURL {
			log.Printf("[cloud] not resuming context %q: kubeconfig now points at a different cluster than the saved connection", ctxName)
			return
		}
	}
	log.Printf("[cloud] resuming saved Radar Cloud connection for context %q (cluster %s) — `radar cloud disconnect` to stop", ctxName, cred.ClusterID)
	os.Args = append(os.Args,
		"--cloud-url="+cred.WSSURL,
		"--cloud-token="+cred.Token,
		"--cluster-name="+cred.ClusterID,
	)
}

// isKubeconfigOverrideArg reports whether an arg selects a non-default
// kubeconfig, which would make the default-context resume unsafe.
func isKubeconfigOverrideArg(a string) bool {
	for _, p := range []string{"--kubeconfig", "-kubeconfig", "--kubeconfig-dir", "-kubeconfig-dir"} {
		if a == p || strings.HasPrefix(a, p+"=") {
			return true
		}
	}
	return false
}

// currentKubeContextName reads the current kubecontext directly from kubeconfig,
// without initializing Radar's full client (this runs before that setup).
// Empty string on any failure (e.g. in-cluster with no kubeconfig).
func currentKubeContextName() string {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	cfg, err := rules.Load()
	if err != nil || cfg == nil {
		return ""
	}
	return cfg.CurrentContext
}

// currentClusterServerURL returns the kube-apiserver endpoint of the current
// context, resolved locally (no network). Empty on any failure. Used to bind a
// saved credential to its cluster so a same-named context in a different
// kubeconfig can't resume it.
func currentClusterServerURL() string {
	restCfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(),
		&clientcmd.ConfigOverrides{},
	).ClientConfig()
	if err != nil {
		return ""
	}
	return restCfg.Host
}

// gatherConnectMetadata assembles best-effort display context for the consent
// page. k8s version + node count are looked up under a short timeout and simply
// omitted on any failure (RBAC, unreachable) — the consent page renders what's
// present.
func gatherConnectMetadata(clusterName string) cloud.ConnectMetadata {
	meta := cloud.ConnectMetadata{
		DeploymentMode: "local",
		ClusterName:    clusterName,
		RadarVersion:   version,
		Scope:          "cluster",
	}

	restCfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(),
		&clientcmd.ConfigOverrides{},
	).ClientConfig()
	if err != nil {
		return meta
	}
	// Bound the whole best-effort probe so `radar cloud connect` never hangs on
	// an unreachable cluster — ServerVersion() has no context and would
	// otherwise inherit the rest config's (zero = infinite) timeout.
	restCfg.Timeout = 5 * time.Second
	cs, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return meta
	}
	if v, err := cs.Discovery().ServerVersion(); err == nil && v != nil {
		meta.K8sVersion = v.GitVersion
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if nodes, err := cs.CoreV1().Nodes().List(ctx, metav1.ListOptions{Limit: 500}); err == nil {
		n := len(nodes.Items)
		meta.NodeCount = &n
	}
	return meta
}
