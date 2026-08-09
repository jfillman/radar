#!/usr/bin/env bash
# Bootstrap a kind cluster pre-populated with Velero backup/restore scenarios
# for visual-testing the Velero views and the backup-failure Issues.
# Idempotent — re-run to refresh state or apply fixture updates without
# recreating the cluster.
#
# READ THIS FIRST — why the Velero controller is scaled to zero.
#
#   Velero's interesting phases (Failed, PartiallyFailed, FailedValidation,
#   WaitingForPluginOperations...) cannot be produced on a kind cluster,
#   because reaching them requires real object storage and a real backup that
#   actually fails partway. A live controller with no bucket produces exactly
#   one outcome — everything Failed with a credentials error — which is the
#   least interesting row in the table.
#
#   So the controller is installed and then scaled to 0, and the fixtures carry
#   their own status. Nothing reconciles it away, and every phase in the enum
#   becomes reachable. This is the whole trick; without it you will spend an
#   hour wondering why your hand-written status keeps reverting.
#
#   Worth knowing, because the usual advice sends you the wrong way: none of
#   the Velero CRDs declare a status subresource, so a plain `kubectl apply`
#   writes status. `kubectl patch --subresource=status` fails against them with
#   a confusing NotFound.
#
#   The cost: nothing here exercises real controller behaviour. Anything that
#   depends on a running Velero (data-mover DataUpload/DataDownload CRs,
#   real progress counters ticking, backup logs in object storage) is out of
#   reach. See the README's "What this cannot cover" section.
#
# Subcommands:
#   up        Create cluster (if missing), install Velero CRDs, apply fixtures.
#   down      Delete the kind cluster.
#   reset     down + up.
#   status    Inventory what's installed and what the fixtures look like.
#   verify    Re-run the fixture assertions without reapplying.
#   help      Show this message.
#
# Prerequisites:
#   - kind     https://kind.sigs.k8s.io/
#   - kubectl
#   - helm     (installs the Velero chart; the controller is then scaled to 0)
#   - python3  (expands the @now tokens; already required by gitops-demo.sh)
#
# Set CLUSTER_NAME=foo to use a different cluster (default: radar-velero-demo).

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-radar-velero-demo}"
KUBECTL_CTX="kind-${CLUSTER_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/velero-demo"
NS=velero

# Pinned so the demo behaves consistently. Chart 12.1.0 ships Velero 1.18.1,
# whose Backup phase enum is what the fixtures and the phase→level table in
# resource-utils-velero.ts are written against. Bump both together.
VELERO_CHART_VERSION="${VELERO_CHART_VERSION:-12.1.0}"
VELERO_APP_VERSION="1.18.1"

if [ -t 1 ]; then
  C_RESET=$'\e[0m'; C_BLUE=$'\e[34m'; C_GREEN=$'\e[32m'
  C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_DIM=$'\e[2m'
else
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""
fi
step() { printf "${C_BLUE}==> %s${C_RESET}\n" "$1"; }
ok()   { printf "${C_GREEN}    ✓ %s${C_RESET}\n" "$1"; }
warn() { printf "${C_YELLOW}    ! %s${C_RESET}\n" "$1"; }
fail() { printf "${C_RED}    ✗ %s${C_RESET}\n" "$1"; exit 1; }
note() { printf "${C_DIM}    %s${C_RESET}\n" "$1"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found — install it: $2"
}

k() { kubectl --context "${KUBECTL_CTX}" "$@"; }

# Rendered fixtures (tokens expanded) live in temp dirs cleaned up on exit. A
# RETURN trap looks tidier but fires on every later function return too, and
# then trips `set -u` on a variable that has gone out of scope.
RENDER_DIRS=()
cleanup_render_dirs() {
  for d in "${RENDER_DIRS[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done
}
trap cleanup_render_dirs EXIT

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; }

# --- Lifecycle -------------------------------------------------------------

cmd_up() {
  require_cmd kind "https://kind.sigs.k8s.io/docs/user/quick-start/#installation (or 'brew install kind')"
  require_cmd kubectl "https://kubernetes.io/docs/tasks/tools/"
  require_cmd helm "https://helm.sh/docs/intro/install/ (or 'brew install helm')"
  require_cmd python3 "https://www.python.org/downloads/"

  if cluster_exists; then
    step "Cluster '${CLUSTER_NAME}' already exists — reusing"
  else
    step "Creating kind cluster '${CLUSTER_NAME}'"
    kind create cluster --name "${CLUSTER_NAME}" --wait 60s
    ok "Cluster created"
  fi
  k cluster-info >/dev/null || fail "kind context not reachable"

  install_velero
  apply_fixtures
  verify_fixtures
  print_summary
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

cmd_reset() { cmd_down; cmd_up; }

# --- Velero ----------------------------------------------------------------

install_velero() {
  step "Installing Velero chart ${VELERO_CHART_VERSION} (app ${VELERO_APP_VERSION})"

  helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update vmware-tanzu >/dev/null 2>&1 || true

  # credentials.useSecret=false and snapshotsEnabled=false keep the install
  # from demanding a cloud credential that would never be used — the
  # controller is about to be scaled to zero. The BSL is declared anyway so
  # the fixtures have a default location to reference.
  helm upgrade --install velero vmware-tanzu/velero \
    --kube-context "${KUBECTL_CTX}" \
    --namespace "${NS}" --create-namespace \
    --version "${VELERO_CHART_VERSION}" \
    --set credentials.useSecret=false \
    --set snapshotsEnabled=false \
    --set deployNodeAgent=false \
    --set "initContainers[0].name=velero-plugin-for-aws" \
    --set "initContainers[0].image=velero/velero-plugin-for-aws:v1.12.0" \
    --set "initContainers[0].volumeMounts[0].mountPath=/target" \
    --set "initContainers[0].volumeMounts[0].name=plugins" \
    --set "configuration.backupStorageLocation[0].name=default" \
    --set "configuration.backupStorageLocation[0].provider=aws" \
    --set "configuration.backupStorageLocation[0].bucket=radar-demo" \
    --set "configuration.backupStorageLocation[0].default=true" \
    --set "configuration.backupStorageLocation[0].config.region=us-east-1" \
    --wait --timeout 5m >/dev/null
  ok "Chart installed (13 CRDs)"

  # The load-bearing step. See the header comment.
  step "Scaling the Velero controller to 0 so hand-written status survives"
  k -n "${NS}" scale deployment/velero --replicas=0 >/dev/null
  k -n "${NS}" wait --for=delete pod -l deploy=velero --timeout=90s >/dev/null 2>&1 || true
  ok "Controller stopped — nothing will reconcile the fixtures away"
}

# --- Fixtures --------------------------------------------------------------

# None of the Velero CRDs declare a status subresource (checked across all six
# in v1.18.1), so status is an ordinary field and a plain apply writes it. The
# usual "kubectl apply drops status" rule only holds for kinds that DO register
# the subresource — reaching for `kubectl patch --subresource=status` here
# fails with a confusing NotFound, because there is no such subresource to
# address. If a future Velero release adds one, this is the function to change.
apply_one() {
  k apply -f "$1" >/dev/null
}

# Fixtures carry @now±Nm tokens instead of absolute timestamps, so a demo
# recorded today doesn't render as "expired 8 months ago" next year. Expand
# them into RFC3339 at apply time.
expand_tokens() {
  local src="$1" dst="$2"
  python3 - "$src" "$dst" <<'PY'
import datetime, re, sys
src, dst = sys.argv[1], sys.argv[2]
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
def sub(m):
    t = now + datetime.timedelta(minutes=int(m.group(1)))
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')
open(dst, 'w').write(re.sub(r'@now([+-]\d+)m', sub, open(src).read()))
PY
}

apply_fixtures() {
  step "Applying Velero demo fixtures"
  [ -d "${FIXTURES_DIR}" ] || fail "Fixtures dir not found: ${FIXTURES_DIR}"

  local tmp; tmp="$(mktemp -d)"
  RENDER_DIRS+=("${tmp}")

  for f in $(ls "${FIXTURES_DIR}"/*.yaml 2>/dev/null | sort); do
    local base; base="$(basename "$f")"
    grep -q '^[[:space:]]*[^#[:space:]]' "$f" || { note "skipping ${base} (comments only)"; continue; }

    expand_tokens "$f" "${tmp}/${base}"
    note "applying ${base}"
    apply_one "${tmp}/${base}"

    # The CRD needs to be established before its CR can be created, and the
    # supersession backups need distinct creationTimestamps — see
    # verify_fixtures. Both are handled by pausing after the relevant files.
    case "${base}" in
      05-collision-crd.yaml)
        k wait --for=condition=Established crd/restores.resources.cattle.io --timeout=60s >/dev/null
        ;;
      6*-supersession-*.yaml)
        sleep 2
        ;;
    esac
  done
  ok "Fixtures applied"
}

# --- Verification ----------------------------------------------------------

# The fixture is only useful if it actually holds the states it claims to.
# These assertions are cheap and they fail loudly, which beats discovering
# mid-review that a phase silently didn't stick.
verify_fixtures() {
  step "Verifying fixture state"
  local errs=0

  # 1. Every Backup phase in the enum is present exactly once.
  local expected="Completed Deleting Failed FailedValidation Finalizing FinalizingPartiallyFailed InProgress New PartiallyFailed Queued ReadyToStart WaitingForPluginOperations WaitingForPluginOperationsPartiallyFailed"
  local missing=""
  for p in ${expected}; do
    k get backups.velero.io -n "${NS}" \
      -o jsonpath='{.items[*].status.phase}' 2>/dev/null | tr ' ' '\n' | grep -qx "$p" || missing="${missing} $p"
  done
  if [ -n "${missing}" ]; then warn "missing Backup phases:${missing}"; errs=$((errs+1))
  else ok "all 13 Backup phases present"; fi

  # 2. Status actually stuck. If the controller were still running, or the
  #    subresource patch silently no-opped, phases would be empty.
  local empty
  empty="$(k get backups.velero.io -n "${NS}" -o json \
    | python3 -c 'import json,sys; print(sum(1 for i in json.load(sys.stdin)["items"] if not (i.get("status") or {}).get("phase")))')"
  if [ "${empty}" != "0" ]; then warn "${empty} Backups have no phase — is the controller still running?"; errs=$((errs+1))
  else ok "hand-written status survived (controller is down)"; fi

  # 3. Supersession ordering. The rule under test is "a later successful backup
  #    clears an earlier failure in the same schedule". If the two nightly
  #    backups share a creationTimestamp, ordering falls back to the name
  #    tie-break and the test passes for a reason that has nothing to do with
  #    time — so assert the timestamps are actually distinct.
  local t_old t_new
  t_old="$(k get backup.velero.io -n "${NS}" nightly-20260806010000 -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || true)"
  t_new="$(k get backup.velero.io -n "${NS}" nightly-20260807010000 -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || true)"
  if [ -z "${t_old}" ] || [ -z "${t_new}" ]; then
    warn "supersession backups missing"; errs=$((errs+1))
  elif [ "${t_old}" = "${t_new}" ]; then
    warn "supersession backups share creationTimestamp ${t_old} — ordering would be decided by name, not time"; errs=$((errs+1))
  elif [[ "${t_old}" > "${t_new}" ]]; then
    warn "supersession backups created out of order (${t_old} > ${t_new})"; errs=$((errs+1))
  else
    ok "supersession ordering distinct (${t_old} -> ${t_new})"
  fi

  # 4. The collision CR exists and is genuinely foreign.
  if k get restores.resources.cattle.io rancher-restore >/dev/null 2>&1; then
    ok "rancher restores.resources.cattle.io present (plural collision covered)"
  else
    warn "rancher collision CR missing"; errs=$((errs+1))
  fi

  # 5. A restic repository exists — the Type column exists to surface it.
  if k get backuprepositories.velero.io -n "${NS}" -o jsonpath='{.items[*].spec.repositoryType}' 2>/dev/null | tr ' ' '\n' | grep -qx restic; then
    ok "restic BackupRepository present"
  else
    warn "no restic BackupRepository — the Type column has nothing to flag"; errs=$((errs+1))
  fi

  [ "${errs}" -eq 0 ] || fail "${errs} fixture check(s) failed"
}

cmd_verify() { verify_fixtures; }

# --- Status ----------------------------------------------------------------

cmd_status() {
  cluster_exists || fail "Cluster '${CLUSTER_NAME}' does not exist — run: $0 up"
  step "Cluster '${CLUSTER_NAME}'"
  note "$(k -n "${NS}" get deployment velero -o jsonpath='velero controller replicas={.spec.replicas} (0 is correct)' 2>/dev/null || echo 'velero deployment not found')"
  for kind in backups restores schedules backupstoragelocations volumesnapshotlocations backuprepositories; do
    printf "${C_DIM}    %-26s %s${C_RESET}\n" "${kind}" \
      "$(k get "${kind}.velero.io" -n "${NS}" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  done
  echo
  step "Backup phases"
  k get backups.velero.io -n "${NS}" \
    -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,SCHEDULE:.metadata.labels.velero\.io/schedule-name' 2>/dev/null
  echo
  step "Schedules"
  k get schedules.velero.io -n "${NS}" \
    -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,PAUSED:.spec.paused,CRON:.spec.schedule' 2>/dev/null
}

print_summary() {
  echo
  step "Ready"
  note "context:  ${KUBECTL_CTX}"
  note "point Radar at it:  kubectl config use-context ${KUBECTL_CTX} && make restart"
  note "coverage matrix:    scripts/velero-demo/README.md"
  note "inventory:          $0 status"
}

case "${1:-help}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  status) cmd_status ;;
  verify) cmd_verify ;;
  help|-h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d' ;;
  *) fail "Unknown subcommand: $1 (try: $0 help)" ;;
esac
