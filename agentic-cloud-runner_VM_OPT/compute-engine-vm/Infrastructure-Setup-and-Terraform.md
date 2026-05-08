# Infrastructure Setup and Terraform

## Purpose

Define the shared GCP infrastructure for the Compute Engine VM option.

This assumes the runner system does not exist yet and needs a first infrastructure phase before any task VM can be launched.

## Recommendation

Use Terraform for all shared, long-lived resources.

That includes:

- Compute Engine configuration
- service accounts and IAM
- Artifact Registry
- GCS buckets
- Pub/Sub
- Secret Manager
- optional Firestore for task metadata

## Shared Infrastructure

Recommended shared resources:

- dedicated GCP project or strongly isolated environment
- Artifact Registry for runner/support images
- GCS bucket for artifacts and logs
- Pub/Sub topic for task requests
- Secret Manager secrets for Bitbucket access and other credentials
- Firestore or similar store for task/status records
- service accounts for dispatcher and task VMs
- one VM instance template or image family for task VMs
- public preview ingress resources for ephemeral app/API URLs

## Terraform Scope

Terraform should manage:

- required Google APIs
- service accounts and IAM bindings
- Artifact Registry repositories
- GCS buckets
- Pub/Sub topics/subscriptions
- Secret Manager secret containers and access policies
- Compute Engine instance template
- firewall rules if needed
- Cloud DNS preview records
- Certificate Manager wildcard certificate
- external HTTPS load balancer for preview ingress
- Cloud Run preview gateway
- VPC egress path from the gateway to private task VMs
- optional snapshot scheduler or supporting resources later

Terraform should not manage:

- one VM per task
- one disk per task
- live task status updates

Those are runtime operations.

## VM Foundation

You need one reusable VM base.

Recommended options:

- instance template backed by a base image
- custom image if startup dependencies become large

The base VM should include:

- Docker and Docker Compose support
- Git
- language/tooling needed for bootstrap scripts
- logging/upload utilities

## Service Accounts

Recommended service accounts:

- dispatcher service account
- task VM service account
- optional seed builder service account

### Dispatcher Service Account

Needs permissions for:

- creating disks from snapshots
- creating/deleting VMs
- reading snapshot pointer metadata
- writing task launch metadata

### Task VM Service Account

Needs permissions for:

- reading Secret Manager credentials
- writing artifacts to GCS
- writing status updates

## Networking

Keep the network model simple in v1.

Decide explicitly:

- whether task VMs need public IPs
- whether they need outbound access to Bitbucket and package registries
- whether internal APIs are private or public
- whether human preview access is enabled for a task or review environment

Recommendation:

- start with simple outbound access
- keep task VMs private for public preview use
- expose app/API through the shared preview gateway instead of direct VM public IPs
- tighten later once the system works

For ephemeral public URLs, use:

- `*.preview.example.com` pointing to one HTTPS load balancer
- a wildcard certificate for that preview subdomain
- a Cloud Run gateway backend
- Direct VPC egress or Serverless VPC Access from the gateway to task VM internal IPs
- a firewall rule that allows only gateway egress traffic to the VM edge proxy port

## Storage

At minimum you need:

- boot disk from template/image
- attached data disk created from snapshot
- artifact bucket

This option avoids Kubernetes storage setup, but it still requires good disk lifecycle hygiene.

## Suggested Terraform Modules

Conceptually:

1. `project-services`
2. `artifact-registry`
3. `gcs-buckets`
4. `pubsub-tasking`
5. `secret-manager`
6. `iam-service-accounts`
7. `compute-engine-template`
8. `task-metadata-store`
9. `preview-ingress`

## Bootstrap Sequence

Recommended order:

1. provision shared infrastructure with Terraform
2. validate that a task VM can boot from the template
3. validate that a data disk can be created from a snapshot and attached
4. validate that startup metadata and scripts work
5. validate the preview gateway can reach a private VM edge proxy
6. then implement the dispatcher and seed pipeline

## Summary

For the VM option, Terraform is still the right place for shared setup.

The difference from the GKE path is that the durable infrastructure is smaller and simpler:

- one VM template
- shared cloud services
- no Kubernetes control plane requirements
