package server

import "testing"

// Report producers are inconsistent about case across report families, so the
// vocabulary is normalized before anything branches on it.
func TestNormalizePolicyResult(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"fail", "fail"}, {"Fail", "fail"}, {"FAIL", "fail"},
		{"pass", "pass"}, {"Pass", "pass"},
		{"warn", "warn"}, {"error", "error"}, {"skip", "skip"},
		{"something-new", "something-new"},
	} {
		if got := normalizePolicyResult(c.in); got != c.want {
			t.Errorf("normalizePolicyResult(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Worst first, so a workload with one error among many warnings does not bury
// it. An unknown result sorts last rather than jumping the queue.
func TestPolicyResultRankOrdersWorstFirst(t *testing.T) {
	order := []string{"error", "fail", "warn", "skip", "mystery"}
	for i := 1; i < len(order); i++ {
		if policyResultRank(order[i-1]) >= policyResultRank(order[i]) {
			t.Errorf("%q should rank before %q", order[i-1], order[i])
		}
	}
	// Case must not change the ordering.
	if policyResultRank("FAIL") != policyResultRank("fail") {
		t.Error("ranking is case-sensitive")
	}
}

// Counts include passes even though passes are not listed: the count is what
// proves a check actually ran, which is the difference between "compliant" and
// "never examined".
func TestPolicyCountsIncludePassesThatAreNotListed(t *testing.T) {
	var c PolicyResourceCounts
	for _, r := range []string{"pass", "Pass", "fail", "warn", "error", "skip", "unknown"} {
		c.count(r)
	}
	if c.Pass != 2 || c.Fail != 1 || c.Warn != 1 || c.Error != 1 || c.Skip != 1 {
		t.Errorf("counts = %+v", c)
	}
	if !isPolicyPassResult("PASS") || isPolicyPassResult("fail") {
		t.Error("pass detection is wrong")
	}
}
