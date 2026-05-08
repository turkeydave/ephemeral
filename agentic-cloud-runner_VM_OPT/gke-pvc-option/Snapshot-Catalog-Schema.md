# Snapshot Catalog Schema

## Purpose

Define the minimal control-plane data needed to tell the dispatcher which golden snapshot to use.

This document is intentionally simple. It does not define a large catalog service. It defines the smallest useful progression from:

- POC hardcoded snapshot selection
- to a minimal v1 current-snapshot record
- to optional later history

## What the Snapshot Catalog Is

The snapshot catalog is not a registry of per-task PVCs.

It is a small record of published golden snapshots that answers:

- what snapshot is currently usable
- what Kubernetes `VolumeSnapshot` name to clone from
- whether that snapshot passed validation

## Recommendation

Start with the simplest possible progression:

1. POC: one snapshot name hardcoded in config
2. v1: one persisted "current snapshot" record
3. later: optional historical records and channels

Do not build a large catalog system first.

## POC Model

In the proof-of-concept stage, the dispatcher can use one configured snapshot reference.

Example config:

```json
{
  "current_snapshot_name": "golden-nightly-2026-03-14-01"
}
```

POC behavior:

- dispatcher reads the configured name
- dispatcher creates the PVC from that snapshot
- no runtime catalog lookup is required

This is acceptable for early implementation.

## v1 Model

For v1, replace the hardcoded value with one minimal persisted record.

Recommended fields:

```json
{
  "snapshot_id": "golden-nightly-2026-03-14-01",
  "volume_snapshot_name": "golden-nightly-2026-03-14-01",
  "status": "ready",
  "created_at": "2026-03-14T05:25:00Z",
  "validation_status": "passed"
}
```

That is enough for the dispatcher to:

- find the currently usable snapshot
- avoid using an unvalidated build
- record which snapshot a task used

## Minimal Storage Options

Recommended v1 choices:

- one Firestore document
- or one JSON manifest in GCS

### Firestore Shape

Collection:

- `runner_config`

Document:

- `current_snapshot`

Example:

```json
{
  "snapshot_id": "golden-nightly-2026-03-14-01",
  "volume_snapshot_name": "golden-nightly-2026-03-14-01",
  "status": "ready",
  "created_at": "2026-03-14T05:25:00Z",
  "validation_status": "passed"
}
```

### GCS Shape

Object path:

- `gs://<bucket>/runner-config/current-snapshot.json`

Example contents:

```json
{
  "snapshot_id": "golden-nightly-2026-03-14-01",
  "volume_snapshot_name": "golden-nightly-2026-03-14-01",
  "status": "ready",
  "created_at": "2026-03-14T05:25:00Z",
  "validation_status": "passed"
}
```

## Dispatcher Contract

The dispatcher should need only this:

- `volume_snapshot_name`
- `status`

Recommended rule:

- only use the record if `status == ready`

If the current snapshot record is missing or not ready:

- do not launch the task
- return a clear failure reason

## Minimal Status Values

Keep this set small:

- `building`
- `ready`
- `failed`

For the current snapshot pointer, the dispatcher should only accept `ready`.

## Optional v1.1 Fields

Add these only when needed:

- `channel`
- `seed_version`
- `postgres_image`
- `meilisearch_image`
- `firebase_image`
- `notes`

Example:

```json
{
  "snapshot_id": "golden-nightly-2026-03-14-01",
  "volume_snapshot_name": "golden-nightly-2026-03-14-01",
  "status": "ready",
  "created_at": "2026-03-14T05:25:00Z",
  "validation_status": "passed",
  "channel": "nightly",
  "seed_version": "v1"
}
```

## Optional Later History Model

Only add this once you need rollback history or multiple channels.

Possible shape:

- `current_snapshot` pointer document
- `snapshots/{snapshot_id}` records for history

Historical record example:

```json
{
  "snapshot_id": "golden-nightly-2026-03-14-01",
  "volume_snapshot_name": "golden-nightly-2026-03-14-01",
  "status": "ready",
  "created_at": "2026-03-14T05:25:00Z",
  "validation_status": "passed",
  "channel": "nightly"
}
```

The pointer record would simply identify which one is active.

## Recommendation Summary

Use this staged approach:

### POC

- hardcoded configured snapshot name

### v1

- one persisted current-snapshot record

### Later

- optional snapshot history and channel support

This gives you rollover and rollback without prematurely building a full catalog service.
