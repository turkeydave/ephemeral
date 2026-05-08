# Security and Secrets

## Purpose

Define the security model for the Compute Engine VM option, with specific guidance for:

- Google Cloud API access
- secret delivery
- non-secret config delivery
- machine trust boundaries
- service account impersonation
- public preview access for ephemeral app/API URLs

## Core Recommendation

For the VM option, use:

- a user-managed service account attached to the task VM
- Secret Manager for external secrets
- instance metadata and startup inputs for non-secret config
- no long-lived service account key files
- centralized preview access through a gateway rather than direct public VM exposure

## Security Model

This design also separates three categories:

### Non-Secret Config

Examples:

- task id
- prompt
- repo URLs
- branch names
- artifacts bucket path
- status API URL

These can be delivered by:

- instance metadata
- startup-script arguments
- generated local config files

### Google Cloud Authorization

Examples:

- Firestore access
- Cloud Storage access
- Secret Manager access

These should come from the VM's attached service account, not static credentials.

### Secrets

Examples:

- Bitbucket SSH key or app password
- external LLM API keys
- third-party tokens

These should be stored in Secret Manager and fetched at runtime.

## Recommended Identity Pattern

Attach a user-managed service account to each task VM.

Recommended uses:

- writing task status
- uploading artifacts
- reading specific secrets

This is simpler than GKE workload identity and works well for a per-task VM model.

## Important Trust-Boundary Caveat

The VM is the trust boundary.

Implication:

- any process on the VM can potentially use the attached service account identity

That means the security boundary is coarser than GKE in principle, even though the operational model is simpler.

For public preview environments, the public trust boundary should be the HTTPS load balancer plus preview gateway.

The task VM should remain private by default.

## Practical Consequence

The VM service account should be tightly scoped.

Do not attach broad project-wide privileges just because the VM is ephemeral.

## Recommended Service Accounts

Use separate Google service accounts for:

- dispatcher
- task VM
- optional seed builder

### Dispatcher Service Account

Needs access to:

- create and delete VMs
- create and delete disks
- read current snapshot pointer/config
- write task launch metadata

### Task VM Service Account

Needs access only to:

- write status
- write artifacts
- read specific secrets
- optional Google Cloud APIs used directly by the task

### Seed Builder Service Account

Needs access only to:

- build and validate the golden data state
- create snapshots

## Secret Delivery

Recommended pattern:

1. store external secrets in Secret Manager
2. fetch them at runtime from the runner bootstrap or runner process
3. expose them only to the process that needs them
4. avoid persisting them on disk longer than necessary

### Bitbucket Credentials

Recommended handling:

- store SSH key or app password in Secret Manager
- fetch at runtime
- write to a temp file with strict permissions if SSH is used
- delete during teardown

### External LLM Keys

Recommended handling:

- if using Vertex AI, prefer IAM-based access
- if using OpenAI or Anthropic, store the key in Secret Manager
- inject it only into the runner process environment at runtime

## Firestore and GCS Access

Recommended handling:

- use the VM service account via Application Default Credentials
- do not create static service keys

Typical examples:

- runner writes task status to Firestore
- runner uploads logs and artifacts to GCS

## Service Account Impersonation

This option can also support service account impersonation.

Recommended use:

- only if a task occasionally needs access that should not live on the base VM identity

Default recommendation:

- avoid impersonation in the first cut unless it solves a specific least-privilege problem

Start with a tightly scoped task VM service account.

## Config Delivery

Non-secret config can be delivered through:

- instance metadata
- startup scripts
- generated local env files

Examples:

- `TASK_ID`
- `REPO_APP`
- `REPO_API`
- `ARTIFACTS_PREFIX`
- `STATUS_API_URL`

Do not place secrets in instance metadata.

## Public Preview Access

For human-reviewable app/API URLs:

- terminate TLS at the shared HTTPS load balancer
- put IAP in front of the preview gateway by default
- require the gateway to enforce per-environment authorization
- route from the gateway to task VMs over private VPC addresses
- expose only the VM edge proxy port to the gateway egress range

Do not expose app/API containers directly to the internet from each VM.

Do not rely on unguessable URLs as the only protection.

If an external reviewer cannot use IAP, add a separate signed-token mode later:

- one token per environment
- token hash stored in the environment record
- expiration no later than the environment TTL
- explicit audit trail for token creation

## What Not To Do

- do not bake secrets into images
- do not commit secrets into repos
- do not use service account key files on the VM
- do not store secrets in instance metadata

## Recommended v1 Policy

For the first implementation:

- one tightly scoped task VM service account
- Secret Manager for Bitbucket and external LLM keys
- direct IAM-based access for Firestore and GCS
- no static service account key files
- no impersonation unless clearly needed
- IAP-protected preview gateway for public app/API URLs
- private task VMs by default

## Residual Risk

The main residual risk in this design is the machine-level trust boundary.

Because all runtime processes share the VM identity:

- compromise or misuse in one process can affect all permissions granted to the VM

That is acceptable for a simpler first implementation if IAM remains tight.

## References

- [Service accounts on Compute Engine](https://cloud.google.com/compute/docs/access/service-accounts)
- [Create a VM that uses a user-managed service account](https://cloud.google.com/compute/docs/access/create-enable-service-accounts-for-instances)
- [Authenticate workloads on Compute Engine](https://docs.cloud.google.com/compute/docs/access/authenticate-workloads)
- [About VM metadata](https://cloud.google.com/compute/docs/metadata/overview)
- [Use startup scripts on Linux VMs](https://docs.cloud.google.com/compute/docs/instances/startup-scripts/linux)
- [Secret Manager on Google Cloud](https://cloud.google.com/secret-manager/docs)
