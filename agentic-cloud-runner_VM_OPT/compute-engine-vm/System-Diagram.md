# Compute Engine Runner System Diagram

## Purpose

Visualize the Compute Engine VM design with both supported runtime modes:

- `agentic`: an agent works inside the environment and can use the same app/API preview URLs for verification
- `review`: the seeded stack runs without an agent so QA, PMs, or engineers can manually test a branch or PR

## High-Level Architecture

```mermaid
flowchart TB
    Requester["Engineer / QA / PM / automation"] --> Request["Task or review request"]
    Request --> Dispatcher["Dispatcher service"]

    SnapshotPointer["Current golden snapshot pointer"] --> Dispatcher
    Dispatcher --> Disk["Create cloned data disk from golden snapshot"]
    Dispatcher --> VM["Create ephemeral Compute Engine VM"]
    Dispatcher --> Record["Create / update environment record"]

    subgraph SharedIngress["Shared public preview ingress"]
        DNS["*.preview.example.com"]
        LB["External HTTPS load balancer"]
        Auth["IAP or preview auth"]
        Gateway["Cloud Run preview gateway"]

        DNS --> LB --> Auth --> Gateway
    end

    subgraph Registry["Control-plane state"]
        Record
        Status["Task / environment status"]
        Artifacts["Artifacts and logs bucket"]
    end

    Gateway --> Record

    subgraph TaskVM["Ephemeral VM: one environment"]
        Startup["Startup script"]
        Workspace["Checked-out repos<br/>docket + docket-platform"]
        Edge["VM edge proxy<br/>internal port 8080"]
        App["Docket web app"]
        API["platform-api"]
        Firebase["Firebase emulator"]
        PubSub["PubSub subscriber"]
        Postgres["Postgres<br/>seeded data"]
        Meili["Meilisearch<br/>seeded data"]
        Agent["Agent runner<br/>agentic mode only"]

        Startup --> Workspace
        Startup --> App
        Startup --> API
        Startup --> Firebase
        Startup --> PubSub
        Startup --> Postgres
        Startup --> Meili
        Startup --> Edge
        Startup -. agentic mode only .-> Agent

        Edge --> App
        Edge --> API

        App --> API
        API --> Postgres
        API --> Meili
        Firebase --> Workspace
        PubSub --> Workspace
        Agent --> Workspace
        Agent --> App
        Agent --> API
        Agent --> Status
        Agent --> Artifacts
    end

    Disk --> Postgres
    Disk --> Meili
    VM --> Startup

    Gateway -- private VPC route --> Edge

    User["Human tester"] --> DNS
```

## Mode Split

```mermaid
flowchart LR
    EnvRequest["Environment request"] --> Mode{"mode"}

    Mode -->|"agentic"| Agentic["Agentic environment"]
    Mode -->|"review"| Review["Review environment"]

    subgraph CommonStack["Common seeded stack"]
        DataDisk["Snapshot-cloned data disk"]
        Repos["Checked-out repos"]
        Compose["Docker Compose"]
        App["Docket app"]
        API["platform-api"]
        Firebase["Firebase emulator"]
        PubSub["PubSub subscriber"]
        DB["Postgres"]
        Search["Meilisearch"]
        Edge["VM edge proxy"]
    end

    DataDisk --> Compose
    Repos --> Compose
    Compose --> App
    Compose --> API
    Compose --> Firebase
    Compose --> PubSub
    Compose --> DB
    Compose --> Search
    Compose --> Edge

    Agentic --> Compose
    Review --> Compose

    Agentic --> Runner["Start agent runner"]
    Review --> NoRunner["Do not start agent runner"]

    Edge --> URLs["Optional public URLs"]
    URLs --> AppURL["https://{environment_id}-app.preview.example.com"]
    URLs --> APIURL["https://{environment_id}-api.preview.example.com"]

    Runner --> Verification["Agent verifies through app/API and local tools"]
    AppURL --> ManualQA["Human manual testing"]
    APIURL --> ManualQA
```

## Request Routing

```mermaid
sequenceDiagram
    participant User as Human tester
    participant DNS as Wildcard DNS
    participant LB as HTTPS load balancer
    participant Auth as IAP / preview auth
    participant Gateway as Preview gateway
    participant Store as Environment record
    participant Edge as VM edge proxy
    participant App as App or platform-api

    User->>DNS: task-123-app.preview.example.com
    DNS-->>User: load balancer address
    User->>LB: HTTPS request
    LB->>Auth: authenticate request
    Auth->>Gateway: forward request
    Gateway->>Gateway: parse host into environment_id=task-123, service=app
    Gateway->>Store: load task-123 record
    Store-->>Gateway: ready, allowed, vm_internal_ip, edge_proxy_port
    Gateway->>Edge: proxy over private VPC to http://vm_internal_ip:8080
    Edge->>App: route by host/service
    App-->>Edge: response
    Edge-->>Gateway: response
    Gateway-->>User: response
```

## Environment Lifecycle

```mermaid
stateDiagram-v2
    [*] --> accepted
    accepted --> launching: dispatcher accepts request
    launching --> booting: VM created
    booting --> cloning_repos: startup begins
    cloning_repos --> starting_stack: repos ready
    starting_stack --> registering_public_urls: app/API booting
    registering_public_urls --> ready_for_review: readiness checks pass

    ready_for_review --> running_agent: mode = agentic
    running_agent --> uploading_artifacts: agent completes
    uploading_artifacts --> succeeded

    ready_for_review --> expired: review TTL expires
    running_agent --> failed: runner or stack failure
    starting_stack --> failed: startup failure
    ready_for_review --> cancelled: manual stop
    running_agent --> cancelled: manual stop

    succeeded --> cleanup
    failed --> cleanup
    cancelled --> cleanup
    expired --> cleanup
    cleanup --> deleted
    deleted --> [*]
```

## Key Design Point

The environment is dynamic, but the public cloud ingress is stable.

Per environment, the system creates:

- one VM
- one cloned data disk
- one environment record

It does not create per-environment DNS records, certificates, load balancer backends, or public IPs.
