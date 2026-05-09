#!/bin/bash
# VM startup script for an ephemeral-runner task VM (Milestones 1–3).
#
# Reads task inputs from instance metadata (set by the dispatcher, or by
# scripts/launch-vm.ps1 for the hand-launched M1 smoke test):
#
#   repo_url            (e.g. https://github.com/turkeydave/ephemeral.git)
#   branch              (default: main)
#   image_tag           (e.g. m1-abcdef0)
#   firebase_project    (must match the projectId baked into the app)
#   env_id              (M3+; if set, this VM owns Firestore doc
#                        agent_environments/<env_id> and updates it on
#                        /healthz. If unset (M1 hand-launched smoke), the
#                        registry write is skipped entirely.)
#
# Then:
#   1. installs docker + docker compose plugin if missing (Debian)
#   2. configures docker auth for Artifact Registry
#   3. shallow-clones the repo on the requested branch
#   4. writes .env for docker-compose.cloud.yml
#   5. docker compose pull (platform images) + build (api/app) + up -d
#   6. waits for edge-proxy /healthz
#   7. (M3+) updates Firestore agent_environments/<env_id> with
#      status=ready, vm_internal_ip, ready_at.

set -euo pipefail
exec > >(tee -a /var/log/ephem-startup.log) 2>&1
echo "==> ephem-startup: $(date -u +%FT%TZ)"

REGION="us-central1"
PROJECT_ID="project-4b04c9cf-520a-4693-86a"
REPO_ID="ephemeral-runner"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_ID}"

# ---- read metadata ----
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
get_attr() { curl -fsSL -H "$HDR" "${META}/${1}" || true; }

REPO_URL=$(get_attr repo_url)
BRANCH=$(get_attr branch); BRANCH=${BRANCH:-main}
IMAGE_TAG=$(get_attr image_tag)
FIREBASE_PROJECT=$(get_attr firebase_project); FIREBASE_PROJECT=${FIREBASE_PROJECT:-$PROJECT_ID}
ENV_ID=$(get_attr env_id)

if [ -z "$REPO_URL" ] || [ -z "$IMAGE_TAG" ]; then
  echo "ERROR: missing required metadata (repo_url / image_tag)" >&2
  exit 1
fi

# VM internal IP from the metadata server. The dispatcher already wrote
# the doc with status=launching; we update it to status=ready below once
# the stack is live.
VM_INTERNAL_IP=$(curl -fsSL -H "$HDR" \
  "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip" || true)

echo "repo_url=$REPO_URL branch=$BRANCH image_tag=$IMAGE_TAG firebase_project=$FIREBASE_PROJECT env_id=${ENV_ID:-<unset>} vm_internal_ip=$VM_INTERNAL_IP"

# ---- install docker if missing ----
if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing docker"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

# git is needed below; it was installed above unless docker was already present
command -v git >/dev/null 2>&1 || apt-get install -y git

# ---- artifact registry auth (uses VM SA credentials via gcloud) ----
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ---- clone repo ----
WORKDIR=/srv/ephemeral
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$WORKDIR"
cd "$WORKDIR"

# ---- render .env for docker-compose.cloud.yml ----
cat > "$WORKDIR/.env" <<EOF
REGISTRY=$REGISTRY
TAG=$IMAGE_TAG
FIREBASE_PROJECT=$FIREBASE_PROJECT
EOF

# ---- pull (platform images) + build (api/app) + start ----
# `pull` only fetches the services that reference images from Artifact
# Registry. `build` covers the agent-editable services (api, app) that
# `docker-compose.cloud.yml` builds from the cloned repo with bind-mounts.
cd "$WORKDIR"
docker compose -f docker-compose.cloud.yml --env-file .env pull --ignore-buildable
docker compose -f docker-compose.cloud.yml --env-file .env build
docker compose -f docker-compose.cloud.yml --env-file .env up -d

# ---- wait for edge-proxy health ----
echo "==> waiting for edge-proxy :8080/healthz"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "==> edge-proxy healthy after ${i}s"
    break
  fi
  sleep 1
done

curl -fsS http://127.0.0.1:8080/healthz || {
  echo "ERROR: edge-proxy did not become healthy" >&2
  docker compose -f docker-compose.cloud.yml ps || true
  exit 1
}

# ---- (M3) update Firestore agent_environments/<env_id> ----
# The dispatcher created the doc with status=launching when it created
# this VM. We patch it to status=ready and stamp the IP + timestamp.
# Skipped entirely when env_id metadata is unset (M1 hand-launched VM).
if [ -n "$ENV_ID" ] && [ -n "$VM_INTERNAL_IP" ]; then
  echo "==> updating Firestore agent_environments/$ENV_ID -> status=ready ip=$VM_INTERNAL_IP"

  TOKEN=$(curl -fsSL -H "$HDR" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

  if [ -z "$TOKEN" ]; then
    echo "WARN: could not obtain access token; skipping registry update" >&2
  else
    NOW=$(date -u +%FT%TZ)
    # Firestore REST PATCH against the (default) DB. updateMask is
    # repeated; only listed fields are written, anything else (e.g.
    # status=launching that the dispatcher set) is preserved.
    URL="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/agent_environments/${ENV_ID}?updateMask.fieldPaths=status&updateMask.fieldPaths=vm_internal_ip&updateMask.fieldPaths=ready_at"
    BODY=$(cat <<JSON
{
  "fields": {
    "status":         {"stringValue":    "ready"},
    "vm_internal_ip": {"stringValue":    "$VM_INTERNAL_IP"},
    "ready_at":       {"timestampValue": "$NOW"}
  }
}
JSON
)
    HTTP_CODE=$(curl -sS -o /tmp/firestore-patch.out -w "%{http_code}" \
      -X PATCH \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      "$URL" || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
      echo "==> Firestore registry updated: status=ready"
    else
      echo "WARN: Firestore patch returned HTTP $HTTP_CODE" >&2
      cat /tmp/firestore-patch.out >&2 || true
      # Don't fail the boot — gateway will keep returning 503 and the
      # cleanup worker will eventually reap the VM.
    fi
  fi
else
  echo "==> no env_id metadata (or no IP); skipping Firestore registry update"
fi

echo "==> ephem-startup complete: $(date -u +%FT%TZ)"
