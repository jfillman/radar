package version

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestIsNewerVersion(t *testing.T) {
	tests := []struct {
		name    string
		latest  string
		current string
		want    bool
		wantErr bool
	}{
		{"major upgrade", "2.0.0", "1.0.0", true, false},
		{"minor upgrade", "1.1.0", "1.0.0", true, false},
		{"patch upgrade", "1.0.1", "1.0.0", true, false},
		{"same version", "1.0.0", "1.0.0", false, false},
		{"downgrade", "1.0.0", "2.0.0", false, false},
		{"prerelease newer than stable", "1.1.0-rc1", "1.0.0", true, false},
		{"with v prefix on latest", "v1.1.0", "1.0.0", true, false},
		{"with v prefix on current", "1.1.0", "v1.0.0", true, false},
		{"invalid latest", "not-a-version", "1.0.0", false, true},
		{"invalid current", "1.0.0", "not-a-version", false, true},
		{"empty latest", "", "1.0.0", false, true},
		{"empty current", "1.0.0", "", false, true},
		{"both empty", "", "", false, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := isNewerVersion(tt.latest, tt.current)
			if (err != nil) != tt.wantErr {
				t.Errorf("isNewerVersion(%q, %q) error = %v, wantErr %v", tt.latest, tt.current, err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("isNewerVersion(%q, %q) = %v, want %v", tt.latest, tt.current, got, tt.want)
			}
		})
	}
}

func TestGetUpdateCommand(t *testing.T) {
	tests := []struct {
		name   string
		method InstallMethod
		goos   string
		want   string
	}{
		{"homebrew", InstallHomebrew, "darwin", "brew upgrade skyhook-io/tap/radar"},
		{"krew", InstallKrew, "linux", "kubectl krew upgrade radar"},
		{"scoop", InstallScoop, "windows", "scoop update radar"},
		{"direct linux", InstallDirect, "linux", "curl -fsSL https://get.radarhq.io | sh"},
		{"direct darwin", InstallDirect, "darwin", "curl -fsSL https://get.radarhq.io | sh"},
		{"direct windows", InstallDirect, "windows", "irm https://get.radarhq.io/install.ps1 | iex"},
		{"direct freebsd falls through", InstallDirect, "freebsd", ""},
		{"direct empty goos falls through", InstallDirect, "", ""},
		{"desktop", InstallDesktop, "darwin", ""},
		{"unknown", InstallMethod("unknown"), "linux", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := getUpdateCommandForOS(tt.method, tt.goos)
			if got != tt.want {
				t.Errorf("getUpdateCommandForOS(%q, %q) = %q, want %q", tt.method, tt.goos, got, tt.want)
			}
		})
	}
}

func TestDetectInstallMethodFromPath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want InstallMethod
	}{
		{"homebrew mac arm", "/opt/homebrew/bin/radar", InstallHomebrew},
		{"homebrew cellar", "/usr/local/Cellar/radar/1.0/bin/radar", InstallHomebrew},
		{"linuxbrew", "/home/linuxbrew/.linuxbrew/bin/radar", InstallHomebrew},
		{"krew", "/home/user/.krew/store/radar/v1.0/radar", InstallKrew},
		{"scoop unix", "/home/user/scoop/apps/radar/current/radar", InstallScoop},
		{"scoop windows", `C:\Users\user\scoop\apps\radar\current\radar.exe`, InstallScoop},
		{"direct /usr/local/bin", "/usr/local/bin/radar", InstallDirect},
		{"direct home", "/home/user/bin/radar", InstallDirect},
		{"direct tmp", "/tmp/radar", InstallDirect},
		{"mixed case Homebrew", "/opt/Homebrew/bin/radar", InstallHomebrew},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectInstallMethodFromPath(tt.path)
			if got != tt.want {
				t.Errorf("detectInstallMethodFromPath(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestTruncateNotes(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		maxLen int
		want   string
	}{
		{"shorter than max", "hello", 10, "hello"},
		{"exactly at max", "hello", 5, "hello"},
		{"longer than max", "hello world", 5, "hello..."},
		{"empty string", "", 10, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncateNotes(tt.input, tt.maxLen)
			if got != tt.want {
				t.Errorf("truncateNotes(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.want)
			}
		})
	}
}

func TestInstallTimestampDoesNotUseLocalDirectoryInCluster(t *testing.T) {
	if got := installTimestamp(context.Background(), "in-cluster"); got != 0 {
		t.Fatalf("in-cluster timestamp = %d, want no local-directory fallback", got)
	}
}

func TestIsReleaseVersion(t *testing.T) {
	tests := map[string]bool{
		"1.2.3":       true,
		"v1.2.3":      true,
		"dev":         false,
		"1.2.3-dirty": false,
		"1.2.3-rc.1":  false,
		"1.2":         false,
		"":            false,
	}
	for value, want := range tests {
		if got := IsReleaseVersion(value); got != want {
			t.Errorf("IsReleaseVersion(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestBrowserUpdateCheckReportsEveryAcceptedClaim(t *testing.T) {
	var queries []url.Values
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.Query())
		_ = json.NewEncoder(w).Encode(githubRelease{
			TagName: "v1.3.0",
			HTMLURL: "https://github.com/skyhook-io/radar/releases/tag/v1.3.0",
		})
	}))
	defer proxy.Close()

	previousURL, previousVersion := releasesURL, Current
	releasesURL = proxy.URL
	SetCurrent("1.2.3")
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	t.Cleanup(func() {
		releasesURL = previousURL
		SetCurrent(previousVersion)
		mu.Lock()
		cachedResult = nil
		lastCheck = time.Time{}
		mu.Unlock()
	})

	if _, reported := CheckForUpdateBrowser(context.Background(), "2026-08-29", "c66ce4e8-fb90-4e0e-a2af-2172bb868b9e", true); !reported {
		t.Fatal("first browser report was not acknowledged")
	}
	if _, reported := CheckForUpdateBrowser(context.Background(), "2026-08-29", "c66ce4e8-fb90-4e0e-a2af-2172bb868b9e", true); !reported {
		t.Fatal("second browser report was not acknowledged")
	}

	if len(queries) != 2 {
		t.Fatalf("proxy calls = %d, want one per browser report", len(queries))
	}
	for _, query := range queries {
		if query.Get("source") != "browser-proxy" || query.Get("report") != "1" {
			t.Errorf("report routing query = %v", query)
		}
		if query.Get("day") != "2026-08-29" || query.Get("rid") != "c66ce4e8-fb90-4e0e-a2af-2172bb868b9e" {
			t.Errorf("report identity query = %v", query)
		}
		if query.Get("auth") != "true" || query.Get("mode") != "in-cluster" {
			t.Errorf("report context query = %v", query)
		}
	}

	resetUpdateCache()
	CheckForUpdateRelease(context.Background())
	if len(queries) != 3 || queries[2].Get("source") != "release-only" || queries[2].Get("report") != "0" {
		t.Fatalf("release-only routing query = %v", queries)
	}

	SetCurrent("1.2.3-rc.1")
	resetUpdateCache()
	if _, handled := CheckForUpdateBrowser(context.Background(), "2026-08-29", "c66ce4e8-fb90-4e0e-a2af-2172bb868b9e", true); !handled {
		t.Fatal("prerelease browser report should be handled without retry")
	}
	if len(queries) != 4 || queries[3].Get("source") != "release-only" || queries[3].Get("report") != "0" {
		t.Fatalf("prerelease routing query = %v", queries)
	}
}

func TestBrowserUpdateCheckReportsProxyFailureDespiteGitHubFallback(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer proxy.Close()
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(githubRelease{TagName: "v1.3.0"})
	}))
	defer github.Close()

	previousReleaseURL, previousGitHubURL, previousVersion := releasesURL, githubURL, Current
	releasesURL, githubURL = proxy.URL, github.URL
	SetCurrent("1.2.3")
	t.Cleanup(func() {
		releasesURL, githubURL = previousReleaseURL, previousGitHubURL
		SetCurrent(previousVersion)
		resetUpdateCache()
	})

	info, reported := CheckForUpdateBrowser(context.Background(), "2026-08-29", "c66ce4e8-fb90-4e0e-a2af-2172bb868b9e", false)
	if reported {
		t.Fatal("browser report was acknowledged after the release proxy failed")
	}
	if info.LatestVersion != "1.3.0" {
		t.Fatalf("GitHub fallback latest version = %q, want 1.3.0", info.LatestVersion)
	}
}

func resetUpdateCache() {
	mu.Lock()
	defer mu.Unlock()
	cachedResult = nil
	lastCheck = time.Time{}
}
