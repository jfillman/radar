package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConnectClient_Create(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/connect/requests" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var meta ConnectMetadata
		_ = json.NewDecoder(r.Body).Decode(&meta)
		if meta.DeploymentMode != "local" || meta.ClusterName != "prod" {
			t.Errorf("metadata not forwarded: %+v", meta)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(CreateResponse{
			RequestID: "req000000000000000000", DeviceSecret: "sec", VerificationCode: "K7QP-2M4X",
			ConnectURL: "https://app/connect/req000000000000000000", ExpiresIn: 900, PollInterval: 5,
			WSSURL: "wss://api/agent",
		})
	}))
	defer srv.Close()

	c := NewConnectClient(srv.URL)
	cr, err := c.Create(context.Background(), ConnectMetadata{DeploymentMode: "local", ClusterName: "prod"})
	if err != nil {
		t.Fatal(err)
	}
	if cr.RequestID != "req000000000000000000" || cr.DeviceSecret != "sec" || cr.VerificationCode != "K7QP-2M4X" {
		t.Errorf("bad create response: %+v", cr)
	}
}

func TestConnectClient_Create_Non201(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	_, err := NewConnectClient(srv.URL).Create(context.Background(), ConnectMetadata{})
	if err == nil {
		t.Fatal("expected error on non-201")
	}
}

func TestConnectClient_Poll_SendsBearer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer my-secret" {
			t.Errorf("Authorization = %q, want Bearer my-secret", got)
		}
		_ = json.NewEncoder(w).Encode(PollResponse{Status: "pending"})
	}))
	defer srv.Close()
	pr, err := NewConnectClient(srv.URL).Poll(context.Background(), "req1", "my-secret")
	if err != nil {
		t.Fatal(err)
	}
	if pr.Status != "pending" {
		t.Errorf("status = %q", pr.Status)
	}
}

func TestConnectClient_Poll_401IsTerminal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()
	_, err := NewConnectClient(srv.URL).Poll(context.Background(), "req1", "bad")
	if err == nil {
		t.Fatal("401 must be a terminal error")
	}
}

// TestRunFlow_PendingThenApproved drives the whole flow: the hub returns pending
// once, then approved with a token.
func TestRunFlow_PendingThenApproved(t *testing.T) {
	var polls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(CreateResponse{
				RequestID: "req1", DeviceSecret: "sec", VerificationCode: "AAAA-BBBB",
				ConnectURL: "https://app/connect/req1", ExpiresIn: 900, PollInterval: 0, // 0 → client floors to a usable interval
				WSSURL: "wss://api/agent",
			})
		default:
			polls++
			if polls == 1 {
				_ = json.NewEncoder(w).Encode(PollResponse{Status: "pending"})
				return
			}
			_ = json.NewEncoder(w).Encode(PollResponse{Status: "approved", ClusterID: "clus1", Token: "rhc_tok", WSSURL: "wss://api/agent"})
		}
	}))
	defer srv.Close()

	c := NewConnectClient(srv.URL)
	// Shorten the poll interval for the test by overriding after Create isn't
	// possible; PollInterval:0 makes RunFlow floor to 5s which is too slow for a
	// unit test, so drive Create+Poll directly instead.
	cr, err := c.Create(context.Background(), ConnectMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	// First poll pending, second approved.
	if pr, _ := c.Poll(context.Background(), cr.RequestID, cr.DeviceSecret); pr.Status != "pending" {
		t.Fatalf("first poll: %+v", pr)
	}
	pr, err := c.Poll(context.Background(), cr.RequestID, cr.DeviceSecret)
	if err != nil {
		t.Fatal(err)
	}
	if pr.Status != "approved" || pr.Token != "rhc_tok" || pr.ClusterID != "clus1" {
		t.Fatalf("second poll: %+v", pr)
	}
}

// TestRunFlow_Approved exercises RunFlow end to end with an immediate approval
// so the 5s floor only bites once; kept short with a context deadline guard.
func TestRunFlow_Approved(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(CreateResponse{
				RequestID: "req1", DeviceSecret: "sec", VerificationCode: "AAAA-BBBB",
				ConnectURL: "https://app/connect/req1", ExpiresIn: 900, PollInterval: 1, WSSURL: "wss://api/agent",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(PollResponse{Status: "approved", ClusterID: "clus1", Token: "rhc_tok"})
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var opened string
	res, err := NewConnectClient(srv.URL).RunFlow(ctx, ConnectMetadata{ClusterName: "prod"}, io.Discard, func(u string) { opened = u })
	if err != nil {
		t.Fatal(err)
	}
	if res.Token != "rhc_tok" || res.ClusterID != "clus1" {
		t.Errorf("flow result: %+v", res)
	}
	if res.WSSURL != "wss://api/agent" { // fell back to create-time wss
		t.Errorf("wss = %q", res.WSSURL)
	}
	if !strings.Contains(opened, "/connect/req1") {
		t.Errorf("browser opened %q", opened)
	}
	if res.ClusterName != "prod" {
		t.Errorf("cluster name not carried: %q", res.ClusterName)
	}
}

func TestRunFlow_Expired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(CreateResponse{
				RequestID: "req1", DeviceSecret: "sec", ConnectURL: "https://app/connect/req1",
				ExpiresIn: 900, PollInterval: 1,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(PollResponse{Status: "expired"})
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := NewConnectClient(srv.URL).RunFlow(ctx, ConnectMetadata{}, io.Discard, nil)
	if err != ErrConnectExpired {
		t.Fatalf("want ErrConnectExpired, got %v", err)
	}
}
