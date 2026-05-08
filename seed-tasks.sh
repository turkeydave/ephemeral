#!/usr/bin/env bash
set -e

PROJECT="project-4b04c9cf-520a-4693-86a"
BASE="http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents"

seed_task() {
  local id="$1"
  local title="$2"
  local status="$3"
  local priority="$4"
  local ts="$5"

  curl.exe -s -X PATCH \
    -H "Content-Type: application/json" \
    "${BASE}/tasks/${id}" \
    -d "{
      \"fields\": {
        \"title\":     {\"stringValue\":  \"${title}\"},
        \"status\":    {\"stringValue\":  \"${status}\"},
        \"priority\":  {\"stringValue\":  \"${priority}\"},
        \"createdAt\": {\"timestampValue\":\"${ts}\"},
        \"updatedAt\": {\"timestampValue\":\"${ts}\"}
      }
    }" >/dev/null
  echo "seeded: ${id} — ${title}"
}

seed_task "task-001" "Provision GCP project skeleton"        "open"        "high"   "2026-05-08T09:00:00Z"
seed_task "task-002" "Wire Firestore emulator into compose"  "done"        "medium" "2026-05-08T09:05:00Z"
seed_task "task-003" "Define tasks API contract"             "open"        "high"   "2026-05-08T09:10:00Z"
seed_task "task-004" "Implement onTaskUpdate trigger"        "in-progress" "medium" "2026-05-08T09:15:00Z"
seed_task "task-005" "Hook web app to tasks API"             "open"        "low"    "2026-05-08T09:20:00Z"
seed_task "task-006" "Plan ephemeral env IaC"                "blocked"     "high"   "2026-05-08T09:25:00Z"
