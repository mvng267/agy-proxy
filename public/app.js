// ===== Antigravity Account Manager — frontend =====
const FLOWS = [
  { key: 'agy', label: 'Antigravity', col: 'status_agy' },
  { key: 'kiro', label: 'Kiro', col: 'status_kiro' },
];
const PIPELINE = FLOWS.map((f) => f.key);

const $ = (id) => document.getElementById(id);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (path, opts) => {
  const hasBody = opts && opts.body != null;
  const r = await fetch(path, { ...opts, headers: hasBody ? { 'content-type': 'application/json', ...(opts.headers || {}) } : (opts && opts.headers) || {}, body: hasBody ? JSON.stringify(opts.body) : undefined });
  return r.json();
};
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
function noProxy() { return $('no-proxy').checked; }
function selectedFlows() { return [...document.querySelectorAll('.fp:checked')].map((c) => c.value); }
const cssId = (s) => s.replace(/[^a-zA-Z0-9]/g, '_');
const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const fmtDur = (s) => (s <= 0 ? '' : s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h');

// ---------- helper UI dùng chung ----------
function fmtNum(n) { n = +n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; return String(n); }
function fmtAgo(ms) { if (!ms) return '—'; const d = Date.now() - ms; if (d < 60000) return Math.max(1, Math.round(d / 1000)) + 's trước'; if (d < 3600000) return Math.round(d / 60000) + 'p trước'; if (d < 86400000) return Math.round(d / 3600000) + 'h trước'; return Math.round(d / 86400000) + 'd trước'; }
function fmtReset(iso) { if (!iso) return '—'; const d = new Date(iso).getTime() - Date.now(); if (d <= 0) return 'đã reset'; const days = Math.floor(d / 86400000), hrs = Math.floor((d % 86400000) / 3600000); return days > 0 ? `${days}d ${hrs}h` : `${hrs}h`; }
function qColor(pct) { return pct >= 50 ? 'q-hi' : pct >= 20 ? 'q-mid' : 'q-lo'; }
function qbar(pct, label) { const p = pct == null ? 0 : pct; return `<div class="qbar ${pct == null ? '' : qColor(p)}"><i style="width:${p}%"></i><span>${pct == null ? '—' : p + '%'}${label ? ' ' + label : ''}</span></div>`; }
const remember = (k, def) => { try { const v = localStorage.getItem('vs_' + k); return v !== null ? JSON.parse(v) : def; } catch { return def; } };
const store_ = (k, v) => { try { localStorage.setItem('vs_' + k, JSON.stringify(v)); } catch {} };
async function withSpin(btn, fn) { if (!btn) return fn(); const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; } }
function confirmAct(msg) { return confirm(msg); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function paginate(list, st) { const total = list.length; const pages = Math.max(1, Math.ceil(total / st.size)); if (st.page > pages) st.page = pages; if (st.page < 1) st.page = 1; const start = (st.page - 1) * st.size; return { rows: list.slice(start, start + st.size), total, pages }; }
// ---- biểu đồ SVG thuần (responsive viewBox, theme-aware) ----
/**
 * Biểu đồ đường SVG. `min`/`max` cho phép ghim thang (vd quota 0–100 hoặc auto-zoom
 * quanh dải thật) — nếu để auto thang luôn từ 0 nên dải 90–100% sẽ bị bẹt.
 * `series`: vẽ nhiều đường trên cùng trục.
 */
function svgLine(values, opts = {}) {
  const series = opts.series || [{ values, color: opts.color || 'var(--primary)' }];
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return '<div class="empty">Chưa có dữ liệu</div>';
  const h = opts.h || 90, w = 300, pad = 8;
  let lo = opts.min != null ? opts.min : Math.min(...all);
  let hi = opts.max != null ? opts.max : Math.max(...all);
  if (opts.min == null && opts.max == null) {
    const span = Math.max(1, hi - lo);
    lo = Math.max(0, lo - span * 0.15); hi = hi + span * 0.15; // auto-zoom quanh dải thật
  }
  if (hi - lo < 1) { hi = lo + 1; }
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => (n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  // lưới ngang mờ (chỉ khi ghim thang, vd 0–100%)
  const grid = opts.grid === false || opts.min == null ? '' :
    [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const gy = (h - pad - f * (h - 2 * pad)).toFixed(1);
      return `<line x1="${pad}" x2="${w - pad}" y1="${gy}" y2="${gy}" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    }).join('');
  const body = series.map((s, si) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = opts.area === false ? '' : `<polygon points="${pad},${h - pad} ${pts} ${w - pad},${h - pad}" fill="${s.color}" opacity="0.12"/>`;
    const dots = s.values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2" fill="${s.color}"><title>${v}</title></circle>`).join('');
    // đường thứ 2 nét đứt → không bị che khi hai đường trùng nhau
    const dash = si > 0 ? ' stroke-dasharray="5 3"' : '';
    return `${area}<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"${dash} vector-effect="non-scaling-stroke"/>${dots}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}${body}</svg>`;
}
/** Chú thích + trục cho biểu đồ (đặt ngoài SVG để không méo theo preserveAspectRatio). */
function chartLegend(items, from, to, lo, hi) {
  return `<div class="chart-legend"><span class="cl-items">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`).join('')}</span>` +
    `<span class="faint">${esc(from || '')}${to ? ' → ' + esc(to) : ''}${lo != null ? ` · thang ${lo}–${hi}%` : ''}</span></div>`;
}
function svgDonut(pct, label, color) {
  const p = pct == null ? 0 : pct, r = 34, c = 2 * Math.PI * r, off = c * (1 - p / 100);
  const col = color || (p >= 50 ? 'var(--green)' : p >= 20 ? 'var(--amber)' : 'var(--red)');
  return `<div class="donut"><svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="${r}" fill="none" stroke="var(--card-2)" stroke-width="9"/><circle cx="45" cy="45" r="${r}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 45 45)"/><text x="45" y="49" text-anchor="middle" class="donut-val">${pct == null ? '—' : p + '%'}</text></svg><div class="donut-lbl">${esc(label)}</div></div>`;
}
function barRows(items, nameKey, valFn, valLabel) {
  if (!items.length) return '<div class="empty">Chưa có dữ liệu</div>';
  const max = Math.max(1, ...items.map(valFn));
  return items.map((it) => `<div class="ubar-row"><span class="ubar-lbl" title="${esc(it[nameKey])}">${esc(it[nameKey])}</span><div class="ubar"><i style="width:${Math.round((valFn(it) / max) * 100)}%"></i></div><span class="ubar-val">${valLabel(it)}</span></div>`).join('');
}
function countUp(elId, target) {
  const e = $(elId); if (!e) return; const t = +target || 0; if (t <= 0) { e.textContent = String(t); return; }
  const dur = 500, t0 = performance.now();
  const step = (now) => { const k = Math.min(1, (now - t0) / dur); e.textContent = fmtNum(Math.round(t * (0.2 + 0.8 * k) * (k < 1 ? 1 : 1) )); if (k < 1) requestAnimationFrame(step); else e.textContent = fmtNum(t); };
  requestAnimationFrame(step);
}
function skeleton(elId, rows = 4) { const e = $(elId); if (e) e.innerHTML = Array.from({ length: rows }, () => '<div class="skel"></div>').join(''); }
function renderPager(elId, st, total, pages, onChange) {
  const e = $(elId); if (!e) return;
  if (total <= st.size && st.page === 1) { e.innerHTML = total ? `<span class="pg-info">${total} kết quả</span>` : ''; return; }
  let nums = '';
  for (let p = 1; p <= pages; p++) {
    if (pages > 7 && p !== 1 && p !== pages && Math.abs(p - st.page) > 1) { if (p === st.page - 2 || p === st.page + 2) nums += '<span class="pg-dots">…</span>'; continue; }
    nums += `<button class="pg-num ${p === st.page ? 'active' : ''}" data-p="${p}">${p}</button>`;
  }
  e.innerHTML = `<span class="pg-info">Trang ${st.page}/${pages} · ${total} kết quả</span><div class="pg-nav"><button class="pg-btn" data-p="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>${icon('left')}</button>${nums}<button class="pg-btn" data-p="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>${icon('right')}</button></div><label class="pg-size">/trang <select class="w-auto">${[25, 50, 100].map((s) => `<option ${s === st.size ? 'selected' : ''}>${s}</option>`).join('')}</select></label>`;
  e.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { const p = +b.dataset.p; if (p >= 1 && p <= pages) { st.page = p; onChange(); } }));
  e.querySelector('select').addEventListener('change', (ev) => { st.size = +ev.target.value; st.page = 1; onChange(); });
}

let accounts = [], proxyLabels = [], selected = new Set(), credsCache = [];

// ---------- nav / views ----------
$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item[data-tab]'); if (!b) return;
  document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $('view-' + b.dataset.tab).classList.add('active');
  store_('tab', b.dataset.tab);
  if (innerWidth <= 720) closeDrawers();
  const t = b.dataset.tab;
  if (t === 'overview') loadOverview();
  if (t === 'connections') loadConnections();
  if (t === 'tokens') loadTokens();
  if (t === 'chat') loadAgy();
  if (t === 'agy') loadAgy();
  if (t === 'quota') loadQuota();
  if (t === 'usage') loadUsage();
  if (t === 'gwlog') renderGwlog();
  if (t === 'models') loadModels();
  if (t === 'combo') loadCombo();
  if (t === 'tools') loadTools();
  if (t === 'settings') loadSettings();
});

// ---------- drawers / collapse / theme ----------
function closeDrawers() { $('nav').classList.remove('open'); $('logpane').classList.remove('open'); $('backdrop').classList.remove('on'); }
$('btn-nav').addEventListener('click', () => { $('nav').classList.toggle('open'); $('backdrop').classList.toggle('on', $('nav').classList.contains('open')); });
$('btn-log').addEventListener('click', () => { $('logpane').classList.toggle('open'); $('backdrop').classList.toggle('on', $('logpane').classList.contains('open')); });
$('backdrop').addEventListener('click', closeDrawers);
$('btn-nav-collapse').addEventListener('click', () => { const c = $('app').classList.toggle('nav-collapsed'); store_('navCollapsed', c); });
$('btn-logout').addEventListener('click', async () => { if (!confirm('Đăng xuất?')) return; await api('/api/auth/logout', { method: 'POST', body: {} }); location.href = '/login'; });
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('theme', t); $('btn-theme').innerHTML = icon(t === 'light' ? 'sun' : 'moon'); }
function toggleTheme() { applyTheme((localStorage.getItem('theme') || 'dark') === 'dark' ? 'light' : 'dark'); }
$('btn-theme').addEventListener('click', toggleTheme);

// ---------- summary (stats per-page + runbar + omni pill) ----------
function mkCard(label, value, sub, cls) { return `<div class="card ${cls || ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ''}</div></div>`; }
async function loadSummary() {
  const s = await api('/api/summary');
  // nav badges
  $('tc-acc').textContent = s.totalAccounts; $('tc-proxy').textContent = s.totalProxies; $('tc-conn').textContent = s.omniOk ? s.connectionCount : '—';
  // stats Tài khoản
  const accEl = $('stats-acc'); let html = mkCard('Tổng tài khoản', s.totalAccounts, `${s.totalProxies} proxy`);
  for (const f of PIPELINE) {
    const c = s.counts[f] || {}; const done = c.ok || 0; const pct = Math.round((done / (s.totalAccounts || 1)) * 100);
    const label = FLOWS.find((x) => x.key === f).label;
    html += `<div class="card provider"><div class="label">${label}</div><div class="value">${done}<span class="faint" style="font-size:14px">/${s.totalAccounts}</span></div><div class="sub">${c.failed ? `❌ ${c.failed}` : ''} ${c.needs_human ? `⏸ ${c.needs_human}` : ''} ${c.running ? `● ${c.running}` : ''}</div><div class="prog"><i style="width:${pct}%"></i></div></div>`;
  }
  const nh = PIPELINE.reduce((n, f) => n + ((s.counts[f] || {}).needs_human || 0), 0);
  html += mkCard('Cần xử lý tay', nh, nh ? 'chờ challenge' : 'không có');
  accEl.innerHTML = html;
  // stats Proxy
  const crowded = s.maxPerProxy > 10;
  $('stats-proxy').innerHTML = mkCard('Tổng proxy', s.totalProxies, '') + mkCard('Tải / IP tối đa', s.maxPerProxy, crowded ? '<span style="color:var(--red)">⚠ dồn nhiều acc/1 IP</span>' : 'acc trên 1 IP') + mkCard('Direct (no proxy)', (s.proxyLoad && (s.proxyLoad['(direct)'] || s.proxyLoad['direct'])) || 0, 'account chạy IP máy');
  // runbar
  const rb = $('runbar');
  if (s.sched.running && s.sched.batchTotal > 0) {
    rb.classList.add('on');
    const pct = Math.round((s.sched.done / s.sched.batchTotal) * 100);
    $('runbar-fill').style.width = pct + '%';
    const cur = s.sched.current;
    $('runbar-cur').innerHTML = cur ? `Đang chạy <b>${esc(cur.email.split('@')[0])}</b>/${cur.flow}` : 'Đang chạy';
    $('runbar-meta').innerHTML = `<b>${s.sched.done}/${s.sched.batchTotal}</b> (${pct}%)${s.sched.etaSec ? ' · còn ~' + fmtDur(s.sched.etaSec) : ''} · queue ${s.sched.queued} · login24h ${s.sched.loginsLast24h}/${s.sched.dailyCap}`;
  } else { rb.classList.remove('on'); $('runbar-cur').textContent = `Rảnh · login24h ${s.sched.loginsLast24h}/${s.sched.dailyCap}`; $('runbar-meta').textContent = ''; }
  const op = $('pill-omni'); op.className = 'status-pill ' + (s.omniOk ? 'ok' : 'bad'); op.innerHTML = `<span class="dot"></span> OmniRoute ${s.omniOk ? 'OK' : 'lỗi'}`;
}

// ---------- Tổng quan ----------
async function loadOverview() {
  skeleton('ov-kpi', 6);
  const o = await api('/api/overview');
  const agyOk = (o.accounts.counts.agy || {}).ok || 0, kiroOk = (o.accounts.counts.kiro || {}).ok || 0;
  const kpis = [
    ['Tài khoản', o.accounts.total, `${o.proxies} proxy`],
    ['Antigravity ok', agyOk, `kiro ${kiroOk}`],
    ['Pool bật', `${o.gateway.enabled}/${o.gateway.total}`, 'đang phục vụ'],
    ['Requests 7d', fmtNum(o.usage.totals.requests), 'gọi model'],
    ['Tokens 7d', fmtNum(o.usage.totals.tokIn + o.usage.totals.tokOut), 'in + out'],
    ['Cooldown / chết', `${o.gateway.cooldown} / ${o.gateway.dead}`, 'cần chú ý'],
  ];
  $('ov-kpi').innerHTML = kpis.map(([l, v, s], i) => `<div class="card"><div class="label">${l}</div><div class="value" id="kpi-${i}">${v}</div><div class="sub">${s}</div></div>`).join('');
  // dải thống kê TÁCH THEO PROVIDER
  $('ov-providers').innerHTML = (o.providers || []).map((p) => `<div class="card provider">
    <div class="label">${esc(p.label)} <span class="chip">${esc(p.id)}/</span></div>
    <div class="value">${p.ready}<span class="faint" style="font-size:15px">/${p.total}</span></div>
    <div class="sub">sẵn sàng · ${p.cooldown} nghỉ${p.quotaAvg != null ? ` · quota TB ${p.quotaAvg}%` : p.probeOk ? ` · ${p.probeOk} dò OK` : ''}</div>
    <div class="sub">${fmtNum(p.requests)} req/7d · ${fmtNum(p.tokens)} tok${p.estimated ? ' (ước lượng)' : ''}</div>
  </div>`).join('');
  // donut hạn mức + mini xu hướng
  $('ov-quota').innerHTML = svgDonut(o.quota.geminiAvg, 'Gemini') + svgDonut(o.quota.thirdPartyAvg, 'Claude/GPT') + `<div class="donut-note faint">${o.quota.fetched}/${o.gateway.total} account đã nạp</div><div id="ov-qtrend" style="width:100%"></div>`;
  api('/api/gateway/quota/history?range=7d').then((qh) => {
    const s = qh.series || [];
    const box = $('ov-qtrend'); if (!box) return;
    box.innerHTML = s.length
      ? `<div class="faint" style="font-size:11px;margin:6px 0 2px">Xu hướng 7 ngày</div>` + svgLine(null, { series: [
          { values: s.map((x) => x.gemini ?? 0), color: 'var(--green)' },
          { values: s.map((x) => x.third ?? 0), color: 'var(--purple)' },
        ], min: 0, max: 100, h: 56, area: false })
      : '';
  }).catch(() => {});
  // usage line
  const vals = o.usage.series.map((s) => s.requests);
  $('ov-usage').innerHTML = svgLine(vals, { color: 'var(--primary)' }) + `<div class="faint" style="font-size:11px;margin-top:4px">${o.usage.series.length ? o.usage.series[0].bucket + ' → ' + o.usage.series[o.usage.series.length - 1].bucket : 'chưa có dữ liệu'}</div>`;
  // sức khỏe pool (stacked)
  const g = o.gateway, tot = Math.max(1, g.total);
  const seg = (n, cls, lbl) => n ? `<div class="hbar-seg ${cls}" style="width:${(n / tot) * 100}%" title="${lbl}: ${n}"></div>` : '';
  $('ov-health').innerHTML = `<div class="hbar">${seg(g.enabled - g.cooldown - g.dead, 'ok', 'sẵn sàng')}${seg(g.cooldown, 'cd', 'cooldown')}${seg(g.dead, 'dead', 'chết')}${seg(g.total - g.enabled, 'off', 'tắt')}</div>
    <div class="hbar-legend"><span><i class="lg ok"></i>Sẵn sàng ${g.enabled - g.cooldown - g.dead}</span><span><i class="lg cd"></i>Cooldown ${g.cooldown}</span><span><i class="lg dead"></i>Chết ${g.dead}</span><span><i class="lg off"></i>Tắt ${g.total - g.enabled}</span></div>
    <div style="margin-top:12px"><div class="fl">Harvest Antigravity</div><div class="prog"><i style="width:${Math.round((agyOk / (o.accounts.total || 1)) * 100)}%"></i></div>
    <div class="fl" style="margin-top:8px">Harvest Kiro</div><div class="prog"><i style="width:${Math.round((kiroOk / (o.accounts.total || 1)) * 100)}%"></i></div></div>`;
  $('ov-models').innerHTML = barRows(o.usage.byModel, 'model', (m) => m.requests, (m) => `${m.requests} req · ${fmtNum(m.tokIn + m.tokOut)}`);
  $('ov-accounts').innerHTML = barRows(o.usage.byAccount, 'email', (a) => a.requests, (a) => `${a.requests} req · ${fmtNum(a.tokIn + a.tokOut)}`);
}
$('ov-refresh').addEventListener('click', (e) => withSpin(e.currentTarget, loadOverview));

// ---------- accounts ----------
const accSt = { page: 1, size: remember('accSize', 50) };
async function loadAccounts() { const r = await api('/api/accounts'); accounts = r.accounts; renderAccounts(); }
function accountMatches(a) {
  const q = $('acc-search').value.trim().toLowerCase(); if (q && !a.email.toLowerCase().includes(q)) return false;
  const f = $('acc-filter').value; if (!f) return true;
  const sts = PIPELINE.map((k) => a['status_' + k]);
  if (f === 'both-ok') return sts.every((s) => s === 'ok');
  if (f === 'miss-agy') return a.status_agy !== 'ok';
  if (f === 'miss-kiro') return a.status_kiro !== 'ok';
  if (f === 'new') return sts.some((s) => s === 'new');
  return sts.includes(f);
}
function badge(status, email, flow) { return `<span class="badge ${status}" onclick="runFlow('${email}','${flow}')" title="Chạy ${flow} cho account này"><span class="bd"></span>${status}</span>`; }
function renderAccounts() {
  const body = $('acc-body'); body.innerHTML = '';
  const full = accounts.filter(accountMatches);
  const { rows, total, pages } = paginate(full, accSt);
  if (!total) { body.innerHTML = `<tr><td colspan="7"><div class="empty">Không có tài khoản khớp</div></td></tr>`; $('acc-pager').innerHTML = ''; updateSel(); return; }
  for (const a of rows) {
    const tr = el('tr'); if (selected.has(a.email)) tr.classList.add('sel');
    const proxyOpts = ['<option value="">(none)</option>'].concat(proxyLabels.map((l) => `<option ${l === a.proxy ? 'selected' : ''}>${esc(l)}</option>`)).join('');
    tr.innerHTML = `
      <td><input type="checkbox" class="rowchk" data-email="${esc(a.email)}" ${selected.has(a.email) ? 'checked' : ''}></td>
      <td class="email">${esc(a.email)}</td>
      <td><select class="sm rowproxy" data-email="${esc(a.email)}" title="Gán proxy">${proxyOpts}</select></td>
      ${FLOWS.map((f) => `<td>${badge(a[f.col], a.email, f.key)}</td>`).join('')}
      <td class="act">
        <button class="sm primary" onclick="runPipeline('${a.email}')" title="Chạy luồng đã chọn">${icon('play')} Full</button>
        <button class="sm" onclick="showDetail('${a.email}')" title="Chi tiết + credential">${icon('info')} Chi tiết</button>
      </td>
      <td class="act"><button class="sm icon danger" onclick="delAccount('${a.email}')" title="Xoá account">${icon('trash')}</button></td>`;
    body.appendChild(tr);
  }
  body.querySelectorAll('.rowchk').forEach((c) => c.addEventListener('change', (e) => { const em = e.target.dataset.email; if (e.target.checked) selected.add(em); else selected.delete(em); updateSel(); }));
  body.querySelectorAll('.rowproxy').forEach((s) => s.addEventListener('change', (e) => setProxy(e.target.dataset.email, e.target.value)));
  renderPager('acc-pager', accSt, total, pages, () => { store_('accSize', accSt.size); renderAccounts(); });
  updateSel();
}
function updateSel() {
  const n = selected.size; $('acc-selcount').textContent = n ? `${n} đã chọn` : '0 đã chọn';
  $('acc-bulk').classList.toggle('on', n > 0);
  document.querySelectorAll('#acc-body tr').forEach((tr) => { const chk = tr.querySelector('.rowchk'); if (chk) tr.classList.toggle('sel', selected.has(chk.dataset.email)); });
}
$('check-all').addEventListener('change', (e) => { const list = accounts.filter(accountMatches); const { rows } = paginate(list, accSt); if (e.target.checked) rows.forEach((a) => selected.add(a.email)); else rows.forEach((a) => selected.delete(a.email)); renderAccounts(); });
$('acc-search').addEventListener('input', debounce(() => { accSt.page = 1; renderAccounts(); }, 200));
$('acc-filter').addEventListener('change', () => { accSt.page = 1; renderAccounts(); });

async function runFlow(email, flow) { await api('/api/run', { method: 'POST', body: { email, flow, noProxy: noProxy() } }); toast(`Đã xếp ${flow} · ${email.split('@')[0]}`); }
async function runPipeline(email) { const flows = selectedFlows(); if (!flows.length) return toast('Chọn ít nhất 1 luồng'); for (const f of flows) await api('/api/run', { method: 'POST', body: { email, flow: f, noProxy: noProxy() } }); toast(`Đã xếp ${flows.join('+')} · ${email.split('@')[0]}`); }
async function setProxy(email, proxy) { await api('/api/accounts/' + encodeURIComponent(email) + '/proxy', { method: 'POST', body: { proxy } }); }
async function delAccount(email) { if (!confirmAct('Xoá ' + email + '?')) return; await api('/api/accounts/' + encodeURIComponent(email), { method: 'DELETE' }); selected.delete(email); loadAccounts(); loadSummary(); }
$('bulk-run').addEventListener('click', async () => { const flows = selectedFlows(); if (!flows.length) return toast('Chọn ít nhất 1 luồng'); for (const em of selected) for (const f of flows) await api('/api/run', { method: 'POST', body: { email: em, flow: f, noProxy: noProxy() } }); toast(`Đã xếp ${flows.join('+')} cho ${selected.size} account`); });
$('bulk-del').addEventListener('click', async () => { if (!confirmAct(`Xoá ${selected.size} account?`)) return; for (const em of selected) await api('/api/accounts/' + encodeURIComponent(em), { method: 'DELETE' }); selected.clear(); loadAccounts(); loadSummary(); });
$('bulk-proxy').addEventListener('click', async () => { const p = prompt('Label proxy gán cho account đã chọn (trống = bỏ gán):', proxyLabels[0] || ''); if (p === null) return; for (const em of selected) await setProxy(em, p); loadAccounts(); toast('Đã gán proxy'); });
$('btn-retry').addEventListener('click', async () => { const flows = selectedFlows(); const r = await api('/api/retry-failed', { method: 'POST', body: { flows, noProxy: noProxy() } }); toast(`Chạy lại: xếp ${r.queued} job failed/cần-tay`); });
$('btn-auto').addEventListener('click', async () => { reqNotify(); const flows = selectedFlows(); if (!flows.length) return toast('Chọn ít nhất 1 luồng'); const r = await api('/api/auto-run', { method: 'POST', body: { flows, noProxy: noProxy() } }); toast(`Auto Run (${flows.join('+')}): xếp ${r.queued} job`); });
$('btn-stop').addEventListener('click', async () => { await api('/api/stop', { method: 'POST' }); toast('Đã dừng scheduler'); });

// ---------- proxies ----------
async function loadProxies() {
  const { proxies } = await api('/api/proxies'); proxyLabels = proxies.map((p) => p.label);
  const body = $('proxy-body'); body.innerHTML = '';
  if (!proxies.length) body.innerHTML = `<tr><td colspan="4"><div class="empty">Chưa có proxy</div></td></tr>`;
  for (const p of proxies) {
    const tr = el('tr');
    tr.innerHTML = `<td class="mono">${esc(p.label)}</td><td id="pc-${cssId(p.label)}">${esc(p.country) || '—'}</td>
      <td><button class="sm" onclick="testProxy('${esc(p.label)}')" title="Test egress IP">${icon('zap')} Test</button> <span class="faint" id="pt-${cssId(p.label)}"></span></td>
      <td><button class="sm icon danger" onclick="delProxy('${esc(p.label)}')" title="Xoá proxy">${icon('trash')}</button></td>`;
    body.appendChild(tr);
  }
  $('a-proxy').innerHTML = ['<option value="">(chưa gán)</option>'].concat(proxyLabels.map((l) => `<option>${esc(l)}</option>`)).join('');
}
$('p-import').addEventListener('click', async () => { const r = await api('/api/proxies/import', { method: 'POST', body: { url: $('p-url').value, text: $('p-text').value, replace: $('p-replace').checked } }); if (r.error) return toast('Lỗi: ' + r.error); toast('Đã import ' + r.added + ' proxy'); $('p-text').value = ''; loadProxies(); loadSummary(); });
$('p-autoassign').addEventListener('click', async () => { const r = await api('/api/accounts/auto-proxy', { method: 'POST', body: {} }); if (r.error) return toast(r.error); toast('Đã gán proxy cho ' + r.assigned + ' account'); loadAccounts(); loadSummary(); });
async function testProxy(label) { const e = $('pt-' + cssId(label)); e.innerHTML = '<span class="spin"></span>'; const r = await api('/api/proxies/test/' + encodeURIComponent(label), { method: 'POST' }); if (r.ok) { e.textContent = `${r.ip} · ${r.ms}ms`; $('pc-' + cssId(label)).textContent = r.country || '—'; } else e.innerHTML = `<span style="color:var(--red)">✕ ${esc(r.error || 'fail')}</span>`; }
async function delProxy(label) { await api('/api/proxies/' + encodeURIComponent(label), { method: 'DELETE' }); loadProxies(); loadSummary(); }

// ---------- connections ----------
async function loadConnections() {
  const r = await api('/api/omniroute/connections'); const body = $('conn-body'); body.innerHTML = '';
  if (!r.ok) { $('conn-note').textContent = 'Lỗi: ' + r.error; return; }
  $('conn-note').textContent = `Tổng ${r.connections.length} connection.`;
  if (!r.connections.length) { body.innerHTML = `<tr><td colspan="6"><div class="empty">Chưa có connection</div></td></tr>`; return; }
  for (const c of r.connections.sort((a, b) => a.provider.localeCompare(b.provider))) {
    const tr = el('tr');
    const test = c.testStatus === 'active' ? '<span class="badge ok"><span class="bd"></span>active</span>' : c.testStatus === 'unknown' ? '<span class="chip">unknown</span>' : `<span class="badge failed"><span class="bd"></span>${esc(c.testStatus)}</span>`;
    tr.innerHTML = `<td><span class="chip">${esc(c.provider)}</span></td><td>${esc(c.name)}</td><td class="faint">${esc(c.authType)}</td><td>${test}</td><td>${c.proxyEnabled ? '✓' : '—'}</td><td class="faint">${c.createdAt ? new Date(c.createdAt).toLocaleString() : ''}</td>`;
    body.appendChild(tr);
  }
}

// ---------- tokens ----------
const tokSt = { page: 1, size: remember('tokSize', 50) };
function tokenParts(c) {
  if (c.target === 'kiro') { try { const j = JSON.parse(c.value); return { token: j.refreshToken || c.value, info: (j.profileArn ? j.profileArn.split('/').pop() : '') + (j.region ? ' · ' + j.region : '') }; } catch { return { token: c.value, info: '' }; } }
  if (c.target === 'gweb') return { token: c.value, info: c.expires_at ? 'hết hạn ' + new Date(c.expires_at).toLocaleDateString() : 'cookie' };
  return { token: c.value === 'stored_in_omniroute' ? '(lưu trong OmniRoute)' : c.value, info: c.omniroute_connection_id ? 'conn ' + c.omniroute_connection_id.slice(0, 8) : '' };
}
async function loadTokens() { const r = await api('/api/credentials'); credsCache = r.credentials || []; $('tc-tok').textContent = credsCache.length; renderTokens(); }
function renderTokenStats() {
  const stat = (t) => { const l = credsCache.filter((c) => c.target === t); return { alive: l.filter((c) => c.health === 'alive').length, dead: l.filter((c) => c.health === 'dead').length, tot: l.length }; };
  const a = stat('agy'), k = stat('kiro');
  $('stats-tok').innerHTML = mkCard('Antigravity token', a.tot, `🟢 ${a.alive} · 🔴 ${a.dead}`) + mkCard('Kiro token', k.tot, `🟢 ${k.alive} · 🔴 ${k.dead}`) + mkCard('Tổng credential', credsCache.length, '');
}
function renderTokens() {
  renderTokenStats();
  const f = $('tok-filter').value, hf = $('tok-health-filter').value, q = $('tok-search').value.trim().toLowerCase();
  const full = credsCache.filter((c) => (!f || c.target === f) && (!hf || (c.health || 'unknown') === hf) && (!q || c.email.toLowerCase().includes(q)))
    .sort((a, b) => (b.value !== 'stored_in_omniroute') - (a.value !== 'stored_in_omniroute'));
  const { rows, total, pages } = paginate(full, tokSt);
  const body = $('tok-body'); body.innerHTML = '';
  if (!total) { body.innerHTML = `<tr><td colspan="6"><div class="empty">Chưa có token</div></td></tr>`; $('tok-pager').innerHTML = ''; return; }
  rows.forEach((c, i) => {
    const { token, info } = tokenParts(c);
    const real = !(c.target === 'agy' && token.startsWith('('));
    const masked = token.length > 16 ? token.slice(0, 6) + '••••••' + token.slice(-4) : token;
    const hb = c.health === 'alive' ? '<span class="badge alive"><span class="bd"></span>alive</span>' : c.health === 'dead' ? '<span class="badge dead"><span class="bd"></span>dead</span>' : '<span class="chip">—</span>';
    const tr = el('tr');
    tr.innerHTML = `<td class="email">${esc(c.email)}</td><td><span class="chip">${esc(c.target)}</span></td><td>${hb}</td>
      <td class="mono" style="max-width:400px"><span id="tok-${i}" data-full="${esc(token)}" data-shown="0">${esc(masked)}</span>
        ${real ? `<button class="sm icon" title="Hiện/ẩn" onclick="toggleTok(${i})">${icon('eye')}</button><button class="sm icon" title="Copy" onclick="copyTok(${i})">${icon('copy')}</button>` : ''}</td>
      <td class="faint">${esc(info)}</td><td class="faint">${c.updated_at ? new Date(c.updated_at).toLocaleString() : ''}</td>`;
    body.appendChild(tr);
  });
  renderPager('tok-pager', tokSt, total, pages, () => { store_('tokSize', tokSt.size); renderTokens(); });
}
function toggleTok(i) { const s = $('tok-' + i); const full = s.dataset.full; if (s.dataset.shown === '1') { s.dataset.shown = '0'; s.textContent = full.length > 16 ? full.slice(0, 6) + '••••••' + full.slice(-4) : full; } else { s.dataset.shown = '1'; s.textContent = full; } }
async function copyTok(i) { try { await navigator.clipboard.writeText($('tok-' + i).dataset.full); toast('Đã copy token'); } catch { toast('Copy lỗi'); } }
$('tok-filter').addEventListener('change', () => { tokSt.page = 1; renderTokens(); });
$('tok-health-filter').addEventListener('change', () => { tokSt.page = 1; renderTokens(); });
$('tok-search').addEventListener('input', debounce(() => { tokSt.page = 1; renderTokens(); }, 200));
$('tok-health').addEventListener('click', (e) => withSpin(e.currentTarget, async () => { const f = $('tok-filter').value; const r = await api('/api/tokens/check', { method: 'POST', body: f ? { target: f } : {} }); if (r.ok) toast(`Health: 🟢${r.alive} 🔴${r.dead} ⚪${r.unknown} / ${r.total}`); loadTokens(); }));
$('tok-export').addEventListener('click', () => {
  const f = $('tok-filter').value, hf = $('tok-health-filter').value, q = $('tok-search').value.trim().toLowerCase();
  const list = credsCache.filter((c) => (!f || c.target === f) && (!hf || (c.health || 'unknown') === hf) && (!q || c.email.toLowerCase().includes(q)));
  const rows = [['email', 'target', 'value', 'health', 'omniroute_connection_id', 'updated_at']];
  for (const c of list) rows.push([c.email, c.target, c.value, c.health || '', c.omniroute_connection_id || '', c.updated_at || '']);
  downloadFile('credentials' + (f ? '_' + f : '') + '.csv', rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv');
  toast('Đã export ' + list.length + ' token');
});
function downloadFile(name, content, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); }

// ---------- Pool (Antigravity gateway) ----------
const agySt = { page: 1, size: remember('agySize', 50) };
let agyAccounts = [], agyModels = [], agyCfg = {}, agySelected = new Set();
let agyProv = remember('agyProv', 'agy'); // provider đang xem ở trang Pool
async function loadAgy() {
  const [ac, cf, md] = await Promise.all([api('/api/gateway/accounts'), api('/api/gateway/config'), api('/api/gateway/models')]);
  agyAccounts = ac.accounts || []; agyCfg = cf || {}; agyModels = md.models || [];
  const pc = ac.counts || {};
  if ($('pc-agy')) $('pc-agy').textContent = pc.agy ?? 0;
  if ($('pc-kr')) $('pc-kr').textContent = pc.kr ?? 0;
  document.querySelectorAll('#agy-prov button').forEach((x) => x.classList.toggle('active', x.dataset.p === agyProv));
  $('agy-baseurl').value = agyCfg.baseUrl || (location.origin + '/proxy/v1');
  $('agy-apikey').value = agyCfg.apiKey || '';
  $('agy-proxy').value = agyCfg.outboundProxy || '';
  document.querySelectorAll('#agy-strategy button').forEach((b) => b.classList.toggle('active', b.dataset.s === (agyCfg.rotation || 'round-robin')));
  $('agy-chat-model').innerHTML = agyModels.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  $('agy-chat-account').innerHTML = '<option value="auto">auto (theo chiến lược)</option>' + agyAccounts.filter((a) => a.enabled).map((a) => `<option value="${esc(a.email)}">${esc(a.email)}</option>`).join('');
  $('tc-agy').textContent = agyAccounts.filter((a) => a.enabled).length;
  if (!$('agy-models').dataset.checked) renderModelChips(agyModels.map((m) => ({ id: m.id, status: m.image ? 'image' : 'unknown' })));
  renderAgyStats(); renderAgy();
}
function renderModelChips(list) {
  const tip = { ok: 'Gọi được ✓', quota: 'Hết hạn mức tạm thời', error: 'Gọi lỗi', image: 'Model ảnh (chưa kiểm)', unknown: 'Chưa kiểm — bấm Check live' };
  $('agy-models').innerHTML = list.map((m) => {
    const st = m.status || 'unknown';
    const img = m.image || st === 'image' ? '<span class="mc-img" title="Model ảnh">🖼</span>' : '';
    return `<span class="chip model-chip ${st}" title="${esc(tip[st] || st)}${m.detail ? ' — ' + esc(m.detail) : ''}">
      <span class="mc-dot"></span>${img}<b class="mc-id">${esc(m.id)}</b>${m.ms ? `<span class="faint mc-ms">${m.ms}ms</span>` : ''}
      <button class="mc-copy" data-model="${esc(m.id)}" title="Copy tên model">${icon('copy')}</button>
    </span>`;
  }).join('');
  document.querySelectorAll('.mc-copy').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.model); toast('Đã copy: ' + b.dataset.model); }
    catch { toast('Copy lỗi'); }
  }));
}
function renderAgyStats() {
  const on = agyAccounts.filter((a) => a.enabled).length, cd = agyAccounts.filter((a) => a.cooldown).length;
  const req = agyAccounts.reduce((s, a) => s + a.requests, 0), tok = agyAccounts.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0);
  const dead = agyAccounts.filter((a) => a.health === 'dead').length;
  $('stats-agy').innerHTML = mkCard('Account bật', on + ' / ' + agyAccounts.length, 'đang phục vụ') + mkCard('Requests', fmtNum(req), 'tổng đã gọi') + mkCard('Tokens', fmtNum(tok), 'in + out') + mkCard('Cooldown', cd, 'nghỉ (429)') + mkCard('Token chết', dead, 'cần re-login');
}
function agyFilterSort() {
  const q = ($('agy-search').value || '').toLowerCase(), f = $('agy-filter').value, s = $('agy-sort').value;
  let list = agyAccounts.filter((a) => (a.provider || 'agy') === agyProv && a.email.toLowerCase().includes(q));
  if (f === 'on') list = list.filter((a) => a.enabled);
  else if (f === 'off') list = list.filter((a) => !a.enabled);
  else if (f === 'cooldown') list = list.filter((a) => a.cooldown);
  else if (f === 'dead') list = list.filter((a) => a.health === 'dead');
  if (s === 'requests') list.sort((a, b) => b.requests - a.requests);
  else if (s === 'quota') list.sort((a, b) => (b.geminiPct ?? -1) - (a.geminiPct ?? -1));
  else list.sort((a, b) => a.email.localeCompare(b.email));
  return list;
}
function claudePct(a) { const g = (a.quota && a.quota.groups) ? a.quota.groups.find((x) => !/gemini/i.test(x.name)) : null; return g ? g.pct : null; }
function tokenBadge(health) { const c = health === 'alive' ? 'alive' : health === 'dead' ? 'dead' : 'new'; return `<span class="badge ${c}"><span class="bd"></span>${esc(health || '—')}</span>`; }
function liveBadge(s) { if (!s) return '<span class="chip">—</span>'; const map = { ok: ['alive', '✓ live'], quota: ['needs_human', '⏳ quota'], error: ['dead', '✗ lỗi'] }; const [cls, lbl] = map[s] || ['new', s]; return `<span class="badge ${cls}"><span class="bd"></span>${lbl}</span>`; }
function renderAgy() {
  syncPoolHeaders();
  const body = $('agy-body'); body.innerHTML = '';
  const full = agyFilterSort();
  const { rows, total, pages } = paginate(full, agySt);
  if (!total) {
    body.innerHTML = `<tr><td colspan="10"><div class="empty">${agyProv === 'kr'
      ? 'Chưa có account Kiro nào có token. Harvest luồng kiro trước (Tài khoản → Auto Run).'
      : 'Chưa có account Antigravity nào có token. Harvest luồng agy trước (Tài khoản → Auto Run).'}</div></td></tr>`;
    $('agy-pager').innerHTML = ''; return;
  }
  for (const a of rows) {
    const tr = el('tr'); tr.dataset.email = a.email; if (!a.enabled) tr.classList.add('off'); if (a.cooldown) tr.classList.add('cooldown');
    const gpct = a.geminiPct, cpct = claudePct(a);
    // Kiro: hạn mức THẬT lấy từ GetUsageLimits (nhóm 'Credits'), + kết quả dò gần nhất
    const krCredit = a.quota?.groups?.[0];
    const quotaCells = a.provider === 'kr'
      ? `<td class="qcell" title="${esc(krCredit?.desc || 'Bấm nút ⟲ để nạp hạn mức thật (không tốn credit)')}">
           ${krCredit ? `<span class="${qColor(krCredit.pct)}">${krCredit.pct}%</span> <span class="faint">${esc(String(krCredit.desc || '').split('·')[0].trim())}</span>`
             : '<span class="faint">chưa nạp</span>'}</td>
         <td class="qcell">${a.liveStatus === 'ok' ? '<span class="q-hi">gọi được</span>' : a.liveStatus === 'quota' ? '<span class="q-lo">hết credit</span>' : '<span class="faint">chưa dò</span>'}</td>`
      : `<td class="qcell">${gpct == null ? '<span class="faint">—</span>' : `<span class="${qColor(gpct)}">${gpct}%</span>`}</td>
         <td class="qcell">${cpct == null ? '<span class="faint">—</span>' : `<span class="${qColor(cpct)}">${cpct}%</span>`}</td>`;
    tr.innerHTML = `
      <td><input type="checkbox" class="agy-chk" data-email="${esc(a.email)}" ${agySelected.has(a.email) ? 'checked' : ''}></td>
      <td><label class="switch"><input type="checkbox" class="agy-tog" data-email="${esc(a.email)}" ${a.enabled ? 'checked' : ''}/><span class="track"></span></label></td>
      <td class="email">${esc(a.email)}</td>
      ${quotaCells}
      <td>${a.requests}</td>
      <td class="mono faint">${fmtNum(a.tokensIn)}/${fmtNum(a.tokensOut)}</td>
      <td class="c-token">${tokenBadge(a.health)}</td>
      <td class="c-live">${liveBadge(a.liveStatus)}</td>
      <td class="act">
        <button class="sm icon agy-test" data-email="${esc(a.email)}" title="Check token (còn sống?)">${icon('activity')}</button>
        <button class="sm icon agy-live" data-email="${esc(a.email)}" title="Check live (gọi model được?)">${icon('zap')}</button>
        <button class="sm icon agy-quota" data-email="${esc(a.email)}" title="Nạp hạn mức">${icon('gauge')}</button>
        <button class="sm icon" title="Chat thử account này" onclick="agyChatWith('${esc(a.email)}')">${icon('msg')}</button>
      </td>`;
    body.appendChild(tr);
  }
  body.querySelectorAll('.agy-tog').forEach((c) => c.addEventListener('change', async () => {
    const a = agyAccounts.find((x) => x.email === c.dataset.email); if (a) a.enabled = c.checked; renderAgyStats(); // optimistic
    const r = await api('/api/gateway/accounts/' + encodeURIComponent(c.dataset.email) + '/toggle?provider=' + agyProv, { method: 'POST', body: { enabled: c.checked } });
    if (!r.ok) { if (a) a.enabled = !c.checked; renderAgy(); renderAgyStats(); toast('Đổi trạng thái lỗi'); }
    $('tc-agy').textContent = agyAccounts.filter((x) => x.enabled).length;
  }));
  body.querySelectorAll('.agy-chk').forEach((c) => c.addEventListener('change', () => { if (c.checked) agySelected.add(c.dataset.email); else agySelected.delete(c.dataset.email); updateAgySel(); }));
  body.querySelectorAll('.agy-test').forEach((b) => b.addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
    const r = await api('/api/gateway/accounts/' + encodeURIComponent(b.dataset.email) + '/test?provider=' + agyProv, { method: 'POST' });
    const a = agyAccounts.find((x) => x.email === b.dataset.email); if (a) a.health = r.alive ? 'alive' : 'dead';
    toast(`${b.dataset.email.split('@')[0]}: token ${r.alive ? 'sống ✓' : 'CHẾT ✗'} (${r.ms}ms)`); renderAgy();
  })));
  body.querySelectorAll('.agy-live').forEach((b) => b.addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
    const r = await api('/api/gateway/accounts/' + encodeURIComponent(b.dataset.email) + '/checklive?provider=' + agyProv, { method: 'POST' });
    const a = agyAccounts.find((x) => x.email === b.dataset.email); if (a) a.liveStatus = r.status;
    toast(`${b.dataset.email.split('@')[0]}: live ${r.status === 'ok' ? '✓ ok' : r.status === 'quota' ? '⏳ quota' : '✗ ' + (r.detail || 'lỗi')} (${r.ms}ms)`); renderAgy();
  })));
  body.querySelectorAll('.agy-quota').forEach((b) => b.addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
    const r = await api('/api/gateway/quota/' + encodeURIComponent(b.dataset.email) + '?provider=' + agyProv, { method: 'POST' });
    if (r.ok) { const a = agyAccounts.find((x) => x.email === b.dataset.email); if (a) { a.quota = r.quota; a.geminiPct = (r.quota.groups.find((g) => /gemini/i.test(g.name)) || {}).pct ?? null; } toast('Đã nạp hạn mức ' + b.dataset.email.split('@')[0]); renderAgy(); }
    else toast('Lỗi quota: ' + (r.error || ''));
  })));
  renderPager('agy-pager', agySt, total, pages, () => { store_('agySize', agySt.size); renderAgy(); });
  updateAgySel();
}
function updateAgySel() { const n = agySelected.size; $('agy-selcount').textContent = n ? `${n} đã chọn` : '0 đã chọn'; $('agy-bulk').classList.toggle('on', n > 0); }
['agy-search', 'agy-filter', 'agy-sort'].forEach((id) => $(id).addEventListener('input', () => { agySt.page = 1; renderAgy(); }));
$('agy-check-all').addEventListener('change', (e) => { const { rows } = paginate(agyFilterSort(), agySt); rows.forEach((a) => e.target.checked ? agySelected.add(a.email) : agySelected.delete(a.email)); renderAgy(); });
$('agy-copy-url').addEventListener('click', () => { navigator.clipboard.writeText($('agy-baseurl').value); toast('Đã copy Base URL'); });
$('agy-copy-key').addEventListener('click', () => { navigator.clipboard.writeText($('agy-apikey').value); toast('Đã copy API key'); });
$('agy-regen-key').addEventListener('click', async () => { const r = await api('/api/gateway/config', { method: 'PATCH', body: { regenerateKey: true } }); $('agy-apikey').value = r.config.apiKey; toast('Đã sinh API key mới'); });
$('agy-save-cfg').addEventListener('click', async () => { await api('/api/gateway/config', { method: 'PATCH', body: { apiKey: $('agy-apikey').value.trim(), outboundProxy: $('agy-proxy').value.trim() } }); toast('Đã lưu cấu hình gateway'); });
$('agy-strategy').addEventListener('click', async (e) => { const b = e.target.closest('button[data-s]'); if (!b) return; document.querySelectorAll('#agy-strategy button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); await api('/api/gateway/config', { method: 'PATCH', body: { rotation: b.dataset.s } }); toast('Chiến lược: ' + b.textContent.trim()); });
$('agy-all-on').addEventListener('click', (e) => withSpin(e.currentTarget, async () => { await api('/api/gateway/accounts/bulk', { method: 'POST', body: { enabled: true } }); toast('Đã bật tất cả'); loadAgy(); }));
$('agy-all-off').addEventListener('click', async (e) => { if (!confirmAct('Tắt tất cả account?')) return; await api('/api/gateway/accounts/bulk', { method: 'POST', body: { enabled: false } }); toast('Đã tắt tất cả'); loadAgy(); });
$('agy-check-models').addEventListener('click', (e) => withSpin(e.currentTarget, async () => { toast('Đang test model live…'); const r = await api('/api/gateway/models/check', { method: 'POST' }); if (r.models) { renderModelChips(r.models); $('agy-models').dataset.checked = '1'; toast(`Check live qua ${r.account.split('@')[0]}: ${r.models.filter((m) => m.status === 'ok').length}/${r.models.length} ok`); } else toast('Lỗi: ' + (r.error || '')); }));
$('agy-refresh-quota').addEventListener('click', (e) => withSpin(e.currentTarget, async () => { const r = await api('/api/gateway/quota/refresh?provider=' + agyProv, { method: 'POST', body: {} }); toast(`Đang nạp hạn mức ${r.queued} account ${agyProv} (nền)…`); }));

// tab provider ở trang Pool
$('agy-prov').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]'); if (!b) return;
  document.querySelectorAll('#agy-prov button').forEach((x) => x.classList.toggle('active', x === b));
  agyProv = b.dataset.p; store_('agyProv', agyProv);
  agySelected.clear(); updateAgySel();
  agySt.page = 1;
  renderAgy(); renderAgyStats();
});
/** Cột quota chỉ có nghĩa với Antigravity — đổi tiêu đề khi xem Kiro. */
function syncPoolHeaders() {
  const ths = document.querySelectorAll('#view-agy thead th');
  if (ths.length < 5) return;
  const kr = agyProv === 'kr';
  ths[3].textContent = kr ? 'Credit còn' : 'Gemini';
  ths[4].textContent = kr ? 'Dò gần nhất' : 'Claude/GPT';
  const rq = $('agy-refresh-quota');
  if (rq) rq.style.display = ''; // Kiro CÓ API hạn mức thật (GetUsageLimits), không tốn credit
}
$('agy-bulk-on').addEventListener('click', async () => { await api('/api/gateway/accounts/bulk', { method: 'POST', body: { emails: [...agySelected], enabled: true } }); toast('Đã bật ' + agySelected.size); loadAgy(); });
$('agy-bulk-off').addEventListener('click', async () => { await api('/api/gateway/accounts/bulk', { method: 'POST', body: { emails: [...agySelected], enabled: false } }); toast('Đã tắt ' + agySelected.size); loadAgy(); });
$('agy-bulk-quota').addEventListener('click', async () => { const r = await api('/api/gateway/quota/refresh', { method: 'POST', body: { emails: [...agySelected] } }); toast(`Đang nạp hạn mức ${r.queued} account (nền)…`); });
// ---- Check token/live (từng account hoặc tất cả) realtime ----
let checkTotal = 0, checkDone = 0;
async function startCheck(emails, mode) {
  const r = await api('/api/gateway/accounts/check', { method: 'POST', body: { emails, mode } });
  checkTotal = r.queued; checkDone = 0;
  $('agy-checkbar').classList.add('on');
  $('agy-check-label').textContent = `Đang check ${mode === 'live' ? 'live' : mode === 'both' ? 'token+live' : 'token'}…`;
  $('agy-check-fill').style.width = '0%'; $('agy-check-meta').textContent = `0/${checkTotal}`;
  toast(`Đang check ${r.queued} account (realtime)…`);
}
$('agy-check-token-all').addEventListener('click', () => startCheck([], 'token'));
$('agy-check-live-all').addEventListener('click', () => startCheck([], 'live'));
$('agy-bulk-test').addEventListener('click', () => startCheck([...agySelected], 'token'));
$('agy-bulk-live').addEventListener('click', () => startCheck([...agySelected], 'live'));
// cập nhật 1 dòng account theo sự kiện check realtime
function applyCheckEvent(email, check) {
  const a = agyAccounts.find((x) => x.email === email);
  if (a) {
    if (check.kind === 'token') a.health = check.result === 'alive' ? 'alive' : check.result === 'dead' ? 'dead' : a.health;
    else if (check.kind === 'live') a.liveStatus = check.result;
  }
  const tr = document.querySelector(`#agy-body tr[data-email="${CSS.escape(email)}"]`);
  if (tr && a) { const tc = tr.querySelector('.c-token'); if (tc) tc.innerHTML = tokenBadge(a.health); const lc = tr.querySelector('.c-live'); if (lc) lc.innerHTML = liveBadge(a.liveStatus); }
  if (check.total) { checkTotal = check.total; checkDone = check.done || checkDone + 1; const pct = Math.round((checkDone / checkTotal) * 100); $('agy-check-fill').style.width = pct + '%'; $('agy-check-meta').textContent = `${checkDone}/${checkTotal}`; if (checkDone >= checkTotal) { setTimeout(() => { $('agy-checkbar').classList.remove('on'); renderAgyStats(); }, 1200); toast('Check xong'); } }
}
$('agy-chat-reload').addEventListener('click', () => loadAgy());
function agyChatWith(email) { document.querySelector('.nav-item[data-tab="chat"]').click(); setTimeout(() => { const sel = $('agy-chat-account'); if (![...sel.options].some((o) => o.value === email)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(email)}">${esc(email)}</option>`); sel.value = email; $('agy-chat-content').focus(); }, 150); }
$('agy-chat-send').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  const model = $('agy-chat-model').value, content = $('agy-chat-content').value, account = $('agy-chat-account').value, proxy = $('agy-chat-proxy').value.trim();
  const out = $('agy-chat-out'); out.className = ''; out.innerHTML = '<span class="spin"></span> đang gọi model…';
  const r = await api('/api/gateway/chat', { method: 'POST', body: { model, content, account, proxy } });
  if (r.ok) {
    let html = `<div class="agy-out"><div class="meta"><span>✓ <b>${esc(r.model)}</b></span><span>account <b>${esc(r.account)}</b></span><span>${r.ms}ms</span><span>${(r.usage && r.usage.totalTokens) || 0} tok</span></div>`;
    if (r.text) html += `<div class="txt">${esc(r.text)}</div>`;
    for (const img of (r.images || [])) html += `<img src="${img}" alt="ảnh sinh bởi model"/>`;
    out.innerHTML = html + '</div>';
  } else { out.innerHTML = `<div class="agy-out err"><b>✕ Lỗi (${esc(r.account || '')})</b><div class="mono" style="margin-top:6px">${esc(r.error || '')}</div></div>`; }
}));

// ---------- Hạn mức ----------
const quotaSt = { page: 1, size: remember('quotaSize', 25) };
let quotaMode = remember('quotaMode', 'table');
const quotaTried = new Set(); let quotaAutoRunning = false;
async function loadQuota() {
  document.querySelectorAll('#quota-mode button').forEach((b) => b.classList.toggle('active', b.dataset.m === quotaMode));
  const ac = await api('/api/gateway/accounts'); agyAccounts = ac.accounts || [];
  renderQuotaStats(); renderQuota(); loadQuotaHistory();
}

// ---------- biểu đồ lịch sử hạn mức ----------
let qhEmail = null; // null = toàn pool
async function loadQuotaHistory() {
  const box = $('qh-chart'); if (!box) return;
  const range = $('qh-range').value || '7d';
  skeleton('qh-chart', 3);
  const q = qhEmail ? `?email=${encodeURIComponent(qhEmail)}&range=${range}` : `?range=${range}`;
  const d = await api('/api/gateway/quota/history' + q);
  $('qh-all').style.display = qhEmail ? '' : 'none';
  $('qh-title').textContent = qhEmail ? `Xu hướng hạn mức · ${qhEmail}` : 'Xu hướng hạn mức theo thời gian (trung bình toàn pool)';

  if (qhEmail) {
    const pts = d.points || [];
    if (!pts.length) { box.innerHTML = '<div class="empty">Chưa có lịch sử cho account này — bấm nút Quota ở trang Pool để nạp.</div>'; return; }
    const gem = pts.map((p) => p.gemini_pct ?? 0), th = pts.map((p) => p.third_pct ?? 0);
    box.innerHTML = svgLine(null, { series: [
      { values: gem, color: 'var(--green)' }, { values: th, color: 'var(--purple)' },
    ], min: 0, max: 100, h: 120, area: false }) + chartLegend(
      [{ label: 'Gemini', color: 'var(--green)' }, { label: 'Claude/GPT', color: 'var(--purple)' }],
      new Date(pts[0].ts).toLocaleString(), new Date(pts[pts.length - 1].ts).toLocaleString(), 0, 100);
    return;
  }
  const s = d.series || [];
  if (!s.length) { box.innerHTML = '<div class="empty">Chưa có dữ liệu lịch sử. Bấm <b>Refresh</b> để nạp hạn mức — mỗi lần nạp sẽ ghi 1 điểm.</div>'; return; }
  box.innerHTML = svgLine(null, { series: [
    { values: s.map((x) => x.gemini ?? 0), color: 'var(--green)' },
    { values: s.map((x) => x.third ?? 0), color: 'var(--purple)' },
  ], min: 0, max: 100, h: 120, area: false }) + chartLegend(
    [{ label: 'Gemini', color: 'var(--green)' }, { label: 'Claude/GPT', color: 'var(--purple)' }],
    s[0].bucket, s[s.length - 1].bucket, 0, 100) +
    `<div class="faint" style="font-size:11.5px;margin-top:4px">${d.total} bản ghi · gộp theo ${d.groupBy === 'hour' ? 'giờ' : 'ngày'} · click email trong bảng dưới để xem riêng 1 account</div>`;
}
$('qh-range').addEventListener('change', loadQuotaHistory);
$('qh-all').addEventListener('click', () => { qhEmail = null; loadQuotaHistory(); });
function showQuotaHistory(email) { qhEmail = email; loadQuotaHistory(); $('qh-chart').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function renderQuotaStats() {
  const withQ = agyAccounts.filter((a) => a.quota);
  const gem = withQ.map((a) => a.geminiPct ?? 0), cl = withQ.map((a) => claudePct(a) ?? 0);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
  const tiers = {}; withQ.forEach((a) => { if (a.quota.tier) tiers[a.quota.tier] = (tiers[a.quota.tier] || 0) + 1; });
  const tierStr = Object.entries(tiers).map(([k, v]) => `${k}:${v}`).join(' · ') || '—';
  const g = avg(gem), c = avg(cl);
  $('stats-quota').innerHTML = mkCard('Đã nạp hạn mức', `${withQ.length}/${agyAccounts.length}`, withQ.length < agyAccounts.length ? 'đang tự nạp…' : 'account có dữ liệu') +
    `<div class="card"><div class="label">Gemini TB</div><div class="value">${g == null ? '—' : g + '%'}</div><div class="sub">${qbar(g)}</div></div>` +
    `<div class="card"><div class="label">Claude/GPT TB</div><div class="value">${c == null ? '—' : c + '%'}</div><div class="sub">${qbar(c)}</div></div>` +
    mkCard('Tier', tierStr, 'gói account');
}
// tự nạp quota cho account trên trang đang xem (nền, giãn nhịp, mỗi account 1 lần)
async function autoFetchQuota(rows) {
  const todo = rows.filter((a) => !a.quota && !quotaTried.has(a.email));
  if (!todo.length || quotaAutoRunning) return;
  quotaAutoRunning = true;
  for (const a of todo) {
    quotaTried.add(a.email);
    if (!$('view-quota').classList.contains('active')) break;
    try {
      const r = await api('/api/gateway/quota/' + encodeURIComponent(a.email), { method: 'POST' });
      if (r.ok) { const acc = agyAccounts.find((x) => x.email === a.email); if (acc) { acc.quota = r.quota; acc.geminiPct = (r.quota.groups.find((g) => /gemini/i.test(g.name)) || {}).pct ?? null; } if ($('view-quota').classList.contains('active')) { renderQuotaStats(); renderQuota(); } }
    } catch {}
    await new Promise((r) => setTimeout(r, 350));
  }
  quotaAutoRunning = false;
}
function quotaList() {
  const q = ($('quota-search').value || '').toLowerCase(), s = $('quota-sort').value;
  let list = agyAccounts.filter((a) => a.email.toLowerCase().includes(q));
  if (s === 'email') list.sort((a, b) => a.email.localeCompare(b.email));
  else if (s === 'quota-low') list.sort((a, b) => (a.geminiPct ?? 101) - (b.geminiPct ?? 101));
  else list.sort((a, b) => (b.geminiPct ?? -1) - (a.geminiPct ?? -1));
  return list;
}
function renderQuota() {
  const full = quotaList();
  const { rows, total, pages } = paginate(full, quotaSt);
  const box = $('quota-body');
  if (!total) { box.innerHTML = `<div class="empty">Chưa có account. Bấm Refresh để nạp hạn mức.</div>`; $('quota-pager').innerHTML = ''; return; }
  if (quotaMode === 'card') box.innerHTML = '<div class="qcards">' + rows.map(quotaCard).join('') + '</div>';
  else box.innerHTML = quotaTable(rows);
  wireQuotaRefresh();
  renderPager('quota-pager', quotaSt, total, pages, () => { store_('quotaSize', quotaSt.size); renderQuota(); });
  autoFetchQuota(rows);
}
function modelCols() {
  const set = new Set();
  for (const a of agyAccounts) if (a.quota && a.quota.models) for (const m of a.quota.models) {
    if (/^(chat|tab)[-_]/i.test(m.id)) continue; // bỏ id nội bộ (experiment/tab)
    set.add(m.id);
  }
  return [...set].sort();
}
function quotaTable(rows) {
  const cols = modelCols();
  const head = `<tr><th>Email</th><th>Tier</th><th>Gemini</th><th>Claude/GPT</th>${cols.map((c) => `<th title="${esc(c)}">${esc(c.replace(/^gemini-|^claude-/, ''))}</th>`).join('')}<th>Reset</th></tr>`;
  const body = rows.map((a) => {
    const q = a.quota; const cpct = claudePct(a);
    const mmap = {}; if (q && q.models) for (const m of q.models) mmap[m.id] = m.pct;
    const reset = q && q.groups && q.groups[0] ? fmtReset(q.groups[0].resetTime) : '—';
    const cell = (p) => p == null ? '<span class="faint">—</span>' : `<span class="${qColor(p)}">${p}%</span>`;
    return `<tr><td class="email"><a class="qh-link" data-email="${esc(a.email)}" title="Xem lịch sử hạn mức của account này">${esc(a.email)}</a></td><td class="faint">${esc((q && q.tier) || '—')}</td><td class="qcell">${cell(a.geminiPct)}</td><td class="qcell">${cell(cpct)}</td>${cols.map((c) => `<td class="qcell">${cell(mmap[c])}</td>`).join('')}<td class="faint">${reset} <button class="sm icon q-refresh" data-email="${esc(a.email)}" title="Nạp">${icon('refresh')}</button></td></tr>`;
  }).join('');
  return `<div class="tablewrap"><table class="quota-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
function quotaCard(a) {
  const q = a.quota;
  if (!q) return `<div class="qcard empty-card"><div class="qc-head"><b>${esc(a.email)}</b><button class="sm q-refresh" data-email="${esc(a.email)}">${icon('refresh')} Nạp</button></div><div class="faint">Chưa có hạn mức</div></div>`;
  const groups = (q.groups || []).map((g) => `<div class="qc-group"><div class="qc-grow"><span>${esc(g.name)}</span><span class="faint">reset ${fmtReset(g.resetTime)}</span></div>${qbar(g.pct)}</div>`).join('');
  const models = (q.models || []).map((m) => `<span class="chip"><span class="${qColor(m.pct)}">${m.pct}%</span> ${esc(m.id)}</span>`).join('');
  return `<div class="qcard"><div class="qc-head"><b>${esc(a.email)}</b><span class="chip">${esc(q.tier || '—')}</span><button class="sm icon q-refresh" data-email="${esc(a.email)}" title="Nạp lại">${icon('refresh')}</button></div>${groups}<div class="qc-models">${models}</div></div>`;
}
function wireQuotaRefresh() {
  document.querySelectorAll('#quota-body .qh-link').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); showQuotaHistory(a.dataset.email);
  }));
  document.querySelectorAll('#quota-body .q-refresh').forEach((b) => b.addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
    const r = await api('/api/gateway/quota/' + encodeURIComponent(b.dataset.email) + '?provider=' + agyProv, { method: 'POST' });
    if (r.ok) { const a = agyAccounts.find((x) => x.email === b.dataset.email); if (a) { a.quota = r.quota; a.geminiPct = (r.quota.groups.find((g) => /gemini/i.test(g.name)) || {}).pct ?? null; } toast('Đã nạp ' + b.dataset.email.split('@')[0]); renderQuota(); }
    else toast('Lỗi: ' + (r.error || ''));
  })));
}
$('quota-mode').addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (!b) return; quotaMode = b.dataset.m; store_('quotaMode', quotaMode); document.querySelectorAll('#quota-mode button').forEach((x) => x.classList.toggle('active', x === b)); renderQuota(); });
$('quota-search').addEventListener('input', debounce(() => { quotaSt.page = 1; renderQuota(); }, 200));
$('quota-sort').addEventListener('change', () => { quotaSt.page = 1; renderQuota(); });
$('quota-refresh').addEventListener('click', (e) => withSpin(e.currentTarget, async () => { const r = await api('/api/gateway/quota/refresh', { method: 'POST', body: {} }); toast(`Đang nạp hạn mức ${r.queued} account (nền)…`); }));

// ---------- Báo cáo sử dụng ----------
const usageAccSt = { page: 1, size: 25 };
let usageData = null;
async function loadUsage() {
  const range = $('usage-range').value, group = document.querySelector('#usage-group button.active').dataset.g;
  $('usage-export').href = `/api/gateway/usage/export.csv?range=${range}`;
  const d = await api(`/api/gateway/usage?range=${range}&groupBy=${group}`); usageData = d;
  const t = d.totals;
  $('usage-totals').innerHTML = mkCard('Requests', fmtNum(t.requests), 'trong khoảng') + mkCard('Tokens in', fmtNum(t.tokIn), '') + mkCard('Tokens out', fmtNum(t.tokOut), '') + mkCard('Account hoạt động', t.accounts, '');
  const maxR = Math.max(1, ...d.series.map((s) => s.requests));
  $('usage-series').innerHTML = d.series.length ? d.series.map((s) => `<div class="ubar-row"><span class="ubar-lbl">${esc(s.bucket)}</span><div class="ubar"><i style="width:${Math.round((s.requests / maxR) * 100)}%"></i></div><span class="ubar-val">${s.requests} req · ${fmtNum(s.tokIn + s.tokOut)} tok</span></div>`).join('') : '<div class="empty">Chưa có dữ liệu sử dụng</div>';
  $('usage-models').innerHTML = d.byModel.length ? d.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td>${m.requests}</td><td class="faint">${fmtNum(m.tokIn + m.tokOut)}</td></tr>`).join('') : `<tr><td colspan="3"><div class="empty">—</div></td></tr>`;
  renderUsageAccounts();
}
function renderUsageAccounts() {
  if (!usageData) return;
  const { rows, total, pages } = paginate(usageData.byAccount, usageAccSt);
  $('usage-accounts').innerHTML = total ? rows.map((a) => `<tr><td class="email">${esc(a.email)}</td><td>${a.requests}</td><td class="faint">${fmtNum(a.tokIn + a.tokOut)}</td></tr>`).join('') : `<tr><td colspan="3"><div class="empty">—</div></td></tr>`;
  renderPager('usage-acc-pager', usageAccSt, total, pages, renderUsageAccounts);
}
$('usage-range').addEventListener('change', loadUsage);
$('usage-group').addEventListener('click', (e) => { const b = e.target.closest('button[data-g]'); if (!b) return; document.querySelectorAll('#usage-group button').forEach((x) => x.classList.toggle('active', x === b)); loadUsage(); });

// ---------- add ----------
$('add-seg').addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (!b) return; document.querySelectorAll('#add-seg button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); ['single', 'bulk', 'gen', 'file'].forEach((m) => $('add-' + m).style.display = m === b.dataset.m ? 'block' : 'none'); });
async function addSingle() { if (!$('a-email').value.trim()) return toast('Thiếu email'); await api('/api/accounts', { method: 'POST', body: { email: $('a-email').value.trim(), password: $('a-pass').value, totp_secret: $('a-totp').value.trim(), proxy: $('a-proxy').value } }); $('a-email').value = ''; toast('Đã thêm'); loadAccounts(); loadSummary(); }
async function importBulk() { const r = await api('/api/accounts/import', { method: 'POST', body: { text: $('a-bulk').value } }); toast('Đã import ' + r.added + ' account'); $('a-bulk').value = ''; loadAccounts(); loadSummary(); }
async function genRange() { const r = await api('/api/accounts/generate', { method: 'POST', body: { prefix: $('g-prefix').value.trim(), start: +$('g-start').value, end: +$('g-end').value, domain: $('g-domain').value.trim(), password: $('g-pass').value, extra: $('g-extra').value } }); toast('Đã sinh ' + r.added + ' account'); loadAccounts(); loadSummary(); }
$('a-file-import').addEventListener('click', () => { const f = $('a-file').files[0]; if (!f) return toast('Chọn file'); const rd = new FileReader(); rd.onload = async () => { const r = await api('/api/accounts/import', { method: 'POST', body: { text: String(rd.result) } }); toast('Đã import ' + r.added + ' account'); loadAccounts(); loadSummary(); }; rd.readAsText(f); });

// ---------- Models (tách theo provider) ----------
let modelsCache = [];
async function loadModels() {
  const [g, accs] = await Promise.all([api('/api/gateway/models'), api('/api/gateway/accounts')]);
  modelsCache = g.models || [];
  $('tc-models').textContent = modelsCache.length;
  const byProv = {};
  for (const m of modelsCache) (byProv[m.provider] ??= []).push(m);
  const counts = accs.counts || {};
  const okOf = (p) => (accs.accounts || []).filter((a) => a.provider === p && !a.cooldown && a.enabled).length;
  $('models-groups').innerHTML = Object.entries(byProv).map(([pid, list]) => `
    <div class="panel">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3 style="margin:0">${esc(list[0].providerLabel || pid)} <span class="chip">${esc(pid)}/</span></h3>
        <span class="faint">${counts[pid] ?? 0} account · ${okOf(pid)} sẵn sàng
          <button class="sm" data-copyall="${esc(pid)}" title="Copy tất cả id">${icon('copy')} Copy tất cả</button></span>
      </div>
      <div class="chips" id="mg-${esc(pid)}" style="margin-top:10px">${list.map((m) => modelChip(m)).join('')}</div>
    </div>`).join('');
  wireModelChips();
  document.querySelectorAll('[data-copyall]').forEach((b) => b.addEventListener('click', async () => {
    const ids = modelsCache.filter((m) => m.provider === b.dataset.copyall).map((m) => m.id).join('\n');
    await navigator.clipboard.writeText(ids).catch(() => {});
    toast('Đã copy ' + ids.split('\n').length + ' model id');
  }));
}
function modelChip(m) {
  const st = m.status || 'unknown';
  const tip = { ok: 'Gọi được ✓', quota: 'Hết hạn mức', error: 'Gọi lỗi', unknown: 'Chưa kiểm — bấm Check live' }[st] || st;
  return `<span class="chip model-chip ${st}" title="${esc(tip)}${m.detail ? ' — ' + esc(m.detail) : ''}">
    <span class="mc-dot"></span>${m.image ? '<span class="mc-img">🖼</span>' : ''}<b class="mc-id">${esc(m.id)}</b>${m.ms ? `<span class="faint mc-ms">${m.ms}ms</span>` : ''}
    <button class="mc-copy" data-model="${esc(m.id)}" title="Copy tên model">${icon('copy')}</button></span>`;
}
function wireModelChips() {
  document.querySelectorAll('#models-groups .mc-copy').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(b.dataset.model).catch(() => {});
    toast('Đã copy: ' + b.dataset.model);
  }));
}
$('models-check').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  toast('Đang gọi thử từng model (có thể mất 1-2 phút)…');
  const r = await api('/api/gateway/models/check?provider=all', { method: 'POST', body: {} });
  const st = {};
  for (const m of r.models || []) st[m.id] = m;
  modelsCache = modelsCache.map((m) => ({ ...m, ...(st[m.id] || {}) }));
  const byProv = {};
  for (const m of modelsCache) (byProv[m.provider] ??= []).push(m);
  for (const [pid, list] of Object.entries(byProv)) {
    const el2 = $('mg-' + pid);
    if (el2) el2.innerHTML = list.map(modelChip).join('');
  }
  wireModelChips();
  const ok = (r.models || []).filter((m) => m.status === 'ok').length;
  toast(`Check live: ${ok}/${(r.models || []).length} model gọi được`);
}));

// ---------- Combo ----------
async function loadCombo() {
  const r = await api('/api/combos');
  $('tc-combo').textContent = (r.combos || []).length;
  $('auto-chips').innerHTML = (r.autoVariants || []).map((v) => `
    <span class="chip model-chip ok"><span class="mc-dot"></span><b class="mc-id">${esc(v)}</b>
    <button class="mc-copy" data-model="${esc(v)}" title="Copy">${icon('copy')}</button></span>`).join('');
  $('combo-list').innerHTML = (r.combos || []).length
    ? r.combos.map((c) => `
      <div class="panel">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">combo/${esc(c.id)}
            <button class="mc-copy" data-model="combo/${esc(c.id)}" title="Copy id">${icon('copy')}</button></h3>
          <span class="faint">${esc({ priority: 'Ưu tiên theo thứ tự', 'round-robin': 'Chia tải', weighted: 'Trọng số', 'highest-quota': 'Quota cao nhất' }[c.strategy] || c.strategy)}
            · ${c.calls} gọi · ${c.fallbacks} lần trượt</span>
        </div>
        <div style="margin-top:10px">${c.targets.map((t, i) => `
          <div class="row" style="gap:8px;align-items:center;margin-bottom:6px">
            <span class="chip">${i + 1}</span><span class="mono">${esc(t.model)}</span></div>`).join('')}</div>
        <div class="row end" style="margin-top:8px">
          <button class="sm" data-edit="${esc(c.id)}">Sửa</button>
          <button class="sm" data-test="${esc(c.id)}">Thử</button>
          <button class="sm danger" data-del="${esc(c.id)}">Xoá</button>
        </div>
      </div>`).join('')
    : '<div class="panel"><div class="empty">Chưa có combo. Bấm <b>Tạo combo</b> để ghép nhiều model có dự phòng.</div></div>';

  document.querySelectorAll('#view-combo .mc-copy').forEach((b) => b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(b.dataset.model).catch(() => {});
    toast('Đã copy: ' + b.dataset.model);
  }));
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openComboModal(r.combos.find((c) => c.id === b.dataset.edit))));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirmAct(`Xoá combo/${b.dataset.del}?`)) return;
    await api('/api/combos/' + b.dataset.del, { method: 'DELETE' });
    toast('Đã xoá'); loadCombo();
  }));
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
    const t0 = Date.now();
    const res = await fetch('/proxy/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `combo/${b.dataset.test}`, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] }),
    });
    const j = await res.json();
    toast(res.ok ? `✓ ${j.choices?.[0]?.message?.content?.slice(0, 30)} · ${Date.now() - t0}ms` : '✗ ' + (j.error?.message || j.error));
    loadCombo();
  })));
}
// ---- modal tạo/sửa combo: CHỌN model từ danh sách thật, không phải gõ tay ----
let cbChosen = [];
async function openComboModal(existing) {
  const models = modelsCache.length ? modelsCache : (await api('/api/gateway/models')).models;
  modelsCache = models;
  cbChosen = existing ? existing.targets.map((t) => t.model) : [];
  $('combo-modal-title').textContent = existing ? 'Sửa combo/' + existing.id : 'Tạo combo';
  $('cb-id').value = existing ? existing.id : '';
  $('cb-id').disabled = !!existing;
  $('cb-strategy').value = existing ? existing.strategy : 'priority';
  $('cb-pick').innerHTML = models.map((m) => `
    <span class="chip model-chip" style="cursor:pointer" data-add="${esc(m.id)}" title="${esc(m.label || m.id)}">
      <span class="mc-dot"></span><b class="mc-id">${esc(m.id)}</b></span>`).join('');
  document.querySelectorAll('#cb-pick [data-add]').forEach((c) => c.addEventListener('click', () => {
    if (!cbChosen.includes(c.dataset.add)) { cbChosen.push(c.dataset.add); renderChosen(); }
  }));
  renderChosen();
  openModal('modal-combo');
}
function renderChosen() {
  $('cb-chosen').innerHTML = cbChosen.length
    ? cbChosen.map((m, i) => `<div class="row" style="gap:8px;align-items:center;margin-bottom:6px">
        <span class="chip">${i + 1}</span><span class="mono" style="flex:1">${esc(m)}</span>
        <button class="sm icon" data-up="${i}" title="Lên">▲</button>
        <button class="sm icon" data-down="${i}" title="Xuống">▼</button>
        <button class="sm icon danger" data-rm="${i}" title="Bỏ">${icon('x')}</button></div>`).join('')
    : '<div class="empty">Chưa chọn model nào — bấm vào model ở trên để thêm.</div>';
  const swap = (i, j) => { if (j < 0 || j >= cbChosen.length) return; [cbChosen[i], cbChosen[j]] = [cbChosen[j], cbChosen[i]]; renderChosen(); };
  document.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => swap(+b.dataset.up, +b.dataset.up - 1)));
  document.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => swap(+b.dataset.down, +b.dataset.down + 1)));
  document.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { cbChosen.splice(+b.dataset.rm, 1); renderChosen(); }));
}
$('combo-new').addEventListener('click', () => openComboModal(null));
$('cb-save').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  const id = ($('cb-id').value || '').trim();
  if (!id) return toast('Nhập tên combo');
  if (!cbChosen.length) return toast('Chọn ít nhất 1 model');
  const r = await api('/api/combos', {
    method: 'POST',
    body: { id, name: id, strategy: $('cb-strategy').value, targets: cbChosen.map((m) => ({ model: m })) },
  });
  if (r.ok) { toast('Đã lưu combo/' + r.id); closeModal('modal-combo'); loadCombo(); }
  else toast('Lỗi: ' + r.error);
}));
$('auto-preview').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  const r = await api('/api/combos/auto/preview?variant=' + $('auto-variant').value);
  $('auto-rank').innerHTML = `
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Model</th><th>Điểm</th><th>Sức khoẻ</th><th>Quota</th><th>Độ trễ</th><th>Tỉ lệ OK</th></tr></thead><tbody>
    ${(r.ranking || []).map((s, i) => `<tr><td>${i + 1}</td><td class="mono">${esc(s.model)}</td><td><b>${s.score.toFixed(3)}</b></td>
      <td>${(s.detail.health * 100).toFixed(0)}%</td><td>${(s.detail.quota * 100).toFixed(0)}%</td>
      <td>${(s.detail.latency * 100).toFixed(0)}%</td><td>${(s.detail.success * 100).toFixed(0)}%</td></tr>`).join('')}
    </tbody></table></div>
    <div class="faint" style="margin-top:6px">Thứ tự sẽ thử: ${(r.plan || []).map((t) => `<span class="chip">${esc(t.model)}</span>`).join(' → ')}</div>`;
}));

// ---------- CLI Tools ----------
async function loadTools() {
  const r = await api('/api/tools');
  const models = (modelsCache.length ? modelsCache : (await api('/api/gateway/models')).models).map((m) => m.id);
  const combos = (await api('/api/combos').catch(() => ({}))) || {};
  const allIds = [...models, ...(combos.combos || []).map((c) => 'combo/' + c.id), ...(combos.autoVariants || [])];
  $('tools-base').textContent = `OpenAI ${r.baseUrl.openai} · Anthropic ${r.baseUrl.anthropic}`;
  $('tc-tools').textContent = (r.tools || []).filter((t) => t.configured).length + '/' + (r.tools || []).length;
  $('tools-warn').innerHTML = r.warning
    ? `<div class="panel" style="border-color:var(--red)"><b style="color:var(--red)">⚠ ${esc(r.warning)}</b></div>` : '';
  $('tools-grid').innerHTML = (r.tools || []).map((t) => `
    <div class="panel">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3 style="margin:0">${esc(t.label)}</h3>
        ${t.configured ? '<span class="badge ok"><span class="bd"></span>Đã cấu hình</span>' : `<span class="chip">${t.installed ? 'Chưa cấu hình' : 'Chưa cài'}</span>`}
      </div>
      <p class="set-desc mono" style="font-size:11.5px">${esc(t.path)}</p>
      <p class="set-desc">Chuẩn: <b>${t.api === 'anthropic' ? 'Anthropic /v1/messages' : 'OpenAI /proxy/v1'}</b>${t.model ? ` · đang dùng <b>${esc(t.model)}</b>` : ''}</p>
      <label class="fl">Model</label>
      <select data-model-for="${esc(t.id)}">${allIds.map((m) => `<option ${m === (t.model || r.defaultModel) ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      ${t.notes ? `<p class="set-desc" style="margin-top:8px">${esc(t.notes)}</p>` : ''}
      <div class="row end" style="margin-top:12px">
        <button class="sm" data-preview="${esc(t.id)}">Xem trước</button>
        <button class="sm primary" data-apply="${esc(t.id)}">${t.configured ? 'Cấu hình lại' : 'Cấu hình'}</button>
        ${t.configured || t.hasBackup ? `<button class="sm danger" data-undo="${esc(t.id)}">Gỡ</button>` : ''}
      </div>
    </div>`).join('');

  const modelOf = (id) => document.querySelector(`[data-model-for="${id}"]`)?.value;
  document.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
    const p = await api(`/api/tools/${b.dataset.preview}/preview`, { method: 'POST', body: { model: modelOf(b.dataset.preview) } });
    if (!p.ok) return toast('Lỗi: ' + p.error);
    $('detail-title').textContent = 'Sẽ ghi vào ' + p.path;
    $('detail-body').innerHTML =
      `${p.before ? `<h3 style="font-size:12px">Hiện tại</h3><pre class="agy-out" style="max-height:180px">${esc(p.before)}</pre>` : '<p class="faint">File chưa tồn tại — sẽ tạo mới.</p>'}
       <h3 style="font-size:12px;margin-top:10px">Sau khi ghi</h3><pre class="agy-out" style="max-height:220px">${esc(p.after)}</pre>`;
    openModal('modal-detail');
  })));
  document.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
    const r2 = await api(`/api/tools/${b.dataset.apply}/apply`, { method: 'POST', body: { model: modelOf(b.dataset.apply) } });
    toast(r2.ok ? `Đã cấu hình · model ${r2.model}${r2.backup ? ' (đã backup)' : ''}` : 'Lỗi: ' + r2.error);
    loadTools();
  })));
  document.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirmAct('Gỡ cấu hình và khôi phục file cũ?')) return;
    const r2 = await api(`/api/tools/${b.dataset.undo}/undo`, { method: 'POST', body: {} });
    toast(r2.detail || (r2.ok ? 'Đã gỡ' : 'Không gỡ được'));
    loadTools();
  }));
}

// ---------- settings (chia tab, mọi trường lưu DB) ----------
let setMeta = {};
// tab switching
$('set-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]'); if (!b) return;
  document.querySelectorAll('#set-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.set-pane').forEach((p) => p.classList.toggle('active', p.id === 'set-' + b.dataset.t));
  store_('setTab', b.dataset.t);
  if (b.dataset.t === 'security') loadSessions();
});

async function loadSettings() {
  const s = await api('/api/settings');
  setMeta = s.meta || {};
  const v = s.values || {};
  // đổ giá trị vào mọi input có data-key
  document.querySelectorAll('#view-settings [data-key]').forEach((el2) => {
    const k = el2.dataset.key;
    if (!(k in v)) return;
    if (el2.type === 'checkbox') el2.checked = v[k] === true || v[k] === 'true';
    else el2.value = v[k] ?? '';
  });
  $('s-datadir').value = setMeta.dataDir || '';
  $('s-baseurl').textContent = setMeta.baseUrl || '';
  $('set-meta').textContent = `v${setMeta.version || ''} · ${Object.keys(v).length} thiết lập`;
  // đánh dấu trường cần restart
  (s.restartKeys || []).forEach((k) => {
    const el3 = document.querySelector(`#view-settings [data-key="${k}"]`);
    if (el3) el3.title = 'Đổi xong cần Khởi động lại';
  });
  loadSecurity().catch(() => {});
  // khôi phục tab đang xem
  const t = remember('setTab', 'general');
  const btn = document.querySelector(`#set-tabs button[data-t="${t}"]`);
  if (btn) btn.click();
}

/** Lưu mọi input data-key trong 1 pane → PATCH /api/settings (ghi DB). */
async function saveSettingsPane(paneBtn) {
  const pane = paneBtn.closest('.set-pane');
  const patch = {};
  pane.querySelectorAll('[data-key]').forEach((el2) => {
    const k = el2.dataset.key;
    let val = el2.type === 'checkbox' ? el2.checked : el2.value;
    if (el2.type === 'number') val = Number(val);
    if (typeof val === 'string' && val === '••••••••') return; // secret chưa sửa
    patch[k] = val;
  });
  const r = await api('/api/settings', { method: 'PATCH', body: patch });
  if (r.ok) {
    const need = (r.needRestart || []).length;
    toast(`Đã lưu ${r.changed.length} thiết lập${need ? ' · cần Khởi động lại' : ''}`);
  } else toast('Lưu lỗi');
}
document.querySelectorAll('#view-settings [data-save]').forEach((b) =>
  b.addEventListener('click', (e) => withSpin(e.currentTarget, () => saveSettingsPane(e.currentTarget))),
);
$('s-restart').addEventListener('click', async (e) => {
  if (!confirmAct('Khởi động lại tiến trình? Dashboard sẽ mất kết nối vài giây.')) return;
  await api('/api/system/restart', { method: 'POST', body: {} }).catch(() => {});
  toast('Đang khởi động lại…');
  setTimeout(() => location.reload(), 4000);
});
$('s-apikey-gen').addEventListener('click', () => {
  const a = new Uint8Array(18); crypto.getRandomValues(a);
  $('s-apikey').value = 'agy-' + btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 24);
  toast('Đã sinh key — nhớ bấm Lưu');
});
$('s-kp-now').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  const r = await api('/api/gateway/probe?provider=kr&limit=10', { method: 'POST', body: {} });
  toast(`Đang dò ${r.queued} account Kiro (nền — xem Live log)`);
}));
$('cfg-q-refresh').addEventListener('click', (e) => withSpin(e.currentTarget, async () => { const r = await api('/api/gateway/quota/refresh', { method: 'POST', body: {} }); toast(`Đang nạp hạn mức ${r.queued} account (nền)…`); }));
$('cfg-health-now').addEventListener('click', (e) => withSpin(e.currentTarget, async () => { const r = await api('/api/tokens/check', { method: 'POST', body: {} }); toast(`Health: 🟢${r.alive} 🔴${r.dead} ⚪${r.unknown}`); loadTokens(); }));
$('cfg-omni-test').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  await saveSettingsPane(e.currentTarget); // lưu url/mật khẩu trước rồi test
  const r = await api('/api/settings/omniroute/test', { method: 'POST', body: {} });
  $('s-omni-state').innerHTML = r.ok
    ? `<span style="color:var(--green)">✓ Kết nối OK · ${r.connections} connection</span>`
    : `<span style="color:var(--red)">✕ ${esc(r.error || 'lỗi')}</span>`;
  toast(r.ok ? 'OmniRoute OK' : 'OmniRoute lỗi');
}));
$('cfg-theme').addEventListener('click', toggleTheme);

// ---------- phiên đăng nhập + log ----------
async function loadSessions() {
  const r = await api('/api/auth/sessions');
  $('sess-body').innerHTML = (r.sessions || []).length
    ? r.sessions.map((s) => `<tr><td class="mono" style="max-width:280px">${esc((s.ua || '').slice(0, 60))}${s.current ? ' <span class="chip">phiên này</span>' : ''}</td><td class="mono">${esc(s.ip || '')}</td><td class="faint">${fmtAgo(s.created_at)}</td><td class="faint">${fmtAgo(s.last_seen)}</td><td class="act">${s.current ? '' : `<button class="sm icon danger sess-kill" data-id="${esc(s.id)}" title="Thu hồi">${icon('trash')}</button>`}</td></tr>`).join('')
    : '<tr><td colspan="5"><div class="empty">Không có phiên</div></td></tr>';
  $('authlog-body').innerHTML = (r.log || []).length
    ? r.log.map((l) => `<tr><td class="faint">${new Date(l.ts).toLocaleString()}</td><td class="mono">${esc(l.ip || '')}</td><td>${l.ok ? '<span class="badge alive"><span class="bd"></span>OK</span>' : '<span class="badge dead"><span class="bd"></span>sai</span>'}</td><td class="faint">${esc(l.reason || '')}</td></tr>`).join('')
    : '<tr><td colspan="4"><div class="empty">Chưa có</div></td></tr>';
  document.querySelectorAll('.sess-kill').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/auth/sessions/revoke', { method: 'POST', body: { id: b.dataset.id } });
    toast('Đã thu hồi phiên'); loadSessions();
  }));
}
$('sess-revoke-others').addEventListener('click', async () => {
  if (!confirmAct('Đăng xuất tất cả thiết bị khác?')) return;
  const r = await api('/api/auth/sessions/revoke', { method: 'POST', body: { others: true } });
  toast(`Đã đăng xuất ${r.revoked} phiên khác`); loadSessions();
});

// ---------- bảo mật: đổi mật khẩu dashboard ----------
async function loadSecurity() {
  const s = await api('/api/security');
  $('sec-user').value = s.user || '';
  const cur = $('sec-current'), lbl = $('sec-cur-label');
  cur.style.display = s.hasPassword ? '' : 'none';
  lbl.style.display = s.hasPassword ? '' : 'none';
  const openWarn = s.open && !s.hasPassword
    ? '<b style="color:var(--red)">⚠ Đang mở cho máy khác (0.0.0.0) mà CHƯA có mật khẩu — ai vào IP này cũng xem được token!</b>'
    : s.open ? 'Đang mở cho máy khác qua IP · <b style="color:var(--green)">đã khoá bằng mật khẩu</b>'
    : 'Chỉ truy cập từ máy này (127.0.0.1).';
  $('sec-state').innerHTML = (s.hasPassword ? '🔒 <b>Đã bật đăng nhập</b>' : '🔓 <b>Chưa đặt mật khẩu</b>') + ' · ' + openWarn;
}
$('sec-gen').addEventListener('click', () => {
  const a = new Uint8Array(9); crypto.getRandomValues(a);
  const p = btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 12);
  $('sec-pass').value = p; $('sec-pass').type = 'text';
  toast('Mật khẩu gợi ý: ' + p + ' (nhớ lưu lại)');
});
$('sec-save').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  const password = $('sec-pass').value.trim(), user = $('sec-user').value.trim(), current = $('sec-current').value;
  if (!password && !confirmAct('Để trống = TẮT đăng nhập, ai vào được địa chỉ này cũng dùng được. Tiếp tục?')) return;
  const r = await api('/api/security/password', { method: 'POST', body: { password, user, current } });
  if (r.ok) {
    toast(password ? 'Đã đổi mật khẩu — lần sau đăng nhập bằng mật khẩu mới' : 'Đã tắt đăng nhập');
    $('sec-pass').value = ''; $('sec-pass').type = 'password'; $('sec-current').value = '';
    loadSecurity();
  } else toast('Lỗi: ' + (r.error || ''));
}));

// ---------- backup import/export ----------
let backupData = null;
$('bk-file').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      backupData = JSON.parse(String(rd.result));
      const c = backupData.counts || {};
      $('bk-preview').innerHTML = `File: <b>${esc(f.name)}</b> · v${backupData.version || '?'} · ${c.accounts || 0} account · ${c.proxies || 0} proxy · ${c.credentials || 0} token · gateway ${Object.keys(backupData.gateway || {}).length}`;
      $('bk-import-row').style.display = 'flex';
    } catch { backupData = null; $('bk-preview').innerHTML = '<span style="color:var(--red)">File JSON không hợp lệ</span>'; $('bk-import-row').style.display = 'none'; }
  };
  rd.readAsText(f);
});
$('bk-import').addEventListener('click', (e) => withSpin(e.currentTarget, async () => {
  if (!backupData) return toast('Chọn file backup trước');
  const mode = $('bk-mode').value;
  if (!confirmAct(`Phục hồi (${mode === 'replace' ? 'THAY THẾ toàn bộ' : 'gộp'})? Dữ liệu hiện tại sẽ bị ghi đè.`)) return;
  const r = await api('/api/backup/import', { method: 'POST', body: { data: backupData, mode } });
  if (r.ok) { toast(`Đã phục hồi: ${r.restored.accounts} account · ${r.restored.proxies} proxy · ${r.restored.credentials} token`); loadProxies(); loadAccounts(); loadSummary(); loadTokens(); $('bk-import-row').style.display = 'none'; $('bk-preview').innerHTML = ''; $('bk-file').value = ''; }
  else toast('Lỗi phục hồi: ' + (r.error || ''));
}));

// ---------- account detail ----------
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
document.querySelectorAll('.modal-bg').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); }));
async function showDetail(email) {
  const a = accounts.find((x) => x.email === email); const cr = await api('/api/credentials'); const creds = cr.credentials.filter((c) => c.email === email);
  $('detail-title').textContent = email;
  $('detail-body').innerHTML = `
    <div class="row" style="gap:16px"><span class="faint">Proxy:</span> ${esc(a.proxy) || '(none)'} <span class="faint">TZ:</span> ${esc(a.tz)}</div>
    <div style="margin:12px 0">${FLOWS.map((f) => `<span class="badge ${a[f.col]}" style="margin-right:6px"><span class="bd"></span>${f.label}: ${a[f.col]}</span>`).join('')}</div>
    <h3 style="margin:14px 0 6px;font-size:13px">Credentials</h3>
    ${creds.length ? creds.map((c) => `<div class="panel" style="margin:0 0 8px;padding:10px 12px"><b>${esc(c.target)}</b> ${c.health ? `<span class="chip">${esc(c.health)}</span>` : ''} ${c.omniroute_connection_id ? `<span class="chip">conn ${esc(c.omniroute_connection_id.slice(0, 8))}</span>` : ''}<div class="mono faint" style="margin-top:4px;word-break:break-all;max-height:70px;overflow:auto">${esc((c.value || '').slice(0, 400))}</div></div>`).join('') : '<div class="faint">Chưa có</div>'}
    <div class="row end" style="margin-top:12px">${FLOWS.map((f) => `<button class="sm" onclick="runFlow('${email}','${f.key}');toast('Đã xếp ${f.key}')" title="Chạy ${f.key}">${f.label}</button>`).join('')}</div>`;
  openModal('modal-detail');
}

// ---------- pending human + notifications ----------
let notifyOn = false;
function reqNotify() { if (!('Notification' in window)) return; if (Notification.permission === 'default') Notification.requestPermission().then((p) => { notifyOn = p === 'granted'; }); else notifyOn = Notification.permission === 'granted'; }
const notified = new Set();
async function loadHuman() {
  const { pending } = await api('/api/pending-human'); const b = $('human-banner');
  b.innerHTML = pending.length ? pending.map((p) => `<div class="human-card"><b>⏸ Run #${p.runId}</b><div class="faint">${esc(p.reason)}</div>
    <div style="margin-top:8px" class="row"><button class="success sm" onclick="continueRun(${p.runId})" title="Chạy tiếp">${icon('check')} Tiếp tục</button><button class="sm" onclick="skipRun(${p.runId})" title="Bỏ qua">Bỏ qua</button></div></div>`).join('') : '';
  for (const p of pending) if (!notified.has(p.runId)) { notified.add(p.runId); if (notifyOn) try { const n = new Notification('Cần xử lý tay', { body: p.reason }); n.onclick = () => window.focus(); } catch {} }
}
async function continueRun(id) { await api('/api/runs/' + id + '/continue', { method: 'POST' }); loadHuman(); }
async function skipRun(id) { await api('/api/runs/' + id + '/skip', { method: 'POST' }); loadHuman(); }

// ---------- log (SSE) + segmented + live call ----------
const logEl = $('log'); let logLines = []; let logPaused = false; let logCat = '';
const LOGIN_FLOWS = ['google', 'gweb', 'agy', 'kiro'];
$('log-pause').addEventListener('click', () => { logPaused = !logPaused; $('log-pause').innerHTML = icon(logPaused ? 'play' : 'pause'); toast(logPaused ? 'Log tạm dừng cuộn' : 'Log tiếp tục'); });
$('log-clear').addEventListener('click', () => { logLines = []; logEl.innerHTML = ''; renderGwlog(); });
$('log-download').addEventListener('click', () => downloadFile('log.txt', logLines.map((l) => `${l.ts} [${l.level}] ${l.who} ${l.msg}`).join('\n'), 'text/plain'));
$('log-search').addEventListener('input', debounce(() => renderLog(), 150));
$('log-level').addEventListener('change', () => renderLog());
$('log-cat').addEventListener('click', (e) => { const b = e.target.closest('button[data-c]'); if (!b) return; logCat = b.dataset.c; document.querySelectorAll('#log-cat button').forEach((x) => x.classList.toggle('active', x === b)); renderLog(); });
function catOf(l) { return l.flow === 'gateway' ? 'gateway' : LOGIN_FLOWS.includes(l.flow) ? 'login' : 'other'; }
function addLog(ev) {
  const ts = new Date().toLocaleTimeString();
  const who = ev.email ? `${ev.email.split('@')[0]}${ev.flow && ev.flow !== 'gateway' ? '/' + ev.flow : ''}` : '';
  logLines.push({ ts, level: ev.level, who, msg: ev.msg, flow: ev.flow, kind: ev.kind, model: ev.model, account: ev.account });
  if (logLines.length > 1000) logLines.shift();
  renderLog(true); if (ev.flow === 'gateway') renderGwlog(true);
}
function logLineHtml(l) {
  const arrow = l.kind === 'req' ? '<span class="gw-arrow req">→</span>' : l.kind === 'res' ? '<span class="gw-arrow res">←</span>' : l.kind === 'err' ? '<span class="gw-arrow err">←</span>' : '';
  const m = arrow ? esc(l.msg.replace(/^[→←]\s*/, '')) : esc(l.msg);
  return `<div class="line ${l.level} ${l.kind ? 'gw' : ''}"><div class="l1"><span class="ts">${l.ts}</span>${l.who ? `<span class="who">${esc(l.who)}</span>` : ''}</div><div class="msg">${arrow}${m}</div></div>`;
}
function renderLog(incremental) {
  const q = $('log-search').value.trim().toLowerCase(), lv = $('log-level').value;
  const shown = logLines.filter((l) => (!logCat || catOf(l) === logCat) && (!lv || l.level === lv) && (!q || (l.msg + l.who).toLowerCase().includes(q)));
  logEl.innerHTML = shown.slice(-400).map(logLineHtml).join('');
  if (!logPaused && incremental !== false) logEl.scrollTop = logEl.scrollHeight;
}
// live call log page
let gwPaused = false;
$('gwlog-pause').addEventListener('click', () => { gwPaused = !gwPaused; $('gwlog-pause').innerHTML = icon(gwPaused ? 'play' : 'pause') + (gwPaused ? ' Resume' : ' Pause'); });
$('gwlog-clear').addEventListener('click', () => { logLines = logLines.filter((l) => l.flow !== 'gateway'); renderGwlog(); });
$('gwlog-search').addEventListener('input', debounce(() => renderGwlog(), 150));
function renderGwlog(incremental) {
  const box = $('gwlog'); if (!box) return;
  const q = ($('gwlog-search').value || '').toLowerCase();
  const list = logLines.filter((l) => l.flow === 'gateway' && (!q || ((l.model || '') + (l.account || '') + l.msg).toLowerCase().includes(q)));
  box.innerHTML = list.length ? list.slice(-400).map(logLineHtml).join('') : '<div class="empty">Chưa có lệnh gọi nào. Gọi model qua Base URL hoặc Chat thử.</div>';
  if (!gwPaused && incremental !== false) box.scrollTop = box.scrollHeight;
}
function connectSSE() {
  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === 'log') {
      addLog({ level: e.level, msg: e.msg + (e.screenshot ? ` 📷${e.screenshot}` : ''), email: e.email, flow: e.flow, kind: e.kind, model: e.model, account: e.account });
      if (e.kind === 'check' && e.check && e.account) applyCheckEvent(e.account, e.check);
    }
    else if (e.type === 'run') {
      addLog({ level: e.status === 'failed' ? 'error' : e.status === 'paused_needs_human' ? 'challenge' : 'info', msg: `» ${e.status}${e.detail ? ': ' + e.detail : ''}`, email: e.email, flow: e.flow });
      if (e.status === 'paused_needs_human') loadHuman();
      loadAccounts(); loadSummary();
      if (e.status === 'ok') loadTokens();
    }
  };
}

// ---------- sticky header: thêm viền/bóng khi cuộn ----------
(function stickyHeader() {
  const main = document.querySelector('.main');
  if (!main) return;
  const onScroll = () => main.classList.toggle('scrolled', main.scrollTop > 4);
  main.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { const active = document.querySelector('.view.active'); const s = active && active.querySelector('input[id$="-search"]'); if (s) { e.preventDefault(); s.focus(); } } });

// ---------- init ----------
async function init() {
  applyTheme(localStorage.getItem('theme') || 'dark');
  if (remember('navCollapsed', false)) $('app').classList.add('nav-collapsed');
  reqNotify();
  await loadProxies(); await loadAccounts(); await loadSummary(); await loadHuman(); await loadTokens();
  api('/api/gateway/accounts').then((r) => { $('tc-agy').textContent = (r.accounts || []).filter((a) => a.enabled).length; }).catch(() => {});
  connectSSE();
  setInterval(loadSummary, 4000);
  setInterval(loadHuman, 4000);
  // khôi phục tab (mặc định Tổng quan)
  const tab = remember('tab', 'overview');
  if (tab === 'overview') loadOverview();
  else { const nav = document.querySelector(`.nav-item[data-tab="${tab}"]`); if (nav) nav.click(); else loadOverview(); }
}
init();
