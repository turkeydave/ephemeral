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
    const headers = { 'content-type': 'text/plain' };
    addCorsHeaders(req, headers);
    res.writeHead(502, headers);
  }
  res.end(`preview-gateway: upstream error: ${err.message}\n`);
});

// ----- CORS for cross-origin XHR between sister hostnames -----------------
// The static `app` calls the Express `api` and the Firestore emulator on
// sister hostnames (`<env>-api.<lb>.nip.io`, `<env>-firestore.<lb>.nip.io`).
// These are different *origins* than `<env>-app.<lb>.nip.io`, so the
// browser does CORS preflight + requires `Access-Control-Allow-Origin`
// (echoed, not `*`) and `Access-Control-Allow-Credentials: true` on the
// response — both because the app sends `credentials:'include'` to ride
// the `ephem_token_<env>` cookie cross-subdomain.
//
// We restrict the echo to origins whose env_id matches the request's
// env_id and whose suffix matches (i.e. only the env's own
// app/api/firestore subdomains can talk to each other).
//
// Strip whatever the API may have set (the api uses `cors()` which
// returns `*`; that's invalid with credentials, so we override).
function isSisterOrigin(origin, host) {
  if (!origin || !host) return false;
  let originHost;
  try { originHost = new URL(origin).host.split(':')[0]; }
  catch { return false; }
  const hostBare = host.split(':')[0];
  const originEnv = parseEnvId(originHost);
  const hostEnv   = parseEnvId(hostBare);
  if (!originEnv || originEnv !== hostEnv) return false;
  // Same parent suffix (everything after the first dot) — both must end
  // up at the same `<lb-ip>.nip.io` parent.
  const oSuffix = originHost.slice(originHost.indexOf('.'));
  const hSuffix = hostBare.slice(hostBare.indexOf('.'));
  return oSuffix === hSuffix;
}

function addCorsHeaders(req, headers) {
  const origin = req.headers.origin;
  const host   = req.headers.host;
  if (!isSisterOrigin(origin, host)) return;
  headers['access-control-allow-origin']      = origin;
  headers['access-control-allow-credentials'] = 'true';
  headers['vary']                             = 'Origin';
}

proxy.on('proxyRes', (proxyRes, req) => {
  const origin = req.headers.origin;
  const host   = req.headers.host;
  if (!isSisterOrigin(origin, host)) return;
  // Override upstream CORS — API uses cors() which returns `*`; not
  // valid with credentials.
  delete proxyRes.headers['access-control-allow-origin'];
  delete proxyRes.headers['access-control-allow-credentials'];
  proxyRes.headers['access-control-allow-origin']      = origin;
  proxyRes.headers['access-control-allow-credentials'] = 'true';
  proxyRes.headers['vary']                             = 'Origin';
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
// Resolve env_id -> { target, why, expectedToken } or { error: { code, ... } }
// `expectedToken` is null when the env doesn't require token auth (the
// smoketest fallback path, or a legacy doc without access_token set).
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
        expectedToken: doc.access_token || null,
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

  // Smoketest fallback for backwards compat with M2. Token-free.
  if (envId === 'smoketest' && VM_IP) {
    return {
      target: `http://${VM_IP}:${VM_PORT}`,
      why: `smoketest fallback to VM_IP env=${VM_IP}`,
      expectedToken: null,
    };
  }

  return { error: { code: 404, message: `no environment registered for env_id=${envId}` } };
}

// --------------------------------------------------------------------------
// Token enforcement
// --------------------------------------------------------------------------
// Browsers can land on the URL with `?token=...` exactly once; we set a
// host-scoped cookie on first acceptance and immediately redirect to the
// same URL minus the query so the token doesn't leak into history,
// referrers, or downstream logs. Subsequent navigation + XHR / Firestore
// long-poll requests carry the cookie automatically across the
// `<env_id>-app|api|firestore.<lb-ip>.nip.io` sister hostnames because
// we set the cookie domain to the parent (`.<lb-ip>.nip.io`).
//
// The cookie name embeds env_id so cookies for different envs don't
// collide (browser sends them all; we only check the matching one).
const COOKIE_PREFIX = 'ephem_token_';

function parseCookieToken(req, envId) {
  const raw = req.headers.cookie || '';
  if (!raw) return null;
  const wanted = COOKIE_PREFIX + envId;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === wanted) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function parseQueryToken(req) {
  const idx = req.url.indexOf('?');
  if (idx < 0) return { token: null, urlWithoutToken: req.url };
  const path = req.url.slice(0, idx);
  const params = new URLSearchParams(req.url.slice(idx + 1));
  const token = params.get('token');
  if (token === null) return { token: null, urlWithoutToken: req.url };
  params.delete('token');
  const remaining = params.toString();
  const urlWithoutToken = remaining ? `${path}?${remaining}` : path;
  return { token, urlWithoutToken };
}

function cookieDomainFromHost(host) {
  // host is like `e-abc-app.34-120-91-102.nip.io` (port already stripped
  // by the time we use this). We want the parent shared by all sister
  // subdomains: `.34-120-91-102.nip.io`. Strip the leading `<env>-<svc>`
  // segment.
  const dot = host.indexOf('.');
  if (dot < 0) return null;
  return host.slice(dot); // includes leading "."
}

// Returns:
//   { ok: true }                                 token matched (cookie path)
//   { ok: true, redirect: { location, cookie } } token matched via query;
//                                                caller should 302 + Set-Cookie
//   { ok: false, code, message }                 reject
function checkToken(req, host, envId, expectedToken) {
  // No token configured -> open access (smoketest fallback / legacy doc).
  if (!expectedToken) return { ok: true };

  // Cookie wins (cheap, never strips it from URL).
  const cookieToken = parseCookieToken(req, envId);
  if (cookieToken && cookieToken === expectedToken) return { ok: true };

  // Otherwise look for ?token=... in the query string.
  const { token: queryToken, urlWithoutToken } = parseQueryToken(req);
  if (queryToken && queryToken === expectedToken) {
    const domain = cookieDomainFromHost(host.split(':')[0]);
    // 1 day max-age — environments are short-lived; the cleanup worker
    // reaps them inside the TTL anyway.
    const cookieParts = [
      `${COOKIE_PREFIX}${envId}=${encodeURIComponent(expectedToken)}`,
      'Path=/',
      'Max-Age=86400',
      'SameSite=Lax',
      'HttpOnly',
    ];
    if (domain) cookieParts.push(`Domain=${domain}`);
    return {
      ok: true,
      redirect: {
        location: urlWithoutToken,
        cookie:   cookieParts.join('; '),
      },
    };
  }

  if (queryToken || cookieToken) {
    return { ok: false, code: 403, message: `invalid preview token for env ${envId}` };
  }
  return { ok: false, code: 401, message: `preview token required for env ${envId} (use the URL returned by the dispatcher)` };
}

// --------------------------------------------------------------------------
// HTTP server
// --------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';

  // CORS preflight: respond directly. We don't even need to resolve the
  // env — the sister-origin check below covers that. Browsers send these
  // for any non-simple cross-origin request (custom headers, JSON body,
  // etc.). Simple GETs without custom headers won't preflight.
  if (req.method === 'OPTIONS' && req.headers.origin) {
    const headers = {
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers']
        || 'Content-Type, Authorization',
      'access-control-max-age': '600',
      'content-length': '0',
    };
    addCorsHeaders(req, headers);
    res.writeHead(204, headers);
    return res.end();
  }

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
    const headers = { 'content-type': 'text/plain' };
    addCorsHeaders(req, headers);
    res.writeHead(400, headers);
    return res.end(`preview-gateway: cannot parse env_id from Host=${host}\n`);
  }

  let result;
  try {
    result = await resolveTarget(envId);
  } catch (e) {
    const headers = { 'content-type': 'text/plain' };
    addCorsHeaders(req, headers);
    res.writeHead(500, headers);
    return res.end(`preview-gateway: resolution error: ${e.message}\n`);
  }

  if (result.error) {
    const headers = { 'content-type': 'text/plain' };
    if (result.error.retryAfter) headers['retry-after'] = String(result.error.retryAfter);
    addCorsHeaders(req, headers);
    res.writeHead(result.error.code, headers);
    return res.end(`preview-gateway: ${result.error.message}\n`);
  }

  // M4: token check.
  const auth = checkToken(req, host, envId, result.expectedToken);
  if (!auth.ok) {
    const headers = { 'content-type': 'text/plain' };
    addCorsHeaders(req, headers);
    res.writeHead(auth.code, headers);
    return res.end(`preview-gateway: ${auth.message}\n`);
  }
  if (auth.redirect) {
    const headers = {
      'location':      auth.redirect.location,
      'set-cookie':    auth.redirect.cookie,
      'cache-control': 'no-store',
    };
    addCorsHeaders(req, headers);
    res.writeHead(302, headers);
    return res.end();
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
  const host = req.headers.host || '';
  const envId = parseEnvId(host);
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
    // For websocket upgrades we only honor the cookie path (no
    // ?token=...+302 dance — there's no useful response to negotiate).
    if (result.expectedToken) {
      const cookieToken = parseCookieToken(req, envId);
      if (cookieToken !== result.expectedToken) {
        socket.destroy();
        return;
      }
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
