# Issue stability validation harness

This tool is the non-production Phase H of the stability/soft-sort proposal. It extracts reduced
`issues` responses from mixed benchmark transcripts, preserves their original rank as the baseline,
and evaluates an explicitly annotated candidate plus a one-notch soft demotion against
injector-derived ground truth.

The investigation found that Phase A cannot be implemented truthfully and that richer temporal
capture would not resolve the core ambiguity, so the stability annotation and recovery-aware
soft-sort are retired. This branch intentionally does not add a production classifier or change
production ordering:

- `last_seen` is refreshed whenever Radar composes the active issue list; it is not the last restart.
- `restart_count` is a cumulative snapshot, not a delta over the issue window.
- recovered Pods disappear from the active issue list.
- Radar already drops a crashloop after the current container run remains continuous for five
  minutes, so settled startup races are not the rows this proposal needs to demote.
- the captured issues have no current readiness, readiness-probe presence, current-run start, last
  restart time, or observed restart delta.
- the real scenario 6 auth fault and the recurring product-catalog decoy have the same available
  signature: `crashloop`, `CrashLoopBackOff`, restart count 2, at-creation timing, `pod_creation`
  basis.

Fixed-cadence evidence could distinguish a settled recovery from an ongoing flapper, but Radar already
handles the settled case. An ongoing benign flapper and a malignant intermittent fault remain the
same observable class at richer resolution; scenario 6 is the decisive concrete counterexample. No
restart bound, grace period, or acceptance-rate threshold is inferred. The harness remains as the
fail-closed artifact that prevented an unsafe classifier from being made green.

## Inputs and semantics

The extractor accepts only tool results paired with a direct `issues` MCP call. It does not mix in
`get_dashboard.problems`: that is a detector-level view with a different schema and ordering contract,
and treating it as an Issue list would corrupt the captured ranking baseline. Dashboard responses are
not replay rows.

Ground-truth targets have three distinct relations:

- `exact`: the injected root-cause resource;
- `causal`: a known affected workload or downstream symptom; and
- `known_decoys`: independently verified benchmark noise.

Both exact and causal targets are protected by every false-positive, rank-loss, pairwise, cap, and
top-K safety gate. This matters for cases such as scenario 18: the Secret is the exact root, while the
crashing product-catalog Deployment is a real affected workload and must never be treated as the
startup decoy. Scenarios 1 and 24 likewise keep the ResourceQuota/webhook as exact and the deliberately
affected Deployment as causal.

Each reduced scenario records its transcript filename and SHA-256. Corpus provenance also records the
hash of `STATUS.txt` and the run revisions:

- SREGym `9b412c4`
- SREGym applications `18620ed`
- Radar baseline `699d9074`

The ground-truth manifest hashes every scenario problem class plus the shared registry and virtual
fault generator. These references make the checked-in fixture auditable, but they do not embed the
external benchmark source; reproducing source-level fault mechanics still requires those repositories
at the recorded revisions.

## Reproduce the checked-in corpus

```bash
go run ./tools/issue-stability-harness extract \
  -input /path/to/batch11-clean-slate-20260720-173948 \
  -exclude 19 \
  -output /tmp/corpus.json

diff -u tools/issue-stability-harness/testdata/corpus.json /tmp/corpus.json
```

The reduced fixture retains identities, original order, restart/timing fields, members, capture time,
and any candidate stability evidence present in the source. It omits messages, manifests, logs, and
unrelated tool results.
Extraction and evaluation reject missing or duplicate scenario IDs, snapshots, tool-call IDs,
provenance, and vacuous matchers.

## Evaluate

```bash
# Diagnostic report. The go/no-go threshold is intentionally unset, so the gate stays red.
go run ./tools/issue-stability-harness evaluate

# A counterfactual candidate run must state its evidence-backed minimum explicitly.
go run ./tools/issue-stability-harness evaluate \
  -min-decoy-rate <evidence-backed-rate> \
  -require-green
```

`-min-decoy-rate` is deliberately not defaulted. The brief calls for high precision and permits low
recall, while this corpus cannot derive a recall target. The chosen value is applied to three separately
reported intended-effect rates: scenarios with a physical rank demotion, captured decoy occurrences
classified `self_healed`, and eligible occurrences that physically move. A classified decoy already at
the end has no movement opportunity and is not counted in the last denominator. This prevents one
successful snapshot from making a scenario with many untouched calls look fully effective.

The counterfactual evaluator accepts a candidate fixture only when every restart-derived row includes:

- a valid `stability` and nonempty `stability_basis`;
- `current_ready` and `has_readiness_probe`;
- an RFC3339 `last_restart_at` no later than the capture;
- `observed_restart_delta` between zero and the cumulative restart count; and
- when a current run exists, an RFC3339 `current_run_started_at` between the last restart and capture
  (`Ready=true` requires it).

The candidate sort models one severity notch of demotion for `self_healed`, with active rows winning
ties. It runs only after the baseline cap, so membership cannot change. `recovering`, `persistent`,
`unknown`, and unannotated rows remain active for ranking purposes.

A green result additionally requires:

- every expected scenario and every issues call to be reproducibly captured;
- every exact and causal target to be present, inside the baseline cap, and safety-evaluable;
- zero protected rows classified demotable or losing rank;
- zero protected/decoy pairwise losses, active-active inversions, top-K losses, or cap-membership
  changes; and
- all three intended-effect rates to meet the explicitly supplied minimum.

Missing or ambiguous evidence is unevaluable, never safe.

## Batch 11 result

The checked-in corpus contains 29 usable scenarios, 42 issue snapshots, 104 rows, and 53
restart-derived rows. The result is correctly red:

- exact roots appear in 12/29 scenarios and 19/37 exact targets;
- affected/causal targets appear in 3 scenarios and 3/13 targets;
- only 4/37 exact targets and 0/13 causal targets are safety-evaluable; the four scenarios are no-op
  cases outside the restart annotation path;
- stability plus basis and auditable temporal evidence each cover 0/53 restart-derived rows;
- product-catalog appears in 10 known-decoy scenarios and 16 capped snapshot occurrences; all 16
  would have a rank-demotion opportunity, but 0 are classified and 0 move;
- the scenario 6 real auth fault collides exactly with the decoy on every available proposed input;
- three protected rows remain below the known decoy; and
- movement-only safety metrics are zero because no row moved: 0 protected-fault demotions, 0 pairwise
  regressions, 0 active inversions, 0 top-10 losses, and 0 membership changes.

Therefore this corpus falsifies a wire-only classifier, and richer capture does not supply a safe
production boundary for the remaining ongoing flappers. Production Phases A and B are retired: Radar
already removes settled recoveries after five minutes of continuous running, while benign and
malignant intermittent faults can remain observably equivalent. Scenario 6 demonstrates that
ambiguity in the benchmark itself. The checked-in harness and red report are the artifact of record;
there is no annotation or recovery-aware soft-sort to build.
