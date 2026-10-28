(() => {
  const $ = (id) => document.getElementById(id);
  const inr = (n, d = 0) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + '%';

  // ---- dates, all in IST
  const IST = 330 * 60e3;
  const istToday = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5) + 1;
  const monthStart = (d) => d.slice(0, 8) + '01';
  const addMonths = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n, 1); return x.toISOString().slice(0, 10); };
  const weekStart = (d) => { const x = new Date(d + 'T00:00:00Z'); const dow = (x.getUTCDay() + 6) % 7; return addDays(d, -dow); };
  const fmtD = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const fmtM = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const fmtMLong = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  function rangeFor(r) {
    const t = istToday();
    let from, to = t, cfrom, cto, label;
    switch (r) {
      case 'today': from = t; label = 'vs yesterday'; break;
      case 'yesterday': from = to = addDays(t, -1); label = 'vs day before'; break;
      case '7d': from = addDays(t, -6); break;
      case '30d': from = addDays(t, -29); break;
      case '90d': from = addDays(t, -89); break;
      case 'mtd': {
        from = monthStart(t);
        const pmStart = monthStart(addDays(from, -1));
        const pmEnd = addDays(from, -1);
        cfrom = pmStart;
        const same = addDays(pmStart, daysBetween(from, t) - 1);
        cto = same < pmEnd ? same : pmEnd;
        label = 'vs same days last month';
        break;
      }
      case 'lastmonth': {
        to = addDays(monthStart(t), -1); from = monthStart(to);
        cto = addDays(from, -1); cfrom = monthStart(cto); label = 'vs month before';
        break;
      }
    }
    if (!cfrom) { const n = daysBetween(from, to); cto = addDays(from, -1); cfrom = addDays(cto, -(n - 1)); }
    return { from, to, cfrom, cto, label: label || 'vs previous ' + daysBetween(from, to) + ' days' };
  }

  // ---- API
  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  // ---- tiles
  function delta(cur, prev) {
    if (!prev) return '';
    const d = ((cur - prev) / prev) * 100;
    if (Math.abs(d) < 0.5) return '<span>flat</span> ';
    const cls = d >= 0 ? 'up' : 'down';
    return `<span class="${cls}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span> `;
  }
  function tile(k, v, s, hero) {
    return `<div class="tile${hero ? ' hero' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`;
  }

  // ---- shared stacked-bar chart (plain SVG): rows = [{ label, a, b, foot }]
  const kfmt = (v) => v >= 1e5 ? '₹' + (v / 1e5).toFixed(v >= 1e6 ? 0 : 1) + 'L' : v >= 1e3 ? '₹' + Math.round(v / 1e3) + 'k' : '₹' + Math.round(v);
  const cfmt = (v) => v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k' : String(Math.round(v));
  function niceStep(raw) { const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  const charts = {}; // boxId -> { rows, opts }

  function drawStacked(boxId, rows, opts) {
    charts[boxId] = { rows, opts };
    const box = $(boxId); const W = box.clientWidth || 600, H = 240;
    const padL = 44, padR = 6, padT = 8, padB = 24;
    const iw = W - padL - padR, ih = H - padT - padB;
    const peak = Math.max(...rows.map((x) => x.a + x.b), 0);
    const rawStep = peak > 0 ? niceStep(peak / 4) : (opts.money ? 1000 : 1);
    const step = opts.money ? rawStep : Math.max(1, rawStep);
    const ticks = Math.max(1, Math.ceil(peak / step));
    const max = step * ticks;
    const y = (v) => padT + ih - (v / max) * ih;
    const n = rows.length, slot = iw / Math.max(n, 1), bw = Math.max(2, Math.min(36, slot * 0.7));
    const r4 = Math.min(4, bw / 2);
    const yl = opts.money ? kfmt : cfmt;
    let g = '';
    for (let i = 0; i <= ticks; i++) {
      const v = step * i, yy = y(v);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--grid)"/>` +
           `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${yl(v)}</text>`;
    }
    const every = Math.ceil(n / Math.max(3, Math.floor(iw / 62)));
    let bars = '';
    rows.forEach((row, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const yA = y(row.a), yT = y(row.a + row.b), base = y(0);
      const seg = (y1, y2, color, rounded) => {
        const h = y2 - y1; if (h <= 0.5) return '';
        if (!rounded) return `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" fill="${color}"/>`;
        const rr = Math.min(r4, h);
        return `<path d="M${x},${y2} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 + rr} V${y2} Z" fill="${color}"/>`;
      };
      // series a at the bottom, b stacked on top with a 2px surface gap; only the top segment is rounded
      const gap = row.a > 0 && row.b > 0 ? 2 : 0;
      bars += seg(yA, base, 'var(--series-new)', row.b <= 0);
      bars += seg(yT, yA - gap, 'var(--series-repeat)', true);
      bars += `<rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${ih}" fill="transparent" data-i="${i}" class="hit"/>`;
      if (i % every === 0) bars += `<text x="${padL + slot * i + slot / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${row.label}</text>`;
    });
    box.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${opts.aria || ''}">${g}<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>${bars}</svg><div class="tip" hidden></div>`;
  }

  function attachTip(boxId) {
    const box = $(boxId);
    const show = (e) => {
      const t = box.querySelector('.tip'); const c = charts[boxId]; if (!t || !c) return;
      const hit = e.target.closest('.hit'); if (!hit) { t.hidden = true; return; }
      const row = c.rows[Number(hit.dataset.i)], f = c.opts.money ? inr : num;
      t.innerHTML = `<b>${row.title || row.label}</b>` +
        `<div><i style="background:var(--series-new)"></i>${c.opts.names[0]} ${f(row.a)}</div>` +
        `<div><i style="background:var(--series-repeat)"></i>${c.opts.names[1]} ${f(row.b)}</div>` +
        `<div class="tot">${row.foot || ''}</div>`;
      t.hidden = false;
      const br = box.getBoundingClientRect(), hb = hit.getBoundingClientRect();
      let left = hb.left - br.left + hb.width / 2 + 10;
      if (left + 180 > br.width) left = hb.left - br.left + hb.width / 2 - 190;
      t.style.left = Math.max(0, left) + 'px'; t.style.top = '6px';
    };
    box.addEventListener('mousemove', show);
    box.addEventListener('click', show);
    box.addEventListener('mouseleave', () => { const t = box.querySelector('.tip'); if (t) t.hidden = true; });
  }
  attachTip('daily'); attachTip('cChart');
  let rsz; window.addEventListener('resize', () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => { for (const [id, c] of Object.entries(charts)) if ($(id).offsetParent) drawStacked(id, c.rows, c.opts); }, 150);
  });

  // ======================= Revenue tab =======================
  function renderTiles(o, cmpLabel) {
    const c = o.current, p = o.compare || {};
    $('tiles').innerHTML = [
      tile('Net revenue', inr(c.net), `${delta(c.net, p.net)}${cmpLabel} · ex-GST ${inr(c.net_ex_gst)}`, true),
      tile('Orders', num(c.orders), `${delta(c.orders, p.orders)}${num(c.customers)} customers`),
      tile('Avg order value', inr(c.aov), `${delta(c.aov, p.aov)}incl. GST`),
      tile('New customers', num(c.new_orders), `${pct(c.new_net, c.net)} of revenue`),
      tile('Repeat orders', num(c.repeat_orders), `${pct(c.repeat_net, c.net)} of revenue`),
      tile('COD share', pct(c.cod_orders, c.orders), `${num(c.cod_orders)} orders`),
      tile('Cancelled', num(c.cancelled.orders), `${inr(c.cancelled.value)} at checkout`),
    ].join('');
  }
  function renderDaily(o) {
    const byDay = Object.fromEntries(o.daily.map((d) => [d.d, d]));
    const rows = [];
    for (let d = o.from; d <= o.to; d = addDays(d, 1)) {
      const r = byDay[d] || {};
      const a = r.new_net || 0, b = r.repeat_net || 0;
      rows.push({ label: fmtD(d), a, b, foot: `${inr(a + b)} · ${r.orders || 0} orders` });
    }
    drawStacked('daily', rows, { money: true, names: ['New', 'Repeat'], aria: 'Net revenue by day' });
  }
  async function renderMonthly() {
    const rows = await api('/api/monthly');
    if (!rows.length) { $('monthly').innerHTML = '<tr><td class="empty">No orders synced yet</td></tr>'; return; }
    $('monthly').innerHTML =
      '<thead><tr><th>Month</th><th>Net revenue</th><th>Ex-GST</th><th>Orders</th><th>AOV</th><th>New cust.</th><th>New %</th><th>COD %</th></tr></thead><tbody>' +
      rows.map((r) => `<tr><td>${fmtMLong(r.month + '-01')}</td><td>${inr(r.net)}</td><td>${inr(r.net_ex_gst)}</td><td>${num(r.orders)}</td><td>${inr(r.aov)}</td><td>${num(r.new_orders)}</td><td>${pct(r.new_orders, r.orders)}</td><td>${pct(r.cod_orders, r.orders)}</td></tr>`).join('') +
      '</tbody>';
  }
  async function loadRevenue(r) {
    const q = new URLSearchParams({ from: r.from, to: r.to, cfrom: r.cfrom, cto: r.cto });
    const o = await api('/api/overview?' + q);
    renderTiles(o, r.label);
    renderDaily(o);
  }

  // ======================= Customer Snapshot tab =======================
  const cState = { grp: null, pay: 'all', metric: 'customers' }; // grp null = auto from range length
  const autoGrp = (r) => { const n = daysBetween(r.from, r.to); return n <= 31 ? 'day' : n <= 120 ? 'week' : 'month'; };
  let lastCust = null;

  function bucketKeys(from, to, grp) {
    const keys = [];
    if (grp === 'day') for (let d = from; d <= to; d = addDays(d, 1)) keys.push(d);
    else if (grp === 'week') for (let d = weekStart(from); d <= to; d = addDays(d, 7)) keys.push(d);
    else for (let d = monthStart(from); d <= to; d = addMonths(d, 1)) keys.push(d);
    return keys;
  }
  const bucketLabel = (k, grp) => grp === 'month' ? fmtM(k) : fmtD(k);
  const bucketTitle = (k, grp, o) => {
    if (grp === 'day') return fmtD(k);
    if (grp === 'week') { const s = k < o.from ? o.from : k, e = addDays(k, 6) > o.to ? o.to : addDays(k, 6); return `${fmtD(s)} – ${fmtD(e)}`; }
    return fmtMLong(k);
  };

  function renderCustTiles(o, cmpLabel) {
    const c = o.current, p = o.compare || {};
    $('cTiles').innerHTML = [
      tile('Customers who ordered', num(c.customers), `${delta(c.customers, p.customers)}${cmpLabel} · ${num(c.new_customers)} new, ${num(c.returning_customers)} returning`, true),
      tile('New customers', num(c.new_customers), `${delta(c.new_customers, p.new_customers)}${pct(c.new_customers, c.customers)} of customers`),
      tile('Returning customers', num(c.returning_customers), `${delta(c.returning_customers, p.returning_customers)}${pct(c.returning_customers, c.customers)} of customers`),
      tile('First orders', num(c.new_orders), `${pct(c.new_orders, c.orders)} of orders · AOV ${inr(c.new_aov)}`),
      tile('Repeat orders', num(c.repeat_orders), `${delta(c.repeat_orders, p.repeat_orders)}${pct(c.repeat_orders, c.orders)} of orders`),
      tile('Repeat AOV', inr(c.repeat_aov), `vs ${inr(c.new_aov)} on first orders`),
      tile('Repeat revenue', inr(c.repeat_net), `${pct(c.repeat_net, c.net)} of net revenue`),
    ].join('');
  }

  const METRICS = {
    customers: { title: 'Customers', names: ['New', 'Returning'], money: false, sub: 'Distinct customers who ordered, split new vs returning',
      a: (r) => r.new_customers, b: (r) => r.returning_customers, foot: (r) => `${num(r.customers)} customers · ${num(r.orders)} orders` },
    orders: { title: 'Orders', names: ['First orders', 'Repeat orders'], money: false, sub: "Orders split by customer's 1st order vs 2nd onwards",
      a: (r) => r.new_orders, b: (r) => r.repeat_orders, foot: (r) => `${num(r.new_orders + r.repeat_orders)} orders${r.unknown_orders ? ` (+${r.unknown_orders} guest)` : ''}` },
    revenue: { title: 'Net revenue', names: ['First orders', 'Repeat orders'], money: true, sub: 'Net revenue incl. GST from first vs repeat orders',
      a: (r) => r.new_net, b: (r) => r.repeat_net, foot: (r) => `${inr(r.new_net + r.repeat_net)} · ${num(r.orders)} orders` },
  };
  const ZERO = { customers: 0, new_customers: 0, returning_customers: 0, orders: 0, new_orders: 0, repeat_orders: 0, unknown_orders: 0, new_net: 0, repeat_net: 0, net: 0 };

  function renderCustChart() {
    const o = lastCust; if (!o) return;
    const m = METRICS[cState.metric];
    const by = Object.fromEntries(o.buckets.map((b) => [b.b, b]));
    const rows = bucketKeys(o.from, o.to, o.grp).map((k) => {
      const r = by[k] || ZERO;
      return { label: bucketLabel(k, o.grp), title: bucketTitle(k, o.grp, o), a: m.a(r), b: m.b(r), foot: m.foot(r) };
    });
    $('cChartTitle').textContent = `${m.title} by ${o.grp}`;
    $('cChartSub').textContent = m.sub;
    $('cLegend').innerHTML = `<span><i style="background:var(--series-new)"></i>${m.names[0]}</span><span><i style="background:var(--series-repeat)"></i>${m.names[1]}</span>`;
    drawStacked('cChart', rows, { money: m.money, names: m.names, aria: `${m.title} by ${o.grp}, ${m.names.join(' vs ')}` });
  }

  function renderSeqTable(o) {
    const rows = o.byOrderNumber;
    const total = rows.reduce((s, r) => s + r.orders, 0);
    if (!total) { $('seqTable').innerHTML = '<tr><td class="empty">No orders in this range</td></tr>'; $('unknownNote').textContent = ''; return; }
    const maxO = Math.max(...rows.map((r) => r.orders));
    const name = (n) => n === 1 ? '1st (new)' : n === 6 ? '6th+' : n + ['', '', 'nd', 'rd', 'th', 'th'][n];
    $('seqTable').innerHTML = '<thead><tr><th>Order #</th><th>Orders</th><th>Share</th><th class="bar-cell"></th><th>Net revenue</th><th>AOV</th></tr></thead><tbody>' +
      [1, 2, 3, 4, 5, 6].map((n) => {
        const r = rows.find((x) => x.n === n) || { orders: 0, net: 0 };
        return `<tr><td>${name(n)}</td><td>${num(r.orders)}</td><td>${pct(r.orders, total)}</td>` +
          `<td class="bar-cell"><div class="hbar${n === 1 ? ' first' : ''}" style="width:${maxO ? (r.orders / maxO) * 100 : 0}%"></div></td>` +
          `<td>${inr(r.net)}</td><td>${inr(r.orders ? r.net / r.orders : 0)}</td></tr>`;
      }).join('') + '</tbody>';
    const u = o.current.unknown_orders;
    $('unknownNote').textContent = u ? `${num(u)} guest order${u > 1 ? 's' : ''} without a customer record ${u > 1 ? "are" : "is"} not included above.` : '';
  }

  function renderBucketTable(o) {
    const by = Object.fromEntries(o.buckets.map((b) => [b.b, b]));
    const keys = bucketKeys(o.from, o.to, o.grp).reverse();
    $('bucketTitle').textContent = `By ${o.grp}`;
    $('bucketTable').innerHTML =
      `<thead><tr><th>${o.grp[0].toUpperCase() + o.grp.slice(1)}</th><th>New cust.</th><th>Returning</th><th>First orders</th><th>Repeat orders</th><th>Repeat %</th><th>First-order rev.</th><th>Repeat rev.</th></tr></thead><tbody>` +
      keys.map((k) => {
        const r = by[k] || ZERO;
        return `<tr><td>${bucketTitle(k, o.grp, o)}</td><td>${num(r.new_customers)}</td><td>${num(r.returning_customers)}</td><td>${num(r.new_orders)}</td><td>${num(r.repeat_orders)}</td>` +
          `<td>${pct(r.repeat_orders, r.new_orders + r.repeat_orders)}</td><td>${inr(r.new_net)}</td><td>${inr(r.repeat_net)}</td></tr>`;
      }).join('') + '</tbody>';
  }

  function syncSeg(id, v) { document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }

  async function loadCustomers(r) {
    const grp = cState.grp || autoGrp(r);
    syncSeg('grp', grp);
    const q = new URLSearchParams({ from: r.from, to: r.to, cfrom: r.cfrom, cto: r.cto, grp, pay: cState.pay });
    const o = await api('/api/customers?' + q);
    lastCust = o;
    renderCustTiles(o, r.label);
    renderCustChart();
    renderSeqTable(o);
    renderBucketTable(o);
  }

  function bindSeg(id, onPick) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      syncSeg(id, b.dataset.v); onPick(b.dataset.v);
    });
  }
  bindSeg('grp', (v) => { cState.grp = v; load(); });
  bindSeg('pay', (v) => { cState.pay = v; load(); });
  bindSeg('metric', (v) => { cState.metric = v; renderCustChart(); });

  // ======================= Tabs + shared date range =======================
  let tab = 'revenue';
  let current = 'mtd';
  let customRange = null;
  const activeRange = () => (current === 'custom' && customRange ? customRange : rangeFor(current === 'custom' ? 'mtd' : current));

  function showTab(t) {
    tab = t === 'customers' ? 'customers' : 'revenue';
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    $('tab-revenue').hidden = tab !== 'revenue';
    $('tab-customers').hidden = tab !== 'customers';
    load();
  }
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  async function load() {
    const r = activeRange();
    $('rangeLabel').textContent = `${fmtD(r.from)} – ${fmtD(r.to)}, compared with ${fmtD(r.cfrom)} – ${fmtD(r.cto)}`;
    try {
      if (tab === 'customers') await loadCustomers(r); else await loadRevenue(r);
    } catch (e) { console.error(e); }
  }

  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b));
    current = b.dataset.r;
    $('custom').classList.toggle('on', current === 'custom');
    if (current !== 'custom') { cState.grp = null; load(); }
  });
  $('cApply').addEventListener('click', () => {
    const from = $('cFrom').value, to = $('cTo').value;
    if (!from || !to || from > to) return;
    const n = daysBetween(from, to), cto = addDays(from, -1);
    customRange = { from, to, cfrom: addDays(cto, -(n - 1)), cto, label: `vs previous ${n} days` };
    cState.grp = null;
    load();
  });

  // ---- sync status + button
  const ago = (iso) => {
    if (!iso) return 'never';
    const m = Math.round((Date.now() - new Date(iso)) / 60e3);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  };
  let polling = null;
  async function refreshStatus(reloadWhenDone) {
    const s = await api('/api/status');
    const btn = $('syncBtn');
    if (s.running) {
      btn.disabled = true; btn.textContent = 'Syncing…';
      $('syncText').textContent = s.running.progress || 'Syncing…';
      if (!polling) polling = setInterval(() => refreshStatus(true), 3000);
      return;
    }
    if (polling) { clearInterval(polling); polling = null; }
    btn.disabled = false; btn.textContent = 'Sync now';
    if (s.last?.status === 'error') {
      $('syncText').innerHTML = `<span class="err" title="${(s.last.error || '').replace(/"/g, '&quot;')}">Last sync failed</span> · good data from ${ago(s.lastOk?.finished_at)}`;
    } else {
      $('syncText').textContent = `Updated ${ago(s.lastOk?.finished_at)} · ${num(s.orderCount)} orders`;
    }
    if (reloadWhenDone) { load(); renderMonthly(); }
  }
  $('syncBtn').addEventListener('click', async () => {
    $('syncBtn').disabled = true;
    try { await api('/api/sync', { method: 'POST', body: '{}' }); } catch (e) { alert('Sync failed to start: ' + e.message); }
    refreshStatus(true);
  });

  showTab(location.hash.slice(1));
  renderMonthly(); refreshStatus(false);
})();
