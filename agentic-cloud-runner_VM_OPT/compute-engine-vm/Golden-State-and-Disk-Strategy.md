# Golden State and Disk Strategy

## Purpose

Define how the Compute Engine VM option handles seeded runtime state.

This reuses the same core idea as the GKE design:

- create a canonical seeded data state once
- snapshot it
- clone from it per task

The difference is where that state is mounted:

- on a VM-attached persistent disk instead of a cloned PVC

## Core Recommendation

Split runtime state into:

- boot/runtime software state
- seeded data state

Recommended implementation:

- boot disk comes from an image or instance template
- data disk is created from the current golden snapshot

## What Lives on the Data Disk

Recommended layout:

```text
/mnt/golden
  /postgres/pgdata
  /meilisearch/data
  /firebase/export
  /metadata/seed-manifest.json
```

## Service Behavior

### Postgres

- uses `/mnt/golden/postgres/pgdata`
- this should be preinitialized runtime data

### Meilisearch

- uses `/mnt/golden/meilisearch/data`
- this should be preinitialized runtime data

### Firebase Emulator

- reads `/mnt/golden/firebase/export`
- starts with `--import=/mnt/golden/firebase/export`

This is the same distinction as the GKE option:

- raw runtime data for Postgres/Meilisearch
- export/import compatibility boundary for Firebase

## How the Snapshot Is Made

Recommended progression:

### POC

- manually create one seeded data disk
- validate it
- create one snapshot

### v1

- create a repeatable seed builder process
- publish one current golden snapshot pointer

## Seed Builder Options

Simplest options:

- one dedicated builder VM
- or one manually operated script on an admin VM

The seed builder should:

1. create or attach a blank data disk
2. populate Postgres and Meilisearch data directories
3. write Firebase export data
4. validate the resulting state
5. stop services cleanly
6. snapshot the disk

## Why This Is Simpler Than GKE

There are no Kubernetes storage objects to manage.

The control plane only needs to do this:

1. create disk from snapshot
2. attach disk to VM
3. mount disk in startup script

## Mutable Repos Stay Separate

Do not put checked-out repos on the golden data disk.

The golden data disk is for seeded runtime state only.

Repos should be cloned fresh onto the VM boot disk or local workspace path, such as:

- `/srv/runner/workspace/docket`
- `/srv/runner/workspace/docket-platform`

This separation matters because:

- seeded data is canonical and reusable
- repos are mutable task-local working copies

## Suggested Compose Mounts

Example mapping:

- VM path `/mnt/golden/postgres/pgdata` -> Postgres container data path
- VM path `/mnt/golden/meilisearch/data` -> Meilisearch container data path
- VM path `/mnt/golden/firebase/export` -> Firebase import path
- VM path `/srv/runner/workspace/docket` -> `/opt/docket` inside Firebase and pubsub containers

## Cleanup

Per-task attached disks must be deleted after the VM is finished.

The snapshot remains.

This is the VM equivalent of PVC cleanup in the GKE design.

## Summary

The seeded-state design does not fundamentally change in the VM option.

What changes is the expression:

- VM-attached disk from snapshot
- filesystem mounts into Docker Compose
- no PVC or pod storage plumbing
