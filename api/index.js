const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3001', 10);

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'ephemeral',
  password: process.env.PGPASSWORD || 'ephemeral',
  database: process.env.PGDATABASE || 'ephemeral',
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

app.get('/products', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, description, price, created_at FROM products ORDER BY id ASC'
    );
    res.json({ products: rows });
  } catch (err) {
    console.error('GET /products failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Replicated task history (populated by the pubsub-relay).
app.get('/history', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, task_id, op, before_data, after_data, occurred_at, received_at, message_id
         FROM task_history
         ORDER BY received_at DESC
         LIMIT 100`
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('GET /history failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Pub/Sub push endpoint. The body shape mirrors GCP push delivery:
//   { message: { data: <base64>, attributes, messageId, publishTime }, subscription }
// We decode `data` (a JSON-encoded task history event) and upsert to postgres.
app.post('/events/task-history', async (req, res) => {
  const msg = req.body && req.body.message;
  if (!msg || typeof msg.data !== 'string') {
    return res.status(400).json({ error: 'expected pubsub push envelope with message.data' });
  }

  let event;
  try {
    event = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'message.data is not valid base64 JSON: ' + err.message });
  }

  try {
    await pool.query(
      `INSERT INTO task_history
         (task_id, op, before_data, after_data, occurred_at, message_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id) DO NOTHING`,
      [
        event.taskId || msg.attributes?.taskId || null,
        event.op || msg.attributes?.op || null,
        event.before || null,
        event.after || null,
        event.occurredAt || msg.publishTime || null,
        msg.messageId || null,
      ]
    );
    // ACK by 2xx (Pub/Sub will redeliver on non-2xx).
    res.status(204).end();
  } catch (err) {
    console.error('POST /events/task-history failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`api: listening on :${PORT}`);
});
