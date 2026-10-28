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
  const fmtD = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

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

  // ---- daily chart: stacked bars (new vs repeat), plain SVG, hover tooltip
  const kfmt = (v) => v >= 1e5 ? '₹' + (v / 1e5).toFixed(v >= 1e6 ? 0 : 1) + 'L' : v >= 1e3 ? '₹' + Math.round(v / 1e3) + 'k' : '₹' + Math.round(v);
  function niceStep(raw) { const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  let dailyRows = [];
  function renderDaily(o) {
    const byDay = Object.fromEntries(o.daily.map((d) => [d.d, d]));
    dailyRows = [];
    for (let d = o.from; d <= o.to; d = addDays(d, 1)) {
      const r = byDay[d] || {};
      dailyRows.push({ d, n: r.new_net || 0, r: r.repeat_net || 0, o: r.orders || 0 });
    }
    const box = $('daily'); const W = box.clientWidth || 600, H = 240;
    const padL = 44, padR = 6, padT = 8, padB = 24;
    const iw = W - padL - padR, ih = H - padT - padB;
    const peak = Math.max(...dailyRows.map((x) => x.n + x.r), 0);
    const step = peak > 0 ? niceStep(peak / 4) : 1000;
    const ticks = Math.max(1, Math.ceil(peak / step));
    const max = step * ticks;
    const y = (v) => padT + ih - (v / max) * ih;
    const n = dailyRows.length, slot = iw / n, bw = Math.max(2, Math.min(28, slot * 0.7));
    const r4 = Math.min(4, bw / 2);
    let g = '';
    for (let i = 0; i <= ticks; i++) {
      const v = step * i, yy = y(v);
      g += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--grid)"/>` +
           `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${kfmt(v)}</text>`;
    }
    const every = Math.ceil(n / 7);
    let bars = '';
    dailyRows.forEach((row, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const yN = y(row.n), yT = y(row.n + row.r), base = y(0);
      const top = row.r > 0 ? 'r' : 'n';
      // new (bottom), then repeat stacked on top with a 2px surface gap; only the top segment gets rounded corners
      const seg = (y1, y2, color, rounded) => {
        const h = y2 - y1; if (h <= 0.5) return '';
        if (!rounded) return `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" fill="${color}"/>`;
        const rr = Math.min(r4, h);
        return `<path d="M${x},${y2} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 + rr} V${y2} Z" fill="${color}"/>`;
      };
      const gap = row.n > 0 && row.r > 0 ? 2 : 0;
      bars += seg(yN, base, 'var(--series-new)', top === 'n');
      bars += seg(yT, yN - gap, 'var(--series-repeat)', top === 'r');
      bars += `<rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${ih}" fill="transparent" data-i="${i}" class="hit"/>`;
      if (i % every === 0) bars += `<text x="${padL + slot * i + slot / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${fmtD(row.d)}</text>`;
    });
    box.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Net revenue by day">${g}<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>${bars}</svg><div class="tip" id="tip" hidden></div>`;
  }
  $('daily').addEventListener('mousemove', (e) => showTip(e));
  $('daily').addEventListener('click', (e) => showTip(e));
  $('daily').addEventListener('mouseleave', () => { const t = $('tip'); if (t) t.hidden = true; });
  function showTip(e) {
    const hit = e.target.closest('.hit'); const t = $('tip'); if (!t) return;
    if (!hit) { t.hidden = true; return; }
    const row = dailyRows[Number(hit.dataset.i)];
    t.innerHTML = `<b>${fmtD(row.d)}</b><div><i style="background:var(--series-new)"></i>New ${inr(row.n)}</div>` +
      `<div><i style="background:var(--series-repeat)"></i>Repeat ${inr(row.r)}</div><div class="tot">${inr(row.n + row.r)} · ${row.o} orders</div>`;
    t.hidden = false;
    const box = $('daily').getBoundingClientRect(), hb = hit.getBoundingClientRect();
    let left = hb.left - box.left + hb.width / 2 + 10;
    if (left + 170 > box.width) left = hb.left - box.left + hb.width / 2 - 180;
    t.style.left = Math.max(0, left) + 'px'; t.style.top = '6px';
  }
  let rsz; window.addEventListener('resize', () => { clearTimeout(rsz); rsz = setTimeout(() => lastOverview && renderDaily(lastOverview), 150); });

  // ---- monthly table
  async function renderMonthly() {
    const rows = await api('/api/monthly');
    if (!rows.length) { $('monthly').innerHTML = '<tr><td class="empty">No orders synced yet</td></tr>'; return; }
    const m = (s) => new Date(s + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    $('monthly').innerHTML =
      '<thead><tr><th>Month</th><th>Net revenue</th><th>Ex-GST</th><th>Orders</th><th>AOV</th><th>New cust.</th><th>New %</th><th>COD %</th></tr></thead><tbody>' +
      rows.map((r) => `<tr><td>${m(r.month)}</td><td>${inr(r.net)}</td><td>${inr(r.net_ex_gst)}</td><td>${num(r.orders)}</td><td>${inr(r.aov)}</td><td>${num(r.new_orders)}</td><td>${pct(r.new_orders, r.orders)}</td><td>${pct(r.cod_orders, r.orders)}</td></tr>`).join('') +
      '</tbody>';
  }

  // ---- load
  let lastOverview = null;
  let current = 'mtd';
  let customRange = null;
  async function load() {
    const r = current === 'custom' && customRange ? customRange : rangeFor(current === 'custom' ? 'mtd' : current);
    $('rangeLabel').textContent = `${fmtD(r.from)} – ${fmtD(r.to)}, compared with ${fmtD(r.cfrom)} – ${fmtD(r.cto)}`;
    const q = new URLSearchParams({ from: r.from, to: r.to, cfrom: r.cfrom, cto: r.cto });
    const o = await api('/api/overview?' + q);
    renderTiles(o, r.label);
    lastOverview = o;
    renderDaily(o);
  }

  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b));
    current = b.dataset.r;
    $('custom').classList.toggle('on', current === 'custom');
    if (current !== 'custom') load();
  });
  $('cApply').addEventListener('click', () => {
    const from = $('cFrom').value, to = $('cTo').value;
    if (!from || !to || from > to) return;
    const n = daysBetween(from, to), cto = addDays(from, -1);
    customRange = { from, to, cfrom: addDays(cto, -(n - 1)), cto, label: `vs previous ${n} days` };
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

  load(); renderMonthly(); refreshStatus(false);
})();
