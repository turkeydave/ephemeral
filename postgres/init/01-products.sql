-- Schema + seed for the products POC.
-- Runs once, the first time the postgres data volume is initialized.

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  price       NUMERIC(10, 2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO products (name, description, price) VALUES
  ('Ephemeral Env Starter',  'Spin up a disposable GCP environment in seconds', 19.99),
  ('Agentic Runner',         'On-demand agent worker pool',                     49.00),
  ('Firestore Replay',       'Capture & replay Firestore traffic for tests',    29.50),
  ('Trigger Inspector',      'Visualize Cloud Functions trigger graphs',         9.99),
  ('Postgres Snapshot Kit',  'Branch & restore Postgres in CI',                 39.00);
