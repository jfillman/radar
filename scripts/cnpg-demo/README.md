# CloudNativePG Demo Cluster

Bootstraps a `kind` cluster with CloudNativePG installed and a curated set of
fixtures covering the states Radar's CNPG surfaces need to render correctly.
Use it for visual-testing CNPG UI changes, or for catching regressions across
badge / drawer / Issues / audit / filter in a single pass.

Without it you are testing against whatever cluster is in your current context
— often a customer or EKS cluster with one healthy Postgres and none of the
variety that matters.

## Quick start

```bash
# Prerequisites: kind, kubectl, python3
./scripts/cnpg-demo.sh up        # ~6 minutes on first run
./scripts/cnpg-demo.sh status    # inventory, and whether the operator is frozen

# Run Radar against it
kubectl config use-context kind-radar-cnpg-demo
./scripts/visual-test-start.sh

# When done
./scripts/cnpg-demo.sh down
```

## Read this before changing the fixtures

Three things about CNPG are not obvious, cost hours to discover, and determine
which states can be faked and which cannot. Each one fails in a way that looks
like success.

### 1. Freezing the operator is not enough to hold a status

Every Postgres pod runs an **instance manager** that writes cluster status
independently of the controller. Scaling `cnpg-controller-manager` to zero
stops the controller — it does **not** stop the instance managers.

The consequence is specific:

| Field | Survives with the operator frozen? |
|---|---|
| `status.phase` | **Yes** — nothing else writes it |
| `status.conditions` | **No** — rewritten from the pods, reverts in ~10 min |
| `status.readyInstances` | **No** — same |

So a hand-patched `ContinuousArchiving=False` looks correct, demos fine, and
quietly heals itself about ten minutes later. Anything built that way is a
fixture with a half-life. This is why the terminal phases below are patched and
the WAL failure is not.

Freezing also requires deleting CNPG's webhook configurations, because the
operator **serves its own admission webhooks** from the controller pod. At zero
replicas every write to a CNPG resource otherwise fails with a connection
error. `cnpg-demo.sh up` handles this.

Thawing is therefore not just scaling back up: the operator builds its PKI at
startup by looking up its own webhook configurations, so with them deleted it
fails `ensurePKI` and **crash-loops**. `thaw` re-applies the install manifest
first, which restores them and is idempotent.

### 2. Order matters twice, and both failures look like success

**A Pooler must not share a name with one of its cluster's Services.** CNPG
creates `<cluster>-rw`, `-ro` and `-r` Services for every cluster, and a Pooler
creates a Service of its own name. Name a Pooler `pg-healthy-rw` and it finds a
Service it does not own, then refuses to reconcile — forever — with
`invalid ownership for managed resources`. Nothing surfaces on the CR: no
status, no condition, no event. It just sits there looking slow.

**Backup objects must be CREATED after the freeze, not merely patched after
it.** A Backup created against a running operator is not just reconciled to
`running` — the operator *attempts* it, and one pointed at a cluster with no
backup configuration fails and stamps `LastBackupSucceeded=False` on that
cluster. The pristine baseline silently acquired a `Backup Failed` badge, via a
resource attached to it rather than anything wrong with it. `07-backups.yaml`
is therefore held back and applied after the operator is down.

Before a frozen cluster is thawed, the script deletes those three Backup
fixtures while the operator is still stopped. Otherwise a reused `up` or
`live` run would let the controller attempt them and permanently contaminate
the healthy baseline with `LastBackupSucceeded=False`.

Velero's Backup is the exception: no controller is installed for it, so nothing
reconciles it away and it can be patched at any point.

### 3. Make the failure real instead of asserting it

The durable way to get `ContinuousArchiving=False` is to let it actually
happen: point `spec.backup.barmanObjectStore` at an unroutable endpoint
(`192.0.2.1`, TEST-NET-1, which never answers), then give the archiver a
segment to fail on by writing some rows and calling `pg_switch_wal()`.

**But only after the cluster is up.** CNPG verifies the object store during
bootstrap, so a cluster created with an unroutable endpoint never finishes
coming up — it sits in `Waiting for the instances to become active` and never
reaches Ready. That still produces `ContinuousArchiving=False`, which is why it
is such a convincing wrong answer: the condition looks right on a cluster that
is simply broken. The script therefore creates the cluster clean, waits for
2/2, and only then attaches the store — and its success check requires **both**
`ContinuousArchiving=False` **and** 2/2 Ready, because asserting the condition
alone passes on the broken version.

The archiver then fails on its own, the instance manager reports it, and the
state is self-sustaining for as long as the cluster exists. It is also better
evidence — a real archiving failure rather than a hand-written condition.

The cluster stays **2/2 Ready and serving** throughout. That is the entire
point of the scenario: nothing about availability looks wrong, and the recovery
point is silently frozen.

## What's in the cluster

### Clusters — all 2/2 Ready, four different badges

The uniform instance count is deliberate. Every difference here is invisible to
counts, which is the class of bug this fixture exists to catch.

| Resource | Badge | What it exercises |
|---|---|---|
| `pg/pg-healthy` | `Healthy` | Baseline. Also one of the three clusters `cnpgNoDeclarativeBackup` reports — it has no backup configuration at all. |
| `pg/pg-wal-failing` | `WAL Archiving Failing` | The headline state. **Real** archiver failure (see above). Badge, drawer banner, `critical` Issue and the AI context must all agree while every pod is Ready. |
| `pg/pg-unrecoverable` | `Unrecoverable` | Terminal phase outranking instance counts: red badge on a 2/2 row, with Instances and Primary muted + tooltipped. |
| `pg/pg-doomed` | `Unrecoverable` | A second terminal cluster so the Status filter renders a count of `(2)`. A dropdown where every option reads `(1)` cannot distinguish "counts work" from "counts are always 1". |

### Everything else

| Resource | Kind | What it exercises |
|---|---|---|
| `pg/pg-healthy-pooler` | Pooler | Positive state is **Scheduled**, not Ready — `status.instances` counts pods being scheduled, not ready ones. Deliberately not named `pg-healthy-rw`; see below. |
| `pg/pg-nightly` | ScheduledBackup | `method: plugin`. The audit check must count all three method values; a default-method fixture would pass whether or not it is plugin-aware. |
| `pg/pg-backup-ok` | Backup | `completed` |
| `pg/pg-backup-wal-broken` | Backup | `walArchivingFailing` — a Radar-curated label, not a CNPG phase string |
| `pg/pg-backup-unknown-phase` | Backup | An unmapped phase, proving a future CNPG minor passes through **verbatim** rather than being asserted healthy |
| `pg/velero-nightly-cluster` | Backup (`velero.io`) | Shared `backups` plural — must render Velero's column set, not CNPG's |
| `pg/kb-mysql` | Cluster (`apps.kubeblocks.io`) | Shared `clusters` plural — must render the **generic** drawer: not blank, not a fabricated Postgres status |

The last two are load-bearing. With only CNPG installed, a guard that matches
everything and a guard that matches the right API group behave identically, so
the collision handling cannot be verified at all.

## What to check in one pass

1. **Clusters list** — four rows at 2/2, four different badges, every badge on one line, no clipped headers.
2. **Status filter** — options match the badges on the rows exactly, with `Unrecoverable (2)`. Confirms the filter reads the curated text rather than raw `status.phase`, which for CNPG is prose.
3. **`pg-wal-failing` drawer** — WAL banner, and the "otherwise serving normally" clause present (it is a healthy cluster apart from archiving).
4. **`pg-unrecoverable` drawer** — terminal banner; Instances/Primary muted with tooltips in the list.
5. **Issues** — WAL archiving `critical`; concurrent causes on one cluster appear as separate rows.
6. **Checks / audit** — `cnpgNoDeclarativeBackup` reports `evaluated 4 / passed 1`. Only `pg-wal-failing` passes, via its `method: plugin` ScheduledBackup — which is what makes the check demonstrably plugin-aware rather than merely asserted to be.
7. **Backups list** — CNPG columns (Cluster / Method / Started); the Velero row renders Velero's set instead.
8. **`kb-mysql`** — generic drawer, own sidebar group.

## Live-operator variant

```bash
./scripts/cnpg-demo.sh live      # same fixtures, operator left running
./scripts/cnpg-demo.sh refreeze  # go back to the frozen rendering fixtures
```

The frozen path is optimised for **rendering** verification, and it is the one
that is proven. Work on failovers, switchovers, backup execution or anything
that needs a reconciling controller wants the opposite — so `live` skips the
freeze and the terminal phases with it. It also removes the three hand-written
Backup objects before the operator starts; otherwise the controller would
attempt them and contaminate the healthy baseline.

## Notes

- `CNPG_VERSION` is pinned to 1.27.0. Radar matches CNPG's phases on **equality**
  against full English sentences from `api/v1/cluster_types.go`, so bumping the
  version can silently move a cluster into the unrecognised-phase bucket. Bump
  deliberately, then re-check the badges.
- `CLUSTER_NAME=foo ./scripts/cnpg-demo.sh up` uses a different cluster.
- `up` is idempotent and re-runnable; it thaws a frozen operator first so
  fixture edits can be applied, then re-freezes.
