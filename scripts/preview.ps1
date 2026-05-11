<#
.SYNOPSIS
  Mint an ephemeral preview environment via the dispatcher Cloud Run service.

.DESCRIPTION
  POSTs to the dispatcher's /environments endpoint with an OIDC identity
  token from `gcloud auth print-identity-token`, prints the env_id +
  public URLs, and (by default) polls the registry until status=ready
  and opens the app URL in your default browser.

  The dispatcher mints a per-env access_token; the public URLs returned
  here include `?token=...` so the gateway accepts the first request and
  sets a cookie. After the redirect the cookie carries auth across all
  three sister hostnames (`<env>-app|api|firestore.<lb>.nip.io`).

.PARAMETER Branch
  Git branch the task VM should clone. Default: main.

.PARAMETER Tag
  Image tag for the platform images the VM pulls (postgres-seeded,
  firebase-emulator-seeded, pubsub-relay, edge-proxy). Default: omit
  to use the dispatcher's DEFAULT_IMAGE_TAG env var.

.PARAMETER TtlSeconds
  Time-to-live in seconds. Cleanup worker reaps the VM after this.
  Default: 3600 (1 hour). Min 60, max 86400.

.PARAMETER DispatcherUrl
  Override the dispatcher base URL. Default: read from
  `terraform output -raw dispatcher_url` if INFRA_DIR is set, else
  hardcoded fallback below.

.PARAMETER NoOpen
  Don't open the browser after the env becomes ready.

.PARAMETER NoWait
  Don't poll. Just POST and print the response.

.EXAMPLE
  .\scripts\preview.ps1
  .\scripts\preview.ps1 -Branch feat/auth -TtlSeconds 600 -NoOpen
#>
param(
  [string]$Branch        = "main",
  [string]$Tag           = "",
  [int]   $TtlSeconds    = 3600,
  [string]$DispatcherUrl = "",
  [switch]$NoOpen,
  [switch]$NoWait
)

$ErrorActionPreference = "Stop"

# ---- resolve dispatcher URL ----
if (-not $DispatcherUrl) {
  $InfraDir = $env:INFRA_DIR
  if (-not $InfraDir) {
    $InfraDir = "c:\Users\kilmo\development\infra\ephemeral-runner"
  }
  if (Test-Path $InfraDir) {
    Push-Location $InfraDir
    try {
      $DispatcherUrl = (terraform output -raw dispatcher_url 2>$null).Trim()
    } catch {
      $DispatcherUrl = ""
    }
    Pop-Location
  }
}

if (-not $DispatcherUrl) {
  throw "Could not resolve dispatcher URL. Pass -DispatcherUrl explicitly or set INFRA_DIR to your terraform stack dir."
}

Write-Host "Dispatcher: $DispatcherUrl" -ForegroundColor Cyan

# ---- mint identity token (Cloud Run audience = dispatcher URL) ----
$Token = (gcloud auth print-identity-token --audiences=$DispatcherUrl).Trim()
if (-not $Token) { throw "gcloud auth print-identity-token returned empty. Run `gcloud auth login`." }

# ---- build request body ----
$body = @{
  branch      = $Branch
  ttl_seconds = $TtlSeconds
}
if ($Tag) { $body.image_tag = $Tag }
$bodyJson = $body | ConvertTo-Json -Compress

# ---- POST /environments ----
Write-Host ""
Write-Host "==> POST /environments" -ForegroundColor Green
$resp = curl.exe -sS -w "`n%{http_code}" `
  -X POST "$DispatcherUrl/environments" `
  -H "Authorization: Bearer $Token" `
  -H "Content-Type: application/json" `
  -d $bodyJson

# Last line of $resp is the HTTP code; everything before is the body.
$lines    = $resp -split "`n"
$httpCode = $lines[-1].Trim()
$bodyText = ($lines[0..($lines.Length - 2)] -join "`n").Trim()

if ($httpCode -ne "201") {
  Write-Host ""
  Write-Host "ERROR: dispatcher returned HTTP $httpCode" -ForegroundColor Red
  Write-Host $bodyText
  throw "dispatcher rejected request"
}

$env = $bodyText | ConvertFrom-Json

Write-Host ""
Write-Host "env_id     : $($env.env_id)"      -ForegroundColor Cyan
Write-Host "vm_name    : $($env.vm_name)"     -ForegroundColor Cyan
Write-Host "expires_at : $($env.expires_at)"  -ForegroundColor Cyan
Write-Host ""
Write-Host "URLs (token embedded — gateway sets cookie + 302s on first hit):"
Write-Host "  app       : $($env.public_urls.app)"
Write-Host "  api       : $($env.public_urls.api)"
Write-Host "  firestore : $($env.public_urls.firestore)"
Write-Host ""

if ($NoWait) {
  Write-Host "(skipping wait — not polling for ready)" -ForegroundColor Yellow
  return
}

# ---- poll until ready ----
Write-Host "==> waiting for status=ready (typical: 90s-3min)" -ForegroundColor Green

$started = Get-Date
$deadline = $started.AddMinutes(5)

while ((Get-Date) -lt $deadline) {
  Start-Sleep 8
  $doc = curl.exe -sS "$DispatcherUrl/environments/$($env.env_id)" `
    -H "Authorization: Bearer $Token" | ConvertFrom-Json
  $elapsed = [int]((Get-Date) - $started).TotalSeconds
  Write-Host ("  [{0,3}s] status={1} ip={2}" -f $elapsed, $doc.status, ($doc.vm_internal_ip ?? "-"))
  if ($doc.status -eq "ready") {
    Write-Host ""
    Write-Host "==> ready in ${elapsed}s." -ForegroundColor Green
    if (-not $NoOpen) {
      Write-Host "Opening $($env.public_urls.app)" -ForegroundColor Cyan
      Start-Process $env.public_urls.app
    }
    return
  }
  if ($doc.status -in @('failed','deleted','expired')) {
    throw "env entered terminal state $($doc.status) before ready"
  }
}

throw "env $($env.env_id) did not become ready within 5min"
