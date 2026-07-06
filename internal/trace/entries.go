package trace

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/skyhook-io/radar/pkg/k8score"
	"github.com/skyhook-io/radar/pkg/probe"
)

type networkingIngress = networkingv1.Ingress

// traceServiceEntry handles the most common entry kind: a Service. The
// downstream chain is the Service itself + the selected-pod hop; upstreams
// are every Ingress and Gateway-API Route referencing this Service, judged
// independently because parallel ingress paths fail independently.
func traceServiceEntry(ctx context.Context, deps Deps, t *Trace) {
	_ = ctx // single-chain entry has no fan-out loop; the caller's deadline check covers it
	svc, err := deps.Cache.Services().Services(t.Subject.Namespace).Get(t.Subject.Name)
	if err != nil {
		t.Verdict = VerdictUnknown
		t.Reason = serviceLookupReason(err, t.Subject)
		return
	}
	svcRef := refForService(svc)
	t.Subject = svcRef

	switch {
	case svc.Spec.Type == corev1.ServiceTypeExternalName:
		t.Downstream = []Hop{{
			Resource: svcRef,
			Edge:     "entry:Service",
			Findings: hopFindings(deps.Issues, svcRef),
		}, {
			Resource: ResourceRef{Kind: "ExternalName", Name: svc.Spec.ExternalName},
			Edge:     "Service->ExternalName",
			Findings: []Finding{{
				Code:     "svc:external-name",
				Severity: SeverityInfo,
				Message:  fmt.Sprintf("Service resolves to %q outside the cluster; downstream is not traced", svc.Spec.ExternalName),
			}},
		}}
		t.Upstreams = serviceUpstreams(deps, svc)
		return

	case len(svc.Spec.Selector) == 0:
		t.Downstream = []Hop{{
			Resource: svcRef,
			Edge:     "entry:Service",
			Meta:     map[string]any{"selectorless": true},
			Findings: append(hopFindings(deps.Issues, svcRef), Finding{
				Code:     "svc:selectorless",
				Severity: SeverityInfo,
				Message:  "Service has no selector; endpoints are managed manually and pod health is not derivable",
				Command:  fmt.Sprintf("kubectl get endpoints %s -n %s", svc.Name, svc.Namespace),
			}),
		}}
		t.Upstreams = serviceUpstreams(deps, svc)
		return
	}

	svcHop := Hop{
		Resource: svcRef,
		Edge:     "entry:Service",
		Findings: hopFindings(deps.Issues, svcRef),
		Meta:     map[string]any{},
		Config:   serviceConfig(svc),
	}
	if svc.Spec.ClusterIP == "None" {
		svcHop.Meta["headless"] = true
	}
	// A LoadBalancer with no external address can't be reached from outside the
	// cluster. The standing detector also flags this, but only after a 5-minute
	// grace (so the global Problems list doesn't flap during normal provisioning);
	// in the diagnose context the operator is looking right now, so surface it
	// immediately - unless the detector's finding is already present (avoid a dup).
	if svc.Spec.Type == corev1.ServiceTypeLoadBalancer && len(svc.Status.LoadBalancer.Ingress) == 0 &&
		!hasLoadBalancerFinding(svcHop.Findings) {
		svcHop.Findings = append(svcHop.Findings, Finding{
			Code:     "svc:loadbalancer-pending",
			Severity: SeverityWarning,
			Message:  "LoadBalancer has no external address yet - traffic from outside the cluster can't reach it (the in-cluster ClusterIP path is unaffected)",
			Command:  fmt.Sprintf("kubectl get service %s -n %s", svc.Name, svc.Namespace),
		})
	}

	pods, unreadable := selectedPods(deps, svc)
	appendTargetPortAdvisory(&svcHop, svc, pods)
	podsHop := buildPodsHop(deps, svc, pods, unreadable)
	linkNoReadyToCulprit(&svcHop, &podsHop)

	t.Downstream = []Hop{svcHop, podsHop}
	t.Upstreams = serviceUpstreams(deps, svc)
}

// linkNoReadyToCulprit points a Service's "0/N selected pods ready" symptom at
// the actual failing Pod: the real next step is to open that pod's logs, not to
// `kubectl describe service` (which shows the empty endpoints, never the why).
// It lifts the culprit Pod ref + its state-true command (e.g. logs --previous)
// from the Pods hop onto the Service finding, so the UI can link straight to the
// cause from the Service node. No-op when the cause isn't a single named Pod.
func linkNoReadyToCulprit(svcHop, podsHop *Hop) {
	var culprit *Finding
	for i := range podsHop.Findings {
		f := &podsHop.Findings[i]
		if f.Resource != nil && f.Resource.Kind == "Pod" && f.Command != "" {
			culprit = f
			break
		}
	}
	if culprit == nil {
		return
	}
	for i := range svcHop.Findings {
		f := &svcHop.Findings[i]
		if !isNoReadyEndpointsFinding(f) {
			continue
		}
		if f.Resource == nil {
			f.Resource = culprit.Resource
		}
		// Swap the low-value `describe service` for the command that reveals the
		// cause; carry the parsed cause/action so the symptom row reads like the
		// diagnosis it is.
		f.Command = culprit.Command
		if f.Cause == "" {
			f.Cause = culprit.Cause
		}
		if f.Action == "" {
			f.Action = culprit.Action
		}
	}
}

// isNoReadyEndpointsFinding matches the Service-level "no ready endpoints"
// symptom (pods exist but none are ready), the finding whose real cause lives on
// a downstream Pod. Matches both the stable fingerprint (`svc:no-ready-endpoints`,
// emitted when issueCode uses the Fingerprint) and the source:reason form
// (`problem:0/N selected pods ready`, emitted when it doesn't) so it's robust to
// either code path.
func isNoReadyEndpointsFinding(f *Finding) bool {
	if f.Code == "svc:no-ready-endpoints" {
		return true
	}
	return strings.HasPrefix(f.Code, "problem:0/") && strings.HasSuffix(f.Code, " selected pods ready")
}

// serviceConfig captures the wire-shape of a Service: which port mapping
// the Service declares, the type (ClusterIP / NodePort / LoadBalancer /
// ExternalName), and the selector. This is the data an operator needs to
// reason about "what port does traffic actually target" without leaving
// the trace.
// servicePortMaps resolves a Service's port mappings to the PortMap shape the
// trace carries - each port plus the targetPort the pods actually receive on
// (numeric or named, defaulting to the Service port). Shared by serviceConfig
// and the NetworkPolicy evaluator so port identity is resolved one way.
func servicePortMaps(svc *corev1.Service) []PortMap {
	out := make([]PortMap, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		tp := ""
		switch p.TargetPort.Type {
		case intstr.Int:
			if p.TargetPort.IntVal > 0 {
				tp = fmt.Sprintf("%d", p.TargetPort.IntVal)
			}
		case intstr.String:
			tp = p.TargetPort.StrVal
		}
		if tp == "" {
			tp = fmt.Sprintf("%d", p.Port)
		}
		appProto := ""
		if p.AppProtocol != nil {
			appProto = *p.AppProtocol
		}
		out = append(out, PortMap{
			Name:        p.Name,
			Port:        p.Port,
			TargetPort:  tp,
			Protocol:    string(p.Protocol),
			AppProtocol: appProto,
		})
	}
	return out
}

func serviceConfig(svc *corev1.Service) *HopConfig {
	if svc == nil {
		return nil
	}
	c := &HopConfig{
		ServiceType: string(svc.Spec.Type),
		ClusterIP:   svc.Spec.ClusterIP,
		Ports:       servicePortMaps(svc),
	}
	if len(svc.Spec.Selector) > 0 {
		c.Selector = map[string]string{}
		for k, v := range svc.Spec.Selector {
			c.Selector[k] = v
		}
	}
	return c
}

// targetPortAdvisory flags a likely-misconfigured numeric targetPort: the
// Service routes to a container port number that NO ready pod declares, while
// the pods DO declare other ports. A containerPort is informational - kube-proxy
// forwards to the targetPort number whether or not the container declares it -
// so this can never be proof of a break, only a warning worth verifying. The
// positive-evidence guard (pods declare ports, but none match) keeps it off the
// common case where pods declare no container ports at all, where a mismatch
// would mean nothing. The fault is the Service spec, so the finding lands on the
// Service hop, not the pods.
func targetPortAdvisory(svc *corev1.Service, pods []*corev1.Pod) (Finding, []int32, bool) {
	if svc == nil {
		return Finding{}, nil, false
	}
	declared := map[int32]bool{}
	for _, pod := range pods {
		if pod == nil || !isPodReadyForTrace(pod) {
			continue
		}
		for _, c := range pod.Spec.Containers {
			for _, cp := range c.Ports {
				declared[cp.ContainerPort] = true
			}
		}
	}
	if len(declared) == 0 {
		return Finding{}, nil, false
	}
	var suspects []string
	var suspectSvcPorts []int32
	for _, sp := range svc.Spec.Ports {
		if sp.TargetPort.Type != intstr.Int {
			continue // named targetPorts resolve by container-port name, not number
		}
		tp := sp.TargetPort.IntVal
		if tp == 0 {
			tp = sp.Port // unset targetPort defaults to the Service port
		}
		if !declared[tp] {
			suspects = append(suspects, fmt.Sprintf("%d→:%d", sp.Port, tp))
			suspectSvcPorts = append(suspectSvcPorts, sp.Port)
		}
	}
	if len(suspects) == 0 {
		return Finding{}, nil, false
	}
	observed := make([]int32, 0, len(declared))
	for p := range declared {
		observed = append(observed, p)
	}
	sort.Slice(observed, func(i, j int) bool { return observed[i] < observed[j] })
	obs := make([]string, len(observed))
	for i, p := range observed {
		obs[i] = fmt.Sprintf(":%d", p)
	}
	return Finding{
		Code:     "svc:targetport-no-listener",
		Severity: SeverityWarning,
		Message:  fmt.Sprintf("Service targetPort %s matches no port the ready pods declare (they declare %s). If nothing listens on the target port, traffic silently goes nowhere.", strings.Join(suspects, ", "), strings.Join(obs, ", ")),
		Cause:    "Service targetPort likely wrong",
		Action:   "Confirm the Service targetPort matches the port the container listens on",
		Command:  fmt.Sprintf("kubectl get svc %s -n %s -o yaml", svc.Name, svc.Namespace),
	}, suspectSvcPorts, true
}

// appendTargetPortAdvisory attaches the targetPort advisory to a Service hop
// (re-sorting so the worst severity leads), when the positive-evidence guard
// fires. The suspect Service ports are stashed on the hop so the post-probe
// reconcile can downgrade the warning once a probe proves those ports reachable.
func appendTargetPortAdvisory(hop *Hop, svc *corev1.Service, pods []*corev1.Pod) {
	adv, suspectPorts, ok := targetPortAdvisory(svc, pods)
	if !ok {
		return
	}
	hop.Findings = append(hop.Findings, adv)
	if hop.Meta == nil {
		hop.Meta = map[string]any{}
	}
	hop.Meta["targetPortSuspectPorts"] = suspectPorts
	sortFindingsBySeverity(hop.Findings)
}

// reconcileTargetPortAdvisory downgrades the static "targetPort matches no
// declared container port" WARNING to an info note once live probes prove every
// suspect Service port is reachable - a containerPort is optional and kube-proxy
// forwards regardless, so a reachable port means SOMETHING listens and the
// static suspicion is contradicted. Only downgrade when EVERY suspect port saw a
// non-skipped success and none failed; a failed/absent probe keeps the warning
// (it may be the real cause). Mirrors reconcilePolicyFindings' fail-toward-truth.
func reconcileTargetPortAdvisory(t *Trace) {
	if t == nil {
		return
	}
	visit := func(hops []Hop) {
		for i := range hops {
			h := &hops[i]
			idx := findingIndexByCode(h.Findings, "svc:targetport-no-listener")
			if idx < 0 || h.Meta == nil {
				continue
			}
			suspects := metaInt32Slice(h.Meta["targetPortSuspectPorts"])
			if len(suspects) == 0 {
				continue
			}
			allReached := true
			for _, sp := range suspects {
				reached, failed := portProbeReached(h.Probes, sp)
				if !reached || failed {
					allReached = false
					break
				}
			}
			if !allReached {
				continue
			}
			downgradeTargetPortFinding(&h.Findings[idx])
			sortFindingsBySeverity(h.Findings)
		}
	}
	visit(t.Downstream)
	visit(t.Upstreams)
}

// downgradeTargetPortFinding rewrites a svc:targetport-no-listener WARNING into
// the reassuring info note once live traffic proved the suspect port has a
// listener. Shared by the static-probe path (reconcileTargetPortAdvisory) and the
// in-cluster fold (reconcileInClusterTargetPort) so the two can't drift.
func downgradeTargetPortFinding(f *Finding) {
	f.Severity = SeverityInfo
	f.Message = "The Service targetPort matches no port the ready pods DECLARE, but a live probe reached it - a containerPort is optional, so the listener simply isn't declared. Nothing to fix; declaring the containerPort would make the wiring self-documenting."
	f.Cause = ""
	f.Action = ""
}

// portProbeReached reports whether a hop's probe set reached / failed a specific
// Service port (skipped rows ignored).
func portProbeReached(probes []probe.Result, port int32) (reached, failed bool) {
	for _, p := range probes {
		if p.Skipped || p.Port != port {
			continue
		}
		if p.OK {
			reached = true
		} else {
			failed = true
		}
	}
	return
}

// metaInt32Slice reads a []int32 stashed on a hop's Meta, tolerating the []any
// shape a JSON round-trip would produce.
func metaInt32Slice(v any) []int32 {
	switch s := v.(type) {
	case []int32:
		return s
	case []any:
		out := make([]int32, 0, len(s))
		for _, e := range s {
			out = append(out, metaInt32(e))
		}
		return out
	}
	return nil
}

func buildPodsHop(deps Deps, svc *corev1.Service, pods []*corev1.Pod, unreadable bool, backendPorts ...string) Hop {
	podsRef := ResourceRef{Kind: "Pods", Namespace: svc.Namespace}
	meta := map[string]any{
		"selected": len(pods),
		"ready":    readyCount(pods),
	}
	if unreadable {
		// Pod lister errored: don't pretend the empty selection means "no
		// backends". Mark endpointSource=unknown so computeVerdict degrades
		// to unknown and the banner says we couldn't read pod state.
		meta["endpointSource"] = "unknown"
	} else {
		meta["endpointSource"] = "pod-readiness"
	}
	hop := Hop{
		Resource: podsRef,
		Edge:     "Service->Pods",
		Meta:     meta,
		Config:   podsConfig(pods, svc),
	}
	if unreadable {
		hop.Findings = append(hop.Findings, Finding{
			Code:     "pods:lister-error",
			Severity: SeverityInfo,
			Message:  "Couldn't list pods matching the Service selector. RBAC may be blocking the pods listing, or the cache is still syncing. Treat the trace as unverifiable until this clears.",
		})
	}
	hop.Findings = append(hop.Findings, podFanoutFindings(deps, pods)...)
	if cmd := selectorReproducer(podsRef, svc.Spec.Selector); cmd != "" {
		for i := range hop.Findings {
			if hop.Findings[i].Command == "" {
				hop.Findings[i].Command = cmd
			}
		}
	}
	if res, finding, ok := policyFinding(deps, svc, pods, backendPorts...); ok {
		hop.Findings = append(hop.Findings, finding)
		meta["policyVerdict"] = policyVerdictKey(res.verdict)
		if len(res.policyNames) > 0 {
			meta["policyNames"] = res.policyNames
		}
		if res.port != "" {
			meta["policyPort"] = res.port
		}
		if res.denyPort > 0 {
			meta["policyDenyPort"] = res.denyPort
		}
	}
	if mesh := detectMesh(pods); mesh != "" {
		hop.Findings = append(hop.Findings, Finding{
			Code:     "mesh:probe-may-fail-mtls",
			Severity: SeverityInfo,
			Message:  fmt.Sprintf("These pods run in a %s service mesh. A reachability probe from outside the mesh can fail TLS/HTTP (mTLS) even when real in-mesh traffic is healthy - trust in-mesh traffic, or run the in-cluster test.", mesh),
		})
	}
	// Pods are selected but none are Ready, and nothing above named a cause -
	// surface the real blocking pod state (OOM / stuck init / failing readiness)
	// so the operator isn't left with a bare "not reached". Warning-tier, matching
	// the present-but-not-ready calibration; a critical no-ready-endpoints issue,
	// when the detector emits one, already takes precedence here.
	if len(pods) > 0 && readyCount(pods) == 0 &&
		worstSeverity(hop.Findings) != SeverityCritical && worstSeverity(hop.Findings) != SeverityWarning {
		for _, pod := range pods {
			if pod == nil || podIsReady(pod) {
				continue
			}
			if cause, command := podDiagnosis(pod); cause != "" {
				podRef := ResourceRef{Kind: "Pod", Namespace: pod.Namespace, Name: pod.Name}
				hop.Findings = append(hop.Findings, Finding{
					Code:     "pods:no-ready-endpoints",
					Severity: SeverityWarning,
					Message:  cause,
					Command:  command,
					Resource: &podRef,
				})
				break
			}
		}
	}
	return hop
}

// detectMesh reports the service mesh the selected pods belong to (Istio /
// Linkerd / Consul), or "" when none is detected. An injected sidecar enforces
// mTLS, so a probe from outside the mesh can fail TLS/HTTP even when real
// sidecar-to-sidecar traffic is healthy; buildPodsHop surfaces this as an INFO
// advisory only - it must never escalate the verdict. The injected sidecar
// container name is the strongest signal (the proxy is actually running);
// labels/annotations are the injection request and catch the pre-Running case.
func detectMesh(pods []*corev1.Pod) string {
	for _, pod := range pods {
		if pod == nil {
			continue
		}
		for _, c := range pod.Spec.Containers {
			switch c.Name {
			case "istio-proxy":
				return "Istio"
			case "linkerd-proxy":
				return "Linkerd"
			case "consul-dataplane":
				return "Consul"
			}
		}
		if pod.Annotations["sidecar.istio.io/status"] != "" ||
			pod.Labels["istio.io/rev"] != "" ||
			pod.Labels["sidecar.istio.io/inject"] == "true" ||
			pod.Annotations["sidecar.istio.io/inject"] == "true" {
			return "Istio"
		}
		if pod.Labels["linkerd.io/inject"] == "enabled" ||
			pod.Annotations["linkerd.io/inject"] == "enabled" {
			return "Linkerd"
		}
		if pod.Labels["consul.hashicorp.com/connect-inject"] == "true" ||
			pod.Annotations["consul.hashicorp.com/connect-inject"] == "true" {
			return "Consul"
		}
	}
	return ""
}

const maxPodIPsInConfig = 10

// podsConfig folds the selected pods into a deduplicated container-port +
// probe summary. We dedupe on (container, name, port) so a 50-replica
// Deployment doesn't produce 50 identical rows - every replica declares the
// same ports. Probes from sidecars matter (multi-container readiness is
// AND'ed) so they're listed per container. Pod IPs/names are captured up
// to maxPodIPsInConfig (10) so the in-cluster probe orchestrator can sample
// from a real pool; the probe layer caps the actually-probed pods to
// maxPodsToProbe (3) so total runtime stays inside the 3-second budget.
//
// Container ports are filtered to those the upstream Service actually
// targets. Sidecar / admin / metrics ports (Envoy 15000, Prometheus 9090,
// kubelet probe ports) aren't reachable via kube-proxy, so probing them
// would emit false "probe failed" rows that mislead the operator about
// the actual data-path. When svc has no ports declared, every container
// port stays so we don't blank-screen the hop.
func podsConfig(pods []*corev1.Pod, svc *corev1.Service) *HopConfig {
	if len(pods) == 0 {
		return nil
	}
	// The Pods lister returns slice order from a map-backed store, so the
	// "first N" we sample for the IP/name pool can differ across Radar
	// instances - two operators viewing the same Service would probe
	// different replicas. Sort by Name first so the sample is stable.
	sorted := make([]*corev1.Pod, len(pods))
	copy(sorted, pods)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i] == nil {
			return false
		}
		if sorted[j] == nil {
			return true
		}
		return sorted[i].Name < sorted[j].Name
	})
	targeted := serviceTargetedPorts(svc)
	cp := map[string]ContainerPortRef{}
	pr := map[string]ProbeRef{}
	var ips []string
	var names []string
	var readyRoster, notReadyRoster []PodStatus
	podTotal := 0
	for _, pod := range sorted {
		if pod == nil {
			continue
		}
		podTotal++
		// Names and IPs must stay positionally aligned: the data path probes
		// the first N IPs while the apiserver path probes the first N
		// names, and divergence detection assumes those are the same pods.
		// Appending names while IP is empty would shift the sequences, so
		// pods without a PodIP yet are dropped from the sample entirely.
		ready := isPodReadyForTrace(pod)
		if ready && pod.Status.PodIP != "" && len(names) < maxPodIPsInConfig {
			ips = append(ips, pod.Status.PodIP)
			names = append(names, pod.Name)
		}
		// Roster rows the grid renders. A ready pod only earns a row if it will
		// actually be probed (the probe layer caps at maxPodsToProbe) - otherwise
		// it reads a useless "not tested". A not-ready pod ALWAYS earns a row: it
		// is a culprit, and dropping it (first-N-by-name) could hide the exact pod
		// the operator is hunting. Reason is the plain-English cause.
		ps := PodStatus{Name: pod.Name, IP: pod.Status.PodIP, Ready: ready}
		if ready {
			readyRoster = append(readyRoster, ps)
		} else {
			if cause, _ := podDiagnosis(pod); cause != "" {
				ps.Reason = cause
			} else {
				ps.Reason = "not ready"
			}
			notReadyRoster = append(notReadyRoster, ps)
		}
		for _, c := range pod.Spec.Containers {
			for _, port := range c.Ports {
				if !portIsServiceTargeted(targeted, port.Name, port.ContainerPort) {
					continue
				}
				key := c.Name + "/" + port.Name + "/" + fmt.Sprintf("%d", port.ContainerPort)
				if _, ok := cp[key]; ok {
					continue
				}
				cp[key] = ContainerPortRef{
					Container: c.Name,
					Name:      port.Name,
					Port:      port.ContainerPort,
					Protocol:  string(port.Protocol),
				}
			}
			if ref, ok := describeProbe(c.Name, "readiness", c.ReadinessProbe, c.Ports); ok {
				pr[c.Name+"/readiness"] = ref
			}
			if ref, ok := describeProbe(c.Name, "liveness", c.LivenessProbe, c.Ports); ok {
				pr[c.Name+"/liveness"] = ref
			}
		}
	}
	// Culprits (not-ready) first so they are never sampled out, then the ready
	// pods that were actually probed (aligned to maxPodsToProbe so no row reads a
	// useless "not tested"), all capped for JSON size. PodTotal keeps the true
	// count so the grid renders "N of total" and never reads as complete.
	roster := append([]PodStatus{}, notReadyRoster...)
	if len(roster) > maxPodIPsInConfig {
		roster = roster[:maxPodIPsInConfig]
	}
	for i, rp := range readyRoster {
		if i >= maxPodsToProbe || len(roster) >= maxPodIPsInConfig {
			break
		}
		roster = append(roster, rp)
	}
	if len(cp) == 0 && len(pr) == 0 && len(ips) == 0 && len(names) == 0 && len(roster) == 0 {
		return nil
	}
	c := &HopConfig{}
	c.PodIPs = ips
	c.PodNames = names
	c.Pods = roster
	c.PodTotal = podTotal
	for _, v := range cp {
		c.ContainerPorts = append(c.ContainerPorts, v)
	}
	sort.Slice(c.ContainerPorts, func(i, j int) bool {
		if c.ContainerPorts[i].Container != c.ContainerPorts[j].Container {
			return c.ContainerPorts[i].Container < c.ContainerPorts[j].Container
		}
		return c.ContainerPorts[i].Port < c.ContainerPorts[j].Port
	})
	for _, v := range pr {
		c.Probes = append(c.Probes, v)
	}
	sort.Slice(c.Probes, func(i, j int) bool {
		if c.Probes[i].Container != c.Probes[j].Container {
			return c.Probes[i].Container < c.Probes[j].Container
		}
		return c.Probes[i].Type < c.Probes[j].Type
	})
	return c
}

// annotateServiceTerminal applies the same terminal-case meta+finding the
// Service-entry path attaches, when a backend Service is reached from an
// Ingress / Route fan-out. ExternalName and selectorless backends are
// terminal - there's no Pods hop to add and the verdict downgrade in
// hasUnverifiableEndpoints needs the selectorless flag to fire. Without
// this, an Ingress backed by a selectorless Service would silently report
// `healthy` while a direct Service trace of the same backend would
// honestly read `unknown`. Returns true when terminal (caller skips Pods).
func annotateServiceTerminal(hop *Hop, svc *corev1.Service) bool {
	if svc == nil {
		return false
	}
	if svc.Spec.Type == corev1.ServiceTypeExternalName {
		hop.Findings = append(hop.Findings, Finding{
			Code:     "svc:external-name",
			Severity: SeverityInfo,
			Message:  fmt.Sprintf("Service resolves to %q outside the cluster; downstream is not traced", svc.Spec.ExternalName),
		})
		return true
	}
	if len(svc.Spec.Selector) == 0 {
		if hop.Meta == nil {
			hop.Meta = map[string]any{}
		}
		hop.Meta["selectorless"] = true
		hop.Findings = append(hop.Findings, Finding{
			Code:     "svc:selectorless",
			Severity: SeverityInfo,
			Message:  "Service has no selector; endpoints are managed manually and pod health is not derivable",
			Command:  fmt.Sprintf("kubectl get endpoints %s -n %s", svc.Name, svc.Namespace),
		})
		return true
	}
	return false
}

// servicePortTargets captures the union of ports a Service routes to. The
// apiserver treats targetPort as int OR named-string; pods carry both
// (containerPort and Name). We surface both so portIsServiceTargeted can
// match against either. Empty == no Service known, in which case we
// keep all ports (Pods hops attached to non-Service entries).
type servicePortTargets struct {
	known   bool
	intSet  map[int32]struct{}
	nameSet map[string]struct{}
}

func serviceTargetedPorts(svc *corev1.Service) servicePortTargets {
	if svc == nil || len(svc.Spec.Ports) == 0 {
		return servicePortTargets{}
	}
	t := servicePortTargets{
		known:   true,
		intSet:  map[int32]struct{}{},
		nameSet: map[string]struct{}{},
	}
	for _, sp := range svc.Spec.Ports {
		switch sp.TargetPort.Type {
		case intstr.Int:
			if sp.TargetPort.IntVal > 0 {
				t.intSet[sp.TargetPort.IntVal] = struct{}{}
			} else {
				// Unset TargetPort defaults to Port (apiserver behavior).
				t.intSet[sp.Port] = struct{}{}
			}
		case intstr.String:
			if sp.TargetPort.StrVal != "" {
				t.nameSet[sp.TargetPort.StrVal] = struct{}{}
			} else {
				t.intSet[sp.Port] = struct{}{}
			}
		}
	}
	return t
}

func portIsServiceTargeted(t servicePortTargets, name string, port int32) bool {
	if !t.known {
		return true
	}
	if _, ok := t.intSet[port]; ok {
		return true
	}
	if name != "" {
		if _, ok := t.nameSet[name]; ok {
			return true
		}
	}
	return false
}

// isPodReadyForTrace returns true if the pod's Ready condition is True.
// Only ready pods are surfaced as probe targets - probing a NotReady pod
// reports "TCP connect failed", but kube-proxy was already routing around
// it, so the trace would be reporting a non-issue.
func isPodReadyForTrace(pod *corev1.Pod) bool {
	if pod == nil {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func describeProbe(container, kind string, probe *corev1.Probe, ports []corev1.ContainerPort) (ProbeRef, bool) {
	if probe == nil {
		return ProbeRef{}, false
	}
	ref := ProbeRef{Container: container, Type: kind}
	resolvePort := func(p intstr.IntOrString) string {
		switch p.Type {
		case intstr.Int:
			if p.IntVal > 0 {
				return fmt.Sprintf("%d", p.IntVal)
			}
		case intstr.String:
			for _, cp := range ports {
				if cp.Name == p.StrVal && cp.ContainerPort > 0 {
					return fmt.Sprintf("%s→%d", p.StrVal, cp.ContainerPort)
				}
			}
			if p.StrVal != "" {
				return p.StrVal + "(unresolved)"
			}
		}
		return ""
	}
	switch {
	case probe.HTTPGet != nil:
		ref.Port = resolvePort(probe.HTTPGet.Port)
		ref.Path = probe.HTTPGet.Path
		ref.Scheme = string(probe.HTTPGet.Scheme)
	case probe.TCPSocket != nil:
		ref.Port = resolvePort(probe.TCPSocket.Port)
		ref.Scheme = "TCP"
	case probe.GRPC != nil:
		if probe.GRPC.Port > 0 {
			ref.Port = fmt.Sprintf("%d", probe.GRPC.Port)
		}
		ref.Scheme = "gRPC"
	case probe.Exec != nil:
		ref.Scheme = "exec"
	default:
		return ProbeRef{}, false
	}
	return ref, true
}

// podFanoutFindings collapses the per-pod issue fan-out into hop-level
// findings. We deliberately surface the worst-severity representative per
// distinct code instead of every pod's copy - the diagnosis is "this hop is
// broken", not "here are 47 identical alerts".
func podFanoutFindings(deps Deps, pods []*corev1.Pod) []Finding {
	if deps.Issues == nil {
		return nil
	}
	seen := map[string]Finding{}
	for _, pod := range pods {
		if pod == nil {
			continue
		}
		ref := ResourceRef{Kind: "Pod", Namespace: pod.Namespace, Name: pod.Name}
		cause, command := podDiagnosis(pod)
		for _, f := range hopFindings(deps.Issues, ref) {
			prev, ok := seen[f.Code]
			if !ok || severityRank(f.Severity) > severityRank(prev.Severity) {
				podRef := ref
				f.Resource = &podRef
				// Promote the kubelet's own container state: a clean, state-true
				// command (logs --previous for a crash loop, describe for a
				// never-started pod) and - only when the detector left it blank -
				// a plain-English cause that leads with the real blocking state
				// instead of the raw issue Message ("Completed - back-off…").
				if command != "" {
					f.Command = command
				}
				if f.Cause == "" && cause != "" {
					f.Cause = cause
				}
				seen[f.Code] = f
			}
		}
	}
	out := make([]Finding, 0, len(seen))
	for _, f := range seen {
		out = append(out, f)
	}
	return out
}

// podDiagnosis reads a pod's real container state and returns a plain-English
// cause + the single most useful read-only command for it. It is honest by
// construction - every string is derived from the kubelet's own reported state
// (waiting reason, phase, readiness), never inferred. Returns ("","") when the
// pod has no clear blocking state, so the caller keeps the describe fallback.
// The command is deliberately ONE runnable line (not a describe+logs jam), and
// --previous is emitted ONLY for a crash loop - a never-started container
// (ImagePull/Pending) has no previous instance to read.
func podDiagnosis(pod *corev1.Pod) (cause, command string) {
	if pod == nil {
		return "", ""
	}
	ns := ""
	if pod.Namespace != "" {
		ns = " -n " + pod.Namespace
	}
	describe := "kubectl describe pod " + pod.Name + ns
	statuses := append(append([]corev1.ContainerStatus{}, pod.Status.InitContainerStatuses...), pod.Status.ContainerStatuses...)
	for _, cs := range statuses {
		w := cs.State.Waiting
		if w == nil {
			continue
		}
		switch w.Reason {
		case "CrashLoopBackOff":
			if lastOOM(cs) {
				return fmt.Sprintf("Container %q was OOMKilled (out of memory) and is crash-looping", cs.Name),
					"kubectl logs " + pod.Name + ns + " --previous"
			}
			return fmt.Sprintf("Container %q is crash-looping (CrashLoopBackOff)", cs.Name),
				"kubectl logs " + pod.Name + ns + " --previous"
		case "ImagePullBackOff", "ErrImagePull", "InvalidImageName":
			return fmt.Sprintf("Container %q cannot pull its image (%s)", cs.Name, w.Reason), describe
		case "CreateContainerConfigError", "CreateContainerError":
			return fmt.Sprintf("Container %q failed to start (%s)", cs.Name, w.Reason), describe
		}
	}
	// A container OOMKilled but not (yet) parked in CrashLoopBackOff waiting.
	for _, cs := range statuses {
		if t := cs.State.Terminated; t != nil && t.Reason == "OOMKilled" {
			return fmt.Sprintf("Container %q was OOMKilled (out of memory)", cs.Name),
				"kubectl logs " + pod.Name + ns + " --previous"
		}
	}
	// An init container that hasn't completed blocks the main containers from
	// ever starting - name it instead of the generic "Pending" below.
	for _, cs := range pod.Status.InitContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode == 0 {
			continue
		}
		if cs.State.Waiting != nil {
			continue // its waiting reason was already handled above
		}
		return fmt.Sprintf("Init container %q hasn't completed - the main containers won't start until it does", cs.Name), describe
	}
	if pod.Status.Phase == corev1.PodPending {
		return "Pod is Pending (not scheduled, or its containers haven't started)", describe
	}
	if pod.Status.Phase == corev1.PodRunning && !podIsReady(pod) {
		return "Pod is Running but not Ready (readiness probe failing)", describe
	}
	return "", ""
}

// hasLoadBalancerFinding reports whether a finding already covers a pending
// LoadBalancer (the standing detector emits one past its grace period).
func hasLoadBalancerFinding(fs []Finding) bool {
	for _, f := range fs {
		if strings.Contains(strings.ToLower(f.Code), "loadbalancer") || strings.Contains(strings.ToLower(f.Message), "loadbalancer") {
			return true
		}
	}
	return false
}

// lastOOM reports whether the container's most recent termination was an OOM kill.
func lastOOM(cs corev1.ContainerStatus) bool {
	return cs.LastTerminationState.Terminated != nil && cs.LastTerminationState.Terminated.Reason == "OOMKilled"
}

// podIsReady reports whether the pod's Ready condition is True.
func podIsReady(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func severityRank(s string) int {
	switch s {
	case SeverityCritical:
		return 3
	case SeverityWarning:
		return 2
	case SeverityInfo:
		return 1
	}
	return 0
}

// selectedPods returns the pods matching svc.Spec.Selector in svc.Namespace.
// The second return value is true when the lister errored: callers must mark
// the Pods hop as having unreadable state instead of treating an empty slice
// as "no backends", which would mislead the operator about path health.
func selectedPods(deps Deps, svc *corev1.Service) (pods []*corev1.Pod, unreadable bool) {
	if svc == nil || len(svc.Spec.Selector) == 0 {
		// Genuinely nothing to read: no Service, or a headless/selectorless
		// Service that has no pod backends to enumerate.
		return nil, false
	}
	if deps.Cache == nil || deps.Cache.Pods() == nil {
		// A selector exists but the Pods lister is unavailable (Pods kind
		// RBAC-disabled at startup, or cache not wired). We can't read pod
		// state, so this is uncertain - mark unreadable like the err path
		// rather than reporting a confident "0 ready pods".
		return nil, true
	}
	got, err := deps.Cache.Pods().Pods(svc.Namespace).List(labels.SelectorFromSet(labels.Set(svc.Spec.Selector)))
	if err != nil {
		return nil, true
	}
	// A namespace-scoped Pods informer (narrow pod RBAC) returns an EMPTY slice with
	// no error for a namespace it doesn't watch. That empty is "out of scope", not
	// "0 pods" - reporting a confident "no backends / 0 ready" for a Service whose
	// namespace falls outside pod scope would false-condemn it. Trust an empty list
	// only when the informer actually covers this namespace.
	if len(got) == 0 && !deps.Cache.KindCoversNamespace("pods", svc.Namespace) {
		return nil, true
	}
	return got, false
}

// livePods drops pods that aren't serving - terminal (Succeeded/Failed) or being
// deleted - so counts reflect actually-running pods, not stale/old ones lingering
// under the same selector (e.g. a controller "ready/total" inflated by old pods).
func livePods(pods []*corev1.Pod) []*corev1.Pod {
	out := make([]*corev1.Pod, 0, len(pods))
	for _, p := range pods {
		if p == nil || p.DeletionTimestamp != nil || p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		out = append(out, p)
	}
	return out
}

func readyCount(pods []*corev1.Pod) int {
	n := 0
	for _, pod := range pods {
		if pod == nil {
			continue
		}
		for _, c := range pod.Status.Conditions {
			if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
				n++
				break
			}
		}
	}
	return n
}

// serviceUpstreams reverse-walks Ingresses and Gateway-API Routes pointing at
// the Service. Each upstream is one Hop with its own findings; we don't
// chain through to the route's own pods (that's the route's own trace).
func serviceUpstreams(deps Deps, svc *corev1.Service) []Hop {
	var out []Hop
	out = append(out, ingressUpstreamsForService(deps, svc)...)
	out = append(out, routeUpstreamsForService(deps, svc, "HTTPRoute")...)
	out = append(out, routeUpstreamsForService(deps, svc, "GRPCRoute")...)
	sortHopsByResource(out)
	return out
}

func ingressUpstreamsForService(deps Deps, svc *corev1.Service) []Hop {
	if deps.Cache == nil || deps.Cache.Ingresses() == nil {
		return nil
	}
	ingresses, err := deps.Cache.Ingresses().Ingresses(svc.Namespace).List(labels.Everything())
	if err != nil {
		return nil
	}
	var out []Hop
	for _, ing := range ingresses {
		if !ingressReferencesService(ing, svc.Name) {
			continue
		}
		ref := ResourceRef{Group: "networking.k8s.io", Kind: "Ingress", Namespace: ing.Namespace, Name: ing.Name}
		out = append(out, Hop{
			Resource: ref,
			Edge:     "Ingress->Service",
			Findings: hopFindings(deps.Issues, ref),
			// Config is what probeIngress reads to decide which hostnames
			// to DNS / TCP / TLS / HTTP probe. Omitting it left upstream
			// Ingress hops out of the active layer entirely even though
			// ?probe=true walks them.
			Config: ingressConfig(ing),
		})
	}
	return out
}

func ingressReferencesService(ing *networkingIngress, svcName string) bool {
	if ing == nil {
		return false
	}
	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil && ing.Spec.DefaultBackend.Service.Name == svcName {
		return true
	}
	for _, rule := range ing.Spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, p := range rule.HTTP.Paths {
			if p.Backend.Service != nil && p.Backend.Service.Name == svcName {
				return true
			}
		}
	}
	return false
}

func routeUpstreamsForService(deps Deps, svc *corev1.Service, kind string) []Hop {
	gvr, ok := deps.Discovery.GetGVRWithGroup(kind, "gateway.networking.k8s.io")
	if !ok {
		return nil
	}
	if deps.Dynamic == nil {
		return nil
	}
	routes, err := deps.Dynamic.ListWatched(gvr)
	if err != nil || len(routes) == 0 {
		// Some clusters only have the GVR namespaced. Try cluster-wide first
		// - backendRefs in HTTPRoute / GRPCRoute can be cross-namespace
		// (with ReferenceGrant), so a Service-namespace-only fallback would
		// silently miss routes attaching from other namespaces. Fall back to
		// the Service's namespace only when cluster-wide fails too.
		if routes2, err2 := deps.Dynamic.List(gvr, ""); err2 == nil && len(routes2) > 0 {
			routes = routes2
		} else {
			routes3, _ := deps.Dynamic.List(gvr, svc.Namespace)
			routes = routes3
		}
	}
	var out []Hop
	for _, route := range routes {
		if !routeReferencesService(route, svc.Namespace, svc.Name) {
			continue
		}
		ref := ResourceRef{Group: "gateway.networking.k8s.io", Kind: kind, Namespace: route.GetNamespace(), Name: route.GetName()}
		// A Route referencing this Service from a namespace outside the
		// caller's scope still belongs in the trace (so the topology
		// isn't a lie) but its findings are suppressed; the existence
		// of the dependency is in-scope, the Route's own state is not.
		if !deps.NamespaceAllowed(route.GetNamespace()) {
			out = append(out, Hop{
				Resource: ref,
				Edge:     kind + "->Service",
				Meta:     map[string]any{"endpointSource": "unknown"},
				Findings: []Finding{{
					Code:     "rbac:cross-namespace-redacted",
					Severity: SeverityInfo,
					Message:  fmt.Sprintf("Upstream %s %q is in namespace %q, which is outside the namespaces you can read. Its findings are not shown.", kind, route.GetName(), route.GetNamespace()),
				}},
			})
			continue
		}
		out = append(out, Hop{
			Resource: ref,
			Edge:     kind + "->Service",
			Findings: hopFindings(deps.Issues, ref),
		})
	}
	return out
}

func routeReferencesService(route *unstructured.Unstructured, svcNS, svcName string) bool {
	rules, found, _ := unstructured.NestedSlice(route.Object, "spec", "rules")
	if !found {
		return false
	}
	for _, r := range rules {
		rm, ok := r.(map[string]any)
		if !ok {
			continue
		}
		refs, _ := rm["backendRefs"].([]any)
		for _, ref := range refs {
			refm, ok := ref.(map[string]any)
			if !ok {
				continue
			}
			group, _ := refm["group"].(string)
			kindf, _ := refm["kind"].(string)
			if group != "" || (kindf != "" && kindf != "Service") {
				continue
			}
			name, _ := refm["name"].(string)
			ns, _ := refm["namespace"].(string)
			if ns == "" {
				ns = route.GetNamespace()
			}
			if name == svcName && ns == svcNS {
				return true
			}
		}
	}
	return false
}

// traceIngressEntry: Ingress is the external entry point; no upstreams. We
// walk every unique backend Service the rules name and emit a Service +
// Pods hop pair for each one. Without that, a multi-backend Ingress where
// backend B is broken but backend A is healthy would look healthy - the
// trace would only show A's pods. Capped at maxBackends to bound fan-out;
// Truncated is set when the cap kicks in.
//
// Verdict semantics for multi-backend paths: any critical hop trips the
// verdict to broken. That slightly overstates severity for the
// "some backends broken, others healthy" case (degraded would be more
// precise), but the operator still sees every backend named in the trace
// with its own findings.
func traceIngressEntry(ctx context.Context, deps Deps, t *Trace) {
	ingLister := deps.Cache.Ingresses()
	if ingLister == nil {
		t.Verdict = VerdictUnknown
		t.Reason = "Ingress lister not ready"
		return
	}
	ing, err := ingLister.Ingresses(t.Subject.Namespace).Get(t.Subject.Name)
	if err != nil {
		t.Verdict = VerdictUnknown
		t.Reason = serviceLookupReason(err, t.Subject)
		return
	}
	ingRef := ResourceRef{Group: "networking.k8s.io", Kind: "Ingress", Namespace: ing.Namespace, Name: ing.Name}
	t.Subject = ingRef

	hops := []Hop{{
		Resource: ingRef,
		Edge:     "entry:Ingress",
		Findings: hopFindings(deps.Issues, ingRef),
		Config:   ingressConfig(ing),
	}}
	// An Ingress is only routing rules - surface WHO actually serves them (the
	// ingress controller). Quiet cases ride as a config pill (servedBy); only a
	// controller PROBLEM (none / unready) is a finding that lights up the hop.
	st := ingressControllerStatus(deps, ing)
	if st.hasFinding {
		hops[0].Findings = append(hops[0].Findings, st.finding)
		sortFindingsBySeverity(hops[0].Findings)
	}
	if st.servedBy != "" && hops[0].Config != nil {
		hops[0].Config.ServedBy = st.servedBy
		hops[0].Config.ServedByTitle = st.servedByTitle
	}

	allBackends := ingressBackendNames(ing)
	backends := allBackends
	if len(backends) > maxBackendsTraced {
		backends = backends[:maxBackendsTraced]
		t.Truncated = true
		// Verdict computation only walks the kept backends, so a broken
		// backend beyond the cap would otherwise leave the trace looking
		// healthy. The info-severity finding on the entry hop surfaces
		// the truncation explicitly, matching the Gateway routes-
		// truncated pattern.
		hops[0].Findings = append(hops[0].Findings, Finding{
			Code:     "ingress:backends-truncated",
			Severity: SeverityInfo,
			Message:  fmt.Sprintf("Tracing %d of %d backends; remaining backends were skipped to bound the trace response", maxBackendsTraced, len(allBackends)),
		})
	}
	for _, name := range backends {
		if ctx.Err() != nil {
			break // total budget exhausted - stop fanning out, return what we have
		}
		svcRef := ResourceRef{Kind: "Service", Namespace: ing.Namespace, Name: name}
		svcHop := Hop{
			Resource: svcRef,
			Edge:     "Ingress->Service",
			Findings: hopFindings(deps.Issues, svcRef),
		}
		svc, svcErr := deps.Cache.Services().Services(ing.Namespace).Get(name)
		if svcErr == nil {
			svcHop.Config = serviceConfig(svc)
		} else if !apierrors.IsNotFound(svcErr) {
			// RBAC denial / transient API failure - we can't read the backend, so
			// don't let the path read healthy. Mark endpointSource=unknown (mirrors
			// buildPodsHop's lister-error handling) so the verdict degrades to
			// unknown rather than hiding an unreadable backend. A confirmed
			// NotFound stays a real break handled by the verdict layer.
			if svcHop.Meta == nil {
				svcHop.Meta = map[string]any{}
			}
			svcHop.Meta["endpointSource"] = "unknown"
		}
		terminal := svcErr == nil && annotateServiceTerminal(&svcHop, svc)
		hasPods := svcErr == nil && !terminal && len(svc.Spec.Selector) > 0
		var selPods []*corev1.Pod
		var unreadable bool
		if hasPods {
			selPods, unreadable = selectedPods(deps, svc)
			appendTargetPortAdvisory(&svcHop, svc, selPods)
		}
		hops = append(hops, svcHop)
		if hasPods {
			hops = append(hops, buildPodsHop(deps, svc, selPods, unreadable, ingressBackendPorts(ing, name)...))
		}
	}
	t.Downstream = hops
}

// ingressBackendPorts returns the Service port(s) an Ingress references for a
// given backend Service name (numeric or named), so the NetworkPolicy verdict
// can be scoped to the path's actual port rather than every Service port.
func ingressBackendPorts(ing *networkingIngress, name string) []string {
	if ing == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(svc *networkingv1.IngressServiceBackend) {
		if svc == nil || svc.Name != name {
			return
		}
		p := ingressBackendPortString(svc.Port)
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if ing.Spec.DefaultBackend != nil {
		add(ing.Spec.DefaultBackend.Service)
	}
	for _, rule := range ing.Spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, p := range rule.HTTP.Paths {
			add(p.Backend.Service)
		}
	}
	return out
}

// maxBackendsTraced caps the per-backend Service+Pods fan-out for Ingress
// and Route subjects. Real-world Ingresses with more than a handful of
// backends are rare; the cap bounds response size + selector-match work.
// Truncated is set on the Trace when this kicks in so the UI surfaces
// "showing N of M".
const maxBackendsTraced = 5

// ingressConfig captures the spec.rules[] shape (hosts + paths + backend
// service+port) so the trace's Ingress hop names the URLs and ports it
// actually owns. Hostnames are flattened to a top-level field for fast
// scanning - operators usually ask "which hosts does this Ingress serve"
// before they ask "for each host, what paths".
func ingressConfig(ing *networkingv1.Ingress) *HopConfig {
	if ing == nil {
		return nil
	}
	c := &HopConfig{}
	hostsSeen := map[string]bool{}
	addHost := func(h string) {
		if h == "" || hostsSeen[h] {
			return
		}
		hostsSeen[h] = true
		c.Hostnames = append(c.Hostnames, h)
	}
	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
		c.Rules = append(c.Rules, RouteRule{
			Paths: []string{"(default backend)"},
			Backends: []BackendRef{{
				Kind: "Service",
				Name: ing.Spec.DefaultBackend.Service.Name,
				Port: ingressBackendPortString(ing.Spec.DefaultBackend.Service.Port),
			}},
		})
	}
	for _, rule := range ing.Spec.Rules {
		addHost(rule.Host)
		if rule.HTTP == nil {
			continue
		}
		for _, p := range rule.HTTP.Paths {
			path := p.Path
			if path == "" {
				path = "/"
			}
			rr := RouteRule{Paths: []string{path}}
			if rule.Host != "" {
				rr.Hosts = []string{rule.Host}
			}
			if p.Backend.Service != nil {
				rr.Backends = append(rr.Backends, BackendRef{
					Kind: "Service",
					Name: p.Backend.Service.Name,
					Port: ingressBackendPortString(p.Backend.Service.Port),
				})
			}
			c.Rules = append(c.Rules, rr)
		}
	}
	// Record which hosts terminate TLS so the probe only tests 443 where the
	// Ingress actually serves HTTPS. Probing 443 on a plain-HTTP host dials a
	// port the Ingress doesn't own and false-reports unreachable / cert error.
	for _, t := range ing.Spec.TLS {
		if len(t.Hosts) == 0 {
			// TLS with no host list = default cert serving every host on 443.
			c.TLSHosts = append(c.TLSHosts, c.Hostnames...)
			continue
		}
		c.TLSHosts = append(c.TLSHosts, t.Hosts...)
	}
	if ing.Spec.IngressClassName != nil && *ing.Spec.IngressClassName != "" {
		// Surface IngressClass as a low-frequency "Selector"-style field;
		// the UI renders it as a chip next to the type/clusterIP set.
		c.Selector = map[string]string{"ingressClass": *ing.Spec.IngressClassName}
	}
	// The external entry address a controller published (status.loadBalancer) -
	// the single most useful "front door" fact. Reuses Addresses (Gateway's
	// field) so the UI renders it without new geometry.
	c.Addresses = ingressEntryAddress(ing)
	return c
}

func ingressBackendPortString(p networkingv1.ServiceBackendPort) string {
	if p.Name != "" {
		return p.Name
	}
	if p.Number > 0 {
		return fmt.Sprintf("%d", p.Number)
	}
	return ""
}

func ingressBackendNames(ing *networkingIngress) []string {
	if ing == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(n string) {
		if n == "" || seen[n] {
			return
		}
		seen[n] = true
		out = append(out, n)
	}
	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
		add(ing.Spec.DefaultBackend.Service.Name)
	}
	for _, rule := range ing.Spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, p := range rule.HTTP.Paths {
			if p.Backend.Service != nil {
				add(p.Backend.Service.Name)
			}
		}
	}
	return out
}

// traceRouteEntry: HTTPRoute or GRPCRoute. Downstream is Route → (Service +
// Pods) per backend; upstreams are the route's parent Gateways via
// parentRefs. Every backend is walked, not just the first - a route fanning
// out to N services where one is broken must surface that backend's hop or
// the verdict lies. Cross-namespace backends respect the BackendRef's own
// namespace.
func traceRouteEntry(ctx context.Context, deps Deps, t *Trace, kind string) {
	gvr, ok := deps.Discovery.GetGVRWithGroup(kind, "gateway.networking.k8s.io")
	if !ok {
		t.Verdict = VerdictUnknown
		t.Reason = kind + " API not available in this cluster"
		return
	}
	if deps.Dynamic == nil {
		t.Verdict = VerdictUnknown
		t.Reason = kind + " could not be read in this cluster"
		return
	}
	route, err := deps.Dynamic.Get(gvr, t.Subject.Namespace, t.Subject.Name)
	if err != nil || route == nil {
		t.Verdict = VerdictUnknown
		t.Reason = serviceLookupReason(err, t.Subject)
		return
	}
	routeRef := ResourceRef{Group: "gateway.networking.k8s.io", Kind: kind, Namespace: route.GetNamespace(), Name: route.GetName()}
	t.Subject = routeRef

	hops := []Hop{{
		Resource: routeRef,
		Edge:     "entry:" + kind,
		Findings: hopFindings(deps.Issues, routeRef),
		Config:   routeConfig(route),
	}}

	allBackends := routeBackends(route)
	backends := allBackends
	if len(backends) > maxBackendsTraced {
		backends = backends[:maxBackendsTraced]
		t.Truncated = true
		hops[0].Findings = append(hops[0].Findings, Finding{
			Code:     "route:backends-truncated",
			Severity: SeverityInfo,
			Message:  fmt.Sprintf("Tracing %d of %d backends; remaining backends were skipped to bound the trace response", maxBackendsTraced, len(allBackends)),
		})
	}
	for _, b := range backends {
		if ctx.Err() != nil {
			break // total budget exhausted - stop fanning out, return what we have
		}
		svcRef := ResourceRef{Kind: "Service", Namespace: b.Namespace, Name: b.Name}
		// A backendRef pointing at a Service the caller can't read must
		// still appear in the trace (so the path doesn't pretend it
		// doesn't exist) but its config + pod fan-out + probes are
		// suppressed and the hop is marked unverifiable. Without the
		// scope check, the cluster-wide cache would leak resources the
		// REST handler did not authorize. See Deps.AllowedNamespaces.
		if !deps.NamespaceAllowed(b.Namespace) {
			hops = append(hops, Hop{
				Resource: svcRef,
				Edge:     kind + "->Service",
				Meta:     map[string]any{"endpointSource": "unknown"},
				Findings: []Finding{{
					Code:     "rbac:cross-namespace-redacted",
					Severity: SeverityInfo,
					Message:  fmt.Sprintf("Backend Service %q is in namespace %q, which is outside the namespaces you can read. Its config and probe results are not shown.", b.Name, b.Namespace),
				}},
			})
			continue
		}
		svcHop := Hop{
			Resource: svcRef,
			Edge:     kind + "->Service",
			Findings: hopFindings(deps.Issues, svcRef),
		}
		svc, svcErr := deps.Cache.Services().Services(b.Namespace).Get(b.Name)
		if svcErr == nil {
			svcHop.Config = serviceConfig(svc)
		} else if !apierrors.IsNotFound(svcErr) {
			// RBAC denial / transient API failure - mark the backend unreadable so
			// the verdict degrades to unknown instead of reading healthy. A
			// confirmed NotFound stays a real break for the verdict layer.
			if svcHop.Meta == nil {
				svcHop.Meta = map[string]any{}
			}
			svcHop.Meta["endpointSource"] = "unknown"
		}
		// A backend explicitly weighted to 0 while a sibling carries traffic is
		// drained by design - it serves no requests, so trace it informationally
		// (no pod fan-out, no probes) and keep it out of the verdict/coverage
		// failure tally. Folding a down weight-0 backend in would false-condemn a
		// path that intentionally carries zero traffic.
		if routeBackendDrained(route, b.Namespace, b.Name) {
			if svcHop.Meta == nil {
				svcHop.Meta = map[string]any{}
			}
			svcHop.Meta["drained"] = true
			svcHop.Findings = append(svcHop.Findings, Finding{
				Code:     "route:drained-weight-zero",
				Severity: SeverityInfo,
				Message:  fmt.Sprintf("Backend Service %q is weighted to 0 while a sibling backend carries traffic - drained / canary-cutover. It serves no requests by design, so it was not probed.", b.Name),
			})
			hops = append(hops, svcHop)
			continue
		}
		terminal := svcErr == nil && annotateServiceTerminal(&svcHop, svc)
		hasPods := svcErr == nil && !terminal && len(svc.Spec.Selector) > 0
		var selPods []*corev1.Pod
		var unreadable bool
		if hasPods {
			selPods, unreadable = selectedPods(deps, svc)
			appendTargetPortAdvisory(&svcHop, svc, selPods)
		}
		hops = append(hops, svcHop)
		if hasPods {
			hops = append(hops, buildPodsHop(deps, svc, selPods, unreadable, routeBackendPorts(route, b.Namespace, b.Name)...))
		}
	}
	t.Downstream = hops
	t.Upstreams = routeParentGateways(deps, route)
}

// routeConfig captures the route's hostnames + per-rule match/backend
// shape. Unlike Ingress, HTTPRoute paths can be regex/prefix/exact - we
// flatten to a single display string per match (the matcher type is shown
// as a prefix like "PathPrefix:") so the UI doesn't need a sub-tab.
func routeConfig(route *unstructured.Unstructured) *HopConfig {
	if route == nil {
		return nil
	}
	c := &HopConfig{}
	hostnames, _, _ := unstructured.NestedStringSlice(route.Object, "spec", "hostnames")
	c.Hostnames = hostnames

	rules, found, _ := unstructured.NestedSlice(route.Object, "spec", "rules")
	if !found {
		return c
	}
	for _, r := range rules {
		rm, ok := r.(map[string]any)
		if !ok {
			continue
		}
		var paths []string
		matches, _ := rm["matches"].([]any)
		for _, m := range matches {
			mm, ok := m.(map[string]any)
			if !ok {
				continue
			}
			pathSpec, _ := mm["path"].(map[string]any)
			if pathSpec != nil {
				pType, _ := pathSpec["type"].(string)
				pValue, _ := pathSpec["value"].(string)
				if pValue == "" {
					pValue = "/"
				}
				if pType != "" && pType != "PathPrefix" {
					paths = append(paths, pType+":"+pValue)
				} else {
					paths = append(paths, pValue)
				}
			}
		}
		var backends []BackendRef
		refs, _ := rm["backendRefs"].([]any)
		for _, ref := range refs {
			refm, ok := ref.(map[string]any)
			if !ok {
				continue
			}
			group, _ := refm["group"].(string)
			kind, _ := refm["kind"].(string)
			if kind == "" {
				kind = "Service"
			}
			name, _ := refm["name"].(string)
			ns, _ := refm["namespace"].(string)
			b := BackendRef{Kind: kind, Name: name, Namespace: ns}
			if group != "" {
				b.Kind = group + "/" + kind
			}
			b.Port = backendPortString(refm["port"])
			backends = append(backends, b)
		}
		rr := RouteRule{Paths: paths, Backends: backends}
		c.Rules = append(c.Rules, rr)
	}
	return c
}

func backendPortString(v any) string {
	switch n := v.(type) {
	case int64:
		return fmt.Sprintf("%d", n)
	case int32:
		return fmt.Sprintf("%d", n)
	case int:
		return fmt.Sprintf("%d", n)
	case float64:
		if n == float64(int64(n)) {
			return fmt.Sprintf("%d", int64(n))
		}
	case string:
		return n
	}
	return ""
}

// routeBackendPorts returns the Service port(s) an HTTPRoute/GRPCRoute
// backendRef references for a given backend Service (numeric or named), so the
// NetworkPolicy verdict can be scoped to the path's port rather than every
// Service port.
func routeBackendPorts(route *unstructured.Unstructured, namespace, name string) []string {
	rules, found, _ := unstructured.NestedSlice(route.Object, "spec", "rules")
	if !found {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, r := range rules {
		rm, ok := r.(map[string]any)
		if !ok {
			continue
		}
		refs, _ := rm["backendRefs"].([]any)
		for _, ref := range refs {
			refm, ok := ref.(map[string]any)
			if !ok {
				continue
			}
			group, _ := refm["group"].(string)
			kind, _ := refm["kind"].(string)
			if group != "" || (kind != "" && kind != "Service") {
				continue
			}
			refName, _ := refm["name"].(string)
			ns, _ := refm["namespace"].(string)
			if ns == "" {
				ns = route.GetNamespace()
			}
			if refName != name || ns != namespace {
				continue
			}
			p := backendPortString(refm["port"])
			if p != "" && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// routeBackendDrained reports whether a Gateway-API backendRef is intentionally
// drained: its weight is EXPLICITLY 0 in every rule that references it while at
// least one sibling backendRef in such a rule carries traffic (weight>0 or
// omitted). A drained backend (canary cutover, blue/green retire) receives no
// requests by design, so it must not be probed or condemned as a broken route.
// A weight that is omitted anywhere defaults to traffic-carrying → not drained.
func routeBackendDrained(route *unstructured.Unstructured, namespace, name string) bool {
	rules, found, _ := unstructured.NestedSlice(route.Object, "spec", "rules")
	if !found {
		return false
	}
	referenced := false
	drainedWithLiveSibling := false
	for _, r := range rules {
		rm, ok := r.(map[string]any)
		if !ok {
			continue
		}
		refs, _ := rm["backendRefs"].([]any)
		var selfWeights []int64
		siblingCarriesTraffic := false
		for _, ref := range refs {
			refm, ok := ref.(map[string]any)
			if !ok {
				continue
			}
			group, _ := refm["group"].(string)
			kind, _ := refm["kind"].(string)
			if group != "" || (kind != "" && kind != "Service") {
				continue
			}
			refName, _ := refm["name"].(string)
			ns, _ := refm["namespace"].(string)
			if ns == "" {
				ns = route.GetNamespace()
			}
			w, hasW := backendRefWeight(refm)
			if refName == name && ns == namespace {
				if !hasW {
					return false // weight omitted here → carries traffic, not drained
				}
				selfWeights = append(selfWeights, w)
				referenced = true
			} else if !hasW || w > 0 {
				siblingCarriesTraffic = true
			}
		}
		for _, w := range selfWeights {
			if w != 0 {
				return false // carries traffic in some rule → not drained
			}
		}
		if len(selfWeights) > 0 && siblingCarriesTraffic {
			drainedWithLiveSibling = true
		}
	}
	return referenced && drainedWithLiveSibling
}

// backendRefWeight reads a backendRef's weight from the unstructured map,
// reporting whether the field was present (an explicit 0 must be distinguished
// from an omitted weight, which defaults to traffic-carrying).
func backendRefWeight(refm map[string]any) (int64, bool) {
	v, ok := refm["weight"]
	if !ok || v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case float64:
		return int64(n), true
	}
	return 0, false
}

func routeBackends(route *unstructured.Unstructured) []ResourceRef {
	rules, found, _ := unstructured.NestedSlice(route.Object, "spec", "rules")
	if !found {
		return nil
	}
	seen := map[string]bool{}
	var out []ResourceRef
	for _, r := range rules {
		rm, ok := r.(map[string]any)
		if !ok {
			continue
		}
		refs, _ := rm["backendRefs"].([]any)
		for _, ref := range refs {
			refm, ok := ref.(map[string]any)
			if !ok {
				continue
			}
			group, _ := refm["group"].(string)
			kind, _ := refm["kind"].(string)
			if group != "" || (kind != "" && kind != "Service") {
				continue
			}
			name, _ := refm["name"].(string)
			ns, _ := refm["namespace"].(string)
			if ns == "" {
				ns = route.GetNamespace()
			}
			key := ns + "/" + name
			if name == "" || seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, ResourceRef{Kind: "Service", Namespace: ns, Name: name})
		}
	}
	return out
}

func routeParentGateways(deps Deps, route *unstructured.Unstructured) []Hop {
	parents, found, _ := unstructured.NestedSlice(route.Object, "spec", "parentRefs")
	if !found {
		return nil
	}
	gvr, ok := deps.Discovery.GetGVRWithGroup("Gateway", "gateway.networking.k8s.io")
	if !ok {
		return nil
	}
	if deps.Dynamic == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []Hop
	for _, p := range parents {
		pm, ok := p.(map[string]any)
		if !ok {
			continue
		}
		group, _ := pm["group"].(string)
		kind, _ := pm["kind"].(string)
		if (group != "" && group != "gateway.networking.k8s.io") || (kind != "" && kind != "Gateway") {
			continue
		}
		name, _ := pm["name"].(string)
		ns, _ := pm["namespace"].(string)
		if ns == "" {
			ns = route.GetNamespace()
		}
		key := ns + "/" + name
		if name == "" || seen[key] {
			continue
		}
		seen[key] = true
		ref := ResourceRef{Group: "gateway.networking.k8s.io", Kind: "Gateway", Namespace: ns, Name: name}
		// A parent Gateway in a namespace outside the caller's scope
		// still belongs in the trace so the path doesn't pretend the
		// route is orphaned, but config + probes + findings are
		// redacted and the hop is marked unverifiable.
		if !deps.NamespaceAllowed(ns) {
			out = append(out, Hop{
				Resource: ref,
				Edge:     "Gateway->Route",
				Meta:     map[string]any{"endpointSource": "unknown"},
				Findings: []Finding{{
					Code:     "rbac:cross-namespace-redacted",
					Severity: SeverityInfo,
					Message:  fmt.Sprintf("Parent Gateway %q is in namespace %q, which is outside the namespaces you can read. Its config and probe results are not shown.", name, ns),
				}},
			})
			continue
		}
		gw, gwErr := deps.Dynamic.Get(gvr, ns, name)
		findings := hopFindings(deps.Issues, ref)
		// Only escalate to "missing-parent" on a confirmed NotFound. The
		// dynamic cache wraps its own sentinel rather than apimachinery's
		// StatusError, so check both: apierrors.IsNotFound for the direct
		// apiserver path, errors.Is(k8score.ErrResourceNotFound) for the
		// cache-miss path. Any other error (RBAC denial, transient
		// failure) marks the hop unverifiable instead so the verdict
		// layer surfaces uncertainty rather than reporting the parent
		// as missing.
		meta := map[string]any{}
		switch {
		case errors.Is(gwErr, k8score.ErrResourceNotFound), apierrors.IsNotFound(gwErr):
			findings = append(findings, Finding{
				Code:     "gateway:missing-parent",
				Severity: SeverityCritical,
				Message:  fmt.Sprintf("parentRef points at Gateway %q in namespace %q which does not exist", name, ns),
				Command:  fmt.Sprintf("kubectl get gateway.gateway.networking.k8s.io -n %s", ns),
			})
		case gw == nil && gwErr != nil:
			// Existence of the Gateway is undetermined. Mark the hop
			// unverifiable so the verdict reads "can't be verified"
			// rather than implying a clean state.
			meta["endpointSource"] = "unknown"
		}
		hop := Hop{
			Resource: ref,
			Edge:     "Gateway->Route",
			Findings: findings,
		}
		if len(meta) > 0 {
			hop.Meta = meta
		}
		// Config drives probeGateway (listeners + addresses → TCP / TLS).
		// Omitting it left upstream Gateway hops outside the active layer
		// even though ?probe=true walks them.
		if gw != nil {
			hop.Config = gatewayConfig(gw)
		}
		out = append(out, hop)
	}
	return out
}

// traceGatewayEntry: a Gateway's downstream is its attached routes as
// parallel hops (capped at gatewayRouteCap to keep the response bounded on
// shared gateways). We don't recurse into each route's own pods - the Diagnose
// tab on the route does that. The Gateway is the subject of its own posture;
// upstreams (which controller manages it) are not modeled here.
func traceGatewayEntry(ctx context.Context, deps Deps, t *Trace) {
	gvr, ok := deps.Discovery.GetGVRWithGroup("Gateway", "gateway.networking.k8s.io")
	if !ok {
		t.Verdict = VerdictUnknown
		t.Reason = "Gateway API not available in this cluster"
		return
	}
	if deps.Dynamic == nil {
		t.Verdict = VerdictUnknown
		t.Reason = "Gateway could not be read in this cluster"
		return
	}
	gw, err := deps.Dynamic.Get(gvr, t.Subject.Namespace, t.Subject.Name)
	if err != nil || gw == nil {
		t.Verdict = VerdictUnknown
		t.Reason = serviceLookupReason(err, t.Subject)
		return
	}
	gwRef := ResourceRef{Group: "gateway.networking.k8s.io", Kind: "Gateway", Namespace: gw.GetNamespace(), Name: gw.GetName()}
	t.Subject = gwRef
	hops := []Hop{{
		Resource: gwRef,
		Edge:     "entry:Gateway",
		Findings: hopFindings(deps.Issues, gwRef),
		Config:   gatewayConfig(gw),
	}}

	attached, total := attachedRoutes(deps, gw)
	// Routes in namespaces the caller can't read render as a referenced
	// ResourceRef with redacted findings, matching the other three
	// cross-namespace fan-out sites in this package. The route's name +
	// namespace are still visible (they identify a dependency the
	// operator should know exists) but the route's own findings stay
	// behind the RBAC boundary.
	for _, ref := range attached {
		if ctx.Err() != nil {
			break // total budget exhausted - stop fanning out, return what we have
		}
		if !deps.NamespaceAllowed(ref.Namespace) {
			hops = append(hops, Hop{
				Resource: ref,
				Edge:     "Gateway->" + ref.Kind,
				Meta:     map[string]any{"endpointSource": "unknown"},
				Findings: []Finding{{
					Code:     "rbac:cross-namespace-redacted",
					Severity: SeverityInfo,
					Message:  fmt.Sprintf("Attached %s %q is in namespace %q, which is outside the namespaces you can read. Its findings are not shown.", ref.Kind, ref.Name, ref.Namespace),
				}},
			})
			continue
		}
		hops = append(hops, Hop{
			Resource: ref,
			Edge:     "Gateway->" + ref.Kind,
			Findings: hopFindings(deps.Issues, ref),
		})
	}
	if total > len(attached) {
		t.Truncated = true
		hops = append(hops, Hop{
			Resource: ResourceRef{Kind: "Routes"},
			Edge:     "Gateway->Routes",
			Findings: []Finding{{
				Code:     "gateway:routes-truncated",
				Severity: SeverityInfo,
				Message:  fmt.Sprintf("Showing %d of %d attached routes; cap protects response size on shared gateways", len(attached), total),
			}},
		})
	}
	t.Downstream = hops
}

// gatewayConfig captures listeners (port/protocol/hostname/name) and the
// status.addresses field - Gateway-API surfaces its routable identity via
// addresses once the controller assigns them.
func gatewayConfig(gw *unstructured.Unstructured) *HopConfig {
	if gw == nil {
		return nil
	}
	c := &HopConfig{}
	listeners, _, _ := unstructured.NestedSlice(gw.Object, "spec", "listeners")
	for _, l := range listeners {
		lm, ok := l.(map[string]any)
		if !ok {
			continue
		}
		gl := GatewayListener{}
		if v, ok := lm["name"].(string); ok {
			gl.Name = v
		}
		switch v := lm["port"].(type) {
		case int64:
			gl.Port = int32(v)
		case int32:
			gl.Port = v
		case int:
			gl.Port = int32(v)
		case float64:
			gl.Port = int32(v)
		}
		if v, ok := lm["protocol"].(string); ok {
			gl.Protocol = v
		}
		if v, ok := lm["hostname"].(string); ok {
			gl.Hostname = v
		}
		c.Listeners = append(c.Listeners, gl)
	}
	addresses, _, _ := unstructured.NestedSlice(gw.Object, "status", "addresses")
	for _, a := range addresses {
		am, ok := a.(map[string]any)
		if !ok {
			continue
		}
		if v, ok := am["value"].(string); ok && v != "" {
			c.Addresses = append(c.Addresses, v)
		}
	}
	return c
}

func attachedRoutes(deps Deps, gw *unstructured.Unstructured) ([]ResourceRef, int) {
	var all []ResourceRef
	for _, kind := range []string{"HTTPRoute", "GRPCRoute"} {
		gvr, ok := deps.Discovery.GetGVRWithGroup(kind, "gateway.networking.k8s.io")
		if !ok {
			continue
		}
		if deps.Dynamic == nil {
			continue
		}
		// Same fallback ladder as routeUpstreamsForService: ListWatched is
		// the union of every running informer (best case); if it's empty or
		// the watch cache isn't ready, try cluster-wide then the Gateway's
		// namespace. A Gateway can have cross-namespace Routes attach to
		// it, so the namespace-only fallback alone would silently miss them.
		routes, err := deps.Dynamic.ListWatched(gvr)
		if err != nil || len(routes) == 0 {
			if routes2, err2 := deps.Dynamic.List(gvr, ""); err2 == nil && len(routes2) > 0 {
				routes = routes2
			} else {
				routes3, _ := deps.Dynamic.List(gvr, gw.GetNamespace())
				routes = routes3
			}
		}
		for _, r := range routes {
			if routeAttachedToGateway(r, gw.GetNamespace(), gw.GetName()) {
				all = append(all, ResourceRef{Group: "gateway.networking.k8s.io", Kind: kind, Namespace: r.GetNamespace(), Name: r.GetName()})
			}
		}
	}
	sortRefs(all)
	if len(all) > gatewayRouteCap {
		return all[:gatewayRouteCap], len(all)
	}
	return all, len(all)
}

func routeAttachedToGateway(route *unstructured.Unstructured, gwNS, gwName string) bool {
	parents, found, _ := unstructured.NestedSlice(route.Object, "spec", "parentRefs")
	if !found {
		return false
	}
	for _, p := range parents {
		pm, ok := p.(map[string]any)
		if !ok {
			continue
		}
		// parentRef.kind defaults to "Gateway" per the Gateway API spec.
		// parentRef.group defaults to "gateway.networking.k8s.io". A Route
		// that points at a same-named non-Gateway parent (e.g. another
		// Route in a tree) must not appear on a Gateway trace.
		kind, _ := pm["kind"].(string)
		if kind != "" && kind != "Gateway" {
			continue
		}
		group, _ := pm["group"].(string)
		if group != "" && group != "gateway.networking.k8s.io" {
			continue
		}
		name, _ := pm["name"].(string)
		ns, _ := pm["namespace"].(string)
		if ns == "" {
			ns = route.GetNamespace()
		}
		if name == gwName && ns == gwNS {
			return true
		}
	}
	return false
}

func refForService(svc *corev1.Service) ResourceRef {
	return ResourceRef{Kind: "Service", Namespace: svc.Namespace, Name: svc.Name}
}

func serviceLookupReason(err error, subject ResourceRef) string {
	if apierrors.IsNotFound(err) {
		return fmt.Sprintf("%s %s/%s not found in cache", subject.Kind, subject.Namespace, subject.Name)
	}
	if apierrors.IsForbidden(err) {
		return "RBAC denies access to this resource for the current user"
	}
	return strings.TrimSpace(fmt.Sprintf("lookup failed: %v", err))
}

// sortHopsByResource orders a slice of Hop deterministically while
// preserving the "external entry first" convention for Service upstream
// sections (Ingress before Gateway-API routes, then alphabetical within
// a kind). Upstream collection walks listers whose iteration order is
// map-backed, so re-runs would otherwise reorder the rendered Upstreams
// section. Alphabetic Kind ordering would invert the convention
// (GRPCRoute < HTTPRoute < Ingress), so use explicit precedence.
func sortHopsByResource(hops []Hop) {
	sort.Slice(hops, func(i, j int) bool {
		a, b := hops[i].Resource, hops[j].Resource
		if a.Kind != b.Kind {
			return hopKindPrecedence(a.Kind) < hopKindPrecedence(b.Kind)
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		return a.Name < b.Name
	})
}

func hopKindPrecedence(kind string) int {
	switch kind {
	case "Ingress":
		return 0
	case "HTTPRoute":
		return 1
	case "GRPCRoute":
		return 2
	case "Gateway":
		return 3
	}
	return 100
}

// sortRefs orders a slice of ResourceRef by (Kind, Namespace, Name) so the
// trace's attached-routes / upstream lists are stable across polls - without
// it, map iteration order leaks into the rendered output.
func sortRefs(refs []ResourceRef) {
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].Kind != refs[j].Kind {
			return refs[i].Kind < refs[j].Kind
		}
		if refs[i].Namespace != refs[j].Namespace {
			return refs[i].Namespace < refs[j].Namespace
		}
		return refs[i].Name < refs[j].Name
	})
}
