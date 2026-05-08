# Task and Status Model

## Purpose

Define the minimal task payload and persisted status model for the Compute Engine VM option.

This stays very close to the GKE option, but uses VM-specific resource fields instead of Kubernetes resource names.

## Recommendation

Use the same staged approach:

### POC

- one task payload
- minimal or no durable persistence

### v1

- one persisted task record per task
- optional later event history

## Task Request

Recommended v1 shape:

```json
{
  "task_id": "task-2026-03-15-001",
  "requested_by": "operator@company.com",
  "mode": "agentic",
  "task_type": "bugfix",
  "prompt": "Investigate invoice search regression",
  "repo_app": "git@bitbucket.org:org/docket.git",
  "repo_api": "git@bitbucket.org:org/docket-platform.git",
  "base_branch_app": "main",
  "base_branch_api": "main",
  "enable_public_urls": true,
  "ttl_minutes": 90,
  "timeout_minutes": 90,
  "artifacts_prefix": "gs://bucket/agent-runs/task-2026-03-15-001/"
}
```

As with the simplified snapshot model, snapshot selection can stay outside the request in v1.

For human-only preview environments, use `mode = "review"` and omit `prompt`.

## Persisted Task Record

Recommended fields:

```json
{
  "task_id": "task-2026-03-15-001",
  "requested_by": "operator@company.com",
  "mode": "agentic",
  "task_type": "bugfix",
  "prompt": "Investigate invoice search regression",
  "repo_app": "git@bitbucket.org:org/docket.git",
  "repo_api": "git@bitbucket.org:org/docket-platform.git",
  "base_branch_app": "main",
  "base_branch_api": "main",
  "snapshot_id": "golden-nightly-2026-03-15-01",
  "instance_name": "agent-task-2026-03-15-001",
  "data_disk_name": "agent-task-2026-03-15-001-data",
  "zone": "us-central1-a",
  "vm_internal_ip": "10.20.4.18",
  "enable_public_urls": true,
  "public_urls": {
    "app": "https://task-2026-03-15-001-app.preview.example.com",
    "api": "https://task-2026-03-15-001-api.preview.example.com"
  },
  "status": "running_agent",
  "status_message": "Codex is analyzing the issue",
  "artifacts_prefix": "gs://bucket/agent-runs/task-2026-03-15-001/",
  "requested_at": "2026-03-15T09:00:00Z",
  "started_at": "2026-03-15T09:02:00Z",
  "ready_at": "2026-03-15T09:04:00Z",
  "expires_at": "2026-03-15T10:30:00Z",
  "finished_at": null,
  "result_summary": null
}
```

## Recommended Status Values

- `accepted`
- `launching`
- `booting`
- `cloning_repos`
- `starting_stack`
- `registering_public_urls`
- `ready_for_review`
- `running_agent`
- `uploading_artifacts`
- `succeeded`
- `failed`
- `cancelled`
- `expired`

## Why Persist Status

Even in a simple VM-based system, this is useful for:

- cancellation targeting
- orphan cleanup
- artifact lookup
- operator visibility

## Storage

Recommended v1 storage:

- Firestore

Suggested collections:

- `agent_tasks`
- optional `agent_task_events`

## Summary

The status model for the VM option can stay almost identical to the GKE option.

The only important difference is the resource identifiers you persist:

- `instance_name`
- `data_disk_name`
- `zone`

instead of Job/PVC names.
