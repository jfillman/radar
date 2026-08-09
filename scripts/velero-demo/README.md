# Velero demo cluster

```bash
make velero-demo                                  # create + populate
kubectl config use-context kind-radar-velero-demo
make restart                                      # point Radar at it
make velero-demo-status                           # inventory
make velero-demo-down                             # tear down
```

## Read this first: the controller is scaled to zero, on purpose

Velero's interesting phases — `Failed`, `PartiallyFailed`, `FailedValidation`,
`WaitingForPluginOperations` — **cannot be produced on a kind cluster.**
Reaching them needs real object storage and a real backup that fails partway
through. A live controller with no bucket produces exactly one outcome:
everything `Failed` with a credentials error, which is the least interesting
row in the table.

So the script installs Velero, **scales the controller to 0**, and the fixtures
carry their own `status`. Nothing reconciles it away, and every phase in the
enum becomes reachable.

Two consequences worth knowing before you debug anything:

- **A plain `kubectl apply` writes `status` here** — none of the six Velero
  CRDs declare a status subresource. The familiar "apply drops status" rule
  only applies to kinds that register one, and reaching for
  `kubectl patch --subresource=status` against these fails with a confusing
  `NotFound`. (This bit during development, which is why it's written down.)
- **If you scale the controller back up, the fixtures dissolve.** Velero will
  reconcile the hand-written phases into whatever the real world says, which
  without a bucket is "everything failed".

## Coverage

### Backups — all 13 phases in the v1.18 enum (`40-backups-phases.yaml`)

| Phase | Level | Raises an issue? |
|---|---|---|
| `Completed` | healthy | no |
| `New` | unknown | **no** |
| `Queued` | neutral | **no** |
| `ReadyToStart` | neutral | **no** |
| `InProgress` | neutral | **no** |
| `Deleting` | degraded | **no** |
| `Finalizing` | neutral | **no** |
| `WaitingForPluginOperations` | neutral | **no** |
| `Failed` | unhealthy | yes |
| `FailedValidation` | unhealthy | yes |
| `PartiallyFailed` | alert | yes |
| `FinalizingPartiallyFailed` | alert | yes |
| `WaitingForPluginOperationsPartiallyFailed` | alert | yes |

The eight `no` rows are the point of the file. A phase that starts raising an
issue is the regression this fixture exists to catch — silence is a
requirement, not an absence of coverage.

### Supersession (`61-`, `62-`, `63-`)

The rule under test: **a later successful backup clears an earlier failure in
the same schedule and namespace.**

| Fixture | Phase | `velero.io/schedule-name` | Expected |
|---|---|---|---|
| `nightly-20260806010000` | Failed | `nightly` | **superseded** — no issue |
| `nightly-20260807010000` | Completed | `nightly` | silent, and clears the above |
| `adhoc-preupgrade` | Failed | *(none)* | raises — ad-hoc backups are never superseded |

**Why these are three separate files applied with a pause.** Ordering is by
`creationTimestamp`, which the API server assigns — the fixture cannot set it.
If two backups land in the same second, ordering falls back to the name
tie-break, and the supersession test then passes for a reason that has nothing
to do with time. The script sleeps between them and `verify` asserts the
timestamps are distinct and correctly ordered, so this fails loudly rather
than silently passing.

### Schedules (`30-schedules.yaml`)

| Fixture | Covers |
|---|---|
| `sched-enabled` | healthy baseline, valid cron, `lastBackup` set |
| `sched-failedvalidation` | `FailedValidation` + an invalid cron (`not-a-cron`) |
| `sched-errors-no-phase` | validation errors with **no phase set** — Velero leaves it empty on some failures; the row must still be filterable |
| `sched-paused` | paused and otherwise healthy |
| `sched-paused-invalid` | **paused *and* rejected** — the row that used to read only "Paused" and gave no sign it was broken |

`sched-errors-no-phase` is also the counter-example that stops "invalid cron"
being derived from the status: it is rejected for a *missing storage location*
while its cron is perfectly valid. Anything that reddens its cron cell is
pointing at the wrong field.

### Storage and repositories

| Fixture | Covers |
|---|---|
| `default` BSL | `Available` |
| `dr-replica` BSL | `Unavailable` → the backup-target-unavailable issue category |
| `default` VSL | **no status at all** — the controller never populates one, which is why the VSL table has no status column |
| `repo-ready`, `repo-notready` | `Ready` / `NotReady`, two distinct values so the status filter affordance renders |
| `repo-legacy-restic` | a **restic** repository — what the Type column exists to make scannable |

Two distinct repository statuses matter: a column with one distinct value
renders no filter control at all, so a single-value fixture cannot exercise
the filter.

### Plural collision (`05-`, `70-`)

`rancher/backup-restore-operator` ships `restores.resources.cattle.io` — the
same plural as Velero. The real CRD is vendored here rather than mocked,
because the guard being tested is "select on the API group, not the plural"
and a mock proves much less.

`rancher-restore` must render through `GenericRenderer` with its own fields
(Backup Filename, Restore Completion Ts), show no Velero strings, and **not
render blank**. Blank is the specific trap: the kind is in `KNOWN_KINDS`, so a
group-gated renderer that doesn't match will also suppress `GenericRenderer`
unless the fall-through is wired.

## Timestamps don't rot

Fixtures store `@now±Nm` tokens rather than absolute dates; the script expands
them at apply time. Without this, a demo recorded today renders as "expired 8
months ago" next year, and the Expires / Last Backup / Age columns stop
demoing anything.

## What this cannot cover

**Anything requiring a live controller.** With Velero scaled to 0 there is no
reconciliation, so:

- **Data mover (`DataUpload` / `DataDownload`)**, which is what data-mover
  support would need. These are emitted by a running controller during a real
  CSI-snapshot backup. Reproducing them needs, at minimum, in-cluster object
  storage (MinIO) *and* a snapshot-capable CSI driver (`csi-hostpath-driver`;
  kind's default local-path provisioner cannot snapshot) *and* the node agent
  enabled *and* a workload with a bound PVC. That is a different and much more
  fragile fixture, not a flag on this one — which is why it isn't one. Faking
  `DataUpload` CRs by hand would test our renderer against our own guess at the
  shape rather than against Velero, and the shape is the thing in doubt.
- **Real progress counters, backup logs, and per-item error detail.** Error and
  warning *counts* are in the CR and are covered here; the messages behind them
  live in a results artifact in object storage, reachable only through a
  `DownloadRequest` served by a running controller.
- **Restore-from-backup flows**, which need a real backup in a real bucket.

If you need any of the above, you need a cluster with real object storage —
say so rather than extending this fixture, because the value of this one is
that it runs offline in about two minutes.
