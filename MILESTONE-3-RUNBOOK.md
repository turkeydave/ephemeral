# Milestone 3 Runbook

End-to-end smoke: a Cloud Run dispatcher creates per-env Compute Engine
VMs, the VM's startup script registers itself in Firestore, and the
preview-gateway resolves `<env_id>-<svc>.<lb>.nip.io` requests by
looking up that Firestore record (instead of the M2 hardcoded `VM_IP`
env var).

Per [POC-Implementation-Plan.md §9 Milestone 3](./POC-Implementation-Plan.md#milestone-3--dispatcher--registry).

## What this milestone proves

```diagram
                  ╭──────────────────╮
   user/CLI ────▶ │ dispatcher       │ POST /environments
                  │ (Cloud Run)      │   {repo,branch,tag,ttl}
                  ╰────────┬─────────╯
                           │ 1. mint env_id (e.g. e-7f3a2b9c)
                           │ 2. compute.instances.insert
                           │    (metadata: env_id, repo, branch, tag,
                           │     startup-script, ephem-runner-task-vm SA)
                           │ 3. Firestore: agent_environments/<env_id>
                           │    {status: "launching", created_at, ...}
                           ▼
                  ╭──────────────────╮
                  │  Compute Engine  │
                  │  task VM boots   │
                  ╰────────┬─────────╯
                           │ startup.sh:
                           │   - same M1 boot (clone, .env, compose up)
                           │   - waits for edge-proxy /healthz
                           │   - PATCH agent_environments/<env_id>
                           │     {status: "ready", vm_internal_ip,
                           │      ready_at}
                           ▼
   user opens                                 ╭──────────────────╮
   <env_id>-app.<lb>.nip.io ──── LB ────────▶ │ preview-gateway  │
                                              │ (Cloud Run)      │
                                              ╰────────┬─────────╯
                                                       │ parse env_id from Host
                                                       │ Firestore lookup (5s cache)
                                                       │ if status!=ready -> 503
                                                       ▼ proxy to vm_internal_ip:8080
```

The gateway keeps a small backwards-compat path: if no Firestore doc
exists for the parsed env_id AND that env_id is exactly `smoketest`, it
falls back to the `VM_IP` env var (the M1 hand-launched VM at
`10.128.0.6`). Drop that fallback once the dispatcher path is the only
way VMs are launched.

## Status — DONE ✅

| Step | Status | Notes                                                                                                                                          |
| ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | ✅     | `firestore databases list` confirms reusable `(default)` DB, FIRESTORE_NATIVE, us-central1. No DB creation needed.                            |
| 1    | ✅     | `iam.tf`: 2 new SAs (`ephem-runner-dispatcher`, `ephem-runner-task-vm`), `roles/datastore.user` added to gateway SA, `iam.serviceAccountUser` from dispatcher → task-vm SA. 14 resources added. |
| 2    | ✅     | `runner/preview-gateway/`: rewritten to parse env_id from Host, look up `agent_environments/<env_id>` in Firestore, 5s cache, smoketest VM_IP fallback. Image `m3-8f67a68`. |
| 3    | ✅     | `runner/dispatcher/files/startup.sh`: relocated from `infra/`. Tail patches the registry doc with status=ready / vm_internal_ip / ready_at via Firestore REST + metadata-server token. |
| 4    | ✅     | `runner/dispatcher/`: Cloud Run service. `POST /environments` mints env_id, writes Firestore doc, calls `compute.instances.insert`. Image `m3-8f67a68`. |
| 5    | ✅     | `dispatcher.tf`: ingress=ALL, allUsers invoker, no VPC egress (Compute API + Firestore are public Google APIs). |
| 6    | ✅     | End-to-end smoke: `POST /environments` → `e-b886e5f0` minted in ~1s. VM `ephem-task-b886e5f0` booted in ~2.5min. Gateway returned 503 with retry-after during launching, then 200 for app/api/firestore once registry flipped to ready. |

Move on to **Milestone 4** (cleanup worker + IAP/token gating; small CLI helper).

## Gotchas captured during M3

- **`GOOGLE_CLOUD_PROJECT` is not auto-set on Cloud Run** (unlike App
  Engine). The dispatcher's `requireEnv()` failed startup probe until
  it was set explicitly via terraform. Both Cloud Run services now set
  it from `var.project_id`.
- **Firestore native vs Datastore mode**: a project can host either, not
  both. Reusing the existing `(default)` DB worked because it's already
  Native — if it had been Datastore mode we'd have needed a named DB.
- **Firestore REST API in bash**: writing the registry doc from
  `startup.sh` uses `curl PATCH` with a token from the metadata server
  rather than installing gcloud-firestore tooling. The `(default)`
  database id sits literally in the URL path (`/databases/(default)/`)
  — no URL-encoding required.
- **Tags vs network tags**: terraform `google_compute_firewall.target_tags`
  matches the VM's `tags.items` list. The dispatcher must include
  `ephem-runner-vm` in the instance tags, otherwise the gateway-egress
  firewall rule won't allow inbound :8080. Bug-bait: easy to forget when
  porting from `gcloud --tags=...`.
- **Image rebuilds for layout-only changes**: moving `startup.sh` from
  `infra/` into `runner/dispatcher/files/` required a dispatcher image
  rebuild and re-push (the file is `COPY`'d into the image). No platform
  image rebuild was needed since the file is injected as VM metadata,
  not baked into the platform images.

## Step 0 — Prereqs

- **Firestore DB**: must already exist as `(default)` in Native mode in
  `us-central1`. Verify with:
  ```powershell
  gcloud firestore databases list --project=project-4b04c9cf-520a-4693-86a
  ```
- **M2 LB still up**: `terraform apply` in `infra/ephemeral-runner/`
  should have a single `preview_lb_ip` output. M3 reuses the same LB.

## Step 1 — Build + push the M3 Cloud Run images

The two Cloud Run images (preview-gateway + dispatcher) version
together. The four VM-side platform images (`postgres-seeded`,
`firebase-emulator-seeded`, `pubsub-relay`, `edge-proxy`) version
independently — no rebuild needed for M3.

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\build-and-push.ps1
```

That builds **all six** images at the same `m1-<sha>` tag. For M3-only
rolls (Cloud Run images only) build manually:

```powershell
$Tag = "m3-$(git rev-parse --short HEAD)"
docker build -f runner/preview-gateway/Dockerfile `
  -t us-central1-docker.pkg.dev/project-4b04c9cf-520a-4693-86a/ephemeral-runner/preview-gateway:$Tag `
  runner/preview-gateway
docker push us-central1-docker.pkg.dev/project-4b04c9cf-520a-4693-86a/ephemeral-runner/preview-gateway:$Tag

docker build -f runner/dispatcher/Dockerfile `
  -t us-central1-docker.pkg.dev/project-4b04c9cf-520a-4693-86a/ephemeral-runner/dispatcher:$Tag `
  runner/dispatcher
docker push us-central1-docker.pkg.dev/project-4b04c9cf-520a-4693-86a/ephemeral-runner/dispatcher:$Tag
```

## Step 2 — Apply infra

Update [terraform.tfvars](file:///c:/Users/kilmo/development/infra/ephemeral-runner/terraform.tfvars):

```hcl
image_tag         = "m3-<sha>"      # the Cloud Run images you just built
task_vm_image_tag = "m1-1685a8a"    # the platform images the VM pulls
```

Then:

```powershell
cd c:\Users\kilmo\development\infra\ephemeral-runner
terraform apply
```

New outputs:

- `dispatcher_url` — public URL for `POST /environments`
- `dispatcher_sa` / `task_vm_sa` — for IAM verification

## Step 3 — Smoke an environment end-to-end

```powershell
$dispatcher = (terraform output -raw dispatcher_url)
$lbDashed   = (terraform output -raw preview_lb_ip_dashed)

# 1. Create
$resp = curl.exe -sS -X POST "$dispatcher/environments" `
  -H "Content-Type: application/json" -d "{}"
$env  = ($resp | ConvertFrom-Json)
$env.env_id

# 2. Wait for ready (90s-3min)
do {
  Start-Sleep 10
  $doc = (curl.exe -sS "$dispatcher/environments/$($env.env_id)" | ConvertFrom-Json)
  Write-Host "status=$($doc.status) ip=$($doc.vm_internal_ip)"
} while ($doc.status -ne "ready")

# 3. Hit the public URLs
curl.exe -sS -w "%{http_code}\n" -o NUL $env.public_urls.app
curl.exe -sS -w "%{http_code}\n" -o NUL "$($env.public_urls.api)products"
curl.exe -sS -w "%{http_code}\n" -o NUL $env.public_urls.firestore
```

All three should return 200.

For gateway debug:

```powershell
curl.exe -sS "http://$($env.env_id)-app.$lbDashed.nip.io/__gateway/info"
```

That returns the resolved target + the `why` (Firestore vs smoketest fallback).

## Step 4 — Tear down a single env

```powershell
gcloud compute instances delete <vm_name> --zone=us-central1-a `
  --project=project-4b04c9cf-520a-4693-86a --quiet
```

The Firestore doc lingers (M4 cleanup worker will mark it `deleted`).

## Step 5 — Tear down the whole stack

Same as M2 — terraform-managed; `terraform destroy` removes the LB,
gateway, dispatcher, NEG, firewall, etc. The Firestore registry
collection persists (Firestore deletes need a separate run).

## Common issues

- **`POST /environments` returns 502 with "vm create failed"**: usually
  IAM. The dispatcher SA needs `compute.instanceAdmin.v1` and
  `iam.serviceAccountUser` on the task-vm SA. Check terraform applied
  cleanly.
- **Env stays `launching` past ~3min**: SSH the VM and tail
  `/var/log/ephem-startup.log`. Common causes: image pull failure
  (wrong `task_vm_image_tag`), no outbound HTTPS to GitHub (don't add
  restrictive egress firewalls), or the Firestore PATCH at the end of
  startup.sh failed (look for `WARN: Firestore patch returned HTTP …`).
- **Gateway returns 503 forever even though the doc says ready**:
  5s in-process cache. Wait or restart the Cloud Run revision.
- **Gateway returns 400 "cannot parse env_id from Host"**: the hostname
  doesn't match `<env_id>-(app|api|firestore).<rest>`. Check for typos
  or missing `-` after the env_id.
