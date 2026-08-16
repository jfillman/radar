package issues

import (
	"strings"
	"testing"
)

// A phase means "in flight" only while something is advancing it. Velero moves
// these phases from its own controller, so once a run has sat in one for longer
// than Velero allows a single operation, "in progress" and "stopped" are the
// same picture — and every screen renders it as work under way.
//
// The demo cluster is exactly that shape: six backups mid-phase with the
// controller scaled to zero, one of them In progress for over a day, and nothing
// anywhere saying so.
//
// The supersession grouping cannot cover this: it considers only DECIDED runs,
// so a backup that never reaches a verdict is invisible to it by design.

func TestVeleroStalledRun(t *testing.T) {
	const overBudget = 5 * 60 // minutes; the default budget is 4h
	const wellUnder = 30

	t.Run("reports a run stuck past the time Velero allows", func(t *testing.T) {
		got := detectBackups(veleroObj{
			name: "phase-inprogress", phase: "InProgress",
			startedMinsAgo: overBudget, createdMinsAgo: overBudget,
		})
		if len(got) != 1 {
			t.Fatalf("issues = %d, want 1 — a backup in flight for 5h raises nothing today", len(got))
		}
		if got[0].Reason != ReasonVeleroRunStalled {
			t.Errorf("reason = %q, want %q", got[0].Reason, ReasonVeleroRunStalled)
		}
		if got[0].Severity != SeverityWarning {
			t.Errorf("severity = %v, want warning", got[0].Severity)
		}
		// The message has to carry both numbers, or it is an assertion without
		// its evidence.
		if !strings.Contains(got[0].Message, "5h") || !strings.Contains(got[0].Message, "4h") {
			t.Errorf("message = %q, want the elapsed time and the budget", got[0].Message)
		}
	})

	// A backup legitimately running for twenty minutes is not news, and a note on
	// every in-flight run would be noise on every healthy cluster.
	t.Run("stays quiet while a run is still within budget", func(t *testing.T) {
		if got := detectBackups(veleroObj{
			name: "fresh", phase: "InProgress", startedMinsAgo: wellUnder, createdMinsAgo: wellUnder,
		}); len(got) != 0 {
			t.Errorf("issues = %d, want 0 for a run 30m in: %+v", len(got), got)
		}
	})

	// Every phase Velero advances from its controller, not just InProgress.
	t.Run("covers the other phases that need a controller to move", func(t *testing.T) {
		for _, phase := range []string{
			"WaitingForPluginOperations", "Finalizing", "Deleting",
			"FinalizingPartiallyFailed", "WaitingForPluginOperationsPartiallyFailed",
		} {
			got := detectBackups(veleroObj{
				name: "x", phase: phase, startedMinsAgo: overBudget, createdMinsAgo: overBudget,
			})
			var found bool
			for _, iss := range got {
				if iss.Reason == ReasonVeleroRunStalled {
					found = true
				}
			}
			if !found {
				t.Errorf("phase %s stuck past budget raised no stall issue", phase)
			}
		}
	})

	// A decided run is not in flight however old it is — the supersession logic
	// owns those, and reporting them here would double up.
	t.Run("says nothing about a run that reached a verdict", func(t *testing.T) {
		for _, phase := range []string{"Completed", "Failed", "FailedValidation"} {
			for _, iss := range detectBackups(veleroObj{
				name: "old", phase: phase, startedMinsAgo: 10 * 24 * 60, createdMinsAgo: 10 * 24 * 60,
			}) {
				if iss.Reason == ReasonVeleroRunStalled {
					t.Errorf("phase %s reported as stalled", phase)
				}
			}
		}
	})

	// Velero stamps startTimestamp only once it picks a backup up. Anchoring on
	// creationTimestamp instead would call a backup stalled while it is still
	// sitting in the queue, which is a different problem with a different fix.
	t.Run("does not start the clock before Velero picked the run up", func(t *testing.T) {
		if got := detectBackups(veleroObj{
			name: "queued", phase: "InProgress", createdMinsAgo: overBudget,
		}); len(got) != 0 {
			t.Errorf("issues = %d, want 0 for a run with no startTimestamp: %+v", len(got), got)
		}
	})
}
