# Milestone 2 Runbook

End-to-end smoke: a global HTTP load balancer fronts a Cloud Run preview
gateway that reverse-proxies to the M1 VM's edge proxy over Direct VPC
egress.

Per [POC-Implementation-Plan.md §9 Milestone 2](./POC-Implementation-Plan.md#milestone-2--public-ingress).

## What this milestone proves

```diagram
          ╭───────────────────────────────╮
user ───▶ │ Global HTTP LB on static IPv4 │
          ╰──────────────┬────────────────╯
                         │ HTTP :80
                         ▼
          ╭───────────────────────────────╮
          │ Serverless NEG → Cloud Run    │
          │   ephem-runner-preview-gateway│
          │   (ingress = LB-only)         │
          ╰──────────────┬────────────────╯
                         │ Direct VPC egress
                         │ (10.180.0.0/28 subnet)
                         ▼
          ╭───────────────────────────────╮
          │ M1 VM internal IP :8080       │
          │   edge-proxy (Caddy)          │
          │   tag: ephem-runner-vm        │
          │   firewall: only the egress   │
          │            subnet allowed in  │
          ╰───────────────────────────────╯
```

VM IP is hardcoded as a Cloud Run env var (`VM_IP`). M3 swaps that for a
Firestore registry lookup keyed by `<env_id>` parsed from the Host header.

## Status

| Step | Status   | Notes                                                                              |
| ---- | -------- | ---------------------------------------------------------------------------------- |
| 0    | **TODO** | Build + push the new `preview-gateway` image (now in `scripts/build-and-push.ps1`) |
| 1    | **TODO** | `terraform apply` in `infra/ephemeral-runner/` — provisions LB + Cloud Run + firewall |
| 2    | **TODO** | Hand-launch a fresh M1 VM, capture its **internal** IP                             |
| 3    | **TODO** | Update `vm_ip` in `infra/ephemeral-runner/terraform.tfvars`, re-apply              |
| 4    | **TODO** | Smoke from your laptop: `curl http://smoketest-app.<lb-ip-dashed>.nip.io/`         |
| 5    | **TODO** | Remove the wide-open M1 firewall rule (`ephem-runner-allow-edge-8080`)             |
| 6    | **TODO** | Verify the VM is now reachable **only** through the LB → gateway path              |

## Step 0 — Build + push the gateway image

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\build-and-push.ps1
```

Five images now: the four M1 platform images plus `preview-gateway`.
Note the printed tag (`m1-<sha>`).

## Step 1 — Apply the ephemeral-runner stack

Update [terraform.tfvars](file:///c:/Users/kilmo/development/infra/ephemeral-runner/terraform.tfvars)
so `image_tag` matches what build-and-push printed, then:

```powershell
cd c:\Users\kilmo\development\infra\ephemeral-runner
terraform init
terraform apply
```

Outputs:

- `preview_lb_ip` — global static IPv4 you'll use in nip.io URLs
- `preview_lb_ip_dashed` — same IP with dots → dashes
- `preview_gateway_url` — Cloud Run URL (NOT publicly reachable; for `gcloud run services describe` only)

## Step 2 — Launch a fresh M1 VM

```powershell
cd c:\Users\kilmo\development\ephemeral
.\scripts\launch-vm.ps1 -Tag m1-<sha>
```

The script prints `INTERNAL_IP` (e.g. `10.128.0.5`). **That** is what M2
needs — not the external IP.

## Step 3 — Wire the VM IP into the gateway

Edit [terraform.tfvars](file:///c:/Users/kilmo/development/infra/ephemeral-runner/terraform.tfvars):

```hcl
vm_ip = "10.128.0.5"   # <-- INTERNAL_IP from launch-vm output
```

Re-apply:

```powershell
cd c:\Users\kilmo\development\infra\ephemeral-runner
terraform apply
```

This re-deploys the Cloud Run service with the new env var.

## Step 4 — Smoke through the LB

Substitute `preview_lb_ip_dashed` from the Terraform output:

```powershell
curl http://smoketest-app.<lb-ip-dashed>.nip.io/
curl http://smoketest-api.<lb-ip-dashed>.nip.io/products
curl http://smoketest-firestore.<lb-ip-dashed>.nip.io/
```

Or open in a browser:

```
http://smoketest-app.<lb-ip-dashed>.nip.io/
```

For gateway debug:

```powershell
curl http://smoketest-app.<lb-ip-dashed>.nip.io/__gateway/info
```

That returns the configured `vm_ip` and the received Host header.

## Step 5 — Remove the wide-open M1 firewall rule

After Step 4 succeeds, lock the VM down so the **only** path in is via
the gateway:

```powershell
gcloud compute firewall-rules delete ephem-runner-allow-edge-8080 `
  --project=project-4b04c9cf-520a-4693-86a --quiet
```

## Step 6 — Verify lock-down

```powershell
# Should now FAIL (no more public path):
curl http://<vm-external-ip>:8080/healthz

# Should still SUCCEED (via the LB path):
curl http://smoketest-app.<lb-ip-dashed>.nip.io/
```

## Tear down

```powershell
gcloud compute instances delete <vm-name> `
  --zone=us-central1-a --project=project-4b04c9cf-520a-4693-86a --quiet
```

The LB + Cloud Run + firewall stay (small idle cost; that's the point —
it's the long-lived ingress, not per-environment).

## Common issues

- **LB returns 502 immediately**: `vm_ip` is unset or wrong. Hit
  `…/__gateway/info` to see what the gateway thinks.
- **LB returns 502 after a few seconds**: VM is up but startup script
  hasn't finished. Wait or tail serial output.
- **`terraform apply` fails on subnet overlap**: pick a different
  `egress_subnet_cidr` in `variables.tf` that doesn't overlap any
  existing subnet (default network uses 10.128.0.0/9 across regions).
- **Cloud Run service won't deploy ("could not find image")**: image_tag
  in tfvars doesn't match what's actually in Artifact Registry. Confirm
  with `gcloud artifacts docker images list us-central1-docker.pkg.dev/<proj>/ephemeral-runner/preview-gateway`.
- **First LB request hits ~30s cold start**: serverless NEG + Cloud Run
  cold start. Subsequent requests are fast.
