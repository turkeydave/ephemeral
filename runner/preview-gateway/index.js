// Preview gateway — Milestone 2.
//
// Receives every preview request from the global HTTPS load balancer and
// reverse-proxies it to the current task VM's edge proxy at
// http://<VM_IP>:8080, preserving the Host header so the VM-side Caddy
// can route by `<env>-app` / `<env>-api` / `<env>-firestore` patterns.
//
// In M2 the VM IP is hardcoded as an env var (VM_IP). M3 will swap that
// for a Firestore lookup keyed by the env_id parsed from the Host header.
//
// Routes:
//   GET /healthz           -> 200 ok                 (LB readiness check)
//   GET /__gateway/info    -> JSON: configured VM_IP (debug)
//   *                      -> reverse proxied to VM
//
// Required env:
//   VM_IP        IPv4 of the M1 VM (internal IP via VPC egress)
// Optional env:
//   VM_PORT      default 8080
//   PORT         Cloud Run injects this; default 8080 locally

const http = require('http');
const httpProxy = require('http-proxy');

const VM_IP = process.env.VM_IP || '';
const VM_PORT = parseInt(process.env.VM_PORT || '8080', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);

if (!VM_IP) {
  console.warn('[preview-gateway] WARN: VM_IP env var is empty. All proxied requests will return 502.');
}

const target = VM_IP ? `http://${VM_IP}:${VM_PORT}` : null;

const proxy = httpProxy.createProxyServer({
  // Don't change Host header — VM Caddy needs `<env>-<svc>.<rest>` to
  // route correctly.
  changeOrigin: false,
  // 30s upstream timeout matches our LB default.
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

const server = http.createServer((req, res) => {
  const host = req.headers.host || '';

  // Local readiness probe.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // Tiny debug endpoint (handy for verifying the env var is plumbed).
  if (req.url === '/__gateway/info') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      vm_ip: VM_IP || null,
      vm_port: VM_PORT,
      received_host: host,
    }));
  }

  if (!target) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    return res.end('preview-gateway: VM_IP not configured\n');
  }

  console.log(`[preview-gateway] ${req.method} ${host}${req.url} -> ${target}`);
  proxy.web(req, res, { target });
});

server.listen(PORT, () => {
  console.log(`[preview-gateway] listening on :${PORT}, forwarding to ${target || '(unconfigured)'}`);
});
