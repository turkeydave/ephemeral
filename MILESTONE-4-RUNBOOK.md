# Milestone 4 Runbook

End-to-end smoke: a Cloud Scheduler job runs every 5 minutes, invokes
the cleanup Cloud Run worker, which deletes any task VMs whose
`expires_at` has passed. The dispatcher mints a per-env access token
that the gateway enforces via cookie/query auth. A `scripts/preview.ps1`
helper wraps the whole flow.

Per [POC-Implementation-Plan.md §9 Milestone 4](./POC-Implementation-Plan.md#milestone-4--cleanup--safety).

## What this milestone proves

```diagram
                     ╭───────────────────────╮
                     │ Cloud Scheduler */5 * │
                     │ ephem-runner-cleanup  │
                     │ -sweep                │
                     ╰────────────┬──────────╯
                                  │ POST /run (OIDC, scheduler SA)
                                  ▼
                     ╭───────────────────────╮
                     │ cleanup (Cloud Run)   │
                     │ ephem-runner-cleanup  │
                     │ ingress=internal-only │
                     ╰────────────┬──────────╯
                                  │ Firestore.where('expires_at','<=',now)
                                  │ for each:
                                  │   compute.delete(vm)  // 404=ok
                                  │   doc.update({status:'deleted'})
                                  ▼
                     ╭───────────────────────╮
                     │ task VM deleted +     │
                     │ registry doc cleared  │
                     ╰───────────────────────╯


   user/CLI                                           browser
       │                                                 │
       │ POST /environments                              │ GET /?token=xxx
       │ Bearer = ID token via                           │
       │ gcloud --impersonate=cli-caller-sa              ▼
       ▼                                          ╭──────────────╮
   ╭──────────────╮  mint env_id + access_token   │ preview-     │
   │ dispatcher   │ ─────────╮                    │ gateway      │
   │ run.invoker  │          │                    ╰──────┬───────╯
   │ = cli-caller │          ▼                           │
   │   SA only    │   ╭──────────────╮                   │
   ╰──────────────╯   │ agent_envs/  │ ◀─── lookup ──────╯
                      │ <env_id>     │     check cookie OR ?token=
                      │  access_token│     302 + Set-Cookie on first hit
                      ╰──────────────╯     proxy to vm_internal_ip:8080
```

## Status — DONE ✅

| Step | Status | Notes |
| ---- | ------ | ----- |
| 0    | ✅     | Cleanup worker code + Dockerfile + package.json in `runner/cleanup/`. |
| 1    | ✅     | `infra/.../cleanup.tf`: cleanup SA, scheduler SA, Cloud Run service (ingress=`INTERNAL_ONLY`), `roles/run.invoker` for scheduler, Cloud Scheduler job at `*/5 * * * *`. 11 added on apply. |
| 2    | ✅     | Token gating in `runner/preview-gateway/index.js`: parses `?token=` or `Cookie: ephem_token_<env_id>=...`, 302+Set-Cookie on first hit, cookie domain = parent (`.34-120-91-102.nip.io`) so it covers app/api/firestore sister hostnames. Smoketest fallback + legacy docs without `access_token` stay open. |
| 3    | ✅     | Dispatcher mints 16-byte hex `access_token`, stores in registry doc, returns URLs with `?token=...` query suffix. |
| 4    | ✅     | Dispatcher invocation no longer `allUsers`. New SA `ephem-runner-cli-caller` is the sole `roles/run.invoker`; humans get `roles/iam.serviceAccountTokenCreator` on the SA via `dispatcher_invoker_members` so they can mint Cloud-Run-bound ID tokens through impersonation. |
| 5    | ✅     | `scripts/preview.ps1`: reads `dispatcher_url`/`cli_caller_sa` from terraform outputs, mints token, POST `/environments`, polls until ready, opens browser. Verified end-to-end: `e-811c8619` minted, ready in 140s, all 3 routes 200 with cookie. |
| 6    | ✅     | Cleanup smoke: manually triggered the scheduler job, watched it delete the leftover M3 test env (`e-b886e5f0`) on its TTL. Second sweep skipped the now-`status=deleted` doc. |

Move on to **Milestone 5** (snapshot data disk + Pub/Sub front + agentic mode skeleton).

## Gotchas captured during M4

- **Cloud Run only accepts ID tokens (with `aud=service-url`) for IAM-gated invocation.** OAuth access tokens are rejected (`403 Forbidden` from the front-end, no app log). User accounts can't mint such ID tokens directly — `gcloud auth print-identity-token --audiences=...` returns `Invalid account type for --audiences`. Canonical workaround = SA impersonation: dedicated SA holds `run.invoker`, humans hold `iam.serviceAccountTokenCreator` on it, `gcloud --impersonate-service-account=...` mints the token.
- **Cloud Run ingress constants in terraform** are `INGRESS_TRAFFIC_ALL` / `INGRESS_TRAFFIC_INTERNAL_ONLY` / `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`. The plain `INGRESS_TRAFFIC_INTERNAL` you'll see in some docs **is not valid** for the Terraform provider.
- **`INTERNAL_ONLY` lets Cloud Scheduler in.** Even though scheduler isn't a VPC source, GCP whitelists same-project Cloud Scheduler / Cloud Tasks / Pub/Sub / Eventarc against this ingress level. So no extra Direct VPC egress is needed for the cleanup worker.
- **Cookie domain trick for sister hostnames.** Setting `Domain=.34-120-91-102.nip.io` on the Set-Cookie response lets the same cookie travel across `<env>-app.…`, `<env>-api.…`, and `<env>-firestore.…`. We name the cookie `ephem_token_<env_id>` so cookies for different envs don't collide (browser sends them all; gateway picks the matching one).
- **PowerShell 5 + native commands**:
  - **Em dash characters** (`—`) in `.ps1` files saved as UTF-8 without BOM are read as Latin-1 by powershell.exe and produce parser errors. Stick to ASCII for script source.
  - **Stderr from native commands** is treated as a terminating error under `$ErrorActionPreference = "Stop"`. Even `2>$null` doesn't help when gcloud writes a non-error WARNING to stderr (the SA-impersonation banner does this). Workaround: route through `cmd /c "... 2>NUL"`.
  - **`Set-Content -Encoding UTF8`** writes a BOM. JSON parsers reject the leading `\ufeff` — use `[System.IO.File]::WriteAllText(...)` with `UTF8Encoding($false)` for byte-exact output.
  - **Null-coalescing `??`** is PowerShell 7+ only. Use `if ($x) { $x } else { $y }` for 5.x compatibility.
- **`GOOGLE_CLOUD_PROJECT` is still not auto-set on Cloud Run** — we set it explicitly in `cleanup.tf` (same as M3 dispatcher).

## Step 0 — Prereqs

- M3 stack already applied; gateway + dispatcher deployed at `m3-*` images.
- Active gcloud account is in `var.dispatcher_invoker_members` (defaults to `user:kilmoyer@gmail.com`). Verify with `gcloud config get account`.

## Step 1 — Build + push the new images

The cleanup image is brand new; gateway and dispatcher both have token-related changes. Bump the tag to roll all three:

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\build-and-push.ps1
```

(That now builds 7 images. For Cloud-Run-only rolls, build just the three with explicit `docker build / push` as in the [M3 runbook](./MILESTONE-3-RUNBOOK.md#step-1).)

## Step 2 — Apply infra

Update [terraform.tfvars](file:///c:/Users/kilmo/development/infra/ephemeral-runner/terraform.tfvars):

```hcl
image_tag                  = "m4-<sha>"
dispatcher_invoker_members = ["user:kilmoyer@gmail.com"]
```

```powershell
cd c:\Users\kilmo\development\infra\ephemeral-runner
terraform apply
```

New outputs:

- `cleanup_url` / `cleanup_sa`
- `cli_caller_sa` (used by the CLI helper for impersonation)

## Step 3 — Mint a preview env via the CLI helper

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\preview.ps1
```

Default flow: branch=main, ttl=3600s, polls until ready (~2.5min), opens the app URL in your browser. Useful flags:

```powershell
.\scripts\preview.ps1 -Branch feat/auth -TtlSeconds 600 -NoOpen
.\scripts\preview.ps1 -NoWait              # just POST and print URLs
```

The browser hits `…?token=...`, the gateway sets `Set-Cookie: ephem_token_<env_id>=...; Domain=.34-120-91-102.nip.io; HttpOnly`, then 302s to the same URL minus the token. Subsequent app/api/firestore requests carry the cookie automatically.

## Step 4 — Watch cleanup work

Cloud Scheduler runs the job at `*/5 * * * *` UTC. To trigger immediately:

```powershell
gcloud scheduler jobs run ephem-runner-cleanup-sweep `
  --location=us-central1 --project=project-4b04c9cf-520a-4693-86a
```

Tail logs:

```powershell
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=ephem-runner-cleanup" `
  --project=project-4b04c9cf-520a-4693-86a --limit=10 --format='value(textPayload)' --freshness=10m
```

Expected lines after a sweep that found expired envs:

```
[cleanup] env=e-xxxx vm=ephem-task-xxxx -> deleted
[cleanup] sweep done: scanned=1 deleted=1 failed=0 skipped=0 (1256ms)
```

## Step 5 — Verify token enforcement

```powershell
$env = "e-xxxx"; $tok = "..."   # from preview.ps1 output

# 401 — no token at all
curl.exe -sS -w "%{http_code}`n" -o NUL "http://$env-app.34-120-91-102.nip.io/"

# 302 + Set-Cookie — first hit with token
curl.exe -sS -w "%{http_code}`n" -o NUL "http://$env-app.34-120-91-102.nip.io/?token=$tok"

# 200 — follow with cookie jar
$jar = New-TemporaryFile
curl.exe -sS -w "%{http_code}`n" -o NUL -L -b $jar -c $jar `
  "http://$env-app.34-120-91-102.nip.io/?token=$tok"
Remove-Item $jar
```

## Common issues

- **`preview.ps1` hangs after "POST /environments"**: usually a permission delay. After granting yourself `tokenCreator` via terraform, GCP can take 30-60s to propagate. Re-run.
- **`preview.ps1` errors `Failed to mint identity token`**: confirm your gcloud account is in `dispatcher_invoker_members` and that you re-applied terraform after adding it. Test directly: `gcloud auth print-identity-token --impersonate-service-account=ephem-runner-cli-caller@... --audiences=https://...`.
- **Browser shows 401 even after clicking the URL with `?token=...`**: check the cookie was set — open DevTools → Application → Cookies. If absent, the redirect path failed (look at the gateway logs: `gcloud logging read ".../service_name=ephem-runner-preview-gateway"`).
- **Cleanup deleted a VM I wanted to keep**: check `expires_at` on the doc — it's set to `now + ttl_seconds` at creation. Re-mint with a longer `-TtlSeconds`. M5 may add an "extend TTL" endpoint.
- **Cloud Scheduler shows `PERMISSION_DENIED`**: confirm `run.invoker` is granted to the scheduler SA on the cleanup service (the `google_cloud_run_v2_service_iam_member.scheduler_invokes_cleanup` resource).
