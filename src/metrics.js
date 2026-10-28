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

// ---------- Customer snapshot: new vs returning customers and orders
// A customer is NEW in a period if their first-ever (non-cancelled) order falls in it, else RETURNING.
// An order is a FIRST order (seq 1) or a REPEAT order (seq 2+). A customer who places their 1st and
// 2nd order inside the same period counts as one new customer, one first order and one repeat order.
const CUST_CTE = `
WITH live AS (
  SELECT o.*, date(o.created_at, @off) AS d,
         ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.created_at, o.id) AS seq
  FROM orders o
  WHERE o.test = 0 AND o.cancelled_at IS NULL
),
f AS (
  SELECT *,
    CASE WHEN customer_id IS NULL THEN 'unknown' WHEN seq = 1 THEN 'new' ELSE 'repeat' END AS otype,
    CASE @grp WHEN 'week'  THEN date(d, '-6 days', 'weekday 1')
              WHEN 'month' THEN substr(d, 1, 7) || '-01'
              ELSE d END AS b
  FROM live
  WHERE d BETWEEN @from AND @to
    AND (@pay = 'all' OR (@pay = 'cod' AND is_cod = 1) OR (@pay = 'prepaid' AND is_cod = 0))
)`;

const CUST_AGG = `
  COUNT(*)                                                         AS orders,
  COUNT(DISTINCT customer_id)                                      AS customers,
  COUNT(DISTINCT CASE WHEN otype = 'new' THEN customer_id END)     AS new_customers,
  COALESCE(SUM(otype = 'new'), 0)                                  AS new_orders,
  COALESCE(SUM(otype = 'repeat'), 0)                               AS repeat_orders,
  COALESCE(SUM(otype = 'unknown'), 0)                              AS unknown_orders,
  ROUND(COALESCE(SUM(CASE WHEN otype = 'new'    THEN net_total END), 0), 2) AS new_net,
  ROUND(COALESCE(SUM(CASE WHEN otype = 'repeat' THEN net_total END), 0), 2) AS repeat_net,
  ROUND(COALESCE(SUM(net_total), 0), 2)                            AS net`;

const custKpiStmt = db.prepare(`${CUST_CTE} SELECT ${CUST_AGG} FROM f`);
const custBucketStmt = db.prepare(`${CUST_CTE} SELECT b, ${CUST_AGG} FROM f GROUP BY b ORDER BY b`);
const custSeqStmt = db.prepare(`${CUST_CTE}
SELECT CASE WHEN seq >= 6 THEN 6 ELSE seq END AS n, COUNT(*) AS orders,
       ROUND(SUM(net_total), 0) AS net, COUNT(DISTINCT customer_id) AS customers
FROM f WHERE customer_id IS NOT NULL GROUP BY n ORDER BY n`);

const withDerived = (k) => ({
  ...k,
  returning_customers: k.customers - k.new_customers,
  new_aov: k.new_orders ? k.new_net / k.new_orders : 0,
  repeat_aov: k.repeat_orders ? k.repeat_net / k.repeat_orders : 0,
});

function customers({ from, to, cfrom, cto, grp = 'day', pay = 'all' }) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('from/to must be YYYY-MM-DD');
  if (!['day', 'week', 'month'].includes(grp)) throw new Error('grp must be day, week or month');
  if (!['all', 'cod', 'prepaid'].includes(pay)) throw new Error('pay must be all, cod or prepaid');
  const p = { off: OFFSET, from, to, grp, pay };
  const out = {
    from, to, grp, pay,
    current: withDerived(custKpiStmt.get(p)),
    buckets: custBucketStmt.all(p).map(withDerived),
    byOrderNumber: custSeqStmt.all(p),
  };
  if (DATE_RE.test(cfrom || '') && DATE_RE.test(cto || '')) {
    out.compare = { from: cfrom, to: cto, ...withDerived(custKpiStmt.get({ ...p, from: cfrom, to: cto })) };
  }
  return out;
}

module.exports = { overview, monthly, customers };
