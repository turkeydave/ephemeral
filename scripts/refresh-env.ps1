<#
.SYNOPSIS
  Pull the latest source onto a running preview VM and restart the
  agent-editable services so the env reflects local commits.

.DESCRIPTION
  Local-dev / remote-environment loop: launch an env with
  `preview.ps1`, then iterate locally — commit + push to the same
  branch the env was launched on — and call this script to refresh
  the VM in seconds.

  What this does on the VM (via `gcloud compute ssh`):

    1. (default) `sudo git -C /srv/ephemeral pull --depth=1`
         - shallow pull keeps the clone tiny; the branch was pinned at
           launch and is still checked out
    2. `sudo docker compose -f docker-compose.cloud.yml restart <svc>`
         - default `api` (the only service that needs a restart to pick
           up new code)
         - `app` is a static nginx bind-mount; new files appear on the
           next request, no restart needed
         - `-Rebuild` flag rebuilds the api image in-place (use when
           api/package.json changed; ~30s)

  No firebase-emulator / postgres restart on purpose — those are
  immutable seeded images, not agent-editable.

.PARAMETER EnvId
  The env_id minted by `preview.ps1` (e.g. `e-27001316`). Required.
  The VM name is derived deterministically: `ephem-task-<envSuffix>`.

.PARAMETER Service
  Which compose service(s) to restart. Default: `api`.
  Pass `none` to skip the restart (useful when only static `app`
  changed). Pass `all` to restart api + app + edge-proxy +
  pubsub-relay (rare; api alone is almost always enough).

.PARAMETER Rebuild
  `docker compose build api` before restart. Needed when
  api/package.json changed. Skips the restart-only fast path.

.PARAMETER NoPull
  Skip `git pull`. Useful if you scp'd / rsync'd files directly to the
  VM out of band and just want the restart.

.PARAMETER Zone
  GCP zone the VM lives in. Default: us-central1-a (matches the
  dispatcher's `task_vm_zone`).

.PARAMETER Project
  GCP project. Default: project-4b04c9cf-520a-4693-86a.

.EXAMPLE
  .\scripts\refresh-env.ps1 -EnvId e-27001316
  # default: git pull + restart api

.EXAMPLE
  .\scripts\refresh-env.ps1 -EnvId e-27001316 -Service none
  # static app change only — pull, no restart

.EXAMPLE
  .\scripts\refresh-env.ps1 -EnvId e-27001316 -Rebuild
  # api/package.json changed; rebuild image then restart
#>
param(
  [Parameter(Mandatory=$true)]
  [string]$EnvId,

  [ValidateSet("api","app","none","all")]
  [string]$Service = "api",

  [switch]$Rebuild,
  [switch]$NoPull,

  [string]$Zone    = "us-central1-a",
  [string]$Project = "project-4b04c9cf-520a-4693-86a"
)

$ErrorActionPreference = "Stop"

# ---- derive VM name from env_id ----
# Dispatcher uses: vmName = `${VM_NAME_PREFIX}${envId.slice(2)}`
# i.e. strip the leading `e-`. See runner/dispatcher/index.js.
if ($EnvId -notmatch '^e-[0-9a-f]+$') {
  throw "EnvId must look like 'e-<hex>' (got: $EnvId)"
}
$vmName = "ephem-task-" + $EnvId.Substring(2)

Write-Host "EnvId  : $EnvId"   -ForegroundColor Cyan
Write-Host "VM     : $vmName"  -ForegroundColor Cyan
Write-Host "Zone   : $Zone"    -ForegroundColor Cyan
Write-Host "Service: $Service$(if($Rebuild){' (rebuild)'})$(if($NoPull){' (no pull)'})" -ForegroundColor Cyan
Write-Host ""

# ---- build the remote bash command ----
$workdir  = "/srv/ephemeral"
$compose  = "sudo docker compose -f $workdir/docker-compose.cloud.yml --env-file $workdir/.env"
$parts    = @()

if (-not $NoPull) {
  # Fetch + hard-reset (instead of `git pull`) for three reasons:
  #   1. shallow clones don't fast-forward cleanly — the local commit
  #      may not be reachable through the depth-1 history boundary, so
  #      `pull --ff-only` reports "Not possible to fast-forward"
  #   2. handles dirty working trees (e.g. operator scp'd a file in for
  #      a one-off test) — we always want the VM to reflect origin
  #   3. handles force-pushes on feature branches without merge conflicts
  # Branch name is read from HEAD on the VM (set by `git clone --branch
  # <branch>` in startup.sh) so we don't need to know it client-side.
  $parts += "echo '==> git fetch + reset --hard origin/HEAD' && " +
            "sudo bash -c 'cd $workdir && B=`$(git rev-parse --abbrev-ref HEAD) && " +
            "git fetch --depth=1 origin `"`$B`" && git reset --hard `"origin/`$B`"'"
}

switch ($Service) {
  "none" {
    if (-not $NoPull) {
      $parts += "echo '==> no service restart requested (static app picks up new files automatically)'"
    }
  }
  "all" {
    if ($Rebuild) {
      $parts += "echo '==> compose build' && $compose build"
    }
    $parts += "echo '==> compose up -d' && $compose up -d"
  }
  default {
    if ($Rebuild) {
      $parts += "echo '==> compose build $Service' && $compose build $Service"
      # `up -d <svc>` recreates the container against the freshly-built image.
      $parts += "echo '==> compose up -d $Service' && $compose up -d $Service"
    } else {
      $parts += "echo '==> compose restart $Service' && $compose restart $Service"
    }
  }
}

$parts += "echo '==> done'"
$remote = $parts -join " && "

# ---- run it ----
Write-Host "==> ssh $vmName" -ForegroundColor Green
# Pipe `y` for first-time host-key acceptance via plink/PuTTY on
# Windows; harmless on subsequent runs once the key is cached.
$started = Get-Date
echo y | gcloud compute ssh $vmName `
  --zone=$Zone --project=$Project --command=$remote
if ($LASTEXITCODE -ne 0) {
  throw "ssh/refresh failed (exit $LASTEXITCODE)"
}
$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host ""
Write-Host "==> refreshed in ${elapsed}s." -ForegroundColor Green
