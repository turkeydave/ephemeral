// Cleanup worker — Milestone 4.
//
// Cloud Scheduler invokes POST /run every 5 minutes. We scan
// agent_environments for any doc with expires_at <= now whose status is
// not already "deleted", delete the corresponding Compute Engine VM
// (best-effort — 404 means it was already gone), and mark the doc
// status="deleted" with deleted_at stamped.
//
// Routes:
//   GET  /healthz   -> 200 ok                  (Cloud Run startup probe)
//   POST /run       -> JSON summary           (Scheduler target)
//
// Required env (set by terraform):
//   GOOGLE_CLOUD_PROJECT     auto-set by Cloud Run if not provided here;
//                            we set explicitly to be safe (same as the
//                            dispatcher — Cloud Run does not auto-populate)
// Optional env:
//   ZONE                     default us-central1-a
//   PORT                     default 8080
//   MAX_DELETIONS_PER_RUN    default 50 (safety cap; if we ever exceed,
//                            log+stop and let the next cron pick up the rest)

const http = require('node:http');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { InstancesClient } = require('@google-cloud/compute');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT
  || process.env.PROJECT_ID
  || '';
const ZONE = process.env.ZONE || 'us-central1-a';
const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_DELETIONS = parseInt(process.env.MAX_DELETIONS_PER_RUN || '50', 10);
const COLLECTION = 'agent_environments';

if (!PROJECT_ID) {
  console.error('[cleanup] FATAL: GOOGLE_CLOUD_PROJECT env var is required');
  process.exit(1);
}

const firestore = new Firestore();
const compute = new InstancesClient();

// --------------------------------------------------------------------------
// Single sweep
// --------------------------------------------------------------------------
async function sweepOnce() {
  const startedAt = new Date();
  const now = startedAt;
  const summary = {
    started_at: now.toISOString(),
    scanned: 0,
    skipped: 0,
    deleted: 0,
    failed: 0,
    items: [],
  };

  // expires_at <= now picks up everything that has run past its TTL.
  // We don't combine with a status filter to avoid needing a composite
  // index — we filter in JS instead.
  const snap = await firestore.collection(COLLECTION)
    .where('expires_at', '<=', now)
    .limit(MAX_DELETIONS)
    .get();

  for (const docSnap of snap.docs) {
    summary.scanned += 1;
    const data = docSnap.data();
    const envId = data.env_id || docSnap.id;
    const status = data.status;
    const vmName = data.vm_name;
    const vmZone = data.vm_zone || ZONE;

    if (status === 'deleted') {
      summary.skipped += 1;
      continue;
    }

    let deleteResult = 'no-vm';
    if (vmName) {
      try {
        await compute.delete({ project: PROJECT_ID, zone: vmZone, instance: vmName });
        deleteResult = 'deleted';
      } catch (e) {
        // Treat "not found" as success — the VM was already gone (deleted
        // out of band, never created, or finished a previous attempt).
        if (e.code === 5 || /not\s*found|no\s*such/i.test(e.message)) {
          deleteResult = 'already-gone';
        } else {
          deleteResult = `error: ${e.message}`;
          summary.failed += 1;
          summary.items.push({ env_id: envId, vm_name: vmName, result: deleteResult });
          // Don't update doc — leave it for the next sweep.
          continue;
        }
      }
    }

    try {
      await docSnap.ref.update({
        status:     'deleted',
        deleted_at: FieldValue.serverTimestamp(),
        delete_result: deleteResult,
      });
      summary.deleted += 1;
      summary.items.push({ env_id: envId, vm_name: vmName, result: deleteResult });
      console.log(`[cleanup] env=${envId} vm=${vmName} -> ${deleteResult}`);
    } catch (e) {
      summary.failed += 1;
      summary.items.push({ env_id: envId, vm_name: vmName, result: `doc-update-failed: ${e.message}` });
    }
  }

  summary.duration_ms = Date.now() - startedAt.getTime();
  return summary;
}

// --------------------------------------------------------------------------
// HTTP server
// --------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'POST' && req.url === '/run') {
    try {
      const summary = await sweepOnce();
      console.log(`[cleanup] sweep done: scanned=${summary.scanned} deleted=${summary.deleted} failed=${summary.failed} skipped=${summary.skipped} (${summary.duration_ms}ms)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(summary, null, 2));
    } catch (e) {
      console.error(`[cleanup] sweep error: ${e.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Convenience: GET /run for manual debugging.
  if (req.method === 'GET' && req.url === '/run') {
    try {
      const summary = await sweepOnce();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(summary, null, 2));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(`cleanup: not found ${req.method} ${req.url}\n`);
});

server.listen(PORT, () => {
  console.log(`[cleanup] listening on :${PORT}`);
  console.log(`[cleanup] project=${PROJECT_ID} zone=${ZONE} max_per_run=${MAX_DELETIONS}`);
});
