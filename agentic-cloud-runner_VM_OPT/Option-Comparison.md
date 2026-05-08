# Agentic Runner Option Comparison

## Purpose

Compare the two current architecture options:

- [GKE PVC Option](./gke-pvc-option/Agentic-Runner-System-v1.md)
- [Compute Engine VM Option](./compute-engine-vm/Agentic-Runner-Compute-Engine-v1.md)

This document is intended to support a design decision, not to produce precise production forecasts.

## Executive Summary

If the goal is the fastest path to a working, understandable system that matches your current Docket runtime model, the Compute Engine VM option is the better choice.

If the goal is to build the more scalable long-term platform now, and you are willing to pay higher setup and operational complexity for that, the GKE PVC option is stronger.

My overall recommendation today:

- start with the Compute Engine VM option
- keep the GKE PVC option as the higher-complexity future platform path

## Decision Criteria

This comparison focuses on:

- setup complexity
- maintenance complexity
- operational reliability
- startup performance
- security and trust boundaries
- ephemeral human-review URLs
- rough cloud spend
- scaling characteristics
- debugging and developer ergonomics

## High-Level Comparison

| Category | Compute Engine VM Option | GKE PVC Option |
| --- | --- | --- |
| Setup complexity | Lower | Higher |
| Ongoing maintenance | Lower | Higher |
| Match to current Docket runtime | Strong | Moderate |
| Startup determinism | Strong | Moderate |
| Fine-grained cloud-native scheduling | Weaker | Stronger |
| Security boundary quality | Coarser machine boundary | Better identity tooling, but weakened by shared pod boundary |
| Ephemeral public preview URLs | Straightforward with stable gateway to private VMs | Natural through Ingress, but adds Kubernetes ingress/platform work |
| Debuggability | Easier | Harder |
| Cost predictability | Easier | More sensitive to resource-request tuning |
| Long-term multi-tenant scaling | Weaker | Stronger |

## 1. Complexity to Set Up

### Compute Engine VM Option

This is the simpler build path.

You need:

- Terraform for shared GCP infrastructure
- one VM template or base image
- one data disk snapshot flow
- one dispatcher that creates a disk and a VM
- one startup script that runs Docker Compose

Why it is simpler:

- the machine behaves like a remote version of your local environment
- mutable repo mounts are natural
- Docker Compose already matches your mental model
- there are fewer platform-specific abstractions to learn and maintain

### GKE PVC Option

This is materially more complex.

You need:

- Terraform for shared GCP infrastructure
- GKE cluster setup
- Workload Identity setup
- snapshot-capable storage classes
- per-task PVC creation from snapshots
- per-task Jobs and pod orchestration
- init containers
- cleanup of Jobs plus PVCs

Why it is more complex:

- the system is expressing a machine-like runtime through Kubernetes primitives
- mutable checked-out source must be coordinated across multiple containers
- your Firebase and pubsub behavior is code-coupled, not just service-coupled

## 2. Complexity to Maintain

### Compute Engine VM Option

Ongoing maintenance is lower.

Main operational burdens:

- keep the base image/template current
- keep the startup script healthy
- clean up orphaned VMs and disks
- maintain the golden snapshot flow

These are straightforward operational concerns.

### GKE PVC Option

Ongoing maintenance is higher.

Main operational burdens:

- maintain cluster, namespace, IAM, and storage plumbing
- keep Kubernetes specs healthy as the runtime evolves
- monitor Job/PVC leaks
- troubleshoot pod startup and container interactions
- reason about pod-level security boundaries

This is a more platform-engineering-heavy system.

## 3. Match to Current Docket Runtime

### Compute Engine VM Option

This matches your existing world well.

Your local system already thinks in terms of:

- one machine
- checked-out repos on disk
- Compose
- mounted mutable code
- local processes and containers

The VM option preserves that shape closely.

### GKE PVC Option

This can reproduce the runtime, but it is a translation.

Key friction points:

- repo bootstrap becomes an init-container problem
- mutable repo mounts become pod volume design
- Firebase and pubsub become sidecars that share code through pod storage

That is possible, but it is less native to how the system currently behaves.

## 4. Startup Performance and Reliability

This category is mostly about cold-start reliability and time-to-usable-environment.

### Compute Engine VM Option

Likely profile:

- VM boot adds a cold-start penalty
- startup script adds some bootstrapping time
- Docker Compose startup is familiar and deterministic

Expected behavior:

- probably a little slower at the first infrastructure layer than a perfectly tuned pod launch
- but likely more reliable and easier to reason about for your stack

My inference:

- once tuned, VM startup is likely in the low-minutes range
- repo checkout and application boot will dominate more than the cloud primitive itself

### GKE PVC Option

Likely profile:

- no full VM boot
- pod scheduling can be fast
- snapshot-cloned PVC startup is efficient
- but there are more moving parts before the cell is truly usable

Expected behavior:

- potentially faster steady-state boot once fully tuned
- more sensitive to misconfiguration and storage/runtime edge cases

My inference:

- the theoretical best startup may be better on GKE
- the practical first-version startup reliability is likely better on VMs

## 5. Security and Trust Boundaries

### Compute Engine VM Option

Strengths:

- simple service-account model
- easy Secret Manager usage
- straightforward access to Firestore, GCS, and other GCP resources

Weakness:

- the VM is the trust boundary
- all processes on the VM effectively share the attached identity

### GKE PVC Option

Strengths:

- better identity tooling through Workload Identity Federation for GKE
- stronger long-term potential for least-privilege design

Weakness:

- in the current design, runner, Firebase, and pubsub live in one pod
- the pod is therefore the effective trust boundary

Net result:

- GKE is better in principle
- with the current single-cell pod design, the practical advantage is smaller than it first appears

## 6. Public Preview URL Requirement

The new requirement is to use the same seeded stack as a human-testable ephemeral environment, without necessarily running an agent process.

That requires short-lived public URLs for:

- the Docket app
- `platform-api`

### Compute Engine VM Option

Recommended addition:

- keep task VMs private
- add one long-lived wildcard preview domain
- terminate HTTPS at one external Application Load Balancer
- route to a Cloud Run preview gateway
- let the gateway proxy to each VM's internal edge proxy based on hostname

This preserves the one-environment-per-VM model while adding human access.

It also avoids creating per-environment load balancer resources.

### GKE PVC Option

The Kubernetes-native version would likely use:

- Ingress or Gateway API
- wildcard DNS and certificate
- per-task Service/HTTPRoute or Ingress objects
- namespace-level cleanup

That is a normal Kubernetes shape, but it reinforces the higher platform complexity of the GKE option.

### Impact on Recommendation

This requirement strengthens the Compute Engine VM recommendation for a first version.

The VM option now supports two modes with the same primitive:

- `agentic`: stack plus runner
- `review`: stack only, with public app/API URLs

The only meaningful addition is a shared preview ingress service. That is less complex than adopting Kubernetes just to get per-environment routing.

## 7. Rough Cloud Spend

These numbers are deliberately rough and should be treated as directional.

They exclude:

- LLM usage
- outbound network charges
- image build costs
- Artifact Registry/network overhead
- engineering time

## Cost Assumptions

Assumptions used below:

- region: `us-central1`
- throughput: `50 tasks/week`
- monthly task count: `~217 tasks/month`
- one retained golden snapshot of `100 GB`
- one per-task cloned data disk of `100 GB`
- Firestore usage is minimal and likely negligible at this scale

### Runtime Assumptions

To make the comparison concrete, I used:

#### Compute Engine VM Option

- one general-purpose `4 vCPU / 16 GiB` task VM
- rough on-demand compute rate: about `$0.15-$0.18/hour`
- 100 GB balanced data disk

#### GKE PVC Option

For the current single-pod task cell, a plausible billed request envelope is:

- runner: `4 vCPU / 16 GiB`
- postgres: `2 vCPU / 4 GiB`
- meilisearch: `1 vCPU / 2 GiB`
- firebase: `1 vCPU / 2 GiB`
- pubsub: `0.5 vCPU / 1 GiB`

That totals roughly:

- `8.5 vCPU`
- `25 GiB memory`

Using current us-central1 GKE Autopilot rates, that is about:

- `$0.50/hour` per active task cell

This is an inference from the current design and Autopilot pricing, not a literal committed bill.

### Shared Storage Assumptions

Using current published us-central1 block storage prices:

- Persistent Disk Balanced: `$0.10/GB-month`
- standard snapshots: `$0.065/GB-month`

That means:

- 100 GB golden snapshot retained: about `$6.50/month`
- each 100 GB task data disk only costs materially while it exists

### Firestore Control-Plane Cost

At this scale, task metadata and status updates are likely negligible.

Current Firestore standard pricing in us-central1 is:

- reads: `$0.03` per `100,000`
- writes: `$0.09` per `100,000`

For a small task/status store, this is not a primary cost driver.

## Rough Monthly Cost Table

The table below uses three average task durations.

| Scenario | Compute Engine VM Option | GKE PVC Option |
| --- | ---: | ---: |
| 217 tasks/month, avg 60 min | `$42-$49/month` | `$83-$118/month` |
| 217 tasks/month, avg 90 min | `$60-$70/month` | `$122-$174/month` |
| 217 tasks/month, avg 120 min | `$78-$91/month` | `$160-$230/month` |

### How to Read This

These figures are rough all-in infrastructure estimates for the runner substrate only:

- compute
- task data disk runtime
- one retained golden snapshot

They do not include LLM spend, which may dominate total cost.

### GKE Cluster Fee Note

GKE charges a flat cluster management fee of `$0.10/hour` per cluster, but the published free tier provides `$74.40/month` in credits, which is equivalent to one free Autopilot or zonal Standard cluster per month.

For one Autopilot cluster, that likely makes the cluster management fee effectively negligible in early stages.

### Main Cost Insight

At your current likely scale, both options are cheap in infrastructure terms.

The more important cost difference is not "can we afford it?"

It is:

- which option costs more engineering time
- which option burns more debugging time
- which option makes startup/resource tuning harder

On that basis, the VM option is cheaper overall.

## 8. Scalability and Concurrency

### Compute Engine VM Option

Good enough for modest concurrency.

Strengths:

- simple horizontal model: one task = one VM
- easy to understand capacity

Weaknesses:

- coarser-grained resource packing
- less elegant for high task parallelism
- more VM lifecycle churn if usage grows sharply

### GKE PVC Option

Better long-term scaling shape.

Strengths:

- better for many concurrent tasks
- better platform building block if you expect this system to become a service

Weaknesses:

- you pay the complexity cost before you necessarily need the scaling benefit

## 9. Debuggability and Operator Experience

### Compute Engine VM Option

Stronger.

Why:

- easier to reason about one VM
- easier to SSH in if needed
- Compose and filesystem behavior are familiar
- fewer invisible orchestration layers

### GKE PVC Option

Weaker.

Why:

- more distributed startup responsibility
- more cloud-native machinery between the operator and the runtime
- more abstractions to inspect when a task fails early

## 10. Reliability Risks by Option

### Compute Engine VM Option

Primary risks:

- startup script drift
- orphaned disks or VMs
- base image drift

These are operationally manageable and easy to understand.

### GKE PVC Option

Primary risks:

- pod startup ordering issues
- PVC clone and mount issues
- resource-request tuning problems
- shared-pod identity ambiguity
- repo/bootstrap sidecar coordination

These are solvable, but they are harder failures.

## 11. What You Might Be Missing

Two factors matter more than raw infrastructure cost:

### Engineering Friction

A system that is theoretically better but harder to debug can be the more expensive system in practice.

### LLM Spend

If tasks are agent-driven and substantial, model/API cost may exceed the cloud substrate cost.

That makes it even more reasonable to choose the simpler infrastructure path first.

## Recommendation

For your current state, choose the Compute Engine VM option first if these are true:

- you want the shortest path to a working system
- you expect modest usage in the near term
- you want to preserve your current Compose-style runtime mental model
- your team is more comfortable with VM/filesystem/container operations than Kubernetes platform work

Choose the GKE PVC option first only if these are true:

- you are deliberately investing in a longer-term internal platform now
- you expect significantly higher concurrency
- you are comfortable paying a larger upfront platform complexity cost

## Final Take

The Compute Engine VM option is not a shortcut in a bad sense.

For your system, it is the more natural first architecture.

The GKE PVC option is still valid, but it is better understood as:

- a future platform evolution path

than as the default first implementation.

## Sources

Pricing and platform references used in this analysis:

- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)
- [Compute Engine VM pricing](https://cloud.google.com/products/compute/pricing?hl=en_US)
- [Compute Engine all pricing tables](https://cloud.google.com/compute/all-pricing?authuser=7)
- [Block storage pricing](https://cloud.google.com/products/block-storage)
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [External Application Load Balancer overview](https://cloud.google.com/load-balancing/docs/https/)
- [Zonal network endpoint groups overview](https://cloud.google.com/load-balancing/docs/negs/zonal-neg-concepts)
- [Cloud Run VPC egress options](https://docs.cloud.google.com/run/docs/configuring/connecting-vpc)
- [IAP with external Application Load Balancers](https://cloud.google.com/iap/docs/load-balancer-howto)
- [Cloud DNS records overview](https://cloud.google.com/dns/docs/records-overview)
- [Certificate Manager certificates](https://cloud.google.com/certificate-manager/docs/certificates)
