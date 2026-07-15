package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/skyhook-io/radar/internal/auth"
	"github.com/skyhook-io/radar/internal/issues"
	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/internal/timeline"
	"github.com/skyhook-io/radar/pkg/capacityapi"
	"github.com/skyhook-io/radar/pkg/k8score"
	"github.com/skyhook-io/radar/pkg/karpenter"
	pkgtimeline "github.com/skyhook-io/radar/pkg/timeline"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
)

var capacityContractNodePoolGVR = schema.GroupVersionResource{
	Group: karpenter.Group, Version: "v1", Resource: "nodepools",
}

func TestCapacityRoutesAreAvailable(t *testing.T) {
	k8s.ResetTestDynamicState()
	t.Cleanup(k8s.ResetTestDynamicState)

	paths := []string{
		"/api/capacity",
		"/api/capacity/pools",
		"/api/capacity/pools/example",
		"/api/capacity/pools/example/members?type=node",
		"/api/capacity/demand",
		"/api/capacity/activity",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			var body map[string]any
			assertOK(t, get(t, path), &body)
			if got := body["state"]; got != string(capacityapi.IntegrationSyncing) {
				t.Fatalf("state = %v, want %q", got, capacityapi.IntegrationSyncing)
			}
			if got := body["schemaVersion"]; got != capacityapi.CurrentSchemaVersion {
				t.Fatalf("schemaVersion = %v, want %q", got, capacityapi.CurrentSchemaVersion)
			}
		})
	}
}

func TestCapacityNotDetectedPrecedesRBACDenial(t *testing.T) {
	initCapacityContractDynamicState(t, false, false)

	env := newAuthTestServer(t)
	permissions := &auth.UserPermissions{AllowedNamespaces: nil}
	permissions.SetCanI("list", karpenter.Group, "nodepools", "", false)
	env.srv.permCache.Set("alice", permissions)

	var body capacityapi.OverviewResponse
	assertOK(t, env.authGet(t, "/api/capacity", "alice", ""), &body)
	if body.State != capacityapi.IntegrationNotDetected {
		t.Fatalf("state = %q, want %q", body.State, capacityapi.IntegrationNotDetected)
	}
}

func TestCapacityAuthorizedStateEnvelopes(t *testing.T) {
	t.Run("not detected", func(t *testing.T) {
		initCapacityContractDynamicState(t, false, false)
		env := newAuthTestServer(t)
		permissions := &auth.UserPermissions{AllowedNamespaces: nil}
		permissions.SetCanI("list", karpenter.Group, "nodepools", "", true)
		env.srv.permCache.Set("alice", permissions)

		var body capacityapi.OverviewResponse
		assertOK(t, env.authGet(t, "/api/capacity", "alice", ""), &body)
		if body.State != capacityapi.IntegrationNotDetected {
			t.Fatalf("state = %q, want %q", body.State, capacityapi.IntegrationNotDetected)
		}
		if got := body.Coverage[capacityapi.CoverageNodePools].Status; got != capacityapi.CoverageUnavailable {
			t.Fatalf("nodePools coverage = %q, want %q", got, capacityapi.CoverageUnavailable)
		}
	})

	t.Run("syncing", func(t *testing.T) {
		initCapacityContractDynamicState(t, true, false)
		env := newAuthTestServer(t)
		permissions := &auth.UserPermissions{AllowedNamespaces: nil}
		permissions.SetCanI("list", karpenter.Group, "nodepools", "", true)
		env.srv.permCache.Set("alice", permissions)

		var body capacityapi.OverviewResponse
		assertOK(t, env.authGet(t, "/api/capacity", "alice", ""), &body)
		if body.State != capacityapi.IntegrationSyncing {
			t.Fatalf("state = %q, want %q", body.State, capacityapi.IntegrationSyncing)
		}
		coverage := body.Coverage[capacityapi.CoverageNodePools]
		if coverage.Status != capacityapi.CoverageSyncing || coverage.ReasonCode != "nodepools_syncing" {
			t.Fatalf("nodePools coverage = %#v", coverage)
		}
	})
}

func TestCapacityPoolMissingIsNotFoundWhenAvailable(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))

	resp := get(t, "/api/capacity/pools/missing")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 404; body = %s", resp.StatusCode, body)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := body["error"]; got != "NodePool not found" {
		t.Fatalf("error = %v, want NodePool not found", got)
	}
}

func TestCapacityDemandPoolFilterRequiresObservedNodePool(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))

	resp := get(t, "/api/capacity/demand?pool=general")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("existing pool status = %d, want 200; body = %s", resp.StatusCode, body)
	}

	missing := get(t, "/api/capacity/demand?pool=missing")
	defer missing.Body.Close()
	if missing.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(missing.Body)
		t.Fatalf("missing pool status = %d, want 404; body = %s", missing.StatusCode, body)
	}
	var body map[string]any
	if err := json.NewDecoder(missing.Body).Decode(&body); err != nil {
		t.Fatalf("decode missing-pool response: %v", err)
	}
	if got := body["error"]; got != "NodePool not found" {
		t.Fatalf("error = %v, want NodePool not found", got)
	}
}

func TestCapacityProjectsCanonicalNodePoolIssues(t *testing.T) {
	pool := capacityContractNodePool("unhealthy")
	pool.SetGeneration(2)
	pool.Object["status"] = map[string]any{"conditions": []any{map[string]any{
		"type":               "Ready",
		"status":             "False",
		"reason":             "ValidationFailed",
		"message":            "requirements are invalid",
		"observedGeneration": int64(2),
		"lastTransitionTime": time.Now().UTC().Add(-time.Minute).Format(time.RFC3339),
	}}}
	initCapacityContractDynamicState(t, true, true, pool)

	var overview capacityapi.OverviewResponse
	assertOK(t, get(t, "/api/capacity"), &overview)
	if len(overview.Pools) != 1 || overview.Pools[0].IssueCount != 1 {
		t.Fatalf("overview pool issue projection = %+v", overview.Pools)
	}
	var notReadyAction *capacityapi.ActionSummary
	for index := range overview.Summary.Actions {
		if overview.Summary.Actions[index].Code == "pool_not_ready" {
			notReadyAction = &overview.Summary.Actions[index]
			break
		}
	}
	if notReadyAction == nil || notReadyAction.Count != 1 {
		t.Fatalf("overview issue-derived actions = %+v", overview.Summary.Actions)
	}

	var detail capacityapi.PoolDetailResponse
	assertOK(t, get(t, "/api/capacity/pools/unhealthy"), &detail)
	if detail.Pool == nil || len(detail.Pool.Issues) != 1 {
		t.Fatalf("pool detail issues = %+v", detail.Pool)
	}
	issue := detail.Pool.Issues[0]
	if issue.Reason != issues.ReasonKarpenterNodePoolNotReady || issue.Message != "requirements are invalid" || issue.Cause == "" || issue.Action == "" {
		t.Fatalf("structured NodePool issue = %+v", issue)
	}
	for _, fact := range detail.Pool.Facts {
		if fact.Code == "nodepool_not_ready" {
			t.Fatalf("readiness was duplicated as a posture fact: %+v", fact)
		}
	}
}

func TestCapacityDemandSummaryIgnoresStateFilter(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))

	var all capacityapi.DemandResponse
	assertOK(t, get(t, "/api/capacity/demand"), &all)
	if all.Summary == nil {
		t.Fatal("observed Pod coverage omitted demand summary")
	}
	if len(all.Summary.ByState) != 5 {
		t.Fatalf("summary states = %d, want 5: %#v", len(all.Summary.ByState), all.Summary.ByState)
	}
	var podCount, groupCount int
	for _, counts := range all.Summary.ByState {
		podCount += counts.PodCount
		groupCount += counts.GroupCount
	}
	if all.Summary.Total != (capacityapi.DemandCounts{PodCount: podCount, GroupCount: groupCount}) {
		t.Fatalf("summary total = %#v, bucket sum = pods %d groups %d", all.Summary.Total, podCount, groupCount)
	}

	var blocked capacityapi.DemandResponse
	assertOK(t, get(t, "/api/capacity/demand?state=blocked"), &blocked)
	if blocked.Summary == nil || !reflect.DeepEqual(*blocked.Summary, *all.Summary) {
		t.Fatalf("state filter changed summary: all=%#v blocked=%#v", all.Summary, blocked.Summary)
	}
	for _, group := range blocked.Items {
		if group.State != capacityapi.DemandBlocked {
			t.Fatalf("state-filtered item = %q, want %q", group.State, capacityapi.DemandBlocked)
		}
	}
}

func TestCapacityDemandSummaryOmittedWithoutPodObservations(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	env := newAuthTestServer(t)
	permissions := &auth.UserPermissions{AllowedNamespaces: []string{}}
	permissions.SetCanI("list", karpenter.Group, "nodepools", "", true)
	permissions.SetCanI("list", karpenter.Group, "nodeclaims", "", false)
	permissions.SetCanI("list", "", "nodes", "", false)
	permissions.SetCanI("list", "", "pods", "", false)
	permissions.SetCanI("list", "metrics.k8s.io", "nodes", "", false)
	env.srv.permCache.Set("alice", permissions)

	resp := env.authGet(t, "/api/capacity/demand", "alice", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 200; body = %s", resp.StatusCode, body)
	}
	wire, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	var body capacityapi.DemandResponse
	if err := json.Unmarshal(wire, &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.State != capacityapi.IntegrationAvailable {
		t.Fatalf("state = %q, want %q", body.State, capacityapi.IntegrationAvailable)
	}
	if body.Summary != nil {
		t.Fatalf("summary = %#v, want omitted without Pod observations", body.Summary)
	}
	podCoverage := body.Coverage[capacityapi.CoveragePods]
	if podCoverage.Status != capacityapi.CoverageDenied || !capacityContainsString(podCoverage.ImpactFields, "demand.summary") {
		t.Fatalf("Pod coverage = %#v, want denied with demand.summary impact", podCoverage)
	}
	var raw map[string]any
	if err := json.Unmarshal(wire, &raw); err != nil {
		t.Fatalf("decode raw response: %v", err)
	}
	if _, found := raw["summary"]; found {
		t.Fatalf("summary key must be absent without Pod observations: %s", wire)
	}
}

func TestCapacityDemandSummaryPresentForExplicitNamespaceScope(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))

	var body capacityapi.DemandResponse
	assertOK(t, get(t, "/api/capacity/demand?namespaces=default"), &body)
	if body.Summary == nil {
		t.Fatal("explicit observed namespace scope omitted demand summary")
	}
	podCoverage := body.Coverage[capacityapi.CoveragePods]
	if podCoverage.Status != capacityapi.CoverageAvailable || podCoverage.Scope != capacityapi.CoverageScopeExplicitNamespaces {
		t.Fatalf("Pod coverage = %#v, want available explicit namespace scope", podCoverage)
	}
}

func TestCapacityDemandPoolFilterDoesNotRevealNodePoolExistenceUnderDenial(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	env := newAuthTestServer(t)
	permissions := &auth.UserPermissions{AllowedNamespaces: nil}
	permissions.SetCanI("list", karpenter.Group, "nodepools", "", false)
	env.srv.permCache.Set("alice", permissions)

	var errorMessage string
	for _, pool := range []string{"general", "missing"} {
		resp := env.authGet(t, "/api/capacity/demand?pool="+pool, "alice", "")
		if resp.StatusCode != http.StatusForbidden {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			t.Fatalf("pool %q status = %d, want 403; body = %s", pool, resp.StatusCode, body)
		}
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			resp.Body.Close()
			t.Fatalf("decode pool %q response: %v", pool, err)
		}
		resp.Body.Close()
		message, _ := body["error"].(string)
		if message == "" {
			t.Fatalf("pool %q returned no error message: %#v", pool, body)
		}
		if errorMessage == "" {
			errorMessage = message
		} else if message != errorMessage {
			t.Fatalf("RBAC denial differs by pool existence: existing=%q missing=%q", errorMessage, message)
		}
	}
}

func TestCapacityOptionalSourceDenialOmitsCounts(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	env := newAuthTestServer(t)
	permissions := &auth.UserPermissions{AllowedNamespaces: nil}
	permissions.SetCanI("list", karpenter.Group, "nodepools", "", true)
	permissions.SetCanI("list", karpenter.Group, "nodeclaims", "", false)
	permissions.SetCanI("list", "", "nodes", "", true)
	permissions.SetCanI("list", "", "pods", "", true)
	permissions.SetCanI("list", "metrics.k8s.io", "nodes", "", false)
	permissions.SetCanI("list", "apps", "replicasets", "default", false)
	permissions.SetCanI("list", "batch", "jobs", "default", false)
	env.srv.permCache.Set("alice", permissions)

	resp := env.authGet(t, "/api/capacity", "alice", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 200; body = %s", resp.StatusCode, body)
	}
	wire, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	var body capacityapi.OverviewResponse
	if err := json.Unmarshal(wire, &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.State != capacityapi.IntegrationAvailable {
		t.Fatalf("state = %q, want %q", body.State, capacityapi.IntegrationAvailable)
	}
	claimCoverage := body.Coverage[capacityapi.CoverageNodeClaims]
	if claimCoverage.Status != capacityapi.CoverageDenied || claimCoverage.ReasonCode != "nodeclaims_list_denied" {
		t.Fatalf("nodeClaims coverage = %#v", claimCoverage)
	}
	if claimCoverage.ItemCount != nil || body.Summary.ClaimCount != nil {
		t.Fatalf("denied claim counts were populated: coverage=%v summary=%v", claimCoverage.ItemCount, body.Summary.ClaimCount)
	}

	var raw map[string]any
	if err := json.Unmarshal(wire, &raw); err != nil {
		t.Fatalf("decode raw response: %v", err)
	}
	summary, ok := raw["summary"].(map[string]any)
	if !ok {
		t.Fatalf("summary is not an object: %s", wire)
	}
	if _, found := summary["claimCount"]; found {
		t.Fatalf("summary.claimCount must be omitted under denial: %s", wire)
	}
	coverageBySource, ok := raw["coverage"].(map[string]any)
	if !ok {
		t.Fatalf("coverage is not an object: %s", wire)
	}
	coverage, ok := coverageBySource[string(capacityapi.CoverageNodeClaims)].(map[string]any)
	if !ok {
		t.Fatalf("coverage.nodeClaims is not an object: %s", wire)
	}
	if _, found := coverage["itemCount"]; found {
		t.Fatalf("coverage.nodeClaims.itemCount must be omitted under denial: %s", wire)
	}
}

func TestCapacityDemandRejectsInvalidFiltersAndCursors(t *testing.T) {
	k8s.ResetTestDynamicState()
	t.Cleanup(k8s.ResetTestDynamicState)

	blockedRequest := capacityPageRequest{
		scope:             "demand",
		filterFingerprint: capacityFilterFingerprint(url.Values{"state": {string(capacityapi.DemandBlocked)}}),
	}
	blockedCursor, err := encodeCapacityPageCursor(blockedRequest, "demand-group", "snapshot-a")
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	tests := map[string]struct {
		path           string
		wantCursorCode bool
	}{
		"invalid state":       {path: "/api/capacity/demand?state=impossible"},
		"limit over maximum":  {path: "/api/capacity/demand?limit=26"},
		"repeated pool":       {path: "/api/capacity/demand?pool=one&pool=two"},
		"malformed cursor":    {path: "/api/capacity/demand?cursor=%25%25%25", wantCursorCode: true},
		"cursor filter drift": {path: "/api/capacity/demand?state=unknown&cursor=" + url.QueryEscape(blockedCursor), wantCursorCode: true},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			resp := get(t, test.path)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d, want 400; body = %s", resp.StatusCode, body)
			}
			var body map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if message, ok := body["error"].(string); !ok || message == "" {
				t.Fatalf("missing error body: %#v", body)
			}
			if test.wantCursorCode {
				if got := body["error_code"]; got != capacityCursorInvalidErrorCode {
					t.Fatalf("error_code = %v, want %q", got, capacityCursorInvalidErrorCode)
				}
			} else if got, found := body["error_code"]; found {
				t.Fatalf("ordinary validation error included error_code = %v", got)
			}
		})
	}
}

func TestCapacityActivityRejectsInvalidFiltersAndCursors(t *testing.T) {
	fingerprint := capacityFilterFingerprint(url.Values{})
	validCursor, err := encodeCapacityActivityCursor("epoch", fingerprint, k8s.ActiveClusterContext(), 1, "newer")
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	otherClusterCursor, err := encodeCapacityActivityCursor("epoch", fingerprint, "other-cluster", 1, "newer")
	if err != nil {
		t.Fatalf("encode cross-cluster cursor: %v", err)
	}
	tests := map[string]struct {
		path           string
		wantCursorCode bool
	}{
		"invalid since":           {path: "/api/capacity/activity?since=yesterday"},
		"repeated filter":         {path: "/api/capacity/activity?pool=one&pool=two"},
		"unsupported workload":    {path: "/api/capacity/activity?workload=api"},
		"malformed cursor":        {path: "/api/capacity/activity?cursor=%25%25%25", wantCursorCode: true},
		"repeated cursor":         {path: "/api/capacity/activity?cursor=one&cursor=two", wantCursorCode: true},
		"cursor filter drift":     {path: "/api/capacity/activity?pool=general&cursor=" + url.QueryEscape(validCursor), wantCursorCode: true},
		"cursor cluster mismatch": {path: "/api/capacity/activity?cursor=" + url.QueryEscape(otherClusterCursor), wantCursorCode: true},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			resp := get(t, test.path)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d, want 400; body = %s", resp.StatusCode, body)
			}
			var body map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if message, ok := body["error"].(string); !ok || message == "" {
				t.Fatalf("missing error body: %#v", body)
			}
			if test.wantCursorCode {
				if got := body["error_code"]; got != capacityCursorInvalidErrorCode {
					t.Fatalf("error_code = %v, want %q", got, capacityCursorInvalidErrorCode)
				}
			} else if got, found := body["error_code"]; found {
				t.Fatalf("ordinary validation error included error_code = %v", got)
			}
		})
	}
}

func TestCapacityActivityEmptyMemoryObservationStartsAtProcessStart(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeMemory, MaxSize: 3}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})
	processStart := timeline.ObservationStart()

	var body capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity"), &body)
	if !body.Observation.StartedAt.Equal(processStart) {
		t.Fatalf("empty memory observation start = %s, want process start %s", body.Observation.StartedAt, processStart)
	}
	if body.Observation.Retention.Mode != "memory_bounded" || body.Observation.Retention.MaxEvents == nil || *body.Observation.Retention.MaxEvents != 3 {
		t.Fatalf("memory retention = %#v, want bounded maxEvents=3", body.Observation.Retention)
	}
}

func TestCapacityActivityReportsCursorEpochAndEviction(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeMemory, MaxSize: 3}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})

	fingerprint := capacityFilterFingerprint(url.Values{})
	epoch := strconv.FormatInt(timeline.ObservationStart().UnixNano(), 10)
	tests := []struct {
		name       string
		cursor     string
		wantStatus capacityapi.CursorStatus
		wantReason string
	}{
		{
			name:       "epoch changed",
			cursor:     mustEncodeCapacityActivityCursor(t, "previous-epoch", fingerprint, 0),
			wantStatus: capacityapi.CursorEpochChanged,
			wantReason: "timeline_epoch_changed",
		},
		{
			name:       "cursor evicted",
			cursor:     mustEncodeCapacityActivityCursor(t, epoch, fingerprint, 1),
			wantStatus: capacityapi.CursorEvicted,
			wantReason: "timeline_cursor_evicted",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var body capacityapi.ActivityResponse
			assertOK(t, get(t, "/api/capacity/activity?cursor="+url.QueryEscape(test.cursor)), &body)
			if body.State != capacityapi.IntegrationAvailable {
				t.Fatalf("state = %q, want %q", body.State, capacityapi.IntegrationAvailable)
			}
			if body.CursorStatus != test.wantStatus {
				t.Fatalf("cursorStatus = %q, want %q", body.CursorStatus, test.wantStatus)
			}
			if body.CursorGap == nil || body.CursorGap.Reason != test.wantReason {
				t.Fatalf("cursorGap = %#v, want reason %q", body.CursorGap, test.wantReason)
			}
			if len(body.Observation.Gaps) != 1 || body.Observation.Gaps[0].Reason != test.wantReason {
				t.Fatalf("observation gaps = %#v", body.Observation.Gaps)
			}
			if body.AnchorCursor == "" || body.Page.NextCursor != body.AnchorCursor {
				t.Fatalf("anchor=%q next=%q, want a matching recovery cursor", body.AnchorCursor, body.Page.NextCursor)
			}
		})
	}
}

func TestCapacityActivityEvictedCursorStillDeliversRetainedEvents(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeMemory, MaxSize: 3}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})

	startedAt := timeline.ObservationStart().Add(-10 * time.Minute)
	for index := 1; index <= 4; index++ {
		id := "config-" + strconv.Itoa(index)
		event := pkgtimeline.TimelineEvent{
			ID: id, Timestamp: startedAt.Add(time.Duration(index) * time.Minute), Source: pkgtimeline.SourceInformer,
			Kind: karpenter.NodePoolKind, APIVersion: karpenter.APIVersionV1, Name: "general", UID: "general-uid",
			EventType: pkgtimeline.EventTypeUpdate, ClusterContext: k8s.ActiveClusterContext(),
			Diff: &k8score.DiffInfo{Summary: id, Fields: []k8score.FieldChange{{Path: "spec.weight"}}},
		}
		if err := timeline.GetStore().Append(context.Background(), event); err != nil {
			t.Fatalf("append %s: %v", id, err)
		}
	}

	epoch := strconv.FormatInt(timeline.ObservationStart().UnixNano(), 10)
	cursor := mustEncodeCapacityActivityCursor(t, epoch, capacityFilterFingerprint(url.Values{}), 0)
	var body capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity?cursor="+url.QueryEscape(cursor)), &body)
	if body.CursorStatus != capacityapi.CursorEvicted || body.CursorGap == nil {
		t.Fatalf("cursor status/gap = %q/%#v, want an explicit eviction gap", body.CursorStatus, body.CursorGap)
	}
	if len(body.Items) != 3 {
		t.Fatalf("retained activities = %d, want all 3 records after the gap", len(body.Items))
	}
	for index, item := range body.Items {
		want := "config-" + strconv.Itoa(index+2)
		if len(item.Evidence) != 1 || item.Evidence[0].RawMessage != want {
			t.Fatalf("retained activity %d = %#v, want %q", index, item, want)
		}
	}
	if body.Page.NextCursor != body.AnchorCursor || body.Page.NextCursor == "" {
		t.Fatalf("next cursor = %q, anchor = %q", body.Page.NextCursor, body.AnchorCursor)
	}
	wantObservationStart := timeline.ObservationStart()
	if !body.Observation.StartedAt.Equal(wantObservationStart) || body.Observation.Retention.MaxEvents == nil || *body.Observation.Retention.MaxEvents != 3 {
		t.Fatalf("evicted observation = %#v, want process-clamped start %s and maxEvents=3", body.Observation, wantObservationStart)
	}
}

func TestCapacityActivityOlderPagePreservesCorrelatedEpisodes(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeMemory, MaxSize: 100}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})

	startedAt := timeline.ObservationStart().Add(time.Second)
	events := []pkgtimeline.TimelineEvent{
		{
			ID: "claim-created", Timestamp: startedAt, Source: pkgtimeline.SourceInformer,
			Kind: karpenter.NodeClaimKind, APIVersion: karpenter.APIVersionV1, Name: "claim-a", UID: "claim-a-uid",
			EventType: pkgtimeline.EventTypeAdd, ClusterContext: k8s.ActiveClusterContext(),
			Owner: &k8score.OwnerInfo{Kind: karpenter.NodePoolKind, Name: "general"},
		},
		{
			ID: "pool-updated", Timestamp: startedAt.Add(time.Minute), Source: pkgtimeline.SourceInformer,
			Kind: karpenter.NodePoolKind, APIVersion: karpenter.APIVersionV1, Name: "general", UID: "general-uid",
			EventType: pkgtimeline.EventTypeUpdate, ClusterContext: k8s.ActiveClusterContext(),
			Diff: &k8score.DiffInfo{Summary: "spec.weight changed", Fields: []k8score.FieldChange{{Path: "spec.weight"}}},
		},
		{
			ID: "claim-ready", Timestamp: startedAt.Add(2 * time.Minute), Source: pkgtimeline.SourceK8sEvent,
			Kind: karpenter.NodeClaimKind, APIVersion: karpenter.APIVersionV1, Name: "claim-a", UID: "claim-a-uid",
			Reason: "Ready", EventType: pkgtimeline.EventTypeNormal, ClusterContext: k8s.ActiveClusterContext(),
		},
	}
	for _, event := range events {
		if err := timeline.GetStore().Append(context.Background(), event); err != nil {
			t.Fatalf("append %s: %v", event.ID, err)
		}
	}

	var first capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity?limit=1"), &first)
	if len(first.Items) != 1 || first.Items[0].Type != capacityapi.ActivityProvision || first.Items[0].State != capacityapi.ActivityCompleted {
		t.Fatalf("first activity page = %#v", first.Items)
	}
	if first.Page.NextCursor == "" {
		t.Fatal("first activity page omitted older cursor")
	}

	var older capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity?cursor="+url.QueryEscape(first.Page.NextCursor)), &older)
	if len(older.Items) != 1 || older.Items[0].Type != capacityapi.ActivityConfigChange {
		t.Fatalf("older activity page = %#v, want only the independent config change", older.Items)
	}
	if older.Page.HasMore || older.Page.NextCursor != "" {
		t.Fatalf("older page pagination = %#v, want exhausted stable record window", older.Page)
	}
}

func TestCapacityActivityIncludesPersistedHistoryBeforeProcessStart(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeSQLite, Path: filepath.Join(t.TempDir(), "timeline.db")}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})
	processStart := timeline.ObservationStart()
	oldTimestamp := processStart.Add(-24 * time.Hour)
	event := pkgtimeline.TimelineEvent{
		ID: "persisted-config", Timestamp: oldTimestamp, Source: pkgtimeline.SourceInformer,
		Kind: karpenter.NodePoolKind, APIVersion: karpenter.APIVersionV1, Name: "general", UID: "general-uid",
		EventType: pkgtimeline.EventTypeUpdate, ClusterContext: k8s.ActiveClusterContext(),
		Diff: &k8score.DiffInfo{Summary: "spec.limits changed", Fields: []k8score.FieldChange{{Path: "spec.limits"}}},
	}
	if err := timeline.GetStore().Append(context.Background(), event); err != nil {
		t.Fatalf("append persisted event: %v", err)
	}

	var body capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity"), &body)
	if len(body.Items) != 1 || body.Items[0].Type != capacityapi.ActivityConfigChange {
		t.Fatalf("persisted activity = %#v", body.Items)
	}
	if !body.Observation.StartedAt.Equal(oldTimestamp) || !body.Observation.StartedAt.Before(processStart) {
		t.Fatalf("observation start = %s, want persisted boundary %s before process start %s", body.Observation.StartedAt, oldTimestamp, processStart)
	}
	if body.Observation.Retention.Mode != "persistent_unbounded" {
		t.Fatalf("retention mode = %q", body.Observation.Retention.Mode)
	}
}

func TestCapacityActivityUsesActiveClusterTimelineBounds(t *testing.T) {
	previousContext := k8s.SetTestContextName("capacity-active")
	t.Cleanup(func() { k8s.SetTestContextName(previousContext) })
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeSQLite, Path: filepath.Join(t.TempDir(), "timeline.db")}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})

	processStart := timeline.ObservationStart().UTC()
	activeAt := processStart.Add(-2 * time.Hour)
	events := []pkgtimeline.TimelineEvent{
		capacityActivityConfigEvent("foreign-oldest", "capacity-foreign", processStart.Add(-30*24*time.Hour)),
		capacityActivityConfigEvent("foreign-second", "capacity-foreign", processStart.Add(-20*24*time.Hour)),
		capacityActivityConfigEvent("foreign-third", "capacity-foreign", processStart.Add(-10*24*time.Hour)),
		capacityActivityConfigEvent("active-event", "capacity-active", activeAt),
		capacityActivityConfigEvent("foreign-newest", "capacity-foreign", processStart.Add(-time.Hour)),
	}
	if err := timeline.GetStore().AppendBatch(context.Background(), events); err != nil {
		t.Fatalf("append mixed-cluster activity: %v", err)
	}

	var body capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity"), &body)
	if len(body.Items) != 1 || body.Items[0].Evidence[0].RawMessage != "active-event" {
		t.Fatalf("active-cluster activity = %#v", body.Items)
	}
	if !body.Observation.StartedAt.Equal(activeAt) {
		t.Fatalf("observation start = %s, want active-cluster boundary %s", body.Observation.StartedAt, activeAt)
	}
	anchor, err := decodeCapacityActivityCursor(body.AnchorCursor)
	if err != nil {
		t.Fatalf("decode active anchor: %v", err)
	}
	if anchor.Seq != 4 {
		t.Fatalf("active anchor seq = %d, want 4 without foreign seq 5", anchor.Seq)
	}

	epoch := strconv.FormatInt(timeline.ObservationStart().UnixNano(), 10)
	evictedCursor := mustEncodeCapacityActivityCursor(t, epoch, capacityFilterFingerprint(url.Values{}), 1)
	var evicted capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity?cursor="+url.QueryEscape(evictedCursor)), &evicted)
	if evicted.CursorStatus != capacityapi.CursorEvicted || evicted.CursorGap == nil || len(evicted.Items) != 1 {
		t.Fatalf("active-cluster eviction response = status %q gap %#v items %#v", evicted.CursorStatus, evicted.CursorGap, evicted.Items)
	}
	evictedAnchor, err := decodeCapacityActivityCursor(evicted.AnchorCursor)
	if err != nil || evictedAnchor.Seq != 4 {
		t.Fatalf("evicted recovery anchor = %#v, %v, want active seq 4", evictedAnchor, err)
	}

	k8s.SetTestContextName("capacity-empty")
	requestStarted := time.Now().UTC()
	var empty capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity"), &empty)
	if len(empty.Items) != 0 || empty.Observation.StartedAt.Before(requestStarted) {
		t.Fatalf("empty active-cluster response leaked foreign history: start=%s items=%#v", empty.Observation.StartedAt, empty.Items)
	}
	emptyAnchor, err := decodeCapacityActivityCursor(empty.AnchorCursor)
	if err != nil || emptyAnchor.Seq != 0 {
		t.Fatalf("empty active-cluster anchor = %#v, %v, want seq 0", emptyAnchor, err)
	}
}

func TestCapacityActivityRBACMetadataUsesOnlyAuthorizedRelevantEvents(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeMemory, MaxSize: 100}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})

	base := timeline.ObservationStart().UTC()
	visibleAt := base.Add(-time.Minute)
	events := []pkgtimeline.TimelineEvent{
		capacityActivityConfigEvent("visible-config", k8s.ActiveClusterContext(), visibleAt),
		{
			ID: "denied-claim", Timestamp: base.Add(-24 * time.Hour), Source: pkgtimeline.SourceK8sEvent,
			Kind: karpenter.NodeClaimKind, APIVersion: karpenter.APIVersionV1, Name: "private-claim", UID: "private-claim-uid",
			Reason: "Ready", EventType: pkgtimeline.EventTypeNormal, Namespace: "private", ClusterContext: k8s.ActiveClusterContext(),
		},
		{
			ID: "unrelated-node", Timestamp: base.Add(-48 * time.Hour), Source: pkgtimeline.SourceInformer,
			Kind: "Node", APIVersion: "v1", Name: "unrelated-node", EventType: pkgtimeline.EventTypeDelete, ClusterContext: k8s.ActiveClusterContext(),
		},
		{
			ID: "denied-node", Timestamp: base.Add(-72 * time.Hour), Source: pkgtimeline.SourceInformer,
			Kind: "Node", APIVersion: "v1", Name: "private-node", EventType: pkgtimeline.EventTypeDelete, ClusterContext: k8s.ActiveClusterContext(),
			Labels: map[string]string{karpenter.NodePoolLabelKey: "private-pool"},
		},
		{
			ID: "denied-k8s-event", Timestamp: base.Add(2 * time.Minute), Source: pkgtimeline.SourceK8sEvent,
			Kind: karpenter.NodePoolKind, APIVersion: karpenter.APIVersionV1, Name: "general", UID: "general-uid",
			Reason: "DisruptionBlocked", EventType: pkgtimeline.EventTypeNormal, Namespace: "private", ClusterContext: k8s.ActiveClusterContext(),
		},
	}
	if err := timeline.GetStore().AppendBatch(context.Background(), events); err != nil {
		t.Fatalf("append mixed-visibility activity: %v", err)
	}

	env := newAuthTestServer(t)
	permissions := &auth.UserPermissions{AllowedNamespaces: nil}
	permissions.SetCanI("list", karpenter.Group, "nodepools", "", true)
	permissions.SetCanI("list", karpenter.Group, "nodeclaims", "", false)
	permissions.SetCanI("list", "", "nodes", "", false)
	permissions.SetCanI("list", "", "events", "", false)
	permissions.SetCanI("list", "", "events", "private", false)
	env.srv.permCache.Set("alice", permissions)

	var body capacityapi.ActivityResponse
	assertOK(t, env.authGet(t, "/api/capacity/activity", "alice", ""), &body)
	if len(body.Items) != 1 || len(body.Items[0].Evidence) != 1 || body.Items[0].Evidence[0].RawMessage != "visible-config" {
		t.Fatalf("visible activity = %#v", body.Items)
	}
	timelineCoverage := body.Coverage[capacityapi.CoverageTimeline]
	if timelineCoverage.ItemCount == nil || *timelineCoverage.ItemCount != 1 || !body.Observation.StartedAt.Equal(base) {
		t.Fatalf("denied activity affected timeline metadata: coverage=%#v observation=%#v", timelineCoverage, body.Observation)
	}
	anchor, err := decodeCapacityActivityCursor(body.AnchorCursor)
	if err != nil || anchor.Seq != 1 {
		t.Fatalf("denied activity affected anchor: %#v, %v", anchor, err)
	}
	if body.Coverage[capacityapi.CoverageKarpenterObjectEvents].Status != capacityapi.CoveragePartial {
		t.Fatalf("event coverage = %#v, want permission-derived partial coverage", body.Coverage[capacityapi.CoverageKarpenterObjectEvents])
	}

	var delta capacityapi.ActivityResponse
	assertOK(t, env.authGet(t, "/api/capacity/activity?cursor="+url.QueryEscape(body.AnchorCursor), "alice", ""), &delta)
	if len(delta.Items) != 0 || delta.Page.HasMore || delta.CursorGap != nil || delta.AnchorCursor != body.AnchorCursor {
		t.Fatalf("denied newer events affected delta metadata: %#v", delta)
	}
}

func TestCapacityActivityEvictedMemoryWithoutVisibleEventsStartsAtRequest(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeMemory, MaxSize: 2}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})
	base := timeline.ObservationStart().UTC()
	for index := range 3 {
		event := pkgtimeline.TimelineEvent{
			ID: "unrelated-node-" + strconv.Itoa(index), Timestamp: base.Add(time.Duration(index-3) * time.Hour), Source: pkgtimeline.SourceInformer,
			Kind: "Node", APIVersion: "v1", Name: "unrelated-node-" + strconv.Itoa(index), EventType: pkgtimeline.EventTypeUpdate,
			ClusterContext: k8s.ActiveClusterContext(),
		}
		if err := timeline.GetStore().Append(context.Background(), event); err != nil {
			t.Fatalf("append unrelated event: %v", err)
		}
	}

	requestStarted := time.Now().UTC()
	var body capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity"), &body)
	if len(body.Items) != 0 || body.Observation.StartedAt.Before(requestStarted) {
		t.Fatalf("unrelated evicted history shaped empty activity: start=%s items=%#v", body.Observation.StartedAt, body.Items)
	}
	if body.Observation.Retention.MaxEvents == nil || *body.Observation.Retention.MaxEvents != 2 {
		t.Fatalf("retention = %#v, want maxEvents=2", body.Observation.Retention)
	}
	anchor, err := decodeCapacityActivityCursor(body.AnchorCursor)
	if err != nil || anchor.Seq != 0 {
		t.Fatalf("unrelated events affected empty anchor: %#v, %v", anchor, err)
	}
}

func capacityActivityConfigEvent(id, clusterContext string, timestamp time.Time) pkgtimeline.TimelineEvent {
	return pkgtimeline.TimelineEvent{
		ID: id, Timestamp: timestamp, Source: pkgtimeline.SourceInformer,
		Kind: karpenter.NodePoolKind, APIVersion: karpenter.APIVersionV1, Name: "general", UID: "general-uid",
		EventType: pkgtimeline.EventTypeUpdate, ClusterContext: clusterContext,
		Diff: &k8score.DiffInfo{Summary: id, Fields: []k8score.FieldChange{{Path: "spec.weight"}}},
	}
}

func TestCapacityActivitySQLiteIgnoresUnrelatedNodeNoiseAcrossRawQueryBounds(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeSQLite, Path: filepath.Join(t.TempDir(), "timeline.db")}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})

	base := timeline.ObservationStart().UTC()
	events := make([]pkgtimeline.TimelineEvent, 0, capacityActivityQueryLimit+3)
	events = append(events, pkgtimeline.TimelineEvent{
		ID: "claim-created", Timestamp: base, Source: pkgtimeline.SourceInformer,
		Kind: karpenter.NodeClaimKind, APIVersion: karpenter.APIVersionV1, Name: "claim-a", UID: "claim-a-uid",
		EventType: pkgtimeline.EventTypeAdd, ClusterContext: k8s.ActiveClusterContext(),
		Owner: &k8score.OwnerInfo{Kind: karpenter.NodePoolKind, Name: "general"},
	})
	events = append(events, pkgtimeline.TimelineEvent{
		ID: "earliest-sequence-activity", Timestamp: base.Add(time.Second), Source: pkgtimeline.SourceInformer,
		Kind: karpenter.NodePoolKind, APIVersion: karpenter.APIVersionV1, Name: "general", UID: "general-uid",
		EventType: pkgtimeline.EventTypeUpdate, ClusterContext: k8s.ActiveClusterContext(),
		Diff: &k8score.DiffInfo{Summary: "earliest-sequence-activity", Fields: []k8score.FieldChange{{Path: "spec.weight"}}},
	})
	for index := range capacityActivityQueryLimit - 1 {
		events = append(events, pkgtimeline.TimelineEvent{
			ID: "noise-" + strconv.Itoa(index), Timestamp: base.Add(time.Duration(index+2) * time.Second), Source: pkgtimeline.SourceInformer,
			Kind: "Node", APIVersion: "v1", Name: "noise-" + strconv.Itoa(index),
			EventType: pkgtimeline.EventTypeUpdate, ClusterContext: k8s.ActiveClusterContext(),
		})
	}
	events = append(events, pkgtimeline.TimelineEvent{
		ID: "late-sequence-arrival", Timestamp: base.Add(-48 * time.Hour), Source: pkgtimeline.SourceInformer,
		Kind: karpenter.NodeClaimKind, APIVersion: karpenter.APIVersionV1, Name: "claim-a", UID: "claim-a-uid",
		Reason: "Ready", Message: "late-sequence-arrival", EventType: pkgtimeline.EventTypeNormal, ClusterContext: k8s.ActiveClusterContext(),
	})
	events = append(events, pkgtimeline.TimelineEvent{
		ID: "subjectless-controller-finalized", Timestamp: base.Add(time.Hour), Source: pkgtimeline.SourceK8sEvent,
		Kind: karpenter.NodeClaimKind, APIVersion: karpenter.APIVersionV1,
		Reason: "Finalized", Message: "Finalized karpenter.sh/termination", EventType: pkgtimeline.EventTypeNormal, ClusterContext: k8s.ActiveClusterContext(),
	})
	if err := timeline.GetStore().AppendBatch(context.Background(), events); err != nil {
		t.Fatalf("append bounded activity fixture: %v", err)
	}

	var body capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity"), &body)
	if len(body.Items) != 2 || body.Items[0].Type != capacityapi.ActivityProvision || body.Items[0].State != capacityapi.ActivityCompleted || body.Items[0].PrimaryReasonCode != "nodeclaim_ready" || len(body.Items[0].Evidence) != 2 {
		t.Fatalf("activity did not correlate across unrelated raw events: %#v", body.Items)
	}
	if body.Items[1].Type != capacityapi.ActivityConfigChange || body.Items[1].Evidence[0].RawMessage != "earliest-sequence-activity" {
		t.Fatalf("independent config activity = %#v", body.Items[1])
	}
	timelineCoverage := body.Coverage[capacityapi.CoverageTimeline]
	if timelineCoverage.Status != capacityapi.CoverageAvailable || timelineCoverage.ReasonCode != "" || timelineCoverage.ItemCount == nil || *timelineCoverage.ItemCount != 3 {
		t.Fatalf("timeline coverage counted unrelated Node events: %#v", timelineCoverage)
	}
	if body.Page.HasMore || body.Page.NextCursor != "" {
		t.Fatalf("unrelated Node events created a false continuation: %#v", body.Page)
	}
	anchor, err := decodeCapacityActivityCursor(body.AnchorCursor)
	if err != nil || anchor.Seq != capacityActivityQueryLimit+2 {
		t.Fatalf("subjectless controller event affected anchor: %#v, %v", anchor, err)
	}

	epoch := strconv.FormatInt(timeline.ObservationStart().UnixNano(), 10)
	cursor := mustEncodeCapacityActivityCursor(t, epoch, capacityFilterFingerprint(url.Values{}), 0)
	var firstDelta capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity?cursor="+url.QueryEscape(cursor)), &firstDelta)
	if len(firstDelta.Items) != 2 || firstDelta.Items[0].Type != capacityapi.ActivityConfigChange || firstDelta.Items[1].Type != capacityapi.ActivityProvision || firstDelta.Items[1].State != capacityapi.ActivityCompleted {
		t.Fatalf("delta activity = %#v, want config then completed provision", firstDelta.Items)
	}
	if firstDelta.Page.HasMore || firstDelta.Page.NextCursor != firstDelta.AnchorCursor {
		t.Fatalf("unrelated Node events bounded the delta: page=%#v anchor=%q", firstDelta.Page, firstDelta.AnchorCursor)
	}
}

func TestCapacityActivityNewerCursorIncludesLateTimestampArrival(t *testing.T) {
	initCapacityContractDynamicState(t, true, true, capacityContractNodePool("general"))
	timeline.ResetStore()
	if err := timeline.InitStore(timeline.StoreConfig{Type: timeline.StoreTypeMemory, MaxSize: 100}); err != nil {
		t.Fatalf("InitStore: %v", err)
	}
	t.Cleanup(func() {
		timeline.ResetStore()
		if err := timeline.InitStore(timeline.DefaultStoreConfig()); err != nil {
			t.Fatalf("re-init global store: %v", err)
		}
	})
	appendConfig := func(id string, timestamp time.Time) {
		t.Helper()
		event := pkgtimeline.TimelineEvent{
			ID: id, Timestamp: timestamp, Source: pkgtimeline.SourceInformer,
			Kind: karpenter.NodePoolKind, APIVersion: karpenter.APIVersionV1, Name: "general", UID: "general-uid",
			EventType: pkgtimeline.EventTypeUpdate, ClusterContext: k8s.ActiveClusterContext(),
			Diff: &k8score.DiffInfo{Summary: id, Fields: []k8score.FieldChange{{Path: "spec.weight"}}},
		}
		if err := timeline.GetStore().Append(context.Background(), event); err != nil {
			t.Fatalf("append %s: %v", id, err)
		}
	}
	appendConfig("initial", time.Now().UTC())
	var initial capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity"), &initial)
	if initial.AnchorCursor == "" {
		t.Fatal("initial response omitted anchor cursor")
	}
	appendConfig("late-arrival", time.Now().UTC().Add(-48*time.Hour))
	var delta capacityapi.ActivityResponse
	assertOK(t, get(t, "/api/capacity/activity?cursor="+url.QueryEscape(initial.AnchorCursor)), &delta)
	if len(delta.Items) != 1 || delta.Items[0].PrimaryReasonCode != "nodepool_spec_changed" || delta.Items[0].Evidence[0].RawMessage != "late-arrival" {
		t.Fatalf("late arrival delta = %#v", delta.Items)
	}
}

func initCapacityContractDynamicState(t *testing.T, discover, waitForSync bool, objects ...runtime.Object) {
	t.Helper()
	k8s.ResetTestDynamicState()
	previousClient := k8s.SetTestClient(&kubernetes.Clientset{})
	t.Cleanup(func() { k8s.SetTestClient(previousClient) })
	dynamicClient := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{capacityContractNodePoolGVR: "NodePoolList"},
		objects...,
	)
	resources := []k8s.APIResource{}
	if discover {
		resources = append(resources, k8s.APIResource{
			Group: karpenter.Group, Version: "v1", Kind: karpenter.NodePoolKind,
			Name: "nodepools", Namespaced: false, IsCRD: true, Verbs: []string{"get", "list", "watch"},
		})
	}
	if err := k8s.InitTestDynamicResourceCache(dynamicClient, resources); err != nil {
		t.Fatalf("InitTestDynamicResourceCache: %v", err)
	}
	t.Cleanup(k8s.ResetTestDynamicState)
	if !waitForSync {
		return
	}
	dynamicCache := k8s.GetDynamicResourceCache()
	if err := dynamicCache.EnsureWatching(capacityContractNodePoolGVR); err != nil {
		t.Fatalf("EnsureWatching(nodepools): %v", err)
	}
	if !dynamicCache.WaitForSync(capacityContractNodePoolGVR, 2*time.Second) {
		t.Fatal("NodePool informer did not sync")
	}
}

func capacityContractNodePool(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": karpenter.APIVersionV1,
		"kind":       karpenter.NodePoolKind,
		"metadata":   map[string]any{"name": name, "uid": name + "-uid"},
	}}
}

func mustEncodeCapacityActivityCursor(t *testing.T, epoch, fingerprint string, seq int64) string {
	t.Helper()
	cursor, err := encodeCapacityActivityCursor(epoch, fingerprint, k8s.ActiveClusterContext(), seq, "newer")
	if err != nil {
		t.Fatalf("encode activity cursor: %v", err)
	}
	return cursor
}
