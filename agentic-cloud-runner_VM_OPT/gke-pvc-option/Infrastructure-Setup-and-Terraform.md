# Infrastructure Setup and Terraform

## Purpose

Define the shared GCP infrastructure required before any seed builds or task runs can happen.

This document assumes the agentic runner system does not exist yet and needs a foundational infrastructure layer for:

- compute,
- storage,
- identity,
- networking,
- secrets,
- observability,
- and deployment boundaries.

## Why This Exists

The other design docs assume a runtime substrate already exists:

- a GKE cluster or equivalent execution environment
- snapshot-capable storage classes
- Artifact Registry repositories
- GCS buckets
- service accounts and permissions
- secret storage
- task/status persistence

If those are not in place, there should be a general infrastructure setup phase first.

Because parts of your wider system already use Terraform, this layer should be managed the same way unless there is a strong reason not to.

## Recommendation

Yes: create a dedicated infrastructure setup step and manage the shared GCP resources with Terraform.

Terraform is a good fit here because:

- the infrastructure is long-lived and shared across many runs
- IAM and networking need reviewable change control
- cluster, bucket, registry, and service-account setup are all declarative resources
- the runner system will likely need environment-specific variants later

## Infrastructure Boundary

Separate the system into:

- shared infrastructure, provisioned infrequently
- operational artifacts, produced continuously
- ephemeral task resources, created per run

### Shared Infrastructure

Examples:

- GKE cluster
- Artifact Registry repositories
- GCS buckets
- service accounts
- IAM bindings
- Pub/Sub topics
- Secret Manager secrets
- optional Firestore/Postgres task metadata store

### Operational Artifacts

Examples:

- runner container images
- seed builder images
- published golden snapshots
- snapshot catalog records

### Ephemeral Task Resources

Examples:

- per-task Jobs
- per-task PVCs
- per-task pod logs

## What Terraform Should Manage

Recommended Terraform scope for v1:

### Project-Level Services

- required Google APIs
- service usage enablement

### Compute

- GKE Autopilot cluster or dedicated GKE cluster
- runner namespace bootstrap if you manage it declaratively
- storage classes and snapshot support, if cluster-specific setup is required

### Identity and Access

- runner dispatcher service account
- agent runner service account
- seed builder service account
- IAM roles for Secret Manager, GCS, Pub/Sub, GKE access, and logging
- Workload Identity bindings

### Storage

- GCS evidence bucket
- optional GCS bucket for snapshot manifests and build logs
- Artifact Registry repositories

### Messaging and Control Plane

- Pub/Sub topics and subscriptions for task requests
- optional dead-letter topics

### Secrets

- placeholder Secret Manager secrets and IAM access policies

### Observability

- logging sinks if needed
- metrics/alerting scaffolding if your Terraform conventions include them

## What Terraform Should Not Manage Per Task

Terraform should not be the mechanism for:

- creating per-task Jobs
- creating per-task PVC clones
- publishing one task at a time
- updating live task state on every heartbeat

Those are runtime operations and should be handled by the dispatcher, runner, or supporting services.

## Environment Model

Recommended v1 environment layout:

- one dedicated GCP project or well-isolated environment for the runner system
- one runner cluster
- one runner namespace for task cells
- one seed namespace for golden build jobs

Do not start by mixing this into unrelated application infrastructure without clear isolation.

## Suggested Terraform Modules

The exact repo layout depends on your existing conventions, but conceptually the modules are:

1. `project-services`
2. `artifact-registry`
3. `gke-runner-cluster`
4. `gcs-buckets`
5. `pubsub-tasking`
6. `secret-manager`
7. `iam-workload-identity`
8. `task-metadata-store`

If your existing Terraform codebase already has reusable modules for some of these, use them instead of creating duplicates.

## Minimum Shared Resources for v1

Before implementation of seed or task logic, provision at least:

- GKE cluster with snapshot-capable storage support
- Artifact Registry for runner and seed-builder images
- GCS evidence bucket
- Pub/Sub topic for task requests
- Secret Manager entries for repo access
- service accounts for dispatcher, runner, and seed builder
- IAM bindings enabling Workload Identity

Optional but likely useful:

- a store for task status and snapshot catalog metadata

## Networking and Isolation

At minimum, decide:

- whether the cluster is public or private
- whether task pods need egress to Bitbucket and other external services
- whether internal APIs are reachable privately or over restricted public endpoints

Recommendation:

- keep the network design simple in v1,
- but do not leave egress and secret access undefined.

## Storage and Snapshot Prerequisites

The golden-seed design depends on the cluster being able to:

- provision PVCs from a storage class
- create `VolumeSnapshot` resources
- clone PVCs from snapshots

This should be validated as part of infrastructure setup, not discovered during seed pipeline implementation.

## Bootstrap Sequence

Recommended order of work:

1. Provision shared infrastructure with Terraform.
2. Validate cluster storage and snapshot behavior.
3. Build and publish runner and seed-builder images.
4. Implement the golden seed pipeline.
5. Implement the dispatcher.
6. Implement the runner lifecycle.
7. Add operational cleanup and alerting.

## Terraform vs Application Config

Use Terraform for:

- durable resources
- IAM
- network boundaries
- cluster creation

Use application/runtime configuration for:

- snapshot selection
- compute profiles
- task payloads
- job specs created dynamically

## Operational Concerns

### State Separation

Keep Terraform state separate from:

- task metadata
- snapshot catalog contents
- runner logs

### Reviewability

Infrastructure changes should be reviewable independently from runner code changes.

### Ownership

Treat shared infrastructure as platform surface area with tighter controls than task-level application logic.

## Open Questions

### Cluster Reuse

Should this runner use an existing cluster or get a dedicated one?

Recommendation: prefer a dedicated runner cluster or at least a strongly isolated namespace and quota boundary.

### Metadata Store

Should task status and snapshot catalog live in:

- Firestore
- PostgreSQL
- GCS manifests

Terraform can provision the underlying resource, but the logical schema belongs to the application design.

## Summary

Yes, there should be a general infrastructure setup step first.

If the runner system does not exist yet, the correct implementation order is:

- provision shared GCP infrastructure with Terraform,
- verify the storage/snapshot substrate,
- then build the seed pipeline and task runtime on top of it.
