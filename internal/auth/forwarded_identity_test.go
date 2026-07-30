package auth

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// resetForwardedIdentityLog clears the package-level dedup set so tests don't
// leak state into each other (the set is shared across the whole test binary).
func resetForwardedIdentityLog() {
	forwardedIdentitySeen.mu.Lock()
	defer forwardedIdentitySeen.mu.Unlock()
	forwardedIdentitySeen.seen = make(map[uint64]struct{})
	forwardedIdentitySeen.order = nil
}

func TestLogAcceptedForwardedIdentity_FirstCallLogs(t *testing.T) {
	resetForwardedIdentityLog()

	var buf bytes.Buffer
	defer log.SetOutput(log.Writer())
	log.SetOutput(&buf)

	logAcceptedForwardedIdentity(&User{Username: "alice", Groups: []string{"radar:idp:abc123"}})

	line := buf.String()
	if !strings.Contains(line, "[auth] accepted forwarded identity") {
		t.Fatalf("expected accepted-identity log line, got: %q", line)
	}
	if !strings.Contains(line, `user="alice"`) {
		t.Errorf("log line missing username: %q", line)
	}
	if !strings.Contains(line, "radar:idp:abc123") {
		t.Errorf("log line missing group: %q", line)
	}
}

func TestLogAcceptedForwardedIdentity_IdenticalCallSuppressed(t *testing.T) {
	resetForwardedIdentityLog()

	var buf bytes.Buffer
	defer log.SetOutput(log.Writer())
	log.SetOutput(&buf)

	user := &User{Username: "bob", Groups: []string{"devs", "radar:idp:xyz789"}}
	logAcceptedForwardedIdentity(user)
	firstLen := buf.Len()
	if firstLen == 0 {
		t.Fatal("expected first call to log")
	}

	// Identical (username, groups) combo again — should not add another line.
	logAcceptedForwardedIdentity(user)
	if buf.Len() != firstLen {
		t.Errorf("expected repeat call to be suppressed, buffer grew from %d to %d bytes: %q", firstLen, buf.Len(), buf.String())
	}

	// Same groups, different order — still the same set, should stay suppressed.
	logAcceptedForwardedIdentity(&User{Username: "bob", Groups: []string{"radar:idp:xyz789", "devs"}})
	if buf.Len() != firstLen {
		t.Errorf("expected reordered-groups call to be suppressed, buffer grew from %d to %d bytes: %q", firstLen, buf.Len(), buf.String())
	}
}

func TestLogAcceptedForwardedIdentity_ChangedGroupSetLogsAgain(t *testing.T) {
	resetForwardedIdentityLog()

	var buf bytes.Buffer
	defer log.SetOutput(log.Writer())
	log.SetOutput(&buf)

	logAcceptedForwardedIdentity(&User{Username: "carol", Groups: []string{"radar:idp:old"}})
	firstLen := buf.Len()
	if firstLen == 0 {
		t.Fatal("expected first call to log")
	}

	// New IdP group added — distinct combo, must log again.
	logAcceptedForwardedIdentity(&User{Username: "carol", Groups: []string{"radar:idp:old", "radar:idp:new"}})
	if buf.Len() <= firstLen {
		t.Errorf("expected changed group-set to produce a new log line, buffer stayed at %d bytes: %q", buf.Len(), buf.String())
	}
	if strings.Count(buf.String(), "[auth] accepted forwarded identity") != 2 {
		t.Errorf("expected exactly 2 log lines, got: %q", buf.String())
	}
}

func TestLogAcceptedForwardedIdentity_NilOrEmptyUsernameNoOp(t *testing.T) {
	resetForwardedIdentityLog()

	var buf bytes.Buffer
	defer log.SetOutput(log.Writer())
	log.SetOutput(&buf)

	logAcceptedForwardedIdentity(nil)
	logAcceptedForwardedIdentity(&User{Username: "", Groups: []string{"devs"}})

	if buf.Len() != 0 {
		t.Errorf("expected no log output for nil/empty-username user, got: %q", buf.String())
	}
}

func TestForwardedIdentityLogger_BoundedEviction(t *testing.T) {
	l := &forwardedIdentityLogger{seen: make(map[uint64]struct{})}

	// Fill well past the cap and confirm the set never grows unbounded.
	for i := 0; i < forwardedIdentityLogCap+10; i++ {
		key := forwardedIdentityKey("user", []string{string(rune('a' + i%26))})
		l.shouldLog(key)
	}

	if len(l.seen) > forwardedIdentityLogCap {
		t.Errorf("dedup set grew to %d entries, want <= %d", len(l.seen), forwardedIdentityLogCap)
	}
	if len(l.order) > forwardedIdentityLogCap {
		t.Errorf("order slice grew to %d entries, want <= %d", len(l.order), forwardedIdentityLogCap)
	}
}
