// Preview gateway — Milestone 3.
//
// Receives every preview request from the global HTTP load balancer and
// reverse-proxies it to the per-environment task VM's edge proxy at
// http://<vm_internal_ip>:8080, preserving the Host header so the VM-side
// Caddy can route by `<env_id>-app` / `<env_id>-api` / `<env_id>-firestore`
// patterns.
//
// Resolution strategy:
//
//   1. Parse `<env_id>-(app|api|firestore).<rest>` out of the Host header.
//   2. Look up `agent_environments/<env_id>` in Firestore (default DB).
//      Cached for FIRESTORE_CACHE_MS (default 5s) per env_id.
//   3. If doc.status === "ready" -> proxy to doc.vm_internal_ip:8080.
//      If doc.status === "launching" -> 503 + Retry-After.
//      If doc.status === "expired" / "deleted" -> 410.
//      If doc missing -> see fallback below.
//
// Fallback (M2 compatibility): if VM_IP env is set AND the env_id is
// exactly `smoketest`, proxy to VM_IP:VM_PORT regardless of Firestore.
// This keeps the original M1/M2 hand-launched VM reachable at
// `smoketest-app.<lb>.nip.io` while M3 lights up. Drop the fallback once
// the dispatcher path is proven.
//
// Routes:
//   GET /healthz           -> 200 ok                 (LB readiness check)
//   GET /__gateway/info    -> JSON: config + (if Host present) resolved target
//   *                      -> reverse proxied to the resolved VM
//
// Required env (in Cloud Run via terraform):
//   GOOGLE_CLOUD_PROJECT   automatically set by Cloud Run
// Optional env:
//   VM_IP                  M2 fallback IP for env_id == "smoketest"
//   VM_PORT                default 8080
//   PORT                   Cloud Run injects; default 8080 locally
//   FIRESTORE_CACHE_MS     per-env_id cache TTL, default 5000

const http = require('http');
const httpProxy = require('http-proxy');
const { Firestore } = require('@google-cloud/firestore');

const VM_IP = process.env.VM_IP || '';
const VM_PORT = parseInt(process.env.VM_PORT || '8080', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);
const CACHE_MS = parseInt(process.env.FIRESTORE_CACHE_MS || '5000', 10);
const COLLECTION = 'agent_environments';

const firestore = new Firestore();

const proxy = httpProxy.createProxyServer({
  // Don't change Host header — VM Caddy needs the original
  // `<env_id>-<svc>.<rest>` to route correctly.
  changeOrigin: false,
  proxyTimeout: 30_000,
  timeout: 30_000,
});

proxy.on('error', (err, req, res) => {
  console.error(`[preview-gateway] proxy error host=${req.headers.host} path=${req.url}: ${err.message}`);
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' });
  }
  res.end(`preview-gateway: upstream error: ${err.message}\n`);
});

// --------------------------------------------------------------------------
// env_id parsing
// --------------------------------------------------------------------------
// Host pattern: <env_id>-<svc>.<rest>[:port]
//   svc must be one of app | api | firestore (these are the three
//   sub-hostnames the VM-side Caddy routes — see edge-proxy/Caddyfile).
//   env_id is everything before the FIRST `-app`, `-api`, or `-firestore`.
const HOST_RE = /^([a-z0-9-]+?)-(?:app|api|firestore)\./i;

function parseEnvId(host) {
  if (!host) return null;
  // strip :port if present
  const bare = host.split(':')[0];
  const m = bare.match(HOST_RE);
  return m ? m[1].toLowerCase() : null;
}

// --------------------------------------------------------------------------
// Firestore lookup with per-env_id TTL cache
// --------------------------------------------------------------------------
const cache = new Map(); // env_id -> { expires, doc | null }

async function lookupEnv(envId) {
  const now = Date.now();
  const hit = cache.get(envId);
  if (hit && hit.expires > now) return hit.doc;

  let doc = null;
  try {
    const snap = await firestore.collection(COLLECTION).doc(envId).get();
    doc = snap.exists ? snap.data() : null;
  } catch (e) {
    console.error(`[preview-gateway] firestore lookup error env_id=${envId}: ${e.message}`);
    // Don't cache the error — let the next request retry.
    throw e;
  }

  cache.set(envId, { expires: now + CACHE_MS, doc });
  return doc;
}

// --------------------------------------------------------------------------
// Resolve env_id -> { target, why } or { error: { code, message } }
// --------------------------------------------------------------------------
async function resolveTarget(envId) {
  // Firestore wins when present.
  let doc = null;
  try {
    doc = await lookupEnv(envId);
  } catch (e) {
    return { error: { code: 502, message: `registry lookup failed: ${e.message}` } };
  }

  if (doc) {
    const status = doc.status;
    if (status === 'ready' && doc.vm_internal_ip) {
      return {
        target: `http://${doc.vm_internal_ip}:${VM_PORT}`,
        why: `firestore: status=ready vm=${doc.vm_internal_ip}`,
      };
    }
    if (status === 'launching') {
      return { error: { code: 503, message: `env ${envId} is still launching`, retryAfter: 5 } };
    }
    if (status === 'expired' || status === 'deleted') {
      return { error: { code: 410, message: `env ${envId} is ${status}` } };
    }
    return { error: { code: 502, message: `env ${envId} doc has unexpected status: ${status}` } };
  }

  // Smoketest fallback for backwards compat with M2.
  if (envId === 'smoketest' && VM_IP) {
    return {
      target: `http://${VM_IP}:${VM_PORT}`,
      why: `smoketest fallback to VM_IP env=${VM_IP}`,
    };
  }

  return { error: { code: 404, message: `no environment registered for env_id=${envId}` } };
}

// --------------------------------------------------------------------------
// HTTP server
// --------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';

  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (req.url === '/__gateway/info') {
    const envId = parseEnvId(host);
    let resolved = null;
    if (envId) {
      try {
        resolved = await resolveTarget(envId);
      } catch (e) {
        resolved = { error: { code: 500, message: e.message } };
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      received_host: host,
      parsed_env_id: envId,
      resolved,
      smoketest_fallback_vm_ip: VM_IP || null,
      vm_port: VM_PORT,
      cache_ms: CACHE_MS,
      collection: COLLECTION,
    }, null, 2));
  }

  const envId = parseEnvId(host);
  if (!envId) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end(`preview-gateway: cannot parse env_id from Host=${host}\n`);
  }

  let result;
  try {
    result = await resolveTarget(envId);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return res.end(`preview-gateway: resolution error: ${e.message}\n`);
  }

  if (result.error) {
    const headers = { 'content-type': 'text/plain' };
    if (result.error.retryAfter) headers['retry-after'] = String(result.error.retryAfter);
    res.writeHead(result.error.code, headers);
    return res.end(`preview-gateway: ${result.error.message}\n`);
  }

  console.log(`[preview-gateway] ${req.method} ${host}${req.url} env=${envId} -> ${result.target} (${result.why})`);
  proxy.web(req, res, { target: result.target });
});

// --------------------------------------------------------------------------
// WebSocket upgrade (Firestore long-poll uses standard HTTP, not WS, but
// this is cheap and future-proofs for any websocket use case in the
// stack — the Caddy edge proxy already streams long-polls fine).
// --------------------------------------------------------------------------
server.on('upgrade', async (req, socket, head) => {
  const envId = parseEnvId(req.headers.host || '');
  if (!envId) {
    socket.destroy();
    return;
  }
  try {
    const result = await resolveTarget(envId);
    if (result.error || !result.target) {
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head, { target: result.target });
  } catch (e) {
    console.error(`[preview-gateway] upgrade error env=${envId}: ${e.message}`);
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[preview-gateway] listening on :${PORT}`);
  console.log(`[preview-gateway] firestore collection=${COLLECTION} cache_ms=${CACHE_MS}`);
  if (VM_IP) {
    console.log(`[preview-gateway] smoketest fallback enabled: env_id=smoketest -> ${VM_IP}:${VM_PORT}`);
  }
});
