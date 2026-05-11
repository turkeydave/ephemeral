// Dispatcher — Milestone 3.
//
// Public API:
//
//   POST /environments
//     body (all optional, defaults shown):
//       {
//         "repo_url":  "https://github.com/turkeydave/ephemeral.git",
//         "branch":    "main",
//         "image_tag": "<DEFAULT_IMAGE_TAG env>",
//         "ttl_seconds": 3600
//       }
//     response 201:
//       {
//         "env_id":      "e-7f3a2b9c",
//         "vm_name":     "ephem-task-7f3a2b9c",
//         "vm_zone":     "us-central1-a",
//         "status":      "launching",
//         "expires_at":  "2026-05-09T08:30:00.000Z",
//         "public_urls": {
//           "app":       "http://e-7f3a2b9c-app.34-120-91-102.nip.io/",
//           "api":       "http://e-7f3a2b9c-api.34-120-91-102.nip.io/",
//           "firestore": "http://e-7f3a2b9c-firestore.34-120-91-102.nip.io/"
//         }
//       }
//
//   GET /environments/<env_id>
//     mirrors the Firestore doc + computed public URLs.
//
//   GET /healthz   -> 200 ok
//
// Lifecycle:
//   1. Mint env_id (random 8-char hex prefixed `e-`).
//   2. Write Firestore agent_environments/<env_id> with status=launching.
//   3. compute.instances.insert with the same shape as scripts/launch-vm.ps1,
//      attaching the task-vm SA + ephem-runner-vm tag + custom metadata
//      (env_id, repo_url, branch, image_tag, firebase_project) + the
//      bundled startup-script.
//   4. Return 201 immediately; the VM's startup.sh patches the doc to
//      status=ready once /healthz comes up.
//
// Required env (in Cloud Run via terraform):
//   GOOGLE_CLOUD_PROJECT     auto-set by Cloud Run
//   ZONE                     e.g. "us-central1-a"
//   TASK_VM_SA_EMAIL         e.g. "ephem-runner-task-vm@<proj>.iam..."
//   LB_IP_DASHED             e.g. "34-120-91-102"
//   DEFAULT_IMAGE_TAG        e.g. "m1-1685a8a" (the image tag baked into
//                            postgres-seeded / firebase-emulator-seeded /
//                            pubsub-relay / edge-proxy)
// Optional env:
//   DEFAULT_REPO_URL         default https://github.com/turkeydave/ephemeral.git
//   DEFAULT_BRANCH           default main
//   VM_MACHINE_TYPE          default e2-medium
//   VM_NAME_PREFIX           default ephem-task-
//   VM_TAG                   default ephem-runner-vm
//   PORT                     default 8080

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { InstancesClient } = require('@google-cloud/compute');

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT
  || process.env.PROJECT_ID
  || '';
const ZONE = process.env.ZONE || 'us-central1-a';
const TASK_VM_SA_EMAIL = process.env.TASK_VM_SA_EMAIL || '';
const LB_IP_DASHED = process.env.LB_IP_DASHED || '';
const DEFAULT_IMAGE_TAG = process.env.DEFAULT_IMAGE_TAG || '';
const DEFAULT_REPO_URL = process.env.DEFAULT_REPO_URL
  || 'https://github.com/turkeydave/ephemeral.git';
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || 'main';
const VM_MACHINE_TYPE = process.env.VM_MACHINE_TYPE || 'e2-medium';
const VM_NAME_PREFIX = process.env.VM_NAME_PREFIX || 'ephem-task-';
const VM_TAG = process.env.VM_TAG || 'ephem-runner-vm';
const PORT = parseInt(process.env.PORT || '8080', 10);

const COLLECTION = 'agent_environments';
const STARTUP_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'files', 'startup.sh'),
  'utf8',
);

// Fail fast on misconfig — easier than 500s deep in a request.
function requireEnv(name, value) {
  if (!value) {
    console.error(`[dispatcher] FATAL: ${name} env var is required`);
    process.exit(1);
  }
}
requireEnv('GOOGLE_CLOUD_PROJECT', PROJECT_ID);
requireEnv('TASK_VM_SA_EMAIL', TASK_VM_SA_EMAIL);
requireEnv('LB_IP_DASHED', LB_IP_DASHED);
requireEnv('DEFAULT_IMAGE_TAG', DEFAULT_IMAGE_TAG);

const firestore = new Firestore();
const compute = new InstancesClient();

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function mintEnvId() {
  // 8 hex chars = 4 bytes random; small but plenty for POC.
  return 'e-' + crypto.randomBytes(4).toString('hex');
}

function mintAccessToken() {
  // 32 hex chars = 128 bits. The gateway accepts this either via a
  // `?token=...` query param on the *first* request (it sets a cookie
  // and 302s to the same URL minus the token) or via the cookie
  // thereafter. See preview-gateway/index.js.
  return crypto.randomBytes(16).toString('hex');
}

function publicUrls(envId, token) {
  const base = `${envId}-{svc}.${LB_IP_DASHED}.nip.io`;
  // The token query param is only needed on the first request — the
  // gateway sets a cookie and strips it on the redirect.
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return {
    app:       `http://${base.replace('{svc}', 'app')}/${q}`,
    api:       `http://${base.replace('{svc}', 'api')}/${q}`,
    firestore: `http://${base.replace('{svc}', 'firestore')}/${q}`,
  };
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

// --------------------------------------------------------------------------
// VM creation
// --------------------------------------------------------------------------
function buildInstanceResource({ envId, vmName, repoUrl, branch, imageTag }) {
  return {
    name: vmName,
    machineType: `zones/${ZONE}/machineTypes/${VM_MACHINE_TYPE}`,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: 'projects/debian-cloud/global/images/family/debian-12',
          diskSizeGb: '20',
          diskType: `zones/${ZONE}/diskTypes/pd-balanced`,
        },
      },
    ],
    networkInterfaces: [
      {
        // default auto-mode network; the auto subnet for ZONE is picked
        // implicitly. accessConfigs gives the VM a public IP for outbound
        // git clone + image pulls — inbound is firewall-restricted to
        // the gateway egress subnet on :8080 only.
        network: 'global/networks/default',
        accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }],
      },
    ],
    serviceAccounts: [
      {
        email: TASK_VM_SA_EMAIL,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    ],
    tags: { items: [VM_TAG] },
    metadata: {
      items: [
        { key: 'startup-script',   value: STARTUP_SCRIPT },
        { key: 'env_id',           value: envId },
        { key: 'repo_url',         value: repoUrl },
        { key: 'branch',           value: branch },
        { key: 'image_tag',        value: imageTag },
        { key: 'firebase_project', value: PROJECT_ID },
      ],
    },
  };
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------
async function handleCreateEnv(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  const repoUrl  = (body.repo_url  || DEFAULT_REPO_URL).trim();
  const branch   = (body.branch    || DEFAULT_BRANCH).trim();
  const imageTag = (body.image_tag || DEFAULT_IMAGE_TAG).trim();
  const ttlSec   = Math.max(60, Math.min(86400,
    parseInt(body.ttl_seconds, 10) || 3600));

  const envId    = mintEnvId();
  const vmName   = `${VM_NAME_PREFIX}${envId.slice(2)}`;
  const expires  = new Date(Date.now() + ttlSec * 1000);
  const accessToken = mintAccessToken();

  const docRef = firestore.collection(COLLECTION).doc(envId);

  // 1. Write the registry doc *before* creating the VM. If VM creation
  //    fails we'll have a launching-status doc to garbage-collect, but
  //    we won't have an orphan VM nobody knows about.
  try {
    await docRef.set({
      env_id:       envId,
      status:       'launching',
      vm_name:      vmName,
      vm_zone:      ZONE,
      repo_url:     repoUrl,
      branch:       branch,
      image_tag:    imageTag,
      access_token: accessToken,
      created_at:   FieldValue.serverTimestamp(),
      expires_at:   expires,
    });
  } catch (e) {
    console.error(`[dispatcher] firestore write failed env=${envId}: ${e.message}`);
    return sendJson(res, 502, { error: 'registry write failed: ' + e.message });
  }

  // 2. Create the VM. instances.insert returns immediately with an
  //    operation ref; we don't poll — startup.sh will patch the doc.
  try {
    await compute.insert({
      project: PROJECT_ID,
      zone: ZONE,
      instanceResource: buildInstanceResource({
        envId, vmName, repoUrl, branch, imageTag,
      }),
    });
  } catch (e) {
    console.error(`[dispatcher] compute.insert failed env=${envId}: ${e.message}`);
    // Mark the doc so cleanup picks it up promptly.
    await docRef.update({
      status: 'failed',
      error:  e.message,
      failed_at: FieldValue.serverTimestamp(),
    }).catch(() => {});
    return sendJson(res, 502, {
      error: 'vm create failed: ' + e.message,
      env_id: envId,
    });
  }

  console.log(`[dispatcher] created env=${envId} vm=${vmName} repo=${repoUrl}@${branch} tag=${imageTag}`);
  return sendJson(res, 201, {
    env_id:       envId,
    vm_name:      vmName,
    vm_zone:      ZONE,
    status:       'launching',
    expires_at:   expires.toISOString(),
    access_token: accessToken,
    public_urls:  publicUrls(envId, accessToken),
  });
}

async function handleGetEnv(req, res, envId) {
  try {
    const snap = await firestore.collection(COLLECTION).doc(envId).get();
    if (!snap.exists) return sendJson(res, 404, { error: `no env ${envId}` });
    const data = snap.data();
    return sendJson(res, 200, {
      ...data,
      // Convert Firestore Timestamps to ISO strings for readability.
      created_at: data.created_at?.toDate?.().toISOString() || null,
      ready_at:   data.ready_at?.toDate?.().toISOString()   || null,
      expires_at: data.expires_at?.toDate?.().toISOString() || data.expires_at,
      public_urls: publicUrls(envId, data.access_token),
    });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

// --------------------------------------------------------------------------
// HTTP server
// --------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'POST' && req.url === '/environments') {
    return handleCreateEnv(req, res);
  }

  const m = req.method === 'GET' && req.url.match(/^\/environments\/([^/?#]+)$/);
  if (m) {
    return handleGetEnv(req, res, decodeURIComponent(m[1]));
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(`dispatcher: not found ${req.method} ${req.url}\n`);
});

server.listen(PORT, () => {
  console.log(`[dispatcher] listening on :${PORT}`);
  console.log(`[dispatcher] project=${PROJECT_ID} zone=${ZONE} lb_ip_dashed=${LB_IP_DASHED}`);
  console.log(`[dispatcher] task_vm_sa=${TASK_VM_SA_EMAIL} default_image_tag=${DEFAULT_IMAGE_TAG}`);
});
