# Milestone 1 Runbook

End-to-end smoke: stack runs on a single hand-launched Compute Engine VM,
images come from Artifact Registry, browser hit through nip.io reaches
the edge proxy and renders the app.

Per [POC-Implementation-Plan.md §9 Milestone 1](./POC-Implementation-Plan.md#milestone-1--plumbing-no-dispatcher-yet).

## Status — pick up here

| Step | Status               | Notes                                                              |
| ---- | -------------------- | ------------------------------------------------------------------ |
| 0    | **TODO**             | gcloud auth + docker auth on your workstation                      |
| 1    | **TODO**             | `terraform plan` no-op verification of the moved sse-temp state    |
| 2    | **TODO**             | Apply `infra/shared/` (creates the ephemeral-runner Artifact Registry repo) |
| 3    | **TODO**             | Push this repo to `github.com/turkeydave/ephemeral` (public)       |
| 4    | **TODO**             | Run `scripts\build-and-push.ps1` (capture the printed `m1-<sha>` tag) |
| 5    | **TODO**             | Run `scripts\launch-vm.ps1 -Tag m1-<sha>`                          |
| 6    | **TODO**             | Tail serial console until `==> ephem-startup complete`             |
| 7    | **TODO**             | Smoke: curl `:8080/healthz` + nip.io URLs in browser               |
| 8    | **TODO**             | Tear the VM down                                                   |

When you mark Step 7 ✅ here, M1 is done; move to Milestone 2.

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
- `firebase-app/app/Dockerfile` — nginx + baked static `index.html`/`main.js`
- `edge-proxy/Dockerfile` + `edge-proxy/Caddyfile` — host-routing reverse
  proxy on `:8080`
- `docker-compose.cloud.yml` — references all six images by tag
- `scripts/build-and-push.ps1` — tag and push everything together
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

## Step 4 — Build & push the six images

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\build-and-push.ps1
```

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
- **App loads but no tasks**: the local app's `connectFirestoreEmulator`
  check runs only on `localhost`/`127.0.0.1` hostnames. In the cloud the
  hostname is `*.nip.io` so the SDK targets *real* Firestore, which is
  empty. **Known M1 limitation** — fix in Milestone 2: have the app point
  at the in-VM emulator via the API, or expose the firestore emulator port
  through the edge proxy.
