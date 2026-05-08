#!/usr/bin/env bash
set -e
PROJECT="project-4b04c9cf-520a-4693-86a"
BASE="http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents"

echo "--- updating task-001 ---"
curl.exe -s -X PATCH \
  -H "Content-Type: application/json" \
  "${BASE}/tasks/task-001?updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt" \
  -d "{\"fields\":{\"status\":{\"stringValue\":\"done\"},\"updatedAt\":{\"timestampValue\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}}"
echo
echo "--- waiting for trigger ---"
sleep 3
echo "--- taskHistory ---"
curl.exe -s "${BASE}/taskHistory?pageSize=10"
