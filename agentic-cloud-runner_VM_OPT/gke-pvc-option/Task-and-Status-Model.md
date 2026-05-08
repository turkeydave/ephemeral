# Task and Status Model

## Purpose

Define the minimal data model for:

- starting a task
- persisting its current state
- optionally recording a simple status event history

This document is intentionally minimal. It is designed to support the first runnable version of the system without overbuilding the control plane.

## Recommendation

Start with:

1. one task request payload
2. one persisted task record
3. optional task event records

That is enough to support:

- task launch
- status visibility
- artifact lookup
- cancellation targeting

## POC Model

In the proof-of-concept stage, you may not need a durable task database before launch.

POC can be:

- submit a task payload
- launch a Job
- rely mostly on Kubernetes logs and GCS artifacts

But even for POC, the task payload shape should be defined clearly.

## POC Task Request

Recommended shape:

```json
{
  "task_id": "task-2026-03-14-001",
  "prompt": "Investigate invoice search regression",
  "repo_app": "git@bitbucket.org:org/docket.git",
  "repo_api": "git@bitbucket.org:org/docket-platform.git",
  "base_branch_app": "main",
  "base_branch_api": "main",
  "timeout_minutes": 90
}
```

That is enough to bootstrap the execution flow.

## v1 Task Request

For v1, add a few control-plane fields:

```json
{
  "task_id": "task-2026-03-14-001",
  "requested_by": "operator@company.com",
  "task_type": "bugfix",
  "prompt": "Investigate invoice search regression",
  "repo_app": "git@bitbucket.org:org/docket.git",
  "repo_api": "git@bitbucket.org:org/docket-platform.git",
  "base_branch_app": "main",
  "base_branch_api": "main",
  "timeout_minutes": 90,
  "artifacts_prefix": "gs://bucket/agent-runs/task-2026-03-14-001/"
}
```

Keep snapshot selection out of the task request if you want the dispatcher to always use the current configured snapshot in v1.

If you later need reproducibility controls, add `snapshot_id`.

## Persisted Task Record

For v1, persist one current record per task.

Recommended fields:

```json
{
  "task_id": "task-2026-03-14-001",
  "requested_by": "operator@company.com",
  "task_type": "bugfix",
  "prompt": "Investigate invoice search regression",
  "repo_app": "git@bitbucket.org:org/docket.git",
  "repo_api": "git@bitbucket.org:org/docket-platform.git",
  "base_branch_app": "main",
  "base_branch_api": "main",
  "snapshot_id": "golden-nightly-2026-03-14-01",
  "job_name": "agent-task-2026-03-14-001",
  "pvc_name": "agent-task-2026-03-14-001-pvc",
  "status": "running_agent",
  "status_message": "Codex is analyzing the issue",
  "artifacts_prefix": "gs://bucket/agent-runs/task-2026-03-14-001/",
  "requested_at": "2026-03-14T07:00:00Z",
  "started_at": "2026-03-14T07:01:00Z",
  "finished_at": null,
  "result_summary": null
}
```

This record should be updated in place as the task moves through its lifecycle.

## Minimal Status Values

Recommended v1 states:

- `accepted`
- `launching`
- `booting`
- `cloning_repos`
- `starting_stack`
- `running_agent`
- `uploading_artifacts`
- `succeeded`
- `failed`
- `cancelled`

Keep them few and operationally meaningful.

## Status Message

In addition to the discrete state, keep one short free-text field:

- `status_message`

Examples:

- `Waiting for Postgres and Meilisearch`
- `Cloning docket and docket-platform`
- `Starting Firebase emulator and pubsub subscriber`
- `Uploading logs and summary`

This gives useful operator visibility without needing a complex event model immediately.

## Optional Task Event Log

You do not need this for the first cut, but it is a cheap improvement once the basics work.

Recommended event shape:

```json
{
  "task_id": "task-2026-03-14-001",
  "timestamp": "2026-03-14T07:10:00Z",
  "state": "starting_stack",
  "message": "API is healthy, starting app"
}
```

This is useful for:

- debugging stuck tasks
- reconstructing task progression
- showing a timeline in a UI later

## Storage Recommendation

For v1, use Firestore unless another existing internal system is already the obvious home.

Why Firestore fits:

- simple document updates
- easy append-only event records if needed
- low overhead for small control-plane metadata

Recommended collections:

- `agent_tasks`
- optional `agent_task_events`

## Suggested Firestore Shapes

### `agent_tasks/{task_id}`

```json
{
  "task_id": "task-2026-03-14-001",
  "requested_by": "operator@company.com",
  "task_type": "bugfix",
  "prompt": "Investigate invoice search regression",
  "repo_app": "git@bitbucket.org:org/docket.git",
  "repo_api": "git@bitbucket.org:org/docket-platform.git",
  "base_branch_app": "main",
  "base_branch_api": "main",
  "snapshot_id": "golden-nightly-2026-03-14-01",
  "job_name": "agent-task-2026-03-14-001",
  "pvc_name": "agent-task-2026-03-14-001-pvc",
  "status": "booting",
  "status_message": "Waiting for sidecars",
  "artifacts_prefix": "gs://bucket/agent-runs/task-2026-03-14-001/",
  "requested_at": "2026-03-14T07:00:00Z",
  "started_at": "2026-03-14T07:01:00Z",
  "finished_at": null,
  "result_summary": null
}
```

### `agent_task_events/{event_id}`

```json
{
  "task_id": "task-2026-03-14-001",
  "timestamp": "2026-03-14T07:10:00Z",
  "state": "starting_stack",
  "message": "API is healthy, starting app"
}
```

## Ownership of Updates

Recommended ownership:

- task producer writes the initial request or calls the dispatcher
- dispatcher writes `accepted` and `launching`
- runner writes lifecycle updates after the Job starts
- control plane writes `cancelled` if a task is terminated externally

## Minimal Cancellation Support

To cancel a task, the system needs at least:

- `task_id`
- `job_name`
- current `status`

That is why persisting the task record is useful even in a simple version.

## Minimal Final Result Fields

At task completion, set:

- `status`
- `finished_at`
- `result_summary`

Optional later additions:

- output branch name
- PR URL
- evidence bundle URL
- exit code

## Recommendation Summary

Use this staged approach:

### POC

- define the task request payload
- do not overbuild persistence yet

### v1

- persist one task record per task
- update `status` and `status_message`
- store `job_name`, `pvc_name`, and `snapshot_id`

### v1.1

- add append-only task events

This is enough structure to make the runner observable and operable without committing to a heavyweight workflow engine.
