# Agentic Cloud Runner Design Index

This folder now contains two parallel architecture options for the agentic runner.

## Options

- [GKE PVC Option](./gke-pvc-option/Agentic-Runner-System-v1.md)
- [Compute Engine VM Option](./compute-engine-vm/Agentic-Runner-Compute-Engine-v1.md)
- [Compute Engine Runner System Diagram](./compute-engine-vm/System-Diagram.md)
- [Compute Engine Ephemeral Public Environments](./compute-engine-vm/Ephemeral-Public-Environments.md)
- [Option Comparison](./Option-Comparison.md)

## Intent

### GKE PVC Option

Use GKE jobs, sidecars, and snapshot-cloned PVCs for each task cell.

This is the more platform-oriented design.

### Compute Engine VM Option

Use one ephemeral VM per task, a snapshot-derived data disk, and Docker Compose on the VM.

This is the simpler design and maps more closely to the current Docket local runtime model.

The VM option can also expose short-lived app/API preview URLs for QA, PM, or engineer review by using a shared preview gateway in front of private task VMs.

## Recommended Reading Order

1. Start with the [Compute Engine VM Option](./compute-engine-vm/Agentic-Runner-Compute-Engine-v1.md) if the priority is a simpler path to a working system.
2. Open the [Compute Engine Runner System Diagram](./compute-engine-vm/System-Diagram.md) for the visual model.
3. Read [Ephemeral Public Environments](./compute-engine-vm/Ephemeral-Public-Environments.md) for the app/API preview URL extension.
4. Read the [GKE PVC Option](./gke-pvc-option/Agentic-Runner-System-v1.md) if the priority is a more scalable long-term platform model.
