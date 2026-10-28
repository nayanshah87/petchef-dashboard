const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'petchef.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

// Only order-level money + a customer ID are stored. No names, phones, emails
// or addresses ever touch this database.
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  name               TEXT,
  created_at         TEXT NOT NULL,
  processed_at       TEXT,
  updated_at         TEXT NOT NULL,
  cancelled_at       TEXT,
  test               INTEGER NOT NULL DEFAULT 0,
  financial_status   TEXT,
  fulfillment_status TEXT,
  currency           TEXT,
  gross_total        REAL NOT NULL DEFAULT 0,
  net_total          REAL NOT NULL DEFAULT 0,
  subtotal           REAL NOT NULL DEFAULT 0,
  discounts          REAL NOT NULL DEFAULT 0,
  tax                REAL NOT NULL DEFAULT 0,
  shipping           REAL NOT NULL DEFAULT 0,
  refunded           REAL NOT NULL DEFAULT 0,
  is_cod             INTEGER NOT NULL DEFAULT 0,
  gateways           TEXT,
  source_name        TEXT,
  customer_id        TEXT,
  tags               TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL,
  orders_upserted INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

const getKV = (k) => db.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null;
const setKV = (k, v) =>
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);

const upsertStmt = db.prepare(`
INSERT INTO orders (id, name, created_at, processed_at, updated_at, cancelled_at, test,
  financial_status, fulfillment_status, currency, gross_total, net_total, subtotal, discounts,
  tax, shipping, refunded, is_cod, gateways, source_name, customer_id, tags)
VALUES (@id, @name, @created_at, @processed_at, @updated_at, @cancelled_at, @test,
  @financial_status, @fulfillment_status, @currency, @gross_total, @net_total, @subtotal, @discounts,
  @tax, @shipping, @refunded, @is_cod, @gateways, @source_name, @customer_id, @tags)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name, created_at=excluded.created_at, processed_at=excluded.processed_at,
  updated_at=excluded.updated_at, cancelled_at=excluded.cancelled_at, test=excluded.test,
  financial_status=excluded.financial_status, fulfillment_status=excluded.fulfillment_status,
  currency=excluded.currency, gross_total=excluded.gross_total, net_total=excluded.net_total,
  subtotal=excluded.subtotal, discounts=excluded.discounts, tax=excluded.tax,
  shipping=excluded.shipping, refunded=excluded.refunded, is_cod=excluded.is_cod,
  gateways=excluded.gateways, source_name=excluded.source_name, customer_id=excluded.customer_id,
  tags=excluded.tags
`);

function upsertMany(rows) {
  db.exec('BEGIN');
  try {
    for (const r of rows) upsertStmt.run(r);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

module.exports = { db, getKV, setKV, upsertMany, DATA_DIR };
