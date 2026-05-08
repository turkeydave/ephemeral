-- Replicated stream of task history events received from the pubsub-relay
-- (which simulates a GCP Pub/Sub push subscription).

CREATE TABLE IF NOT EXISTS task_history (
  id           SERIAL PRIMARY KEY,
  task_id      TEXT NOT NULL,
  op           TEXT NOT NULL,
  before_data  JSONB,
  after_data   JSONB,
  occurred_at  TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_id   TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS task_history_task_id_idx
  ON task_history (task_id);
CREATE INDEX IF NOT EXISTS task_history_received_at_idx
  ON task_history (received_at DESC);
