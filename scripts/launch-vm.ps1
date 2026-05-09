<#
.SYNOPSIS
  Hand-launch a single ephemeral-runner VM for the Milestone 1 smoke test.

.DESCRIPTION
  Creates (idempotently) a firewall rule that allows :8080 from anywhere
  in the default network, then creates a Debian VM with the M1 startup
  script and the metadata it needs to boot the stack.

  This is the manual gcloud equivalent of what the dispatcher Cloud Run
  service will do in Milestone 3.

.PARAMETER Tag
  Image tag to deploy (must already be pushed by build-and-push.ps1).

.PARAMETER Name
  VM name. Default: ephem-m1-<unix-timestamp>.

.PARAMETER Branch
  Git branch to clone. Default: main.

.PARAMETER RepoUrl
  Git repo to clone. Default: the public turkeydave/ephemeral repo.

.PARAMETER Zone
  Compute Engine zone. Default: us-central1-a.

.EXAMPLE
  .\scripts\launch-vm.ps1 -Tag m1-abcdef0
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  [string]$Name    = "",
  [string]$Branch  = "main",
  [string]$RepoUrl = "https://github.com/turkeydave/ephemeral.git",
  [string]$Zone    = "us-central1-a"
)

$ErrorActionPreference = "Stop"

$Project   = "project-4b04c9cf-520a-4693-86a"
$Region    = "us-central1"
$Network   = "default"
$Firewall  = "ephem-runner-allow-edge-8080"
$StartupSh = (Resolve-Path "$PSScriptRoot\..\runner\dispatcher\files\startup.sh").Path

if (-not (Test-Path $StartupSh)) {
  throw "Startup script not found at $StartupSh"
}

if (-not $Name) {
  $Name = "ephem-m1-" + [int][double]::Parse((Get-Date -UFormat %s))
}

Write-Host "Project    : $Project" -ForegroundColor Cyan
Write-Host "Zone       : $Zone"     -ForegroundColor Cyan
Write-Host "VM name    : $Name"     -ForegroundColor Cyan
Write-Host "Image tag  : $Tag"      -ForegroundColor Cyan
Write-Host "Repo       : $RepoUrl @ $Branch" -ForegroundColor Cyan
Write-Host "Startup sh : $StartupSh" -ForegroundColor Cyan
Write-Host ""

# ---- firewall rule (idempotent) ----
# `gcloud ... describe` writes to stderr and exits 1 when the rule is
# missing. With $ErrorActionPreference = "Stop", that bubbles up as a
# NativeCommandError. Suppress both streams and rely on $LASTEXITCODE.
$existing = $null
try {
  $existing = & gcloud compute firewall-rules describe $Firewall `
    --project=$Project --format="value(name)" 2>$null
} catch {
  $existing = $null
}
if ($LASTEXITCODE -ne 0) { $existing = $null }
$global:LASTEXITCODE = 0

if (-not $existing) {
  Write-Host "==> creating firewall rule $Firewall (allow tcp:8080 from anywhere, target tag ephem-runner-vm)" -ForegroundColor Green
  gcloud compute firewall-rules create $Firewall `
    --project=$Project `
    --network=$Network `
    --direction=INGRESS `
    --action=ALLOW `
    --rules=tcp:8080 `
    --source-ranges=0.0.0.0/0 `
    --target-tags=ephem-runner-vm `
    --description="M1 smoke: allow public :8080 to ephemeral-runner edge proxy"
  if ($LASTEXITCODE -ne 0) { throw "firewall create failed" }
} else {
  Write-Host "==> firewall rule $Firewall already exists" -ForegroundColor Yellow
}

# ---- create the VM ----
Write-Host "==> creating VM $Name in $Zone" -ForegroundColor Green
gcloud compute instances create $Name `
  --project=$Project `
  --zone=$Zone `
  --machine-type=e2-medium `
  --image-family=debian-12 `
  --image-project=debian-cloud `
  --boot-disk-size=20GB `
  --boot-disk-type=pd-balanced `
  --tags=ephem-runner-vm `
  --scopes=cloud-platform `
  --metadata="repo_url=$RepoUrl,branch=$Branch,image_tag=$Tag,firebase_project=$Project" `
  --metadata-from-file="startup-script=$StartupSh"

if ($LASTEXITCODE -ne 0) { throw "instance create failed" }

# ---- print connection hints ----
$externalIp = gcloud compute instances describe $Name --project=$Project --zone=$Zone `
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)"

$ipDashed = $externalIp -replace '\.', '-'

Write-Host ""
Write-Host "VM external IP : $externalIp" -ForegroundColor Cyan
Write-Host ""
Write-Host "Tail startup logs (give it ~60s for first pull):" -ForegroundColor Cyan
Write-Host "  gcloud compute instances tail-serial-port-output $Name --zone=$Zone --project=$Project"
Write-Host ""
Write-Host "Smoke tests once startup completes:" -ForegroundColor Cyan
Write-Host "  curl http://$externalIp`:8080/healthz"
Write-Host "  curl http://smoketest-app.$ipDashed.nip.io`:8080/"
Write-Host "  curl http://smoketest-api.$ipDashed.nip.io`:8080/products"
Write-Host ""
Write-Host "Open in browser:" -ForegroundColor Cyan
Write-Host "  http://smoketest-app.$ipDashed.nip.io`:8080/"
Write-Host ""
Write-Host "Tear down when done:" -ForegroundColor Cyan
Write-Host "  gcloud compute instances delete $Name --zone=$Zone --project=$Project --quiet"
