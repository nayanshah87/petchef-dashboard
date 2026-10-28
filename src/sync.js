const readline = require('readline');
const { Readable } = require('stream');
const { db, getKV, setKV, upsertMany } = require('./db');
const { gql, sleep } = require('./shopify');

const CURSOR_KEY = 'orders_updated_cursor';
const OVERLAP_MS = 10 * 60 * 1000; // re-read the last 10 min each time; upserts make it harmless
const COD_RE = new RegExp(process.env.COD_GATEWAY_REGEX || 'cod|cash on delivery', 'i');

// Pulled per order. Money comes from shopMoney (INR). customer { id } only - no PII.
const ORDER_FIELDS = `
  id name createdAt processedAt updatedAt cancelledAt test
  displayFinancialStatus displayFulfillmentStatus currencyCode
  paymentGatewayNames sourceName tags
  totalPriceSet { shopMoney { amount } }
  currentTotalPriceSet { shopMoney { amount } }
  currentSubtotalPriceSet { shopMoney { amount } }
  currentTotalDiscountsSet { shopMoney { amount } }
  currentTotalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  customer { id }
`;

const money = (x) => (x?.shopMoney?.amount != null ? parseFloat(x.shopMoney.amount) : 0);

function toRow(n) {
  const gateways = n.paymentGatewayNames || [];
  return {
    id: n.id,
    name: n.name ?? null,
    created_at: n.createdAt,
    processed_at: n.processedAt ?? null,
    updated_at: n.updatedAt,
    cancelled_at: n.cancelledAt ?? null,
    test: n.test ? 1 : 0,
    financial_status: n.displayFinancialStatus ?? null,
    fulfillment_status: n.displayFulfillmentStatus ?? null,
    currency: n.currencyCode ?? null,
    gross_total: money(n.totalPriceSet),
    net_total: money(n.currentTotalPriceSet),
    subtotal: money(n.currentSubtotalPriceSet),
    discounts: money(n.currentTotalDiscountsSet),
    tax: money(n.currentTotalTaxSet),
    shipping: money(n.totalShippingPriceSet),
    refunded: money(n.totalRefundedSet),
    is_cod: gateways.some((g) => COD_RE.test(g)) ? 1 : 0,
    gateways: JSON.stringify(gateways),
    source_name: n.sourceName ?? null,
    customer_id: n.customer?.id ?? null,
    tags: (n.tags || []).join(','),
  };
}

// ---------- Full sync: Shopify bulk operation (no rate-limit pain for ~3.5 yrs of orders)
async function fullSync(onProgress) {
  const bulkQuery = `{ orders { edges { node { ${ORDER_FIELDS} } } } }`;
  const started = await gql(
    `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
    { q: bulkQuery }
  );
  const r = started.bulkOperationRunQuery;
  if (r.userErrors?.length) throw new Error(`Bulk start failed: ${r.userErrors.map((e) => e.message).join('; ')}`);
  const opId = r.bulkOperation.id;

  let op;
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(Number(process.env.BULK_POLL_MS || 4000));
    const d = await gql(
      `query($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } } }`,
      { id: opId }
    );
    op = d.node;
    onProgress?.(`Shopify export ${op.status.toLowerCase()} (${op.objectCount} orders)`);
    if (['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) break;
  }
  if (!op || op.status !== 'COMPLETED') throw new Error(`Bulk export ended as ${op?.status} ${op?.errorCode || ''}`);
  if (!op.url) return 0; // store has no orders

  const res = await fetch(op.url);
  if (!res.ok) throw new Error(`Downloading bulk file failed (${res.status})`);
  const rl = readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  let batch = [];
  let total = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const n = JSON.parse(line);
    if (!n.id?.includes('/Order/')) continue;
    batch.push(toRow(n));
    if (batch.length >= 1000) { total += upsertMany(batch); batch = []; onProgress?.(`Saved ${total} orders`); }
  }
  if (batch.length) total += upsertMany(batch);
  return total;
}

// ---------- Incremental sync: everything created OR changed since the cursor.
// Keyed on updated_at (not created_at) so refunds, cancellations and edits on old orders flow in.
async function incrementalSync(sinceIso, onProgress) {
  const since = new Date(new Date(sinceIso).getTime() - OVERLAP_MS).toISOString();
  const q = `updated_at:>='${since}'`;
  let cursor = null;
  let total = 0;
  let maxUpdated = sinceIso;
  do {
    const d = await gql(
      `query($cursor: String, $q: String) {
         orders(first: 50, after: $cursor, query: $q, sortKey: UPDATED_AT) {
           pageInfo { hasNextPage endCursor }
           nodes { ${ORDER_FIELDS} }
         } }`,
      { cursor, q }
    );
    const rows = d.orders.nodes.map(toRow);
    total += upsertMany(rows);
    for (const r of rows) if (r.updated_at > maxUpdated) maxUpdated = r.updated_at;
    onProgress?.(`Saved ${total} new/changed orders`);
    cursor = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (cursor);
  return { total, maxUpdated };
}

// ---------- Orchestration: one sync at a time, tracked in sync_runs
let current = null; // { runId, kind, progress }

function startSync({ full = false, trigger = 'manual' } = {}) {
  if (current) return { alreadyRunning: true, ...current };
  const cursorBefore = getKV(CURSOR_KEY);
  const kind = full || !cursorBefore ? 'full' : 'incremental';
  const startedAt = new Date().toISOString();
  const runId = db
    .prepare(`INSERT INTO sync_runs (kind, trigger, started_at, status) VALUES (?, ?, ?, 'running')`)
    .run(kind, trigger, startedAt).lastInsertRowid;
  const runIdNum = Number(runId);
  current = { runId: runIdNum, kind, progress: 'Starting…' };
  const onProgress = (p) => { if (current) current.progress = p; };

  (async () => {
    try {
      let count;
      if (kind === 'full') {
        count = await fullSync(onProgress);
        setKV(CURSOR_KEY, startedAt); // bulk snapshot starts here; later changes caught incrementally
      } else {
        const r = await incrementalSync(cursorBefore, onProgress);
        count = r.total;
        setKV(CURSOR_KEY, r.maxUpdated);
      }
      db.prepare(`UPDATE sync_runs SET status='ok', finished_at=?, orders_upserted=? WHERE id=?`)
        .run(new Date().toISOString(), count, runId);
      console.log(`[sync] ${kind} ok: ${count} orders`);
    } catch (e) {
      db.prepare(`UPDATE sync_runs SET status='error', finished_at=?, error=? WHERE id=?`)
        .run(new Date().toISOString(), String(e.message || e).slice(0, 1000), runId);
      console.error(`[sync] ${kind} failed:`, e);
    } finally {
      current = null;
    }
  })();

  return { started: true, runId: runIdNum, kind };
}

function syncStatus() {
  const last = db.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`).get() || null;
  const lastOk = db.prepare(`SELECT * FROM sync_runs WHERE status='ok' ORDER BY id DESC LIMIT 1`).get() || null;
  const orderCount = db.prepare(`SELECT COUNT(*) AS c FROM orders`).get().c;
  return { running: current, last, lastOk, orderCount, cursor: getKV(CURSOR_KEY) };
}

module.exports = { startSync, syncStatus, toRow };
