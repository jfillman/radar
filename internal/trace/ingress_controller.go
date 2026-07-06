package trace

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
)

// An Ingress is only routing RULES; the traffic is actually served by an ingress
// CONTROLLER (e.g. ingress-nginx pods behind a LoadBalancer/NodePort Service).
// This file surfaces that tier on the Ingress hop - the entry address plus a
// plain-language "who serves this" finding - WITHOUT inventing a separate node.
//
// Honesty invariants (these are the whole point - see the design review):
//   - FAIL TOWARD SILENCE. "couldn't find the controller", "couldn't read its
//     namespace", and "it's a cloud LB" must NEVER render as "no controller /
//     broken". Most production is cloud-LB or cross-namespace-RBAC.
//   - The only WARNING headlines are POSITIVELY gated: a true no-controller
//     (no class resolves AND no address AND no cloud annotations), or controller
//     pods that exist but are 0-ready.
//   - "No address" means "couldn't confirm an address was assigned", not "no
//     controller claimed it".

// ingressEntryAddress returns the external entry address(es) a controller
// published for the Ingress (status.loadBalancer.ingress[]). Empty ≠ "no
// controller" - many valid setups (bare NodePort, hostNetwork, on-prem) never
// populate it.
func ingressEntryAddress(ing *networkingv1.Ingress) []string {
	if ing == nil {
		return nil
	}
	var out []string
	for _, lb := range ing.Status.LoadBalancer.Ingress {
		switch {
		case lb.Hostname != "":
			out = append(out, lb.Hostname)
		case lb.IP != "":
			out = append(out, lb.IP)
		}
	}
	return out
}

type controllerInfo struct {
	name   string            // operator-facing name
	labels map[string]string // label set to find its pods (empty = cloud, no pods)
	cloud  bool              // served by a cloud LB - no in-cluster pods by design
}

// knownControllers maps an IngressClass spec.controller string to how to find /
// describe it. The cloud entries are load-bearing: a working ALB/GCLB Ingress
// has NO in-cluster pods by design, so without knowing it's cloud we'd "find no
// pods" and risk condemning a healthy front door. Unknown controllers fall
// through to fail-soft handling (named, never condemned).
var knownControllers = map[string]controllerInfo{
	"k8s.io/ingress-nginx":           {name: "ingress-nginx", labels: map[string]string{"app.kubernetes.io/name": "ingress-nginx", "app.kubernetes.io/component": "controller"}},
	"nginx.org/ingress-controller":   {name: "NGINX Ingress (F5)", labels: map[string]string{"app.kubernetes.io/name": "nginx-ingress"}},
	"traefik.io/ingress-controller":  {name: "Traefik", labels: map[string]string{"app.kubernetes.io/name": "traefik"}},
	"projectcontour.io/contour":      {name: "Contour", labels: map[string]string{"app.kubernetes.io/name": "contour"}},
	"haproxy.org/ingress-controller": {name: "HAProxy Ingress", labels: map[string]string{"app.kubernetes.io/instance": "haproxy-ingress"}},
	"ingress.k8s.aws/alb":            {name: "AWS Application Load Balancer", cloud: true},
	"k8s.io/ingress-gce":             {name: "Google Cloud load balancer", cloud: true},
}

// resolveIngressClass returns the name + controller string of the IngressClass
// governing the Ingress: the named class, else the cluster's default class.
// found=false when neither resolves - a POSITIVE signal that nothing is
// configured to serve it. The default-class path is the primary one in practice
// (Ingresses commonly omit ingressClassName).
//
// Reads from the DYNAMIC cache (IngressClasses isn't a typed informer in Radar)
// - already synced and RBAC-respecting, so a cluster where the caller can't
// watch ingressclasses simply yields "not found" → fail-soft, never "broken".
func resolveIngressClass(deps Deps, ing *networkingv1.Ingress) (name, controller string, found, couldRead bool) {
	// couldRead reports only the read-ERROR case (RBAC-denied / cold cache). An
	// UNWIRED dynamic/discovery client (nil at runtime - cold start / init
	// failure) is exactly that: we couldn't read the classes, so it must fall to
	// the soft "couldn't identify the controller" pill, never the no-controller
	// condemnation. couldRead=false keeps a possibly-healthy Ingress safe.
	if deps.Dynamic == nil || deps.Discovery == nil {
		return "", "", false, false
	}
	gvr, ok := deps.Discovery.GetGVRWithGroup("IngressClass", "networking.k8s.io")
	if !ok {
		// A discovery miss happens on a cold/unsynced cache too, not only when
		// the API genuinely isn't served. Fail toward silence (mirror the
		// nil-client branch above) so an unverifiable discovery state can never
		// trigger the no-controller condemnation.
		return "", "", false, false
	}
	classes, err := deps.Dynamic.ListWatched(gvr)
	// couldRead distinguishes "read the classes, none matched" (a positive
	// no-controller signal) from "couldn't read them at all" (RBAC-denied / cold
	// cache) - the latter must never condemn a possibly-healthy Ingress.
	couldRead = err == nil
	if err != nil || len(classes) == 0 {
		if c2, e2 := deps.Dynamic.List(gvr, ""); e2 == nil {
			classes = c2
			couldRead = true
		}
	}
	if len(classes) == 0 {
		// A cold/unsynced dynamic informer returns empty WITHOUT error -
		// indistinguishable from "synced and genuinely empty". Treat an empty
		// result as unverifiable so a just-created Ingress (informer not yet
		// synced) with no published LB address isn't false-condemned
		// "no-controller" before the cache catches up. Fail toward silence.
		couldRead = false
	}
	want := ""
	if ing.Spec.IngressClassName != nil {
		want = *ing.Spec.IngressClassName
	}
	controllerOf := func(ic *unstructured.Unstructured) string {
		c, _, _ := unstructured.NestedString(ic.Object, "spec", "controller")
		return c
	}
	var def *unstructured.Unstructured
	for _, ic := range classes {
		if ic == nil {
			continue
		}
		if want != "" {
			if ic.GetName() == want {
				return ic.GetName(), controllerOf(ic), true, couldRead
			}
			continue
		}
		if ic.GetAnnotations()["ingressclass.kubernetes.io/is-default-class"] == "true" {
			def = ic
		}
	}
	if want == "" && def != nil {
		return def.GetName(), controllerOf(def), true, couldRead
	}
	return "", "", false, couldRead
}

// legacyIngressClass returns the value of the legacy
// kubernetes.io/ingress.class annotation, still honored by ingress-nginx and
// ubiquitous on older clusters. An Ingress declaring its class only via this
// annotation must not be condemned as "no controller".
func legacyIngressClass(ing *networkingv1.Ingress) string {
	return strings.TrimSpace(ing.Annotations["kubernetes.io/ingress.class"])
}

// hasCloudLBAnnotations reports cloud load-balancer ingress annotations - a
// signal the Ingress is fronted by a cloud LB (no in-cluster controller pods)
// even when the controller string isn't in the known set.
func hasCloudLBAnnotations(ing *networkingv1.Ingress) bool {
	for k, v := range ing.Annotations {
		if strings.HasPrefix(k, "alb.ingress.kubernetes.io/") ||
			strings.HasPrefix(k, "ingress.gcp.kubernetes.io/") ||
			strings.HasPrefix(k, "networking.gke.io/") {
			return true
		}
		if k == "kubernetes.io/ingress.class" && (strings.Contains(v, "alb") || strings.Contains(v, "gce")) {
			return true
		}
	}
	return false
}

// findControllerPods locates a controller's pods cluster-wide by its known label
// set. found=false means the labels matched nothing - which could be a different
// controller OR RBAC hiding the namespace, so the caller must treat it as
// "couldn't see", never "broken".
func findControllerPods(deps Deps, info controllerInfo) (pods []*corev1.Pod, found bool) {
	if deps.Cache == nil || deps.Cache.Pods() == nil || len(info.labels) == 0 {
		return nil, false
	}
	got, err := deps.Cache.Pods().Pods(metav1.NamespaceAll).List(labels.SelectorFromSet(labels.Set(info.labels)))
	if err != nil || len(got) == 0 {
		return nil, false
	}
	return got, true
}

// controllerStatus is the controller-tier readout for an Ingress hop. The quiet
// cases (a controller IS serving it) become a config PILL - servedBy + its
// tooltip - so a healthy Ingress doesn't light up as a finding. Only a real
// PROBLEM (no controller / pods unready) is a Finding. This keeps the common
// healthy path silent and reserves findings for things to act on.
type controllerStatus struct {
	servedBy      string // short pill label, "" = no pill
	servedByTitle string // pill tooltip (the gloss + shared-infra + health detail)
	finding       Finding
	hasFinding    bool
}

// "ingress controller" gloss + shared-infra cue, woven into the tooltips/cause so
// a non-k8s operator learns the term and never reads shared infra as this
// Ingress's own pods.
const sharedControllerNote = "It's shared cluster infrastructure that serves this and other Ingresses."

func ingressControllerStatus(deps Deps, ing *networkingv1.Ingress) controllerStatus {
	var st controllerStatus
	if ing == nil {
		return st
	}
	addr := ingressEntryAddress(ing)
	cloudAnno := hasCloudLBAnnotations(ing)
	className, ctrlStr, classFound, classReadable := resolveIngressClass(deps, ing)
	_ = className

	if classFound {
		info, known := knownControllers[ctrlStr]
		if cloudAnno || (known && info.cloud) {
			name := "a cloud load balancer"
			if known {
				name = info.name
			}
			st.servedBy = "via " + name
			st.servedByTitle = fmt.Sprintf("Served by %s (a cloud load balancer) - no in-cluster controller pods to check.", name)
			return st
		}
		if known {
			if pods, found := findControllerPods(deps, info); found {
				// Terminal (Succeeded/Failed) or being-deleted pods aren't serving -
				// exclude them so a healthy controller isn't reported as e.g. "1/3 ready"
				// because old/crashed pods linger under the same label (a rolling update
				// leaves a Terminating old pod; a crash can leave Failed pods).
				live := livePods(pods)
				ready, total := readyCount(live), len(live)
				if ready == 0 {
					// The one in-cluster PROBLEM: pods exist but none Ready.
					st.finding = Finding{
						Code:     "ingress:controller-unready",
						Severity: SeverityWarning,
						Message:  fmt.Sprintf("The ingress controller (%s) has no ready pods - traffic to this Ingress can’t be served right now.", info.name),
						Cause:    fmt.Sprintf("An ingress controller is the component that actually serves Ingress traffic; %d of %d %s pods are Ready.", 0, total, info.name),
						Action:   "Check the ingress controller’s pods:",
						Command:  fmt.Sprintf("kubectl get pods -A -l %s", labels.SelectorFromSet(labels.Set(info.labels)).String()),
					}
					st.hasFinding = true
					return st
				}
				st.servedBy = info.name
				st.servedByTitle = fmt.Sprintf("Handled by the cluster’s %s ingress controller (%d/%d pods ready). %s", info.name, ready, total, sharedControllerNote)
				return st
			}
			// Known in-cluster controller, pods not found - almost always a
			// namespace Radar's RBAC can't read. Name it, never condemn.
			st.servedBy = info.name
			st.servedByTitle = fmt.Sprintf("Served by the %s ingress controller - Radar can’t read its pods (they may be in a namespace it can’t access). %s", info.name, sharedControllerNote)
			return st
		}
		// Class resolves to an unrecognized controller - name it, don't guess pods.
		st.servedBy = "via a controller"
		st.servedByTitle = fmt.Sprintf("Served by ingress controller %q. %s", ctrlStr, sharedControllerNote)
		return st
	}

	// No IngressClass resolved.
	if cloudAnno {
		st.servedBy = "via a cloud LB"
		st.servedByTitle = "Served by a cloud load balancer - no in-cluster controller pods to check."
		return st
	}
	if len(addr) > 0 {
		// An address was published, so a controller IS serving it - just couldn't
		// identify which. Reachable, not broken. The @addr pill already shows it,
		// so no extra servedBy pill.
		st.servedBy = "via a controller"
		st.servedByTitle = fmt.Sprintf("Reachable at %s - an ingress controller serves this, but Radar couldn’t identify which one.", strings.Join(addr, ", "))
		return st
	}
	if legacy := legacyIngressClass(ing); legacy != "" {
		// Class declared only via the legacy kubernetes.io/ingress.class annotation
		// (still honored by ingress-nginx). A class IS specified - name it, don't
		// condemn it as "no controller".
		st.servedBy = "via a controller"
		st.servedByTitle = fmt.Sprintf("Class %q is set via the legacy kubernetes.io/ingress.class annotation. %s", legacy, sharedControllerNote)
		return st
	}
	if !classReadable {
		// Couldn't read IngressClasses at all (RBAC-denied / cold cache) - that is
		// not the same as "none configured". Fail toward silence: a soft pill, never
		// a no-controller condemnation of a possibly-healthy Ingress.
		st.servedBy = "via a controller"
		st.servedByTitle = "Radar couldn’t identify the ingress controller (it couldn’t read IngressClasses). This isn’t a sign that nothing is serving the Ingress."
		return st
	}
	// POSITIVE no-controller signal: classes are readable and none resolves, no
	// address, no cloud annotations, no legacy class. Only here do we say nothing
	// serves it.
	cause := "An ingress controller is the component that actually serves Ingress traffic. None is configured here: no IngressClass resolves (none set, no default installed) and no controller has assigned it an address."
	if ing.Spec.IngressClassName != nil && *ing.Spec.IngressClassName != "" {
		// A class IS named, but no IngressClass object by that name resolved -
		// "none set" would be factually wrong and mildly condemn a configured class.
		cause = fmt.Sprintf("An ingress controller is the component that actually serves Ingress traffic. This Ingress names class %q, but no IngressClass by that name was found (it may be misspelled, not installed, or not yet synced) and no controller has assigned it an address.", *ing.Spec.IngressClassName)
	}
	st.finding = Finding{
		Code:     "ingress:no-controller",
		Severity: SeverityWarning,
		Message:  "No ingress controller is handling this - the routing rules exist but nothing is serving them.",
		Cause:    cause,
		Action:   "Install an ingress controller, or set the Ingress’s class to one that’s installed. See what’s available:",
		Command:  "kubectl get ingressclass",
	}
	st.hasFinding = true
	return st
}
