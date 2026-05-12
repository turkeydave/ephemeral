import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  query,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  addDoc,
  updateDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// TODO: Replace with your Firebase config
const firebaseConfig = {
  apiKey: "[REDACTED:google-api-key]",
  authDomain: "project-4b04c9cf-520a-4693-86a.firebaseapp.com",
  projectId: "project-4b04c9cf-520a-4693-86a",
  storageBucket: "project-4b04c9cf-520a-4693-86a.firebasestorage.app",
  messagingSenderId: "80449270535",
  appId: "1:80449270535:web:dd9d285dada9895f3f0ba2"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Decide where the Firestore emulator lives. The whole point of this POC
// is that every ephemeral environment runs its own emulator — never real
// Firestore — so we wire connectFirestoreEmulator in two cases:
//
//   1. Local dev:  hostname is localhost / 127.0.0.1
//                  -> emulator at localhost:8080
//
//   2. Cloud preview: hostname matches `<env>-app.<rest>` (the URL the
//      preview gateway / nip.io serves the app from). The same VM exposes
//      the firestore emulator through its edge proxy on a sister
//      hostname `<env>-firestore.<rest>` on the same port.
//                  -> emulator at <env>-firestore.<rest>:<same port>
//
// If neither pattern matches we leave the SDK pointing at real Firestore
// (which the POC never wants) and surface that loudly in the console.
function resolveEmulatorTarget() {
  const host = window.location.hostname;

  if (host === 'localhost' || host === '127.0.0.1') {
    return { host: 'localhost', port: 8080 };
  }

  const m = host.match(/^([^.]+)-(?:app|api|firestore)\.(.+)$/);
  if (m) {
    // Use whatever ingress served us. In M1 the browser hit the VM
    // directly on :8080 (window.location.port === '8080'); in M2+ the
    // global HTTP LB serves on :80 and window.location.port is empty,
    // so we must NOT fall back to 8080 — that would bypass the LB and
    // hit the VM's now-firewalled :8080 directly.
    const port = window.location.port
      ? parseInt(window.location.port, 10)
      : (window.location.protocol === 'https:' ? 443 : 80);
    return { host: `${m[1]}-firestore.${m[2]}`, port };
  }

  return null;
}

const emuTarget = resolveEmulatorTarget();
if (emuTarget) {
  try {
    connectFirestoreEmulator(db, emuTarget.host, emuTarget.port);
    console.info(`Firestore emulator connected at ${emuTarget.host}:${emuTarget.port}`);
  } catch (e) {
    console.warn('Could not connect to Firestore emulator:', e && e.message ? e.message : e);
  }
} else {
  console.error(
    `Could not derive a Firestore emulator host from "${window.location.hostname}". ` +
    `This POC never uses real Firestore — expected hostname pattern <env>-app.<rest>.`
  );
}

// ----- API base (Express + Postgres service) -----
// Local dev: api is on http://localhost:3001 (compose host port).
// Cloud preview: api is reached through the edge proxy on the sister
// hostname <env>-api.<rest> on the same port the app was served from.
const API_BASE = (() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  const m = host.match(/^([^.]+)-(?:app|api|firestore)\.(.+)$/);
  if (m) {
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${window.location.protocol}//${m[1]}-api.${m[2]}${port}`;
  }
  // Last-resort fallback: same origin (won't actually work, but at least
  // the error in DevTools will be obvious).
  return window.location.origin;
})();
console.info(`api base: ${API_BASE}`);

// ----- DOM -----
const tasksEl = document.getElementById('tasks');
const historyEl = document.getElementById('history');
const form = document.getElementById('task-form');
const submitBtn = document.getElementById('submit-btn');
const cancelBtn = document.getElementById('cancel-btn');
const editingBanner = document.getElementById('editing-banner');
const viewProductsBtn = document.getElementById('view-products-btn');
const productsDialog = document.getElementById('products-dialog');
const productsEl = document.getElementById('products');
const viewPgHistoryBtn = document.getElementById('view-pg-history-btn');
const pgHistoryDialog = document.getElementById('pg-history-dialog');
const pgHistoryEl = document.getElementById('pg-history');

let editingId = null;

// ----- Tasks list (one-shot, refreshed after add/edit) -----
async function loadTasks() {
  tasksEl.textContent = 'Loading…';
  const q = query(collection(db, 'tasks'), orderBy('updatedAt', 'desc'), limit(50));
  const snap = await getDocs(q);
  if (snap.empty) {
    tasksEl.textContent = 'No tasks found.';
    return;
  }
  tasksEl.innerHTML = '';
  snap.forEach(d => tasksEl.appendChild(renderTaskRow(d.id, d.data())));
}

function renderTaskRow(id, data) {
  const row = document.createElement('div');
  row.className = 'task';
  row.innerHTML = `
    <strong>${escapeHtml(data.title || '(untitled)')}</strong>
    <span class="pill">${escapeHtml(data.status || '')}</span>
    <span class="pill">${escapeHtml(data.priority || '')}</span>
    <span class="muted">${escapeHtml(id)}</span>
  `;
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => beginEdit(id, data));
  row.appendChild(editBtn);
  return row;
}

// ----- Add / Edit -----
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const payload = {
    title: (fd.get('title') || '').toString().trim(),
    status: fd.get('status'),
    priority: fd.get('priority'),
    updatedAt: serverTimestamp()
  };
  if (!payload.title) return;

  try {
    submitBtn.disabled = true;
    if (editingId) {
      await updateDoc(doc(db, 'tasks', editingId), payload);
    } else {
      payload.createdAt = serverTimestamp();
      await addDoc(collection(db, 'tasks'), payload);
    }
    resetForm();
    await loadTasks();
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', resetForm);

function beginEdit(id, data) {
  editingId = id;
  form.title.value = data.title || '';
  form.status.value = data.status || 'open';
  form.priority.value = data.priority || 'medium';
  submitBtn.textContent = 'Save Task';
  cancelBtn.hidden = false;
  editingBanner.hidden = false;
  editingBanner.textContent = `editing ${id}`;
  form.title.focus();
}

function resetForm() {
  editingId = null;
  form.reset();
  submitBtn.textContent = 'Add Task';
  cancelBtn.hidden = true;
  editingBanner.hidden = true;
  editingBanner.textContent = '';
}

// ----- Task History (live) -----
function subscribeHistory() {
  const q = query(collection(db, 'taskHistory'), orderBy('updatedAt', 'desc'), limit(50));
  onSnapshot(q, (snap) => {
    if (snap.empty) {
      historyEl.textContent = 'No history yet.';
      return;
    }
    historyEl.innerHTML = '';
    snap.forEach(d => historyEl.appendChild(renderHistoryEntry(d.id, d.data())));
  }, (err) => {
    historyEl.textContent = 'History subscription error: ' + err.message;
  });
}

function renderHistoryEntry(id, data) {
  const row = document.createElement('div');
  row.className = 'entry';
  const ts = data.updatedAt && data.updatedAt.toDate
    ? data.updatedAt.toDate().toISOString().replace('T', ' ').slice(0, 19)
    : '—';
  const diffs = computeDiffs(data.before || {}, data.after || {});
  row.innerHTML = `
    <span class="muted">${escapeHtml(ts)}</span>
    <span class="pill">${escapeHtml(data.op || 'update')}</span>
    <strong>${escapeHtml(data.taskId || '')}</strong>
    <span class="diff">${diffs.length ? diffs.map(escapeHtml).join(' · ') : '(no field changes)'}</span>
  `;
  return row;
}

function computeDiffs(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const k of keys) {
    const a = format(before[k]);
    const b = format(after[k]);
    if (a !== b) out.push(`${k}: ${a} → ${b}`);
  }
  return out;
}

function format(v) {
  if (v == null) return '∅';
  if (typeof v === 'object' && v.toDate) return v.toDate().toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----- Products (loaded from Express API on demand) -----
async function loadProducts() {
  productsEl.textContent = 'Loading…';
  try {
    // credentials: 'include' so the ephem_token_<env> cookie set by the
    // preview-gateway on the app origin travels to the api sister origin.
    // <env>-app and <env>-api are same-site (same eTLD+1 = <ip>.nip.io)
    // so SameSite=Lax permits this; the cookie's Domain=. parent covers
    // both subdomains.
    const res = await fetch(`${API_BASE}/products`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { products } = await res.json();
    if (!products || !products.length) {
      productsEl.textContent = 'No products.';
      return;
    }
    productsEl.innerHTML = '';
    for (const p of products) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px 0; border-bottom:1px solid #eee;';
      row.innerHTML = `
        <div><strong>${escapeHtml(p.name)}</strong>
          <span class="pill">$${escapeHtml(p.price)}</span></div>
        <div class="muted">${escapeHtml(p.description || '')}</div>
      `;
      productsEl.appendChild(row);
    }
  } catch (err) {
    productsEl.textContent = 'Failed to load products: ' + err.message;
  }
}

viewProductsBtn.addEventListener('click', () => {
  productsDialog.showModal();
  loadProducts();
});

// ----- Postgres-replicated task history (loaded from API on demand) -----
async function loadPgHistory() {
  pgHistoryEl.textContent = 'Loading…';
  try {
    const res = await fetch(`${API_BASE}/history`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { history } = await res.json();
    if (!history || !history.length) {
      pgHistoryEl.textContent = 'No replicated history rows yet.';
      return;
    }
    pgHistoryEl.innerHTML = '';
    for (const h of history) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:6px 0; border-bottom:1px solid #eee;';
      const occurred = h.occurred_at ? new Date(h.occurred_at).toISOString().replace('T', ' ').slice(0, 19) : '—';
      const diffs = computeDiffs(h.before_data || {}, h.after_data || {});
      row.innerHTML = `
        <div>
          <span class="muted">${escapeHtml(occurred)}</span>
          <span class="pill">${escapeHtml(h.op || '')}</span>
          <strong>${escapeHtml(h.task_id || '')}</strong>
          <span class="muted">#${h.id}</span>
        </div>
        <div class="diff">${diffs.length ? diffs.map(escapeHtml).join(' · ') : '(no field changes)'}</div>
      `;
      pgHistoryEl.appendChild(row);
    }
  } catch (err) {
    pgHistoryEl.textContent = 'Failed to load Postgres history: ' + err.message;
  }
}

viewPgHistoryBtn.addEventListener('click', () => {
  pgHistoryDialog.showModal();
  loadPgHistory();
});

// ----- boot -----
loadTasks().catch(err => { tasksEl.textContent = 'Error loading tasks: ' + err.message; });
subscribeHistory();
