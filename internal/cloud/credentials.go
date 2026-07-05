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

// saveCredentials writes the store atomically at 0600.
func saveCredentials(c Credentials) error {
	path := CredentialsPath()
	if path == "" {
		return errors.New("cannot determine home directory")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := path + ".tmp"
	// Write the temp file 0600 so the secret is never briefly world-readable.
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	// Defense in depth: re-assert 0600 in case the file pre-existed with looser
	// perms (rename preserves the temp file's mode, but a prior file replaced by
	// rename doesn't carry over — this guards manual edits).
	_ = os.Chmod(path, 0o600)
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
