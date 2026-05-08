# Security and Secrets

## Purpose

Define the security model for the GKE PVC option, with specific guidance for:

- Google Cloud API access
- secret delivery
- non-secret config delivery
- trust boundaries inside the task cell
- service account impersonation

## Core Recommendation

For the GKE option, use:

- Workload Identity Federation for GKE for Google Cloud access
- Secret Manager for external secrets
- environment variables or mounted config for non-secret task config
- no long-lived service account key files

## Security Model

This design separates three categories:

### Non-Secret Config

Examples:

- task id
- prompt
- repo URLs
- branch names
- artifacts bucket path
- status API URL

These can be delivered by:

- environment variables
- ConfigMaps
- mounted task spec files

### Google Cloud Authorization

Examples:

- Firestore access
- Cloud Storage access
- Secret Manager access
- optional access to internal APIs on GCP

These should be provided through GKE workload identity, not static credentials.

### Secrets

Examples:

- Bitbucket SSH key or app password
- external LLM API keys
- third-party tokens

These should be stored in Secret Manager and fetched at runtime.

## Recommended Identity Pattern

Use Workload Identity Federation for GKE.

This gives the pod access to Google Cloud APIs without storing JSON key files in the image or repository.

Recommended pod capabilities:

- write task status to Firestore
- upload artifacts to GCS
- read specific secrets from Secret Manager

## Important Trust-Boundary Caveat

The current GKE design runs multiple containers in one pod:

- `agent-runner`
- `firebase-emulator`
- `pubsub-subscriber`
- `postgres`
- `meilisearch`

In practice, that means the pod is the trust boundary.

Implication:

- if the pod has access to Secret Manager or Firestore, that access is effectively shared by all containers in the pod

This weakens one of the theoretical security advantages of GKE.

## Practical Consequence

The pod should only be granted the minimum set of permissions needed by the task cell as a whole.

Do not assume sidecar containers are strong security boundaries if they share the same pod identity.

## Recommended Service Accounts

Use separate Google service accounts for:

- dispatcher
- task cell pod
- seed builder

### Dispatcher Service Account

Needs access to:

- Kubernetes API operations in the runner namespace
- task metadata/status store if used
- snapshot pointer/config store if used

### Task Cell Service Account

Needs access only to:

- writing status
- writing artifacts
- reading specific secrets
- optional Google Cloud APIs directly used by the task

### Seed Builder Service Account

Needs access only to:

- seed source systems or exports
- snapshot publication path
- related validation outputs

## Secret Delivery

Recommended pattern:

1. store external secrets in Secret Manager
2. fetch them at runtime from the runner process
3. expose them only to the process that needs them
4. avoid persisting them to shared pod volumes unless necessary

### Bitbucket Credentials

Recommended handling:

- store SSH key or app password in Secret Manager
- fetch at runtime
- if SSH is used, write the key to a temp file with strict permissions
- delete it during teardown

### External LLM Keys

Recommended handling:

- if using Vertex AI, prefer IAM-based access and avoid external API keys
- if using OpenAI or Anthropic, store the key in Secret Manager
- inject it only into the runner process environment at runtime

## Firestore and GCS Access

Recommended handling:

- use IAM via workload identity
- do not create separate static credentials for these services

Typical examples:

- runner writes status documents to Firestore
- runner uploads artifacts to GCS

## Service Account Impersonation

This option can support service account impersonation if needed.

Recommended use:

- only when a task occasionally needs elevated access that should not be granted directly to the base pod identity

Default recommendation:

- do not add impersonation in the first cut unless there is a real need

Start with direct least-privilege access for the task pod.

## Config Delivery

Non-secret config can be delivered through:

- environment variables
- ConfigMaps
- mounted task spec JSON

Examples:

- `TASK_ID`
- `REPO_APP`
- `REPO_API`
- `SNAPSHOT_ID`
- `ARTIFACTS_PREFIX`
- `STATUS_API_URL`

Do not use Secret Manager for ordinary run metadata.

## What Not To Do

- do not bake secrets into images
- do not commit secrets into repos
- do not use long-lived service account JSON keys in the task cell
- do not mount broad secret bundles into the whole pod if only the runner needs them

## Recommended v1 Policy

For the first implementation:

- one task-cell pod service account
- only the minimum Firestore, GCS, and Secret Manager permissions
- Secret Manager for Bitbucket and external LLM keys
- workload identity for all Google Cloud API access
- no service account key files
- no impersonation unless a clear use case appears

## Residual Risk

The main residual risk in this design is the shared pod trust boundary.

Even though GKE gives better identity tooling than a VM, the single-pod multi-container design means:

- sensitive capabilities granted to the pod are not cleanly isolated to one container

If stronger separation becomes necessary later, revisit the pod shape rather than trying to solve it purely with documentation or convention.

## References

- [Workload Identity Federation for GKE](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/workload-identity)
- [Authenticate to Google Cloud APIs from GKE workloads](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)
- [Access secrets from GKE workloads](https://docs.cloud.google.com/kubernetes-engine/docs/tutorials/workload-identity-secrets)
- [Secret Manager on Google Cloud](https://cloud.google.com/secret-manager/docs)
