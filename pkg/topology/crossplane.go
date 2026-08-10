package topology

import (
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Crossplane relationships are spec-shape detected, not kind-enumerated:
// Managed Resources, Composites (XRs) and Claims each have provider-defined
// CRD kinds (one CRD per provider service), so there is no fixed kind list to
// key off. The generic owner-reference pass (addGenericCRDNodes) does not wire
// them because Claims have no ownerReference and XRs reference their Claim via
// spec.claimRef rather than an ownerReference — so the composed MRs have no
// owner node to attach to. This step adds the Claim/XR/MR nodes and the
// spec-ref-driven edges directly.
//
// Detection mirrors the frontend accessors in resource-utils-crossplane.ts and
// the audit walker in internal/audit/runner.go so all three agree on what
// counts as a Crossplane resource. v1↔v2 path handling (spec.crossplane.x
// first, fall back to spec.x) lives here.

// isCrossplaneMR reports whether u is a Managed Resource. An MR always carries
// a providerConfigRef (v1: spec.providerConfigRef, v2: spec.crossplane.providerConfigRef).
func isCrossplaneMR(u *unstructured.Unstructured) bool {
	if u == nil {
		return false
	}
	spec, ok := u.Object["spec"].(map[string]interface{})
	if !ok {
		return false
	}
	if _, ok := spec["providerConfigRef"].(map[string]interface{}); ok {
		return true
	}
	if cp, ok := spec["crossplane"].(map[string]interface{}); ok {
		if _, ok := cp["providerConfigRef"].(map[string]interface{}); ok {
			return true
		}
	}
	return false
}

// isCrossplaneComposite reports whether u is a Composite (XR) or a v1 Claim.
// XRs expose spec.resourceRefs (v1) or spec.crossplane.resourceRefs (v2); v1
// Claims expose singular spec.resourceRef + spec.compositionRef. MRs are
// excluded — they share the same CRD group set and are discriminated by shape.
func isCrossplaneComposite(u *unstructured.Unstructured) bool {
	if u == nil || isCrossplaneMR(u) {
		return false
	}
	spec, ok := u.Object["spec"].(map[string]interface{})
	if !ok {
		return false
	}
	if _, ok := spec["resourceRefs"].([]interface{}); ok {
		return true
	}
	if cp, ok := spec["crossplane"].(map[string]interface{}); ok {
		if _, ok := cp["resourceRefs"].([]interface{}); ok {
			return true
		}
	}
	if _, hasRef := spec["resourceRef"].(map[string]interface{}); hasRef {
		if _, hasComp := spec["compositionRef"].(map[string]interface{}); hasComp {
			return true
		}
	}
	return false
}

// crossplaneRef is a resolved composed-resource / bound-XR reference.
type crossplaneRef struct {
	group string
	kind  string
	name  string
}

func groupFromAPIVersion(apiVersion string) string {
	if i := strings.IndexByte(apiVersion, '/'); i >= 0 {
		return apiVersion[:i]
	}
	return ""
}

func refFromMap(m map[string]interface{}) (crossplaneRef, bool) {
	kind, _ := m["kind"].(string)
	name, _ := m["name"].(string)
	if kind == "" || name == "" {
		return crossplaneRef{}, false
	}
	apiVersion, _ := m["apiVersion"].(string)
	return crossplaneRef{group: groupFromAPIVersion(apiVersion), kind: kind, name: name}, true
}

// getBoundXRRef returns the XR a v1 Claim is bound to (spec.resourceRef,
// singular). Gated on spec.compositionRef so an unrelated CRD that happens to
// carry a resourceRef isn't treated as a Claim.
func getBoundXRRef(u *unstructured.Unstructured) (crossplaneRef, bool) {
	if u == nil {
		return crossplaneRef{}, false
	}
	spec, ok := u.Object["spec"].(map[string]interface{})
	if !ok {
		return crossplaneRef{}, false
	}
	if _, hasComp := spec["compositionRef"].(map[string]interface{}); !hasComp {
		return crossplaneRef{}, false
	}
	ref, ok := spec["resourceRef"].(map[string]interface{})
	if !ok {
		return crossplaneRef{}, false
	}
	return refFromMap(ref)
}

// getCrossplaneResourceRefs returns the composed-resource references of an XR
// (spec.crossplane.resourceRefs first, falling back to spec.resourceRefs).
func getCrossplaneResourceRefs(u *unstructured.Unstructured) []crossplaneRef {
	if u == nil {
		return nil
	}
	spec, ok := u.Object["spec"].(map[string]interface{})
	if !ok {
		return nil
	}
	raw, _ := spec["resourceRefs"].([]interface{})
	if cp, ok := spec["crossplane"].(map[string]interface{}); ok {
		if cpRefs, ok := cp["resourceRefs"].([]interface{}); ok {
			raw = cpRefs
		}
	}
	var refs []crossplaneRef
	for _, item := range raw {
		if m, ok := item.(map[string]interface{}); ok {
			if ref, ok := refFromMap(m); ok {
				refs = append(refs, ref)
			}
		}
	}
	return refs
}

// crossplaneIndexKey identifies a Crossplane node by group/kind/name. Composed
// and bound-XR references carry apiVersion+kind+name but no namespace, so the
// namespace is recovered from the indexed node (whose ID embeds it) rather than
// guessed from the referrer.
func crossplaneIndexKey(group, kind, name string) string {
	return strings.ToLower(group) + "/" + strings.ToLower(kind) + "/" + name
}

// addCrossplaneNodes adds Managed Resource / Composite (XR) / Claim nodes and
// the manages edges between them:
//
//	Claim  --manages--> bound XR   (via spec.resourceRef)
//	XR     --manages--> composed MR (via spec.resourceRefs / spec.crossplane.resourceRefs)
//
// It runs before addGenericCRDNodes so the XR nodes exist first; nodes already
// present are not duplicated. Only resources whose informers are already
// watched are seen (same trade-off as the generic CRD pass and the audit walker).
func (b *Builder) addCrossplaneNodes(nodes []Node, edges []Edge, opts BuildOptions) ([]Node, []Edge) {
	dynamicCache := b.dynamic
	if dynamicCache == nil {
		return nodes, edges
	}

	existingIDs := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		existingIDs[n.ID] = true
	}

	type xpObject struct {
		obj    *unstructured.Unstructured
		nodeID string
	}
	// index: group/kind/name -> node ID (namespace recovered from the node ID)
	index := make(map[string]string)
	var objects []xpObject

	for _, gvr := range dynamicCache.GetWatchedResources() {
		kind := dynamicCache.GetKindForGVR(gvr)
		if kind == "" || !dynamicCache.IsCRD(kind) {
			continue
		}
		resources, err := dynamicCache.ListNamespaces(gvr, opts.Namespaces)
		if err != nil {
			continue
		}
		for _, r := range resources {
			if !isCrossplaneMR(r) && !isCrossplaneComposite(r) {
				continue
			}
			ns := r.GetNamespace()
			if !opts.MatchesNamespaceFilter(ns) {
				continue
			}
			name := r.GetName()
			nodeID := fmt.Sprintf("%s/%s/%s", strings.ToLower(kind), ns, name)
			objects = append(objects, xpObject{obj: r, nodeID: nodeID})
			index[crossplaneIndexKey(groupFromAPIVersion(r.GetAPIVersion()), kind, name)] = nodeID

			if existingIDs[nodeID] {
				continue
			}
			existingIDs[nodeID] = true
			nodes = append(nodes, Node{
				ID:     nodeID,
				Kind:   NodeKind(kind),
				Name:   name,
				Status: extractGenericStatus(r),
				Data: map[string]any{
					"namespace":  ns,
					"labels":     r.GetLabels(),
					"apiVersion": r.GetAPIVersion(),
				},
			})
		}
	}

	edgeSeen := make(map[string]bool)
	addEdge := func(src, dst string) {
		if src == "" || dst == "" || src == dst {
			return
		}
		id := fmt.Sprintf("%s-to-%s", src, dst)
		if edgeSeen[id] {
			return
		}
		edgeSeen[id] = true
		edges = append(edges, Edge{ID: id, Source: src, Target: dst, Type: EdgeManages})
	}

	for _, o := range objects {
		if ref, ok := getBoundXRRef(o.obj); ok {
			if target, ok := index[crossplaneIndexKey(ref.group, ref.kind, ref.name)]; ok {
				addEdge(o.nodeID, target)
			}
		}
		for _, ref := range getCrossplaneResourceRefs(o.obj) {
			if target, ok := index[crossplaneIndexKey(ref.group, ref.kind, ref.name)]; ok {
				addEdge(o.nodeID, target)
			}
		}
	}

	return nodes, edges
}
