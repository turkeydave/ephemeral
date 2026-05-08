# Milestone 1 Runbook

End-to-end smoke: stack runs on a single hand-launched Compute Engine VM,
images come from Artifact Registry, browser hit through nip.io reaches
the edge proxy and renders the app.

Per [POC-Implementation-Plan.md §9 Milestone 1](./POC-Implementation-Plan.md#milestone-1--plumbing-no-dispatcher-yet).

## Status — DONE ✅

| Step | Status | Notes                                                              |
| ---- | ------ | ------------------------------------------------------------------ |
| 0    | ✅     | gcloud auth + docker auth                                          |
| 1    | ✅     | sse-temp move verified (3 cosmetic Cloud Run scaling drift updates only — not applied) |
| 2    | ✅     | `infra/shared/` applied — `ephemeral-runner` Artifact Registry + 9 APIs + IAM bindings on default Compute SA |
| 3    | ✅     | Repo on `github.com/turkeydave/ephemeral`                          |
| 4    | ✅     | 4 platform images pushed at tag `m1-deaf62c`                       |
| 5    | ✅     | VM `ephem-m1-1778251367` launched + verified                       |
| 6    | ✅     | Startup completed; all 6 containers running                        |
| 7    | ✅     | `:8080/healthz`, `<env>-app.<ip>.nip.io`, `<env>-api.<ip>.nip.io/products`, `<env>-firestore.<ip>.nip.io` all returned 200; full Firestore→Function→PubSub→relay→api→Postgres chain proven |
| 8    | ✅     | VM deleted                                                         |

Move on to **Milestone 2** (HTTPS LB + serverless NEG + Cloud Run gateway).

## Gotchas captured during M1

These tripped us up; if you re-run from scratch they're already in code.

- **Default Compute SA IAM**: out-of-the-box a personal-project Compute SA
  cannot pull from a fresh Artifact Registry repo nor write logs. Now
  granted in [infra/shared/iam.tf](file:///c:/Users/kilmo/development/infra/shared/iam.tf):
  `roles/artifactregistry.reader` on the `ephemeral-runner` repo,
  `roles/logging.logWriter` and `roles/monitoring.metricWriter`
  project-wide.
- **Caddy `host` matcher is single-label**: `host *-app.*` does NOT match
  `smoketest-app.34-41-236-216.nip.io` (4 labels). Use
  `header_regexp Host ^[^.]+-app\..+$` instead. There is no
  `host_regexp` matcher.
- **PowerShell `$ErrorActionPreference = "Stop"` + native gcloud stderr**:
  `gcloud … describe` writes errors to stderr and exits 1 when the
  resource is missing — even with `2>$null` PowerShell turns that into a
  fatal NativeCommandError. The firewall idempotency check in
  [launch-vm.ps1](file:///c:/Users/kilmo/development/ephemeral/scripts/launch-vm.ps1)
  now wraps it in `try/catch` and clears `$LASTEXITCODE`.
- **`${...}` in Terraform output `description`**: Terraform tries to
  interpret it. Plain `<registry>` text instead.
- **Disk size warning is harmless**: "Disk size 20 GB is larger than
  image size 10 GB" — Debian 12 auto-resizes on boot. Ignore.

Scaffolding already committed (no GCP changes yet): see
[POC-Implementation-Plan.md §9 Milestone 1 progress list](./POC-Implementation-Plan.md#milestone-1--plumbing-no-dispatcher-yet--in-progress).

## What's already in place (this commit)

- `infra/shared/` — Terraform stack: project APIs + Artifact Registry repo
  `ephemeral-runner`
- `infra/sse-temp/` — copy of `sse_temp/terraform/` (unchanged content)
- `infra/ephemeral-runner/files/startup.sh` — VM startup script
- `postgres/Dockerfile` — `postgres:16-alpine` + baked init SQL
- `firebase-emulator/Dockerfile.cloud` — emulator + functions deps + baked
  `emulator-data/`
- `edge-proxy/Dockerfile` + `edge-proxy/Caddyfile` — host-routing reverse
  proxy on `:8080`
- `pubsub-relay/Dockerfile` — Pub/Sub pull→push relay (mirrors the prod
  push subscription that this POC stands in for)
- `docker-compose.cloud.yml` — pulls the four platform images
  (`postgres-seeded`, `firebase-emulator-seeded`, `pubsub-relay`,
  `edge-proxy`) from Artifact Registry, and **builds `api` + serves `app`
  on the VM from the cloned source with bind-mounts** so the agent runner
  can edit those two in place
- `scripts/build-and-push.ps1` — builds + pushes the four platform images
- `scripts/launch-vm.ps1` — gcloud-based hand launch

## One-time prerequisites

You'll need on your workstation:

- `gcloud` CLI authenticated to your account
- Docker running (Desktop on Windows is fine)
- A `git remote` named `origin` on this repo pointing at
  `https://github.com/turkeydave/ephemeral.git`

```powershell
gcloud auth login
gcloud config set project project-4b04c9cf-520a-4693-86a
gcloud auth configure-docker us-central1-docker.pkg.dev
```

## Step 1 — Verify the sse-temp move was lossless

```powershell
cd c:\Users\kilmo\development\infra\sse-temp
terraform init
terraform plan
```

Expect: `No changes. Your infrastructure matches the configuration.`

If clean, you can later delete `c:\Users\kilmo\development\sse_temp\terraform\`
(the source dir was preserved deliberately during the copy).

## Step 2 — Apply `infra/shared/`

```powershell
cd c:\Users\kilmo\development\infra\shared
terraform init
terraform apply
```

This creates the `ephemeral-runner` Artifact Registry repo and ensures the
required project APIs are enabled. Output `ephem_runner_registry` will
print the registry URL — sanity-check it's
`us-central1-docker.pkg.dev/project-4b04c9cf-520a-4693-86a/ephemeral-runner`.

## Step 3 — Push this repo to GitHub

```powershell
cd c:\Users\kilmo\development\ephemeral
git init                                        # if not already
git add -A
git commit -m "milestone 1: cloud images + infra/shared"
git remote add origin https://github.com/turkeydave/ephemeral.git
git branch -M main
git push -u origin main
```

The startup script does `git clone --depth 1 --branch main` against this
URL, so a public push must succeed before the VM can boot.

## Step 4 — Build & push the four platform images

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\build-and-push.ps1
```

Builds and pushes the immutable services only:
`postgres-seeded`, `firebase-emulator-seeded`, `pubsub-relay`, `edge-proxy`.

`api` and `app` are deliberately **not** baked into images here — they
are agent-editable and get built/served on the VM from the cloned repo
with bind-mounts (see `docker-compose.cloud.yml`).

Tag defaults to `m1-<short-sha>`. First build of `firebase-emulator-seeded`
takes a few minutes (npm install + Java base). Note the printed tag.

## Step 5 — Hand-launch the VM

```powershell
.\scripts\launch-vm.ps1 -Tag m1-<short-sha>
```

The script:

- ensures firewall rule `ephem-runner-allow-edge-8080` exists (allows
  `tcp:8080` from `0.0.0.0/0` to instances tagged `ephem-runner-vm`)
- creates a Debian 12 e2-medium VM with the M1 startup script and the
  required metadata
- prints curl commands, an in-browser nip.io URL, and a teardown command

## Step 6 — Watch it boot (≈ 60–120 s)

```powershell
gcloud compute instances tail-serial-port-output ephem-m1-<ts> `
  --zone=us-central1-a --project=project-4b04c9cf-520a-4693-86a
```

Wait for `==> ephem-startup complete`.

## Step 7 — Smoke

```powershell
# Health
curl http://<vm-ip>:8080/healthz                     # -> ok

# App (host-header routed)
curl http://smoketest-app.<vm-ip-dashed>.nip.io:8080/

# API
curl http://smoketest-api.<vm-ip-dashed>.nip.io:8080/products
```

In a browser:

```
http://smoketest-app.<vm-ip-dashed>.nip.io:8080/
```

The Tasks page should render, "View Products" should populate from the
seeded Postgres, and "View History (Postgres)" should be empty until you
edit a task (which will fire the trigger → relay → API → Postgres).

## Step 8 — Tear down

```powershell
gcloud compute instances delete ephem-m1-<ts> `
  --zone=us-central1-a --project=project-4b04c9cf-520a-4693-86a --quiet
```

Leave the firewall rule + Artifact Registry images in place for Milestone 2.

## Done = Milestone 1 ✅

Next: Milestone 2 (HTTPS LB + serverless NEG + Cloud Run gateway echoing
hostname; gateway forwards to the VM by hardcoded IP).

## Common issues

- **`docker push` denied**: re-run `gcloud auth configure-docker us-central1-docker.pkg.dev`.
- **Startup hangs at `gcloud auth configure-docker`**: VM SA needs
  `roles/artifactregistry.reader`. Default Compute Engine SA on a personal
  project usually has it via `roles/editor`; if you've tightened that,
  grant it explicitly.
- **`firebase-emulator-seeded` 10s discovery timeout**: already mitigated
  by `FUNCTIONS_DISCOVERY_TIMEOUT=60` in the compose file.
- **Tasks list says it can't reach Firestore**: the app derives the
  emulator hostname from its own URL by swapping `-app.` for
  `-firestore.` (see `firebase-app/app/main.js`). That sister hostname is
  routed by the edge proxy to the in-VM firebase emulator. If you launched
  the VM with a hostname that doesn't match the `<env>-app.<rest>` pattern
  (e.g. you typed the VM IP directly into the browser), the regex won't
  match and the app will surface that error in the DevTools console. Use
  the nip.io URL the launch script printed.
