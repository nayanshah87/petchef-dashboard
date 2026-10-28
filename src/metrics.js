const { db } = require('./db');

// Shopify returns UTC timestamps; PetChef reports in IST.
const OFFSET = `+${Number(process.env.TZ_OFFSET_MINUTES || 330)} minutes`;

// Revenue definitions (shown on the dashboard too):
//  net revenue  = Shopify "current total": after edits, refunds and returns; incl. GST + shipping;
//                 cancelled and test orders excluded.
//  ex-GST       = net revenue − current tax.
//  gross        = original order total at checkout, all non-test orders incl. later cancelled.
//  new vs repeat = customer's 1st non-cancelled order ever (needs the full history synced).
const BASE_CTE = `
WITH live AS (
  SELECT o.*, date(o.created_at, @off) AS d,
         CASE WHEN o.customer_id IS NULL THEN 'unknown'
              WHEN ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.created_at, o.id) = 1 THEN 'new'
              ELSE 'repeat' END AS ctype
  FROM orders o
  WHERE o.test = 0 AND o.cancelled_at IS NULL
)`;

const kpiStmt = db.prepare(`${BASE_CTE}
SELECT
  COUNT(*)                                                 AS orders,
  COALESCE(SUM(net_total), 0)                              AS net,
  COALESCE(SUM(net_total - tax), 0)                        AS net_ex_gst,
  COALESCE(SUM(discounts), 0)                              AS discounts,
  COALESCE(SUM(refunded), 0)                               AS refunded,
  COALESCE(SUM(CASE WHEN ctype='new' THEN net_total END), 0)    AS new_net,
  COALESCE(SUM(CASE WHEN ctype='new' THEN 1 END), 0)            AS new_orders,
  COALESCE(SUM(CASE WHEN ctype='repeat' THEN net_total END), 0) AS repeat_net,
  COALESCE(SUM(CASE WHEN ctype='repeat' THEN 1 END), 0)         AS repeat_orders,
  COALESCE(SUM(CASE WHEN is_cod=1 THEN net_total END), 0)       AS cod_net,
  COALESCE(SUM(CASE WHEN is_cod=1 THEN 1 END), 0)               AS cod_orders,
  COUNT(DISTINCT customer_id)                              AS customers
FROM live WHERE d BETWEEN @from AND @to`);

const cancelStmt = db.prepare(`
SELECT COUNT(*) AS orders, COALESCE(SUM(gross_total),0) AS value
FROM orders WHERE test = 0 AND cancelled_at IS NOT NULL AND date(created_at, @off) BETWEEN @from AND @to`);

const grossStmt = db.prepare(`
SELECT COUNT(*) AS orders, COALESCE(SUM(gross_total),0) AS value
FROM orders WHERE test = 0 AND date(created_at, @off) BETWEEN @from AND @to`);

const dailyStmt = db.prepare(`${BASE_CTE}
SELECT d,
  COUNT(*) AS orders,
  ROUND(SUM(net_total), 2) AS net,
  ROUND(COALESCE(SUM(CASE WHEN ctype='new' THEN net_total END),0), 2) AS new_net,
  ROUND(COALESCE(SUM(CASE WHEN ctype<>'new' THEN net_total END),0), 2) AS repeat_net
FROM live WHERE d BETWEEN @from AND @to GROUP BY d ORDER BY d`);

const monthlyStmt = db.prepare(`${BASE_CTE}
SELECT substr(d, 1, 7) AS month,
  COUNT(*) AS orders,
  ROUND(SUM(net_total), 0) AS net,
  ROUND(SUM(net_total - tax), 0) AS net_ex_gst,
  COALESCE(SUM(CASE WHEN ctype='new' THEN 1 END),0) AS new_orders,
  ROUND(COALESCE(SUM(CASE WHEN ctype='new' THEN net_total END),0), 0) AS new_net,
  COALESCE(SUM(CASE WHEN is_cod=1 THEN 1 END),0) AS cod_orders,
  COUNT(DISTINCT customer_id) AS customers
FROM live GROUP BY month ORDER BY month DESC LIMIT @limit`);

function kpis(from, to) {
  const p = { off: OFFSET, from, to };
  const k = kpiStmt.get(p);
  k.aov = k.orders ? k.net / k.orders : 0;
  k.cancelled = cancelStmt.get(p);
  k.gross = grossStmt.get(p);
  return k;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function overview({ from, to, cfrom, cto }) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('from/to must be YYYY-MM-DD');
  const out = { from, to, current: kpis(from, to), daily: dailyStmt.all({ off: OFFSET, from, to }) };
  if (DATE_RE.test(cfrom || '') && DATE_RE.test(cto || '')) {
    out.compare = { from: cfrom, to: cto, ...kpis(cfrom, cto) };
  }
  return out;
}

function monthly(limit = 13) {
  return monthlyStmt.all({ off: OFFSET, limit }).map((m) => ({ ...m, aov: m.orders ? m.net / m.orders : 0 }));
}

module.exports = { overview, monthly };
