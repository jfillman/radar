package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/skyhook-io/radar/internal/cloud"
)

func TestCheckWebSocketOriginTrustsAuthenticatedTunnel(t *testing.T) {
	var got bool
	handler := cloud.AuthenticatedTunnelHandler(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = checkWebSocketOrigin(r)
	}))
	req := httptest.NewRequest(http.MethodGet, "http://radar.internal/api/pods/ns/pod/exec", nil)
	req.Header.Set("Origin", "https://hub.example.com")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if !got {
		t.Error("checkWebSocketOrigin refused an authenticated-tunnel request; Hub-proxied exec would break")
	}
}

func TestUpgraderRejectsCrossOriginHandshake(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.Close()
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	sameHost := strings.TrimPrefix(srv.URL, "http://")

	t.Run("cross origin rejected", func(t *testing.T) {
		_, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": {"http://evil.example"}})
		if err == nil {
			t.Fatal("cross-origin handshake succeeded, want rejection")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("cross-origin handshake status = %v, want 403", resp)
		}
	})

	t.Run("same origin accepted", func(t *testing.T) {
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": {"http://" + sameHost}})
		if err != nil {
			t.Fatalf("same-origin handshake failed: %v", err)
		}
		conn.Close()
	})
}
