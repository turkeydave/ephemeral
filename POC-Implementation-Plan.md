# POC Implementation Plan — GCP Ephemeral Environments

This is the concrete plan to stand up the Compute Engine VM design in your
personal GCP account, using the local stack in this repo as the
"stack we'll be previewing" (substituting for `docket` + `docket-platform`
in the design docs).

Authoritative design references (in `agentic-cloud-runner_VM_OPT/`):

- [Agentic Runner Compute Engine v1](./agentic-cloud-runner_VM_OPT/compute-engine-vm/Agentic-Runner-Compute-Engine-v1.md)
- [Infrastructure Setup and Terraform](./agentic-cloud-runner_VM_OPT/compute-engine-vm/Infrastructure-Setup-and-Terraform.md)
- [Golden State and Disk Strategy](./agentic-cloud-runner_VM_OPT/compute-engine-vm/Golden-State-and-Disk-Strategy.md)
- [VM Lifecycle and Orchestration](./agentic-cloud-runner_VM_OPT/compute-engine-vm/VM-Lifecycle-and-Orchestration.md)
- [Ephemeral Public Environments](./agentic-cloud-runner_VM_OPT/compute-engine-vm/Ephemeral-Public-Environments.md)
- [Security and Secrets](./agentic-cloud-runner_VM_OPT/compute-engine-vm/Security-and-Secrets.md)
- [Task and Status Model](./agentic-cloud-runner_VM_OPT/compute-engine-vm/Task-and-Status-Model.md)

## Status snapshot — pick up here

| Milestone | Status                                                                  |
| --------- | ----------------------------------------------------------------------- |
| **M1**    | **In progress.** All scaffolding committed; nothing applied to GCP yet. Resume with [MILESTONE-1-RUNBOOK.md](./MILESTONE-1-RUNBOOK.md). |
| M2        | Not started. Public ingress: HTTPS LB + serverless NEG + Cloud Run gateway echoing the hostname; gateway forwards to the M1 VM by hardcoded IP. |
| M3        | Not started. Dispatcher + Firestore registry.                           |
| M4        | Not started. Cleanup worker + IAP/token gating.                         |
| M5        | Not started. Snapshot data disk + Pub/Sub front + agentic mode skeleton. |

What you need to do next (verbatim from the runbook):

1. `gcloud auth login` + `gcloud auth configure-docker us-central1-docker.pkg.dev`
2. `cd c:\Users\kilmo\development\infra\sse-temp` → `terraform init` →
   `terraform plan` (expect `No changes.`)
3. `cd c:\Users\kilmo\development\infra\shared` → `terraform init` →
   `terraform apply`
4. `git push` this repo to `github.com/turkeydave/ephemeral`
5. From repo root: `.\scripts\build-and-push.ps1`
6. `.\scripts\launch-vm.ps1 -Tag m1-<sha>` (the SHA the build script
   prints at the end)
7. Tail serial console; smoke `:8080/healthz` and the nip.io URLs
8. `gcloud compute instances delete …`

Each ephemeral environment runs its **own** Firestore emulator (not real
Firestore — that's the whole point of this POC). The browser SDK reaches
it through a sister hostname `<env>-firestore.<rest>` routed by the
edge proxy to `firebase-emulator:8080`. The hostname is derived in
`firebase-app/app/main.js` from `window.location.hostname`, so no env
vars or build-time substitution required.

## 0. Mapping the design to our actual stack

The design docs assume `docket` + `docket-platform` repos and a stack of
`postgres`, `meilisearch`, `firebase`, `pubsub-subscriber`, `app`, `api`.
For the POC we substitute:

| Design doc concept              | This POC equivalent                                   |
| ------------------------------- | ----------------------------------------------------- |
| `docket` web repo               | `firebase-app/app/` (nginx static)                    |
| `docket-platform` API repo      | `api/` (Express + Postgres) and `pubsub-relay/`       |
| `firebase` container            | `firebase-emulator/` (Firestore + Functions + PubSub) |
| `pubsub-subscriber` container   | `pubsub-relay/`                                       |
| `postgres` container            | `postgres` service (with seeded products + history)   |
| `meilisearch`                   | (not in POC — drop)                                   |
| Mutable repo mounts             | bind-mounts in `docker-compose.yml` (already wired)   |
| Seeded data — `postgres/pgdata` | host `./postgres/init/*.sql` runs on first boot       |
| Seeded data — Firebase export   | host `./emulator-data/` (export-on-exit / import)     |

The POC has only **one** repo (`ephemeral/`), which simplifies the dispatcher
inputs (no `repo_app` / `repo_api` split — just `repo` + `branch`).

## 1. Top-level directory reorganization

You asked to give Terraform its own root. Proposed layout under
`c:\Users\kilmo\development\`:

```text
infra/                              <-- NEW top-level terraform root
  README.md                         <-- index: what each stack is, apply order
  versions.tf                       <-- shared provider pins (or per-stack)
  shared/                           <-- project-wide infra (one apply, rarely changes)
    project-services.tf             <-- enable APIs
    network.tf                      <-- VPC + subnets
    artifact-registry.tf            <-- single registry shared by all POCs
    dns.tf                          <-- managed zone (if using real domain)
    cert.tf                         <-- wildcard cert
    state-bucket.tf                 <-- (optional) GCS for remote state
  sse-temp/                         <-- moved from sse_temp/terraform/
    *.tf
    terraform.tfvars
  ephemeral-runner/                 <-- NEW for this POC
    project-services.tf             <-- (or rely on shared/)
    iam.tf                          <-- dispatcher SA, task-vm SA, gateway SA
    artifact-registry-images.tf     <-- (optional) per-image cleanup policies
    pubsub.tf                       <-- task-request topic + DLQ
    firestore.tf                    <-- task/env registry collection (or imported)
    secrets.tf                      <-- placeholders for repo creds, LLM keys
    gcs.tf                          <-- artifacts bucket
    compute-template.tf             <-- VM instance template
    firewall.tf                     <-- gateway-egress → VM:8080
    dispatcher.tf                   <-- Cloud Run dispatcher service
    cleanup.tf                      <-- Cloud Scheduler + Cloud Run cleanup
    preview-gateway.tf              <-- Cloud Run gateway + serverless NEG
    lb.tf                           <-- HTTPS LB (URL map → gateway)
    variables.tf
    terraform.tfvars
```

Both `sse-temp/` and `ephemeral-runner/` continue to point at the same
personal GCP project — they share `infra/shared/` so APIs/network/registry
aren't duplicated. Use distinct resource name prefixes (`temp-sse-*`,
`ephem-runner-*`) so they don't collide.

Mechanical move:

1. `git mv` (or copy + delete) `sse_temp/terraform/` → `infra/sse-temp/`.
2. Update `sse_temp/README.md` to point at the new path.
3. Pull existing project-wide pieces (`google_project_service`,
   `google_artifact_registry_repository`) up into `infra/shared/` and
   `terraform import` them into the shared state so we don't re-create.

Open question: **one combined Terraform state, or one per stack?** Recommend
per-stack (separate `.terraform/`) so apply blast-radius stays small. Use a
shared GCS state bucket (`infra/shared/state-bucket.tf`) if you want to move
off local state.

## 2. Code-repository hosting

**Decision (locked)**: public GitHub repo under
[`github.com/turkeydave`](https://github.com/turkeydave) — likely
`github.com/turkeydave/ephemeral`.

Implications:

- VM `git clone https://github.com/turkeydave/ephemeral.git` needs **no
  credentials** (public repo) — no Secret Manager wiring for repo auth in
  v1.
- Dispatcher passes `repo_url` + `branch` (default `main`) in instance
  metadata.
- VM startup script does a shallow clone (`git clone --depth 1 --branch
  ${branch}`) for fast boot.
- Outbound HTTPS to `github.com` from the VM subnet must be allowed
  (default GCP egress allows it; just don't add a restrictive egress
  firewall rule).
- If we ever need private repos later, swap clone URL to SSH and pull a
  deploy key from Secret Manager — schema stays the same.

Action item before Milestone 1: `git init` this workspace, push to
`github.com/turkeydave/ephemeral`.

## 3. Container images & "data baked in"

**Decision (locked)**: bake seed data into images (Strategy A). Use the
minimal existing seeds we already have. No data disk in the POC; revisit
the snapshot-disk approach (Strategy B) only if image rebuild churn becomes
painful.

### Image inventory

Only the **platform** services are baked into immutable images. `app` and
`api` are deliberately *not* — they are the agent-editable surface and
get built / served on the VM from the cloned repo with bind-mounts
(see `docker-compose.cloud.yml`). This matches the design's "mutable
checked-out repos" requirement.

| Image                      | Built+pushed? | Source dir            | Contents                                                                                |
| -------------------------- | ------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `postgres-seeded`          | ✅            | `postgres/`           | `postgres:16-alpine` + **baked init SQL** in `/docker-entrypoint-initdb.d/`             |
| `firebase-emulator-seeded` | ✅            | `firebase-emulator/`  | firebase-tools + functions deps + **baked `emulator-data/`**                            |
| `pubsub-relay`             | ✅            | `pubsub-relay/`       | `@google-cloud/pubsub` pull→push relay (stand-in for the prod push subscription)        |
| `edge-proxy`               | ✅            | `edge-proxy/`         | Caddy routing `*-app.*` → `app:80`, `*-api.*` → `api:3001`, `*-firestore.*` → emulator |
| `api`                      | ❌ (built on VM) | `api/`             | Express + `pg`. VM-side `docker compose build` against the cloned repo with `./api:/app` bind-mount. |
| `app`                      | ❌ (no build)   | `firebase-app/app/` | `nginx:alpine` image + bind-mount of `./firebase-app/app:/usr/share/nginx/html:ro`.    |

### How each "seeded" image works

**`postgres-seeded`** — simplest possible:

```dockerfile
FROM postgres:16-alpine
COPY postgres/init/ /docker-entrypoint-initdb.d/
```

Each fresh container starts with an empty `pgdata` and runs the init
scripts on boot. Same behavior we get locally today, but the SQL is in
the image so no host bind-mount is needed on the VM. (If we ever outgrow
this — e.g. seed gets large or slow to apply — switch to baking a
`pg_dump` tarball that the entrypoint restores on first boot.)

**`firebase-emulator-seeded`** — extend the existing
[`firebase-emulator/Dockerfile`](../firebase-emulator/Dockerfile) to also
`COPY emulator-data/ /workspace/emulator-data/`. The existing
[`start-emulators.sh`](../firebase-emulator/start-emulators.sh) already
auto-imports from `EMULATOR_DATA_DIR` if `firebase-export-metadata.json`
is present, so no script change needed.

### What this means for the local→cloud delta

- Local dev: keeps using bind-mounts + `build:` directives. Unchanged.
- Cloud VM: uses `docker-compose.cloud.yml` referencing image refs from
  Artifact Registry. No host bind-mounts at all.
- Build/push script (`scripts/build-and-push.ps1`) tags all six images
  with the same git SHA so they version together.

## 4. POC scope vs. deferred items

In scope for the first GCP cut (matches "Recommended v1 Scope" in the
design):

- one VM template
- one dispatcher (Cloud Run, HTTP, no Pub/Sub front yet — call it directly)
- per-task VM + (optional) data disk
- Firestore-backed environment registry
- preview gateway + HTTPS LB + wildcard cert + DNS
- IAP on the gateway
- VM-side edge proxy (Caddy or nginx) routing `*-app.*` and `*-api.*`
- one cleanup worker (Cloud Scheduler → Cloud Run)
- review mode only (no agent runner yet)

Explicitly deferred:

- agentic mode & runner container
- managed instance groups / autoscaling
- multiple snapshot channels
- signed-token preview access (IAP only at first)
- artifact upload to GCS (no agent → no artifacts yet)

## 5. Per-VM `docker-compose.yml` changes

Today's `docker-compose.yml` is the local dev shape. For the VM we need a
separate `docker-compose.cloud.yml` (kept in this repo) that:

- uses **image refs from Artifact Registry** for the four platform
  services (`postgres-seeded`, `firebase-emulator-seeded`, `pubsub-relay`,
  `edge-proxy`) instead of `build:` directives
- keeps `build:` + bind-mount for `api`, and `nginx:alpine` + bind-mount
  for `app` — same shape as local — so the agent runner can edit them in
  place against the cloned `/srv/ephemeral` workspace
- drops the `./` workspace bind mount on `firebase-emulator` (data is in
  the image now, or on `/mnt/golden`)
- adds a new **edge proxy** service (Caddy is simplest):
  - listens on `:8080`
  - routes by `Host` header:
    - `*-app.preview.<your-domain>` → `app:80`
    - `*-api.preview.<your-domain>` → `api:3001`
  - exposes `/healthz` for the gateway/startup readiness check
- removes the `4000` (UI), `5432` (postgres), `8080` (firestore), `8085`
  (pubsub) host port bindings — these stay container-internal
- only `8080` (edge proxy) is reachable, and only from the gateway VPC
  egress range via firewall

The startup script renders a small `.env` with the per-environment values
(`ENVIRONMENT_ID`, `PUBLIC_APP_URL`, `PUBLIC_API_URL`,
`FIREBASE_PROJECT`, etc.) before `docker compose -f docker-compose.cloud.yml up -d`.

## 6. Public preview URL design (POC choice)

Design doc uses `{env_id}-{service}.preview.example.com`. For the POC,
two options for "domain":

1. **Real domain** — buy/own one (e.g., `preview.kilmo.dev`), put it in
   Cloud DNS, issue a wildcard cert via Certificate Manager. Best.
2. **No-DNS shortcut for first day** — use `nip.io` or `sslip.io`:
   `task-001-app.34-120-1-2.nip.io` resolves to the LB IP automatically.
   Skip the wildcard cert (use HTTP) for the very first smoke test.

**Recommendation**: start with `nip.io` HTTP for the first end-to-end
smoke, then add real domain + cert before any human reviewer sees it.

## 7. Service accounts (concrete list)

| SA                          | Used by                       | Key roles                                                                                       |
| --------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `ephem-dispatcher`          | Cloud Run dispatcher          | `compute.instanceAdmin.v1`, `compute.diskAdmin`, `iam.serviceAccountUser` (on task-vm SA), `datastore.user` |
| `ephem-task-vm`             | Each ephemeral VM             | `datastore.user` (write env record), `secretmanager.secretAccessor`, `artifactregistry.reader`, `logging.logWriter`, `monitoring.metricWriter` |
| `ephem-preview-gateway`     | Cloud Run preview gateway     | `datastore.user` (read env record), VPC connector use                                           |
| `ephem-cleanup`             | Cloud Run cleanup worker      | `compute.instanceAdmin.v1`, `compute.diskAdmin`, `datastore.user`                               |
| `ephem-seed-builder` (later)| One-shot seed VM (Strategy B) | `compute.instanceAdmin.v1`, `compute.diskAdmin`, snapshot create                                |

No JSON key files anywhere. ADC + attached SAs only.

## 8. Firestore registry

One collection, e.g. `agent_environments`. Document id = `environment_id`.
Fields per the design's [Environment Registry](./compute-engine-vm/Ephemeral-Public-Environments.md#environment-registry) — we already have a Firestore in
the personal project (the local emulator points at it), so just create a
**named** Firestore database (Native mode) in `infra/ephemeral-runner/firestore.tf`
or reuse the default if not already used.

## 9. Implementation sequence (week-shaped milestones)

### Milestone 1 — Plumbing (no dispatcher yet) — **IN PROGRESS**

Detailed step-by-step commands to resume from where we left off:
[MILESTONE-1-RUNBOOK.md](./MILESTONE-1-RUNBOOK.md).

Progress:

1. ✅ **Done (scaffolded)** — directories reorged: `infra/sse-temp/` is a
   copy of `sse_temp/terraform/` with state included. Original kept until
   you confirm `terraform plan` is a no-op in the new location. See
   runbook Step 1.
2. ✅ **Done (scaffolded)** — `infra/shared/` written: APIs +
   `ephemeral-runner` Artifact Registry. **NOT YET APPLIED.** See runbook
   Step 2.
3. ⏳ **Pending you** — `git push` to `github.com/turkeydave/ephemeral`.
   See runbook Step 3.
4. ✅ **Done (scaffolded)** — four platform Dockerfiles written
   (`postgres-seeded`, `firebase-emulator-seeded`, `pubsub-relay`,
   `edge-proxy`) and `scripts/build-and-push.ps1`. `app` and `api` are
   intentionally not images — built/served on the VM from the cloned
   repo with bind-mounts (so the agent runner can edit them in place).
   **NOT YET PUSHED.** See runbook Step 4.
5. ✅ **Done** — `docker-compose.cloud.yml` + `edge-proxy/Caddyfile`
   committed. `docker compose config` and `caddy validate` both pass.
6. ⏳ **Pending you** — `scripts/launch-vm.ps1` written but VM not yet
   created. See runbook Steps 5–7. Acceptance: `:8080/healthz` returns
   `ok` and `View Products` in the browser shows the seeded products.

**Where to pick up**: open
[MILESTONE-1-RUNBOOK.md](./MILESTONE-1-RUNBOOK.md) and start at
Step 1 (verify sse-temp move).

### Milestone 2 — Public ingress

7. Add HTTPS LB + serverless NEG → placeholder Cloud Run service.
8. Add Caddy/nginx-based **preview gateway** Cloud Run service that
   echoes hostname for now (no Firestore lookup yet).
9. Add wildcard DNS (real domain or `nip.io` shortcut) and verify
   `curl https://test-app.<host>` reaches the gateway.
10. Add Direct VPC egress + firewall rule and have the gateway forward
    to the Milestone 1 VM by hardcoded IP. End-to-end browser hit. ✅

### Milestone 3 — Dispatcher + registry

11. `infra/ephemeral-runner/firestore.tf` for the registry collection.
12. Cloud Run **dispatcher** (`POST /environments`):
    - validates payload
    - generates `environment_id`
    - creates VM from instance template (`gcloud compute instances create`
      via SDK), passes metadata
    - writes Firestore record `status=launching`
    - returns `{environment_id, public_urls}`
13. VM startup script writes `ready_at` + `vm_internal_ip` to Firestore
    when Caddy `/healthz` passes.
14. Gateway switches from hardcoded IP to Firestore lookup; returns
    `503` until `status=ready`. ✅ end-to-end on a fresh request.

### Milestone 4 — Cleanup + safety

15. Cloud Scheduler → Cloud Run cleanup (every 5 min): for any
    `expires_at < now` and `status in (ready, expired)`, delete VM +
    disk and mark `deleted`.
16. Add IAP on the LB backend (gateway). Restrict to your Google
    account / a Workspace group.
17. Add a small CLI (`scripts/preview.ps1`) to call the dispatcher and
    open the URL. ✅ "request → URL → click → app" repeatable.

### Milestone 5 — Polish & alignment with design

18. Move from baked-in data to snapshot-cloned data disk
    (Strategy B) — adds seed-builder VM + snapshot pointer doc.
19. Wire Pub/Sub front-door for task requests (matches design's
    "Pub/Sub or internal API" in the architecture diagram).
20. Add `mode=agentic` skeleton (no agent yet) so the schema is ready.

## 10. Decisions (all locked)

- **Repo host**: public GitHub at `github.com/turkeydave/ephemeral`. No
  repo auth needed in v1.
- **GCP project**: reuse `project-4b04c9cf-520a-4693-86a` (shared with
  `sse-temp`). All new resources prefixed `ephem-runner-*` / `ephem-*`
  to avoid collisions.
- **Domain**: `nip.io` for the POC — hostnames look like
  `task-001-app.<LB-IP-with-dashes>.nip.io`. No managed zone, no
  Certificate Manager, no wildcard cert. Gateway terminates HTTP only
  (or self-signed) for now. Real domain is a Milestone-5 follow-up.
- **Region**: `us-central1` (matches `sse-temp`; same VPC + registry).
- **Terraform state**: local per stack (`infra/sse-temp/`,
  `infra/shared/`, `infra/ephemeral-runner/` each have their own
  `.terraform/`). No remote backend.
- **Data strategy**: Strategy A — bake seeds into `postgres-seeded` and
  `firebase-emulator-seeded` images. No data disk in v1.

### Side effects of dropping the wildcard cert (nip.io path)

- LB stack changes: skip `google_certificate_manager_certificate` and
  `google_compute_managed_ssl_certificate`; the LB front-end is HTTP only
  (or HTTP→HTTP `target_http_proxy`). Browsers will warn — fine for the
  POC.
- IAP **requires** HTTPS, so to keep IAP we'd still need a cert.
  **Decision implication**: defer IAP to Milestone 5 along with the real
  domain. For Milestone 1–4 the gateway is reachable on the open
  internet — mitigate by:
  1. Cleanup worker keeps environments short-lived (default 1h TTL).
  2. Gateway requires a `?token=` query parameter checked against the
     Firestore env record (cheap shared secret, generated by dispatcher).
  3. Don't share the URL anywhere public.

## 11. Risks / things easy to forget

- **Cost**: HTTPS LB + Certificate Manager + IAP are not free-tier;
  expect ~\$20–25/mo even idle. Each VM is ~\$0.05/hr (`e2-medium`). The
  cleanup worker is essential.
- **Firestore default DB**: only one default DB per project; if `sse-temp`
  ever creates one in default mode, our app's `projectId` writes will
  collide. Use a **named** database to be safe.
- **Firebase emulator vs. real Firestore**: the in-VM stack still uses
  the emulator. That's fine for POC, but be explicit that prod would
  swap to real Firestore + real Pub/Sub (and the relay container goes
  away in favor of a real push subscription pointing at the API LB URL).
- **Image rebuild on data change** (Strategy A): every seed update needs
  a new image tag. Mitigate by scripting `build-and-push.ps1`.
- **Startup-script time budget**: pulling 4 images on a fresh VM is
  ~30–60s. Use Container-Optimized OS + `gcloud auth configure-docker`
  in the metadata startup-script to cut friction.
- **VM shutdown == data loss** for the firebase emulator if not
  exporting. The cloud compose file should keep `--export-on-exit` and
  GCS-upload the export on `SIGTERM` (a `preStop` hook script).
- **VPC egress quotas**: Direct VPC egress on Cloud Run has limits per
  service; we're well under.
- **Reserved env words**: `app` and `api` in the hostname pattern are
  hardcoded in the gateway parsing — document this in the gateway code.

## 12. Deliverables checklist

When this plan is complete you should have:

- [x] `infra/shared/` Terraform stack (written; **not yet applied**)
- [ ] `infra/ephemeral-runner/` Terraform stack (placeholder only)
- [x] `infra/sse-temp/` (relocated as a copy; **original `sse_temp/terraform/`
      still in place** until verification)
- [ ] This repo published to a remote (GitHub) — **pending**
- [x] `docker-compose.cloud.yml` + Caddyfile for the VM-side edge proxy
- [x] Image build/push script (`scripts/build-and-push.ps1`) — **not yet run**
- [x] VM startup script (`infra/ephemeral-runner/files/startup.sh`)
- [x] Hand-launch helper (`scripts/launch-vm.ps1`) — **not yet run**
- [ ] Cloud Run dispatcher service (`runner/dispatcher/`)
- [ ] Cloud Run preview gateway service (`runner/preview-gateway/`)
- [ ] Cloud Run cleanup worker (`runner/cleanup/`)
- [ ] CLI helper (`scripts/preview.ps1`)
- [ ] One successful end-to-end run: dispatcher call → reachable URL →
      seeded data visible → cleanup deletes VM + disk

## 13. What we will NOT touch in this POC

- the GKE / PVC option (parallel design only)
- multi-region
- per-environment secrets stores
- the `agent-runner` container itself (only the placeholder for
  `mode=agentic` in metadata)
- Meilisearch (not part of our stack)
- Vertex AI / LLM integration
