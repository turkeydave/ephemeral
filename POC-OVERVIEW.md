# Ephemeral Preview POC — System Documentation

This document explains the GCP Ephemeral Environments proof-of-concept built
in this repo. It is aimed at a reasonably technical reader who wants to
understand:

1. What the POC does and why
2. The architecture of the cloud system
3. How the per-environment "stack image set" is built (data + code baking)
4. How to deploy the long-lived infrastructure
5. How to launch (and reap) an ephemeral preview environment

The companion design docs in [agentic-cloud-runner_VM_OPT/](file:///c:/Users/kilmo/development/ephemeral/agentic-cloud-runner_VM_OPT)
describe the *target* production system that this POC is a thin slice of.
This file describes only what is **actually built and running today** at the
end of Milestone 4 (M1–M4 in
[POC-Implementation-Plan.md](file:///c:/Users/kilmo/development/ephemeral/POC-Implementation-Plan.md)).

For the day-by-day implementation history and gotchas, see the per-milestone
runbooks:

- [MILESTONE-1-RUNBOOK.md](file:///c:/Users/kilmo/development/ephemeral/MILESTONE-1-RUNBOOK.md) — single hand-launched VM smoke
- [MILESTONE-2-RUNBOOK.md](file:///c:/Users/kilmo/development/ephemeral/MILESTONE-2-RUNBOOK.md) — Global LB + Cloud Run gateway
- [MILESTONE-3-RUNBOOK.md](file:///c:/Users/kilmo/development/ephemeral/MILESTONE-3-RUNBOOK.md) — Dispatcher + Firestore registry
- [MILESTONE-4-RUNBOOK.md](file:///c:/Users/kilmo/development/ephemeral/MILESTONE-4-RUNBOOK.md) — Cleanup worker + token gating + CLI helper

---

## 1. What the POC proves

Given a public GitHub repo containing a multi-container application stack,
a single `POST /environments` call (or `scripts\preview.ps1` invocation)
produces a publicly-reachable, isolated, per-request **preview
environment** in roughly 90–180 seconds, complete with:

- its own browser-facing static `app` (nginx)
- its own Express `api` against its own seeded Postgres
- its own Firestore + Functions + Pub/Sub *emulator* (so the agent can
  trigger Cloud Functions and watch real Pub/Sub fan-out without touching
  any real GCP project state)
- a stable, browser-friendly URL set:
  `http://<env_id>-{app|api|firestore}.<lb-ip>.nip.io/`
- a per-env access token that gates all three URLs (cookie or `?token=`
  query parameter)
- automatic teardown when its TTL expires

The "stack we are previewing" lives in this same repo (`firebase-app/`,
`api/`, `postgres/`, `firebase-emulator/`, `pubsub-relay/`,
`edge-proxy/`). In the production target, this would be one of any
number of customer-application repos — the POC just collapses the
preview-platform repo and the previewed-app repo into one for simplicity.

The deliberately **out-of-scope** items for this POC:

- the agent runner that mutates code in `app/` + `api/`
- snapshotted data disks (we bake seed data into images instead)
- Pub/Sub front-door for task requests (HTTP dispatcher only)
- managed instance groups / autoscaling
- IAP and HTTPS (gated on a real domain — token gating is the substitute)

---

## 2. Architecture at a glance

```diagram
                ╭──────────────────────────────╮
                │ developer / CLI              │
                │   scripts\preview.ps1        │
                │   gcloud impersonate         │
                │   cli-caller SA -> ID token  │
                ╰──────────────┬───────────────╯
                               │ POST /environments  (Bearer ID token)
                               ▼
                ╭──────────────────────────────╮
                │ Cloud Run: dispatcher        │   ─── writes ───▶ ╭──────────────────╮
                │  ephem-runner-dispatcher     │                   │ Firestore        │
                │  ingress=ALL                 │                   │ (default) DB     │
                │  invoker=cli-caller SA only  │  ◀── reads/upd ── │ agent_environ-   │
                ╰──────────────┬───────────────╯                   │ ments/<env_id>   │
                               │ compute.instances.insert          ╰────────┬─────────╯
                               ▼                                            │
                ╭──────────────────────────────╮                            │
                │ Compute Engine task VM       │  ◀──── PATCH status=ready ─╯
                │   ephem-task-<envSuffix>     │            (curl from startup.sh)
                │   debian-12 e2-medium        │
                │   tag: ephem-runner-vm       │
                │   metadata: env_id, repo_url,│
                │     branch, image_tag, ...   │
                │   startup.sh:                │
                │     git clone repo           │
                │     docker compose pull+up   │
                │     wait for /healthz        │
                │     PATCH registry doc       │
                ╰──────────────┬───────────────╯
                               │ inside the VM:
                               ▼
                ╭──────────────────────────────╮
                │ docker-compose.cloud.yml     │
                │ ┌──────────┐  ┌────────────┐ │
                │ │edge-proxy│─▶│ app        │ │  bind-mount of cloned repo
                │ │ (Caddy)  │  │ (nginx)    │ │
                │ │  :8080   │  ├────────────┤ │
                │ │routes by │─▶│ api (Node) │─┼─▶ postgres (seeded)
                │ │  Host    │  ├────────────┤ │
                │ │  header  │─▶│ firestore  │ │
                │ └──────────┘  │  emulator  │◀┼── pubsub-relay
                │               │ +functions │ │   (taskHistory topic
                │               │ +pubsub    │ │    pull → API push)
                │               └────────────┘ │
                ╰──────────────────────────────╯
                               ▲
                               │ Direct VPC egress (private 10.10.0.0/26)
                               │ firewall: only this /26 + tag ephem-runner-vm
                               │ may reach VM:8080
                               │
                ╭──────────────┴───────────────╮
                │ Cloud Run: preview-gateway   │
                │  ingress=INTERNAL_LB only    │
                │  parses <env_id> from Host   │
                │  Firestore lookup (5s cache) │
                │  enforces ?token= / cookie   │
                │  reverse-proxies to VM       │
                ╰──────────────┬───────────────╯
                               │
                               │ HTTP :80
                               ▼
                ╭──────────────────────────────╮     ╭──────────────────╮
                │ Global HTTP LB (anycast)     │ ◀── │ end user / browser│
                │  static IP 34.120.91.102     │     │ <env_id>-app...   │
                │  serverless NEG → gateway    │     │  .nip.io          │
                ╰──────────────────────────────╯     ╰──────────────────╯


                ╭──────────────────────────────╮
                │ Cloud Scheduler  */5 * * * * │
                │   ephem-runner-cleanup-sweep │
                ╰──────────────┬───────────────╯
                               │ POST /run (OIDC, scheduler SA)
                               ▼
                ╭──────────────────────────────╮
                │ Cloud Run: cleanup           │
                │   ingress=INTERNAL_ONLY      │
                │   query expires_at <= now    │
                │   compute.delete + doc.update│
                ╰──────────────────────────────╯
```

### 2.1 Long-lived vs. ephemeral resources

| Lifetime              | Resources                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| **Forever**           | VPC subnet + firewall, Artifact Registry repo, Firestore (default) DB, IAM SAs and bindings, Global LB IP, URL map, backend, serverless NEG |
| **Until next deploy** | Cloud Run services: `preview-gateway`, `dispatcher`, `cleanup`; Cloud Scheduler job                  |
| **Per environment**   | One Compute Engine VM (`ephem-task-<suffix>`), one Firestore doc (`agent_environments/<env_id>`)     |

Per-env cost while running is roughly $0.05/hr (`e2-medium`, 20 GB
pd-balanced). Long-lived overhead is dominated by the global LB IP and
the always-on Cloud Run minimums (~$0/mo idle since `min_instance_count=0`).

### 2.2 Service accounts (least privilege)

| SA                              | Used by                  | Why                                                                                  |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `ephem-runner-preview-gateway`  | preview-gateway          | AR pull, log/metric writer, `datastore.user` for env registry reads                  |
| `ephem-runner-dispatcher`       | dispatcher               | + `compute.instanceAdmin.v1`, `compute.networkUser`, `serviceAccountUser` on task-vm |
| `ephem-runner-task-vm`          | each task VM             | AR pull, log/metric writer, `datastore.user` to PATCH its own registry doc           |
| `ephem-runner-cleanup`          | cleanup worker           | `compute.instanceAdmin.v1` + `datastore.user`                                        |
| `ephem-runner-scheduler`        | Cloud Scheduler outbound | `run.invoker` on the cleanup service (for OIDC token audience match)                 |
| `ephem-runner-cli-caller`       | impersonation target     | Sole `run.invoker` on the dispatcher; humans get `tokenCreator` on it                |

No JSON keys exist anywhere. All auth is ADC + attached SAs +
short-lived OIDC tokens via impersonation.

---

## 3. The "system images" — how the preview stack is baked

The POC chooses Strategy A from the design docs: **bake seed data into
container images**, no per-env data disk. Six images live in
`us-central1-docker.pkg.dev/<project>/ephemeral-runner/` and are versioned
as a single tag (e.g. `m4-71f7ecd`).

### 3.1 Image inventory

| Image                       | Source                                                                                  | Built by                                                                            | Purpose                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `postgres-seeded`           | [postgres/Dockerfile](file:///c:/Users/kilmo/development/ephemeral/postgres/Dockerfile) | `scripts\build-and-push.ps1`                                                        | `postgres:16-alpine` + baked `init/*.sql` in `/docker-entrypoint-initdb.d/`. Seeds `products` + `task_history` on first boot.      |
| `firebase-emulator-seeded`  | [firebase-emulator/Dockerfile.cloud](file:///c:/Users/kilmo/development/ephemeral/firebase-emulator/Dockerfile.cloud) | same | `eclipse-temurin:21-jre` + `firebase-tools` + functions deps + baked `emulator-data/`. Auto-imports the export at startup.         |
| `pubsub-relay`              | [pubsub-relay/Dockerfile](file:///c:/Users/kilmo/development/ephemeral/pubsub-relay/Dockerfile) | same                                                                       | Standalone Node service that pulls from the in-VM Pub/Sub emulator topic and POSTs to the API — stand-in for a prod push sub.      |
| `edge-proxy`                | [edge-proxy/Dockerfile](file:///c:/Users/kilmo/development/ephemeral/edge-proxy/Dockerfile)     | same                                                                       | `caddy:2-alpine` with [Caddyfile](file:///c:/Users/kilmo/development/ephemeral/edge-proxy/Caddyfile) routing `*-app/api/firestore` by Host header on `:8080`. |
| `preview-gateway`           | [runner/preview-gateway/](file:///c:/Users/kilmo/development/ephemeral/runner/preview-gateway) | same                                                                       | Cloud Run service (not VM). Parses env_id from Host, looks up Firestore, enforces token, reverse-proxies to VM internal IP.        |
| `dispatcher`                | [runner/dispatcher/](file:///c:/Users/kilmo/development/ephemeral/runner/dispatcher)   | same                                                                                | Cloud Run service. Mints env_id + access_token, writes Firestore doc, calls Compute API to create the task VM.                     |
| `cleanup`                   | [runner/cleanup/](file:///c:/Users/kilmo/development/ephemeral/runner/cleanup)         | same                                                                                | Cloud Run service. Triggered every 5min by Scheduler; deletes VMs whose `expires_at` has passed.                                    |

The `app` and `api` services are deliberately **not** baked into images.
Each task VM clones the repo at boot and `docker-compose.cloud.yml`
builds the API on-VM and serves the static app via `nginx:alpine` with
the cloned source bind-mounted in. This matches the design's
"agent-editable mutable surface" requirement: the eventual agent runner
can mutate files under `/srv/ephemeral/{api,app}` and `docker compose
restart` without rebuilding/pushing any image.

### 3.2 What "seeded" means concretely

**Postgres** — [postgres/init/](file:///c:/Users/kilmo/development/ephemeral/postgres/init) holds two SQL files:

- `01-products.sql` — base catalog rows
- `02-task-history.sql` — empty schema for events written by the API

`docker-entrypoint-initdb.d` runs both on first boot when the data
directory is empty. The cloud compose file does **not** mount a volume
for `pgdata`, so every fresh VM gets a fresh, identically-seeded DB.

**Firebase emulator** — [emulator-data/firestore_export/](file:///c:/Users/kilmo/development/ephemeral/emulator-data/firestore_export)
is an `firebase emulators:export` snapshot (Firestore documents only).
It is `COPY`'d into the image at `/seed/emulator-data/`, with
`EMULATOR_DATA_DIR` pointed at it. The shared startup script
[start-emulators.sh](file:///c:/Users/kilmo/development/ephemeral/firebase-emulator/start-emulators.sh)
auto-imports if `firebase-export-metadata.json` is present (it is). The
on-exit export is enabled but discarded with the VM — re-seeding means
re-running the export locally and rebuilding the image.

**Updating seed data** is therefore a 3-step loop:

1. Edit local SQL or run the Firestore emulator locally and re-export.
2. `.\scripts\build-and-push.ps1` — bumps every image to a new tag.
3. Set `task_vm_image_tag = "<new tag>"` in
   [terraform.tfvars](file:///c:/Users/kilmo/development/infra/ephemeral-runner/terraform.tfvars) and `terraform apply`.

Newly-launched envs from that point forward will use the new seed.
Already-running envs are unaffected (they were built from their own
launch-time tag).

### 3.3 Why Cloud Run and VM images version independently

The dispatcher image (`dispatcher:<image_tag>`) and the per-VM platform
images (`postgres-seeded:<task_vm_image_tag>` etc.) are separate
Terraform variables. This is intentional:

- Re-deploying the **dispatcher / gateway / cleanup** is fast (`terraform
  apply` re-rolls Cloud Run revisions in ~30s). They version on their own
  cadence as the orchestration code evolves.
- Re-rolling the **per-VM platform image set** only affects future
  envs (no in-place upgrade — this is by design, ephemeral envs).

Both happen to share one push step (`build-and-push.ps1` builds all 7),
but the tfvars split lets the operator pick which tag goes where.

---

## 4. Repository layout

```text
ephemeral/                            (this repo, github.com/turkeydave/ephemeral)
  POC-Implementation-Plan.md          plan + status table + locked decisions
  POC-OVERVIEW.md                     this file
  MILESTONE-{1,2,3,4}-RUNBOOK.md      per-milestone "what we did, gotchas"
  agentic-cloud-runner_VM_OPT/        target architecture design docs

  docker-compose.yml                  local dev (bind mounts, 5 services exposed on host ports)
  docker-compose.cloud.yml            VM-side compose (image refs from AR, only :8080 exposed)

  postgres/
    Dockerfile                        postgres:16-alpine + baked init scripts
    init/                             *.sql seed scripts
  firebase-emulator/
    Dockerfile / Dockerfile.cloud     local-dev / cloud variants
    start-emulators.sh                shared entrypoint
  firebase-app/
    app/                              static frontend (nginx-served)
    functions/                        Firestore-trigger Cloud Functions
  api/                                Express + pg
  pubsub-relay/                       in-VM Pub/Sub pull → API push (stand-in for prod push subscription)
  edge-proxy/                         Caddy routing on :8080 by Host header
  emulator-data/                      seeded Firestore export (baked into firebase-emulator-seeded image)

  runner/                             Cloud Run services (not VM-side)
    preview-gateway/                  Host -> env_id -> VM lookup; token enforcement; reverse proxy
    dispatcher/                       POST /environments -> mint env_id + create VM
      files/startup.sh                injected into each task VM's metadata as startup-script
    cleanup/                          POST /run -> reap expired VMs

  scripts/
    build-and-push.ps1                build + push all 7 images at tag m{N}-<sha>
    launch-vm.ps1                     hand-launch one VM (M1 smoketest path; not for prod use)
    preview.ps1                       end-to-end CLI: impersonate, POST, poll, open browser
    refresh-env.ps1                   git pull + compose restart on a running env (local-dev loop)

c:\Users\kilmo\development\infra\     (sibling repo / dir — NOT in this repo's git)
  README.md
  shared/                             one-time project bootstrap
    project-services.tf, artifact-registry.tf, iam.tf
  ephemeral-runner/                   long-lived ephemeral-stack infra
    network.tf                        gateway-egress /26 subnet
    firewall.tf                       gateway egress -> VM:8080
    iam.tf                            5 SAs + bindings
    cloudrun.tf                       preview-gateway service
    dispatcher.tf                     dispatcher service + cli-caller SA + impersonation grant
    cleanup.tf                        cleanup service + scheduler SA + scheduler job
    lb.tf                             global IP + serverless NEG + URL map + HTTP proxy + fwd rule
    variables.tf, outputs.tf, terraform.tfvars
  sse-temp/                           unrelated POC stack (ignore here)
```

The Terraform root sits **outside** this repo intentionally (separates
the previewed-app from the platform-infra; the design doc's intended
end state is a separate `docket-platform`-style infra repo).

---

## 5. Building the system from scratch

Bootstrap order matters once. After that, day-to-day work is just
`build-and-push.ps1` + `terraform apply` + `preview.ps1`.

### 5.1 One-time prerequisites

Workstation:

- Windows 11 with PowerShell 5.1+ (the scripts target 5.1 — 7+ also works)
- Docker Desktop running
- `gcloud` CLI authenticated against the personal GCP account
- `git` with the working copy at `c:\Users\kilmo\development\ephemeral`
- Terraform 1.6+ on PATH
- The infra dir checked out at `c:\Users\kilmo\development\infra`
  (mirrors the shape above)

GCP one-time:

```powershell
gcloud auth login
gcloud config set project project-4b04c9cf-520a-4693-86a
gcloud auth configure-docker us-central1-docker.pkg.dev
gcloud auth application-default login   # for terraform
```

### 5.2 Apply `infra/shared/`

Creates the Artifact Registry repo `ephemeral-runner`, enables the 9
required project APIs (Compute, Cloud Run, Cloud Build, Artifact
Registry, Firestore, Pub/Sub, Scheduler, IAM, Service Networking), and
grants the default Compute SA the bare minimum to pull from AR + write
logs.

```powershell
cd c:\Users\kilmo\development\infra\shared
terraform init
terraform apply
```

This is rarely re-run.

### 5.3 Build + push the 7 images

From the repo root:

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\build-and-push.ps1
```

Tag default = `m1-<short git SHA>`. The script builds and pushes in
one shot; the printed tag (e.g. `m1-1685a8a`) is the value to put into
`terraform.tfvars` next.

For Cloud-Run-only re-rolls (dispatcher / gateway / cleanup) without
rebuilding the heavy `firebase-emulator-seeded`, build the three
manually with explicit `docker build / push` per the
[M3 runbook](file:///c:/Users/kilmo/development/ephemeral/MILESTONE-3-RUNBOOK.md#step-1).

### 5.4 Apply `infra/ephemeral-runner/`

Update [terraform.tfvars](file:///c:/Users/kilmo/development/infra/ephemeral-runner/terraform.tfvars):

```hcl
project_id                 = "project-4b04c9cf-520a-4693-86a"
region                     = "us-central1"
image_tag                  = "m4-<sha>"      # Cloud Run images
task_vm_image_tag          = "m1-<sha>"      # per-VM platform images
dispatcher_invoker_members = ["user:you@example.com"]
```

```powershell
cd c:\Users\kilmo\development\infra\ephemeral-runner
terraform init
terraform apply
```

First apply takes ~3 minutes (LB backend + URL map + HTTP proxy +
forwarding rule each take 30–60s). Subsequent applies that only roll
Cloud Run images take ~30s.

Useful outputs after apply:

```powershell
terraform output preview_lb_ip          # global IPv4 -> nip.io
terraform output preview_lb_ip_dashed   # same, dots-as-dashes
terraform output dispatcher_url
terraform output cli_caller_sa
terraform output cleanup_url
```

---

## 6. Launching an ephemeral environment

### 6.1 The happy path — `preview.ps1`

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\preview.ps1                          # branch=main, ttl=3600s
.\scripts\preview.ps1 -Branch feat/x -TtlSeconds 600
.\scripts\preview.ps1 -NoOpen                  # don't auto-open browser
.\scripts\preview.ps1 -NoWait                  # POST and exit; don't poll
```

What the script does, end to end:

1. Reads `dispatcher_url` and `cli_caller_sa` from terraform outputs.
2. Mints an OIDC ID token via SA impersonation:
   `gcloud auth print-identity-token --impersonate-service-account=<cli-caller> --audiences=<dispatcher>`.
3. `POST <dispatcher>/environments` with `{branch, ttl_seconds[, image_tag]}`
   and the `Authorization: Bearer <token>` header.
4. Dispatcher returns `201` with:
   ```json
   {
     "env_id": "e-7f3a2b9c",
     "vm_name": "ephem-task-7f3a2b9c",
     "expires_at": "...",
     "access_token": "<32 hex chars>",
     "public_urls": {
       "app":       "http://e-7f3a2b9c-app.<lb-ip-dashed>.nip.io/?token=...",
       "api":       "http://e-7f3a2b9c-api.<lb-ip-dashed>.nip.io/?token=...",
       "firestore": "http://e-7f3a2b9c-firestore.<lb-ip-dashed>.nip.io/?token=..."
     }
   }
   ```
5. Polls `GET /environments/<env_id>` every 8s until `status="ready"`
   (typically 90–180s — VM boot + docker pulls + emulator startup
   dominate). On ready, opens the app URL in the default browser.

### 6.2 What the gateway does on the first browser hit

```diagram
GET http://e-7f3a2b9c-app.34-120-91-102.nip.io/?token=ab12...

  1. parse env_id "e-7f3a2b9c" from Host
  2. Firestore lookup agent_environments/e-7f3a2b9c (5s in-process cache)
  3. doc.status == "ready", doc.access_token == "ab12..."
  4. ?token= matches access_token  -> 302 to /  + Set-Cookie:
       ephem_token_e-7f3a2b9c=ab12...; Domain=.34-120-91-102.nip.io;
       HttpOnly; SameSite=Lax; Max-Age=86400; Path=/

GET http://e-7f3a2b9c-app.34-120-91-102.nip.io/   (cookie sent automatically)

  1. parse env_id (same)
  2. Firestore lookup (cache hit)
  3. cookie token matches  -> reverse proxy to <vm-internal-ip>:8080
  4. VM-side Caddy sees Host=e-7f3a2b9c-app.* -> matches @app -> nginx:80

Subsequent XHR / WebChannel calls to <env_id>-api / <env_id>-firestore
sister hostnames inherit the cookie because Domain=.<lb-ip>.nip.io
covers all three subdomains.
```

The cookie name embeds the env_id so multiple parallel envs in one
browser don't clash; the gateway only checks the cookie matching the
env_id parsed from the current Host.

### 6.3 Local development against a remote environment

A useful side effect of the architecture: even before the agent runner
lands in M5, the POC already supports a **local-dev / remote-env**
loop. An engineer launches an environment once, then iterates on the
`api` and `app` code locally and refreshes the running VM in seconds —
no rebuild, no redeploy, no re-launch.

This works because:

- The VM clones the repo to `/srv/ephemeral` at boot, pinned to the
  branch passed via `preview.ps1 -Branch`.
- `docker-compose.cloud.yml` bind-mounts the agent-editable services
  from the cloned tree (matching local dev exactly):
  - `./api:/app` (rw) — `node index.js` runs against the live source
  - `./firebase-app/app:/usr/share/nginx/html:ro` — nginx serves the
    bind-mount per request
- The other 4 services (`postgres-seeded`, `firebase-emulator-seeded`,
  `pubsub-relay`, `edge-proxy`) are **not** bind-mounted — they're
  immutable seeded images and never change between iterations.

The loop:

```diagram
┌──────────────────┐         ┌────────────────┐
│ local IDE +      │  edit   │ git push       │
│ optional agent   │────────▶│ same branch    │
└────────┬─────────┘         └───────┬────────┘
         │                            │
         │ scripts\refresh-env.ps1    │
         │   -EnvId e-XXXX            │ (origin)
         ▼                            │
┌────────────────────────────────────────────┐
│ gcloud compute ssh ephem-task-XXXX --      │
│   sudo git -C /srv/ephemeral pull --depth=1│
│   sudo docker compose restart api          │
└────────┬───────────────────────────────────┘
         │
         ▼
   browser refresh → new code live (~5–15s end to end)
```

**Helper**: [`scripts\refresh-env.ps1`](file:///c:/Users/kilmo/development/ephemeral/scripts/refresh-env.ps1)

```powershell
# default: git pull + restart api
.\scripts\refresh-env.ps1 -EnvId e-XXXX

# static app change only — pull only, no restart needed
.\scripts\refresh-env.ps1 -EnvId e-XXXX -Service none

# api/package.json changed — rebuild image then up -d
.\scripts\refresh-env.ps1 -EnvId e-XXXX -Rebuild

# scp'd files directly out of band — restart only
.\scripts\refresh-env.ps1 -EnvId e-XXXX -NoPull
```

Per-service refresh cost (typical):

| Service       | What happens                                              | Wall time |
| ------------- | --------------------------------------------------------- | --------- |
| `app`         | nothing — nginx reads new file on next request            | ~0s       |
| `api`         | `docker compose restart api` against live bind-mount      | ~5–10s    |
| `api -Rebuild` | `compose build api` + `up -d api` (package.json changed) | ~30–60s   |

What this is **not**:

- It is **not** the agent runner itself — the agent isn't in this POC
  yet; you're driving the loop manually (or with whatever local agent
  you choose to point at the cloned repo).
- It is **not** a hot-reload of the platform services. Postgres seed
  changes, emulator seed changes, edge-proxy/Caddy config, or
  pubsub-relay code changes still require a new image push + new env
  launch (or `terraform apply` for `task_vm_image_tag`).
- It is **not** branch-switching. The branch was pinned at clone time;
  switching branches needs a fresh env (or a manual
  `git fetch && git checkout` SSH session — but that breaks the
  shallow-clone assumption).

What this **is**:

- A working "I have a long-lived sandbox in the cloud, my IDE/agent
  edits files locally, the cloud env reflects my changes in seconds"
  loop.
- A useful M4-state validation that the bind-mount surface for the
  agent is wired correctly, ahead of plugging in the real runner in
  M5.

### 6.4 The TTL + cleanup path

- Dispatcher writes `expires_at = now + ttl_seconds` (default 3600s, max
  86400s) at creation.
- Cloud Scheduler runs `*/5 * * * *` UTC, calls
  `POST <cleanup-url>/run` with an OIDC token.
- The cleanup service queries `agent_environments where expires_at <= now`
  (no status filter — composite index avoidance), iterates in JS,
  `compute.delete`s each VM (404 = OK, "already gone"), and updates the
  doc to `status="deleted"` with `deleted_at`.
- Already-`deleted` docs are skipped on subsequent sweeps.

To reap immediately rather than waiting for the next 5-minute boundary:

```powershell
gcloud scheduler jobs run ephem-runner-cleanup-sweep `
  --location=us-central1 --project=project-4b04c9cf-520a-4693-86a
```

To kill a specific VM out-of-band (the cleanup worker will tidy the
Firestore doc on its next run):

```powershell
gcloud compute instances delete <vm_name> --zone=us-central1-a `
  --project=project-4b04c9cf-520a-4693-86a --quiet
```

---

## 7. Lifecycle of one environment, in detail

```diagram
t=0     CLI: POST /environments
        dispatcher: mint env_id "e-XXXX", access_token (16 random bytes)
                    Firestore: SET agent_environments/e-XXXX {
                      status:"launching", vm_name, vm_zone, repo_url,
                      branch, image_tag, access_token,
                      created_at, expires_at
                    }
                    compute.instances.insert(
                      machineType=e2-medium, debian-12, 20GB pd-balanced,
                      tag=ephem-runner-vm,
                      sa=ephem-runner-task-vm,
                      metadata={env_id, repo_url, branch, image_tag,
                                firebase_project, startup-script=<inline>})
        dispatcher returns 201 to caller; CLI starts polling

t≈10s   Compute: VM "ephem-task-XXXX" boots Debian
        startup.sh:
          - read instance metadata (env_id, repo_url, branch, ...)
          - install docker if missing (~30s on a fresh image)
          - gcloud auth configure-docker  (uses VM SA)
          - git clone --depth 1 --branch <branch> <repo_url> /srv/ephemeral
          - write /srv/ephemeral/.env { REGISTRY, TAG, FIREBASE_PROJECT }
          - docker compose -f docker-compose.cloud.yml pull --ignore-buildable
              (postgres-seeded, firebase-emulator-seeded, pubsub-relay,
               edge-proxy from AR; ~20-40s on a fresh VM)
          - docker compose build       (api image, in-VM)
          - docker compose up -d

t≈90s   edge-proxy /healthz returns 200
        startup.sh:
          - GET metadata-server access_token
          - PATCH https://firestore.googleapis.com/v1/.../agent_environments/e-XXXX
              {status:"ready", vm_internal_ip:"10.128.x.y", ready_at:NOW}

        Firestore now has status=ready + vm_internal_ip
        Gateway Firestore cache misses on next request, picks up the change

t≈90s+  CLI: poll sees status=ready -> opens browser
        Browser: GET <env>-app...nip.io/?token=...
        Gateway: 302 + Set-Cookie -> 200 from VM
        Browser: subsequent GETs / XHRs use the cookie

t<expires_at
        all three sister URLs serve 200 from the VM via gateway

t>expires_at
        next */5 cleanup sweep:
          compute.delete ephem-task-XXXX
          Firestore: UPDATE agent_environments/e-XXXX
            {status:"deleted", deleted_at:NOW, delete_result:"deleted"}

        Gateway cache expires (5s), next request:
          doc.status == "deleted" -> 410
```

---

## 8. Network and security model

### 8.1 Ingress paths

| Surface                                              | Who can reach it                                  | How                                                                                |
| ---------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Global LB IP `:80`                                   | Public internet                                   | nip.io URL                                                                         |
| `preview-gateway.run.app`                            | Nobody                                            | `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` blocks the `*.run.app` URL entirely       |
| `dispatcher.run.app`                                 | `ephem-runner-cli-caller` SA only                 | Humans impersonate the SA via `roles/iam.serviceAccountTokenCreator`               |
| `cleanup.run.app`                                    | Cloud Scheduler (same project)                    | `INTERNAL_ONLY` ingress + scheduler SA holds `run.invoker`                         |
| Task VM external IP `:8080`                          | Nobody                                            | The wide M1 firewall (`ephem-runner-allow-edge-8080`) was deleted at end of M2     |
| Task VM internal IP `:8080`                          | The gateway egress /26 subnet only                | `ephem-runner-gw-to-vm-8080` allows tcp:8080 from `10.10.0.0/26` to tag `ephem-runner-vm` |
| App / API / Firestore inside a given VM              | Anyone with the env's `access_token`              | Cookie or `?token=` query enforced at the gateway                                  |

### 8.2 What "compromise" looks like for each surface

- **Leaked dispatcher URL**: harmless — IAM blocks unauthorized calls.
- **Leaked `access_token`**: lets the holder use one specific env until
  TTL expiry. Rotate by minting a new env (cheap).
- **Leaked LB IP**: it's literally in the URL — the IP is not the secret.
- **Leaked VM internal IP**: only useful from inside the VPC + same egress
  subnet. Not in any returned response payload anyway (Firestore-only).

### 8.3 Why no IAP / no HTTPS yet

IAP requires HTTPS, HTTPS requires a managed certificate, managed
certificates require a real DNS name. The POC consciously stays on
`nip.io` HTTP for M1–M4 because the access_token + short TTL combination
gives equivalent practical safety for a single-developer POC. M5
introduces a real domain, wildcard cert, and IAP.

---

## 9. Operational reference

### 9.1 Day-to-day command cheat sheet

```powershell
# Build + push all images
.\scripts\build-and-push.ps1

# Roll Cloud Run after a build (assumes you bumped image_tag in tfvars)
cd c:\Users\kilmo\development\infra\ephemeral-runner
terraform apply

# Mint an env, wait, open browser
cd c:\Users\kilmo\development\ephemeral
.\scripts\preview.ps1

# Local-dev loop: refresh a running env after `git push`
.\scripts\refresh-env.ps1 -EnvId e-XXXX            # default: pull + restart api
.\scripts\refresh-env.ps1 -EnvId e-XXXX -Service none   # static app only
.\scripts\refresh-env.ps1 -EnvId e-XXXX -Rebuild        # api/package.json changed

# List active envs (Firestore)
gcloud firestore documents list `
  --collection-id=agent_environments `
  --project=project-4b04c9cf-520a-4693-86a

# List task VMs
gcloud compute instances list `
  --filter="tags.items=ephem-runner-vm" `
  --project=project-4b04c9cf-520a-4693-86a

# Force a cleanup sweep
gcloud scheduler jobs run ephem-runner-cleanup-sweep `
  --location=us-central1 --project=project-4b04c9cf-520a-4693-86a

# Tail dispatcher / gateway / cleanup logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=ephem-runner-dispatcher" `
  --project=project-4b04c9cf-520a-4693-86a --limit=20 --freshness=10m `
  --format='value(textPayload)'

# Tail a specific VM's startup script
gcloud compute instances tail-serial-port-output <vm_name> `
  --zone=us-central1-a --project=project-4b04c9cf-520a-4693-86a

# Gateway debug for a given hostname
curl http://e-XXXX-app.<lb-ip-dashed>.nip.io/__gateway/info
```

### 9.2 Common failure modes

| Symptom                                            | Diagnosis                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `preview.ps1` hangs at "POST /environments"        | Token-creator IAM still propagating. Wait 30–60s, retry.                                               |
| `preview.ps1` errors "Failed to mint identity token" | Caller not in `dispatcher_invoker_members`, or terraform not re-applied after editing it.            |
| `POST /environments` -> 502 "vm create failed"     | Dispatcher SA missing `compute.instanceAdmin.v1` or `serviceAccountUser` on task-vm SA. Re-apply.      |
| Status stuck at `launching` >3 min                 | SSH the VM, `tail /var/log/ephem-startup.log`. Usually wrong `task_vm_image_tag` or AR auth failure.   |
| Browser shows 401 even after `?token=...`          | Cookie didn't set. DevTools → Application → Cookies. Check gateway logs for the 302 path.              |
| Gateway returns 503 long after VM looks healthy    | 5s in-process cache. Wait or roll the gateway (`terraform apply` after touching its template).         |
| Gateway returns 410                                | Cleanup already ran; doc is `status=deleted`. Mint a new env.                                          |
| Cleanup sweep shows `PERMISSION_DENIED`            | Scheduler SA lost `run.invoker` on the cleanup service. Re-apply.                                      |
| `firebase-emulator-seeded` hits "discovery timeout" | Already mitigated with `FUNCTIONS_DISCOVERY_TIMEOUT=60`; if recurring, raise further or rebuild image. |

For deeper troubleshooting, the per-milestone runbooks each capture the
gotcha that bit us on the way to "done".

---

## 10. What's next (M5, not built yet)

Per [POC-Implementation-Plan.md §9 Milestone 5](file:///c:/Users/kilmo/development/ephemeral/POC-Implementation-Plan.md#milestone-5--polish--alignment-with-design):

- Snapshot-cloned data disk (Strategy B) so seed updates don't require
  image rebuilds.
- Pub/Sub front-door for task-creation (the design's preferred shape).
- `mode=agentic` skeleton: dispatcher accepts an `agent_runner` mode,
  task-vm metadata ready for it, no actual agent code yet.
- Real domain + wildcard cert + IAP — replaces the access_token shim.

Until M5 lands, the POC end-state is: a working preview-environment
factory you can drive from a single PowerShell command, with a single
LB IP fronting any number of short-lived per-env VMs, and automatic
TTL-based reaping.
