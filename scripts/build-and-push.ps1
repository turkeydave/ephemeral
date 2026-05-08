<#
.SYNOPSIS
  Build and push the four "platform" ephemeral-runner images to Artifact Registry.

.DESCRIPTION
  Builds and pushes the immutable, agent-non-editable services:
    - postgres-seeded
    - firebase-emulator-seeded
    - pubsub-relay
    - edge-proxy

  The mutable services (`app`, `api`) are NOT built into images. Each VM
  clones this repo at startup and `docker-compose.cloud.yml` builds those
  two services on the VM with bind-mounts against the cloned source, so
  the agent runner can edit them in place.

  Tags every image with the same tag (default: m1-<short git sha>) so the
  whole stack versions together. Run from the repo root.

.PARAMETER Tag
  Override the tag. Default: m1-<short git sha>.

.EXAMPLE
  .\scripts\build-and-push.ps1
  .\scripts\build-and-push.ps1 -Tag m1-handtest
#>
param(
  [string]$Tag = ""
)

$ErrorActionPreference = "Stop"

$Project  = "project-4b04c9cf-520a-4693-86a"
$Region   = "us-central1"
$RepoId   = "ephemeral-runner"
$Registry = "$Region-docker.pkg.dev/$Project/$RepoId"

if (-not $Tag) {
  $Sha = (git rev-parse --short HEAD).Trim()
  if (-not $Sha) { throw "Could not determine git SHA. Pass -Tag explicitly." }
  $Tag = "m1-$Sha"
}

Write-Host ""
Write-Host "Registry: $Registry" -ForegroundColor Cyan
Write-Host "Tag     : $Tag"      -ForegroundColor Cyan
Write-Host ""

# name | dockerfile (relative to repo root) | build context (relative to repo root)
#
# Only the platform images are built+pushed here. `app` and `api` are
# agent-editable and are built on the VM by docker-compose.cloud.yml
# against the cloned repo (see docker-compose.cloud.yml).
$Images = @(
  @{ Name = "pubsub-relay";               Dockerfile = "pubsub-relay/Dockerfile";         Context = "pubsub-relay" },
  @{ Name = "postgres-seeded";            Dockerfile = "postgres/Dockerfile";             Context = "postgres" },
  @{ Name = "firebase-emulator-seeded";   Dockerfile = "firebase-emulator/Dockerfile.cloud"; Context = "." },
  @{ Name = "edge-proxy";                 Dockerfile = "edge-proxy/Dockerfile";           Context = "edge-proxy" }
)

foreach ($img in $Images) {
  $imageRef = "$Registry/$($img.Name):$Tag"
  Write-Host "==> Building $imageRef" -ForegroundColor Green
  docker build -f $img.Dockerfile -t $imageRef $img.Context
  if ($LASTEXITCODE -ne 0) { throw "docker build failed for $($img.Name)" }

  Write-Host "==> Pushing $imageRef"  -ForegroundColor Green
  docker push $imageRef
  if ($LASTEXITCODE -ne 0) { throw "docker push failed for $($img.Name)" }
}

Write-Host ""
Write-Host "All images built and pushed with tag: $Tag" -ForegroundColor Cyan
Write-Host "Use this tag with scripts\launch-vm.ps1"   -ForegroundColor Cyan
