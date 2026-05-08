#!/bin/sh
set -e

echo "Workspace: /workspace"

# Ensure GCLOUD_PROJECT is set for functions runtime discovery
export GCLOUD_PROJECT=${GCLOUD_PROJECT:-demo-project}

# Where to persist / restore emulator data across container restarts.
# Bind-mounted via docker-compose (the workspace volume), so it survives
# container recreation as long as the host directory exists.
EMULATOR_DATA_DIR="${EMULATOR_DATA_DIR:-/workspace/emulator-data}"
mkdir -p "${EMULATOR_DATA_DIR}"

# Install functions deps if a package.json is present and node_modules is
# missing. In the cloud image deps are baked in, so this is a no-op there;
# in the local dev container (bind-mounted /workspace) this is the first
# install on a fresh container.
if [ -f /workspace/firebase-app/functions/package.json ] \
   && [ ! -d /workspace/firebase-app/functions/node_modules ]; then
  echo "Installing functions dependencies (first run)..."
  npm --prefix /workspace/firebase-app/functions ci --no-audit --no-fund \
    || npm --prefix /workspace/firebase-app/functions install --no-audit --no-fund
fi

# Only pass --import if the directory contains a previous export
# (firebase-tools errors on --import pointing to an empty directory).
IMPORT_FLAG=""
if [ -f "${EMULATOR_DATA_DIR}/firebase-export-metadata.json" ]; then
  echo "Importing emulator data from ${EMULATOR_DATA_DIR}"
  IMPORT_FLAG="--import=${EMULATOR_DATA_DIR}"
else
  echo "No prior export found at ${EMULATOR_DATA_DIR} — starting empty"
fi

echo "Starting Firebase emulators (firestore, functions, ui)"
echo "Will export to ${EMULATOR_DATA_DIR} on shutdown (SIGTERM)"
exec firebase emulators:start \
  --only firestore,functions,pubsub,ui \
  ${IMPORT_FLAG} \
  --export-on-exit="${EMULATOR_DATA_DIR}"
