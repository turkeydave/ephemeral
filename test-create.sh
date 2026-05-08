#!/usr/bin/env bash
set -e
PROJECT="project-4b04c9cf-520a-4693-86a"
BASE="http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents"
ID="task-new-$(date +%s)"

echo "--- creating ${ID} ---"
curl.exe -s -X PATCH -H "Content-Type: application/json" \
  "${BASE}/tasks/${ID}" \
  -d '{"fields":{"title":{"stringValue":"Trigger smoke test"},"status":{"stringValue":"open"},"priority":{"stringValue":"low"}}}' >/dev/null
sleep 2
echo "--- last 3 taskHistory ---"
curl.exe -s "${BASE}/taskHistory?pageSize=3"
