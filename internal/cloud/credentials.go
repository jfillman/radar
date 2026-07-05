package cloud

// Cloud credential persistence. The minted cluster token is a bearer secret, so
// it lives in its OWN file (~/.radar/credentials.json) at 0600 — deliberately
// NOT ~/.radar/config.json, which is written world-readable (0644) for
// non-secret flag defaults. Credentials are keyed by kubecontext so a later
// `radar` run on a known context can resume, and `radar cloud status` /
// `disconnect` can operate per-context.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Credentials is the on-disk shape of ~/.radar/credentials.json.
type Credentials struct {
	// Clusters maps a kubecontext name to its cloud connection.
	Clusters map[string]ClusterCredential `json:"clusters"`
}

// ClusterCredential is a single cluster's cloud connection.
type ClusterCredential struct {
	HubBase     string `json:"hub_base"`     // hub API origin used to connect
	ClusterID   string `json:"cluster_id"`   // hub-assigned id
	ClusterName string `json:"cluster_name"` // display name
	Token       string `json:"token"`        // rhc_… bearer (secret)
	WSSURL      string `json:"wss_url"`      // agent WebSocket URL to dial
	// ServerURL is the kube-apiserver endpoint of the cluster this credential
	// was minted for. Auto-resume compares it against the current context's
	// server URL so a same-named context in a DIFFERENT kubeconfig (a name
	// collision — "kind-kind", "default", …) can't resume this cluster's Cloud
	// identity onto a different cluster. Empty in creds written before this
	// field existed → resume falls back to name-only (prior behavior).
	ServerURL string `json:"server_url,omitempty"`
}

var credMu sync.Mutex

// CredentialsPath returns ~/.radar/credentials.json ("" if HOME is undeterminable).
func CredentialsPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".radar", "credentials.json")
}

// LoadCredentials reads the credentials file. A missing or unreadable file
// yields an empty (non-nil) store, never an error — absence is normal.
func LoadCredentials() Credentials {
	c := Credentials{Clusters: map[string]ClusterCredential{}}
	path := CredentialsPath()
	if path == "" {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	_ = json.Unmarshal(data, &c)
	if c.Clusters == nil {
		c.Clusters = map[string]ClusterCredential{}
	}
	return c
}

// saveCredentials writes the store atomically at 0600. The temp file is created
// via os.CreateTemp — which opens it 0600 by default (the token is never briefly
// world-readable) with a UNIQUE name, so two concurrent Radar processes can't
// collide on a fixed `.tmp` path. Atomic rename means a concurrent writer only
// risks a lost update (last-writer-wins), never a corrupt file.
func saveCredentials(c Credentials) error {
	path := CredentialsPath()
	if path == "" {
		return errors.New("cannot determine home directory")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	f, err := os.CreateTemp(dir, "credentials-*.json.tmp") // 0600, unique
	if err != nil {
		return err
	}
	tmp := f.Name()
	// Ensure 0600 even if umask/CreateTemp semantics ever differ on a target.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// SaveClusterCredential stores (or replaces) the connection for a kubecontext.
func SaveClusterCredential(context string, cred ClusterCredential) error {
	credMu.Lock()
	defer credMu.Unlock()
	c := LoadCredentials()
	c.Clusters[context] = cred
	return saveCredentials(c)
}

// GetClusterCredential returns the stored connection for a kubecontext, if any.
func GetClusterCredential(context string) (ClusterCredential, bool) {
	c := LoadCredentials()
	cred, ok := c.Clusters[context]
	return cred, ok
}

// RemoveClusterCredential deletes the connection for a kubecontext. Returns
// whether a credential was present.
func RemoveClusterCredential(context string) (bool, error) {
	credMu.Lock()
	defer credMu.Unlock()
	c := LoadCredentials()
	if _, ok := c.Clusters[context]; !ok {
		return false, nil
	}
	delete(c.Clusters, context)
	return true, saveCredentials(c)
}
