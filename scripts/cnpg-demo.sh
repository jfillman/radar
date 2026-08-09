#!/usr/bin/env bash
# Bootstrap a kind cluster pre-populated with CloudNativePG scenarios for
# visual-testing Radar's CNPG surfaces. Idempotent — re-run to refresh state
# or apply fixture updates without recreating the cluster.
#
# Subcommands:
#   up        Create cluster (if missing), install CNPG, apply fixtures,
#             induce a real WAL-archiving failure, freeze + patch terminal states.
#   down      Delete the kind cluster.
#   live      Same as up, but leaves the operator RUNNING. Terminal phases are
#             skipped (the operator would reconcile them away). Use this for
#             failover / switchover / backup work that needs a live controller.
#   refreeze  Re-apply the freeze + terminal phases (after a `live` run, or if
#             something reconciled them away).
#   thaw      Scale the operator back up without deleting anything.
#   status    Inventory the cluster and show what each fixture is doing.
#   help      Show this message.
#
# Prerequisites:
#   - kind         https://kind.sigs.k8s.io/
#   - kubectl
#
# Set CLUSTER_NAME=foo to use a different cluster (default: radar-cnpg-demo).
#
# See scripts/cnpg-demo/README.md for the coverage matrix and — more
# importantly — why some states are patched and others must be real.

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-radar-cnpg-demo}"
KUBECTL_CTX="kind-${CLUSTER_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/cnpg-demo"
NS=pg

# Pinned so the demo behaves consistently. The phase STRINGS Radar matches on
# are version-sensitive — they are full English sentences from CNPG's
# api/v1/cluster_types.go, matched on equality — so bumping this can silently
# move a cluster into the "unrecognised phase" bucket. Bump deliberately and
# re-check the badges.
CNPG_VERSION="${CNPG_VERSION:-1.27.0}"
CNPG_MANIFEST="https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.27/releases/cnpg-${CNPG_VERSION}.yaml"

PHASE_UNRECOVERABLE="Cluster is unrecoverable and needs manual intervention"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BLUE='\033[34m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_RESET='\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_RESET=''
fi

step() { printf "${C_BLUE}==> %s${C_RESET}\n" "$1"; }
ok()   { printf "${C_GREEN}    ✓ %s${C_RESET}\n" "$1"; }
warn() { printf "${C_YELLOW}    ! %s${C_RESET}\n" "$1"; }
fail() { printf "${C_RED}    ✗ %s${C_RESET}\n" "$1"; exit 1; }
note() { printf "${C_DIM}    %s${C_RESET}\n" "$1"; }

k() { kubectl --context "${KUBECTL_CTX}" "$@"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found in PATH. Install: $2"
}

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; }

# --- Lifecycle -------------------------------------------------------------

cmd_up()   { bootstrap; freeze_and_patch; print_summary "frozen"; }
cmd_live() { bootstrap; print_summary "live"; }

bootstrap() {
  require_cmd kind "https://kind.sigs.k8s.io/docs/user/quick-start/#installation (or 'brew install kind')"
  require_cmd kubectl "https://kubernetes.io/docs/tasks/tools/"

  if cluster_exists; then
    step "Cluster '${CLUSTER_NAME}' already exists — reusing"
    thaw_operator_quiet
  else
    step "Creating kind cluster '${CLUSTER_NAME}'"
    kind create cluster --name "${CLUSTER_NAME}" --wait 60s
    ok "Cluster created"
  fi

  k cluster-info >/dev/null || fail "kind context not reachable"

  install_cnpg
  apply_fixtures
  wait_for_clusters
  wait_for_pooler
  break_wal_archiving
  # Velero's CRD has no controller here, so nothing will reconcile this away.
  patch_velero_backup
  # CNPG Backup phases are deliberately NOT patched here — the operator owns
  # them and drives a freshly created Backup to `running` within seconds.
  # They are written after the freeze, alongside the terminal phases.
}

cmd_down() {
  require_cmd kind "https://kind.sigs.k8s.io/"
  if cluster_exists; then
    step "Deleting cluster '${CLUSTER_NAME}'"
    kind delete cluster --name "${CLUSTER_NAME}"
    ok "Deleted"
  else
    warn "Cluster '${CLUSTER_NAME}' does not exist; nothing to do"
  fi
}

# --- CNPG operator ---------------------------------------------------------

install_cnpg() {
  step "Installing CloudNativePG ${CNPG_VERSION}"
  k apply --server-side -f "${CNPG_MANIFEST}" >/dev/null
  step "Waiting for the operator to be Ready (~60s)"
  k -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout=180s >/dev/null
  ok "CNPG healthy"
}

# --- Fixtures --------------------------------------------------------------

# Everything except the Backups, which are deliberately held back until after
# the freeze. A Backup created against a running operator is not just
# reconciled to `running` — the operator ATTEMPTS it, and a Backup pointed at a
# cluster with no backup configuration fails and stamps
# LastBackupSucceeded=False on that cluster. That turned the pristine baseline
# into a "Backup Failed" badge, silently, via a resource attached to it.
apply_fixtures() {
  step "Applying CNPG demo fixtures"
  [ -d "${FIXTURES_DIR}" ] || fail "Fixtures dir not found: ${FIXTURES_DIR}"

  for f in $(ls "${FIXTURES_DIR}"/*.yaml 2>/dev/null | sort); do
    case "$(basename "$f")" in
      07-backups.yaml) note "deferring $(basename "$f") until after the freeze"; continue ;;
    esac
    note "applying $(basename "$f")"
    k apply -f "$f" >/dev/null
  done
  ok "Fixtures applied"
}

wait_for_clusters() {
  step "Waiting for Postgres to come up (4 clusters × 2 instances, ~3 min first run)"
  local c deadline
  for c in pg-healthy pg-wal-failing pg-unrecoverable pg-doomed; do
    deadline=$((SECONDS + 420))
    while [ $SECONDS -lt $deadline ]; do
      local ready
      ready=$(k -n "${NS}" get cluster.postgresql.cnpg.io "$c" \
        -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo "")
      [ "${ready:-0}" = "2" ] && break
      sleep 5
    done
    if [ "${ready:-0}" = "2" ]; then
      ok "$c 2/2"
    else
      warn "$c did not reach 2/2 within 7 minutes (continuing; check 'kubectl -n ${NS} get pods')"
    fi
  done
}

# The Pooler must report status.instances before the freeze, or its badge
# renders "Unknown" (absent is not zero) instead of the "Scheduled" state this
# fixture exists to show. A Pooler that never reconciles surfaces nothing on
# the CR — no status, no condition, no event — so a silent failure here looks
# exactly like slowness. Fail loudly with the operator's own reason instead.
wait_for_pooler() {
  step "Waiting for the Pooler to report"
  local deadline=$((SECONDS + 180)) scheduled=""
  while [ $SECONDS -lt $deadline ]; do
    scheduled=$(k -n "${NS}" get pooler.postgresql.cnpg.io pg-healthy-pooler \
      -o jsonpath='{.status.instances}' 2>/dev/null || echo "")
    [ -n "$scheduled" ] && break
    sleep 5
  done

  if [ -n "$scheduled" ]; then
    ok "pg-healthy-pooler status.instances=${scheduled}"
  else
    warn "Pooler never reported status.instances — its badge will read 'Unknown', not 'Scheduled'"
    note "most likely cause: a Service name collision. Check:"
    note "  kubectl -n cnpg-system logs deploy/cnpg-controller-manager | grep notOwnedServiceName"
  fi
}

# --- The WAL-archiving failure, made real ----------------------------------
#
# This is the fixture that cannot be faked. See the README: patching
# ContinuousArchiving=False does not survive, because the instance manager
# inside each Postgres pod writes cluster status independently of the operator
# and reverts it within ~10 minutes — even with the operator scaled to zero.
#
# So instead of asserting the failure we cause it, and the ORDER matters. CNPG
# verifies the object store during bootstrap, so a cluster created with an
# unroutable endpoint never finishes coming up: it sits in "Waiting for the
# instances to become active" forever, with ContinuousArchiving=False for the
# wrong reason. Bootstrap clean, then break archiving on a healthy cluster.
break_wal_archiving() {
  step "Breaking WAL archiving on pg-wal-failing (after it came up clean)"

  local primary
  primary=$(k -n "${NS}" get cluster.postgresql.cnpg.io pg-wal-failing \
    -o jsonpath='{.status.currentPrimary}' 2>/dev/null || echo "")
  if [ -z "$primary" ]; then
    warn "pg-wal-failing has no primary yet; skipping (re-run '$0 up' once it is up)"
    return 0
  fi

  # Point it at an endpoint that never answers. TEST-NET-1 (RFC 5737) is
  # reserved for documentation and is unroutable by design.
  k -n "${NS}" patch cluster.postgresql.cnpg.io pg-wal-failing --type=merge -p '{
    "spec": {"backup": {"barmanObjectStore": {
      "endpointURL": "http://192.0.2.1:9000",
      "destinationPath": "s3://radar-cnpg-demo/",
      "s3Credentials": {
        "accessKeyId": {"name": "cnpg-demo-object-store", "key": "ACCESS_KEY_ID"},
        "secretAccessKey": {"name": "cnpg-demo-object-store", "key": "ACCESS_SECRET_KEY"}
      }
    }}}
  }' >/dev/null || { warn "could not attach the object store"; return 0; }

  # Give the archiver a segment to fail on. An idle cluster may not rotate on
  # its own, and an empty segment can be skipped.
  k -n "${NS}" exec "$primary" -c postgres -- psql -q -U postgres -d postgres -c \
    "CREATE TABLE IF NOT EXISTS radar_demo_churn AS SELECT g, repeat('x', 512) AS pad FROM generate_series(1, 20000) g;" \
    >/dev/null 2>&1 || warn "seed write failed (continuing)"
  k -n "${NS}" exec "$primary" -c postgres -- psql -q -U postgres -d postgres -c \
    "SELECT pg_switch_wal();" >/dev/null 2>&1 || warn "pg_switch_wal failed (continuing)"

  # Both halves must hold, and the readiness half is the one that catches a
  # cluster broken for the wrong reason: ContinuousArchiving=False on a cluster
  # that never came up looks identical here but is a different — and useless —
  # fixture. Asserting only the condition would have reported success on it.
  local deadline=$((SECONDS + 240)) archiving="" ready=""
  while [ $SECONDS -lt $deadline ]; do
    archiving=$(k -n "${NS}" get cluster.postgresql.cnpg.io pg-wal-failing \
      -o jsonpath='{range .status.conditions[?(@.type=="ContinuousArchiving")]}{.status}{end}' 2>/dev/null || echo "")
    ready=$(k -n "${NS}" get cluster.postgresql.cnpg.io pg-wal-failing \
      -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo "")
    [ "$archiving" = "False" ] && [ "${ready:-0}" = "2" ] && break
    sleep 5
  done

  if [ "$archiving" = "False" ] && [ "${ready:-0}" = "2" ]; then
    ok "ContinuousArchiving=False at ${ready}/2 Ready — healthy cluster, broken recovery point"
  else
    warn "wanted ContinuousArchiving=False at 2/2; got '${archiving:-unset}' at '${ready:-unset}'/2"
    warn "the scenario needs BOTH — a broken cluster with failing archiving is the wrong fixture"
  fi
}

# --- Statuses that need the operator out of the way ------------------------

# Timestamps are computed relative to now, never hardcoded. A fixed date rots:
# a Velero backup stamped with a literal expiry renders "Expired" a few months
# later, and "Started" ages into meaninglessness — so the fixture quietly stops
# demonstrating the thing it was built to demonstrate.
# BSD (macOS) and GNU date take different offset flags.
ts_offset() {
  local spec="$1"
  date -u -v"${spec}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "${spec/#+/} ${spec:0:1}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u +%Y-%m-%dT%H:%M:%SZ
}

patch_backup_phases() {
  local started stopped
  started=$(ts_offset -4H)
  stopped=$(ts_offset -3H)

  patch_status backups.postgresql.cnpg.io pg-backup-ok \
    "{\"status\":{\"phase\":\"completed\",\"startedAt\":\"${started}\",\"stoppedAt\":\"${stopped}\",\"method\":\"barmanObjectStore\"}}"
  patch_status backups.postgresql.cnpg.io pg-backup-wal-broken \
    "{\"status\":{\"phase\":\"walArchivingFailing\",\"startedAt\":\"${started}\",\"method\":\"barmanObjectStore\",\"error\":\"WAL archiving is failing, cannot start a new backup\"}}"
  patch_status backups.postgresql.cnpg.io pg-backup-unknown-phase \
    "{\"status\":{\"phase\":\"invalidBackupDefinitionRejected\",\"startedAt\":\"${started}\",\"method\":\"barmanObjectStore\"}}"
  ok "3 Backup phases set"
}

patch_velero_backup() {
  local started completed expires
  started=$(ts_offset -6H)
  completed=$(ts_offset -5H)
  expires=$(ts_offset +25d)
  patch_status backups.velero.io velero-nightly-cluster \
    "{\"status\":{\"phase\":\"Completed\",\"startTimestamp\":\"${started}\",\"completionTimestamp\":\"${completed}\",\"expiration\":\"${expires}\",\"errors\":0}}"
  ok "Velero Backup status set (collision row)"
}

patch_status() {
  local resource="$1" name="$2" patch="$3"
  k -n "${NS}" patch "$resource" "$name" --subresource=status --type=merge -p "$patch" >/dev/null 2>&1 \
    || warn "could not patch $resource/$name"
}

# freeze_and_patch scales the operator to zero and then writes the terminal
# phases. Order matters: with the operator running, a patched phase is
# reconciled back to the truth within seconds.
#
# The webhooks must go too — CNPG serves its own admission webhooks from the
# controller pod, so with zero replicas every write to a CNPG resource fails
# with a connection error instead of being admitted.
freeze_and_patch() {
  step "Freezing the operator so terminal phases persist"

  k delete validatingwebhookconfiguration cnpg-validating-webhook-configuration --ignore-not-found >/dev/null
  k delete mutatingwebhookconfiguration cnpg-mutating-webhook-configuration --ignore-not-found >/dev/null
  k -n cnpg-system scale deployment/cnpg-controller-manager --replicas=0 >/dev/null
  k -n cnpg-system wait --for=delete pod -l app.kubernetes.io/name=cloudnative-pg --timeout=120s >/dev/null 2>&1 || true
  ok "Operator scaled to 0, webhooks removed"

  step "Setting terminal phases"
  local c
  for c in pg-unrecoverable pg-doomed; do
    patch_status clusters.postgresql.cnpg.io "$c" \
      "{\"status\":{\"phase\":\"${PHASE_UNRECOVERABLE}\"}}"
    ok "$c → ${PHASE_UNRECOVERABLE}"
  done

  # Backups are created here, not with the other fixtures — see apply_fixtures.
  step "Creating Backups and setting their phases"
  k apply -f "${FIXTURES_DIR}/07-backups.yaml" >/dev/null
  patch_backup_phases

  note "Instance managers keep running, so these clusters stay 2/2 Ready —"
  note "which is the point: a red badge on a row whose counts look fine."
}

cmd_refreeze() { freeze_and_patch; }

# Thawing is NOT just scaling back up. The operator builds its PKI at startup
# by looking up its own webhook configurations, so with them deleted it fails
# `ensurePKI` and crash-loops:
#
#   unable to setup PKI infrastructure ...
#   mutatingwebhookconfigurations "cnpg-mutating-webhook-configuration" not found
#
# Re-applying the install manifest restores them, and is idempotent.
thaw_operator() {
  step "Restoring webhook configurations and scaling the operator back up"
  k apply --server-side -f "${CNPG_MANIFEST}" >/dev/null
  k -n cnpg-system scale deployment/cnpg-controller-manager --replicas=1 >/dev/null
  k -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout=180s >/dev/null
  ok "Operator running"
}

thaw_operator_quiet() {
  k -n cnpg-system get deployment/cnpg-controller-manager >/dev/null 2>&1 || return 0
  local replicas
  replicas=$(k -n cnpg-system get deployment/cnpg-controller-manager -o jsonpath='{.spec.replicas}')
  [ "$replicas" = "0" ] || return 0
  note "operator was frozen — thawing so fixtures can be applied"
  thaw_operator
}

cmd_thaw() {
  thaw_operator
  warn "Terminal phases will be reconciled away within seconds. Run '$0 refreeze' to restore them."
}

# --- Status ----------------------------------------------------------------

cmd_status() {
  cluster_exists || fail "Cluster '${CLUSTER_NAME}' does not exist. Run '$0 up'."

  step "Operator"
  local replicas
  replicas=$(k -n cnpg-system get deployment/cnpg-controller-manager -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "?")
  if [ "$replicas" = "0" ]; then
    note "cnpg-controller-manager scaled to 0 (frozen — terminal phases hold)"
  else
    note "cnpg-controller-manager running (live — terminal phases will not hold)"
  fi

  step "Clusters"
  k -n "${NS}" get clusters.postgresql.cnpg.io \
    -o custom-columns='NAME:.metadata.name,READY:.status.readyInstances,DESIRED:.spec.instances,PHASE:.status.phase' 2>/dev/null || true

  step "ContinuousArchiving"
  local c st
  for c in $(k -n "${NS}" get clusters.postgresql.cnpg.io -o name 2>/dev/null); do
    st=$(k -n "${NS}" get "$c" -o jsonpath='{range .status.conditions[?(@.type=="ContinuousArchiving")]}{.status}{end}' 2>/dev/null || echo "")
    [ -n "$st" ] && note "$(basename "$c"): ContinuousArchiving=${st}"
  done

  step "Backups, Poolers, ScheduledBackups"
  k -n "${NS}" get backups.postgresql.cnpg.io \
    -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,CLUSTER:.spec.cluster.name' 2>/dev/null || true
  k -n "${NS}" get poolers.postgresql.cnpg.io \
    -o custom-columns='NAME:.metadata.name,DESIRED:.spec.instances,SCHEDULED:.status.instances' 2>/dev/null || true
  k -n "${NS}" get scheduledbackups.postgresql.cnpg.io \
    -o custom-columns='NAME:.metadata.name,METHOD:.spec.method,SUSPEND:.spec.suspend' 2>/dev/null || true

  step "Colliding plurals"
  k -n "${NS}" get backups.velero.io \
    -o custom-columns='NAME:.metadata.name,PHASE:.status.phase' 2>/dev/null || true
  k -n "${NS}" get clusters.apps.kubeblocks.io \
    -o custom-columns='NAME:.metadata.name' 2>/dev/null || true
}

# --- Summary ---------------------------------------------------------------

print_summary() {
  local mode="$1"
  printf "\n"
  step "CNPG demo cluster ready (${mode})"
  cat <<EOF

  Context:  ${KUBECTL_CTX}

  Four clusters, all 2/2 Ready, four different badges:
    pg-healthy         Healthy               no backup config → audit reports it
    pg-wal-failing     WAL Archiving Failing REAL archiver failure, self-sustaining
    pg-unrecoverable   Unrecoverable         terminal phase, muted cells + tooltips
    pg-doomed          Unrecoverable         second one, so the filter shows (2)

  Also: Pooler (Scheduled, not Ready) · ScheduledBackup (method: plugin) ·
        3 Backups (completed / walArchivingFailing / an unmapped phase) ·
        a Velero \`backups\` CR and a KubeBlocks \`clusters\` CRD for the
        shared-plural guards.

  Run Radar against this cluster:
    kubectl config use-context ${KUBECTL_CTX}
    ./scripts/visual-test-start.sh

  Other commands:
    $0 status     # inventory + whether the operator is frozen
    $0 live       # rebuild with the operator LEFT RUNNING (no terminal phases)
    $0 refreeze   # re-apply freeze + terminal phases
    $0 down       # delete cluster

EOF
  if [ "$mode" = "live" ]; then
    cat <<'EOF'
  NOTE: operator is running, so the two terminal-phase clusters show their
  real phase, not "unrecoverable". That is the trade: a live controller gives
  you real failovers, switchovers and backup runs, but will not hold a
  hand-written phase. Run 'refreeze' when you want the rendering fixtures back.

EOF
  fi
}

cmd_help() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-help}" in
  up)       cmd_up       ;;
  down)     cmd_down     ;;
  live)     cmd_live     ;;
  refreeze) cmd_refreeze ;;
  thaw)     cmd_thaw     ;;
  status)   cmd_status   ;;
  help|-h|--help) cmd_help ;;
  *)
    printf "${C_RED}Unknown subcommand: %s${C_RESET}\n\n" "$1"
    cmd_help
    exit 1
    ;;
esac
