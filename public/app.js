/* Tervasaari PM5 — клиент. Vanilla JS, офлайн-очередь, расчёт % локально. */
(() => {
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const cssq = (s) => String(s == null ? '' : s).replace(/["\\]/g, '\\$&');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const loc = () => (window.I18N ? I18N.locale : 'ru-RU');
const n1 = (x) => (Math.round((+x || 0) * 10) / 10).toLocaleString(loc());
const n0 = (x) => Math.round(+x || 0).toLocaleString(loc());

const LS = {
  get t() { return localStorage.getItem('tesa.token'); },
  set t(v) { v ? localStorage.setItem('tesa.token', v) : localStorage.removeItem('tesa.token'); },
  get me() { try { return JSON.parse(localStorage.getItem('tesa.me') || 'null'); } catch (e) { return null; } },
  set me(v) { v ? localStorage.setItem('tesa.me', JSON.stringify(v)) : localStorage.removeItem('tesa.me'); },
  get cache() { try { return JSON.parse(localStorage.getItem('tesa.cache') || 'null'); } catch (e) { return null; } },
  set cache(v) { localStorage.setItem('tesa.cache', JSON.stringify(v)); },
  get queue() { try { return JSON.parse(localStorage.getItem('tesa.queue') || '[]'); } catch (e) { return []; } },
  set queue(v) { localStorage.setItem('tesa.queue', JSON.stringify(v)); },
  get by() { return localStorage.getItem('tesa.by') || ''; },
  set by(v) { v ? localStorage.setItem('tesa.by', v) : localStorage.removeItem('tesa.by'); },
  get details() { try { return JSON.parse(localStorage.getItem('tesa.details') || '{}'); } catch (e) { return {}; } },
  set details(v) { try { localStorage.setItem('tesa.details', JSON.stringify(v)); } catch (e) {} },
};

let ME = LS.me;
/** менеджер (в старых версиях роль называлась foreman) */
const isMgr = (u) => !!u && (u.role === 'manager' || u.role === 'foreman' || u.role === 'admin');
let LINES = [];          // сводки всех линий
let DETAIL = LS.details; // подробности линий (кэш, переживает перезапуск)
let ONLINE = true;       // доступен ли сервер прямо сейчас
let CFG = null;

/* ---------------- сеть ---------------- */
async function api(path, opt) {
  opt = opt || {};
  const h = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
  if (LS.t) h.Authorization = 'Bearer ' + LS.t;
  const r = await fetch('api/' + path, {
    method: opt.method || 'GET', headers: h,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  if (r.status === 401) { LS.t = null; ME = null; LS.me = null; render(); throw new Error(T('login_required')); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || T('err', { n: r.status }));
  return j;
}

function saveDetail(id, data) {
  DETAIL[id] = data;
  const d = LS.details; d[id] = data; LS.details = d;
}

/** Скачивает подробности всех линий, чтобы приложение работало без связи. */
let prefetching = false;
async function prefetchAll(force, onProgress) {
  if (prefetching) return;
  prefetching = true;
  const todo = LINES.map((l) => l.id).filter((id) => force || !DETAIL[id]);
  let done = 0, failed = 0;
  for (const id of todo) {
    try { saveDetail(id, await api('lines/' + encodeURIComponent(id))); }
    catch (e) { failed++; if (failed > 3) break; }
    done++;
    if (onProgress) onProgress(done, todo.length);
  }
  prefetching = false;
  return { done, total: todo.length, failed };
}

function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms || 2200);
}

/* ---------------- офлайн-очередь ---------------- */
async function flushQueue(quiet) {
  const q = LS.queue;
  if (!q.length || !navigator.onLine || !LS.t) return;
  const rest = [];
  let sent = 0;
  for (const item of q) {
    try {
      const r = await api('lines/' + encodeURIComponent(item.id) + '/progress',
        { method: 'PUT', body: { checks: item.checks, note: item.note, by: item.by || LS.by } });
      sent++;
      const i = LINES.findIndex((x) => x.id === item.id);
      if (i >= 0) LINES[i] = r;
    } catch (e) { rest.push(item); }
  }
  LS.queue = rest;
  if (sent) {
    ONLINE = true;
    if (!quiet) toast(T('sent_n', { n: sent }) + (rest.length ? T('sent_left', { r: rest.length }) : ''));
    chrome0();
    if (!rest.length && !quiet) { const h = location.hash; if (h === '#/' || h.startsWith('#/report') || h.startsWith('#/list')) render(); }
  }
}

/** Проверяет связь с сервером и досылает накопленное. */
async function syncTick() {
  if (!LS.t) return;
  let up = false;
  try { const r = await fetch('api/ping', { cache: 'no-store' }); up = r.ok; } catch (e) { up = false; }
  if (up !== ONLINE) { ONLINE = up; chrome0(); }
  if (up) await flushQueue(true);
}

function queuePut(id, checks, note) {
  const q = LS.queue.filter((x) => x.id !== id);
  q.push({ id, checks, note, by: LS.by, ts: Date.now() });
  LS.queue = q;
}

/* ---------------- загрузка данных ---------------- */
async function loadAll(force) {
  try {
    if (!CFG) { CFG = await api('config'); applyHU(); }
    LINES = await api('lines');
    LS.cache = { at: Date.now(), cfg: CFG, lines: LINES };
    await flushQueue();
    if (LS.queue.length) LINES = applyQueue(LINES);
    ONLINE = true;
    // тихо докачиваем подробности линий, чтобы работать без связи
    setTimeout(() => prefetchAll(false).catch(() => {}), 1500);
  } catch (e) {
    ONLINE = false;
    const c = LS.cache;
    if (c) { CFG = c.cfg; LINES = applyQueue(c.lines); toast(T('offline_mem'), 3200); }
    else throw e;
  }
}

function applyQueue(lines) {
  const q = LS.queue;
  if (!q.length) return lines;
  const map = Object.fromEntries(q.map((x) => [x.id, x]));
  return lines.map((l) => {
    const it = map[l.id];
    if (!it) return l;
    const d = DETAIL[l.id] || l;
    const stages = {};
    for (const s of STAGES) stages[s.key] = Math.round(stagePercent(d, it.checks, s.key) * 10) / 10;
    return Object.assign({}, l, { stages, percent: Math.round(linePercent(d, it.checks) * 10) / 10, pending: true });
  });
}

/* ---------------- визуальные элементы ---------------- */
function pctColor(p) { return p >= 100 ? 'var(--ok)' : p > 0 ? 'var(--acc)' : 'var(--ink3)'; }

function bar(p, kind) {
  const v = Math.max(0, Math.min(100, p));
  return `<div class="bar${v >= 100 ? ' ok' : ''}${kind ? ' ' + kind : ''}"><i style="width:${v}%"></i></div>`;
}

function stageSeg(st) {
  // мини-полоса из 5 сегментов по позициям
  const cols = { materials: '#8b93a1', insulation: 'var(--acc)',
                 cladding: '#0b7fb8', finishing: '#7c3aed', inspection: 'var(--ok)' };
  return '<div class="seg">' + STAGES.map((s) => {
    const p = st[s.key] || 0;
    return `<i style="flex:0 0 ${s.weight}%;background:linear-gradient(90deg,${cols[s.key]} ${p}%,var(--line2) ${p}%)"></i>`;
  }).join('') + '</div>';
}

function dial(p) {
  const v = Math.max(0, Math.min(100, p)), R = 26, C = 2 * Math.PI * R;
  return `<div class="dial"><svg width="62" height="62" viewBox="0 0 62 62">
    <circle cx="31" cy="31" r="${R}" fill="none" stroke="var(--line2)" stroke-width="8"/>
    <circle cx="31" cy="31" r="${R}" fill="none" stroke="${pctColor(v)}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - v / 100)}"/>
  </svg><b class="mono">${n1(v)}</b></div>`;
}

function lineCard(l) {
  const d = [l.dn ? 'DN' + l.dn : '',
             (l.pipe_od && l.ins && l.clad_od) ? `${n0(l.pipe_od)}/${n0(l.ins)}/${n0(l.clad_od)}` : '',
             (l.branch_count > 1) ? T('branches_n', { n: l.branch_count }) : ''].filter(Boolean).join(' · ');
  return `<a class="li" data-go="#/line/${l.id}">
    <div class="hd"><span class="nm">${esc(l.short)}</span>
      <span class="pc mono" style="color:${pctColor(l.percent)}">${n1(l.percent)}%</span></div>
    <div class="sub">${esc(d)} — ${n1(l.length_m)} ${T('c_m')} · ${n1(l.area_m2)} ${T('c_m2')}${l.partial ? ` · <span class="badge p">${T('partial')}</span>` : ''}${l.pending ? ` · <span class="badge p">${T('not_sent_badge')}</span>` : ''}</div>
    ${stageSeg(l.stages)}
  </a>`;
}

/* ---------------- экраны ---------------- */

function chrome(title, sub, showBack) {
  const t = $('#top');
  t.hidden = false; $('#nav').hidden = false;
  $('#ttl').textContent = title;
  $('#sub').textContent = sub || 'Tervasaari PM5';
  $('#back').style.visibility = showBack ? 'visible' : 'hidden';
  $('#who').innerHTML = ME
    ? `<span class="rolechip ${isMgr(ME) ? 'ed' : 'ro'}" id="rolechip">${esc(ME.name)}</span>`
      + (LS.by ? '<br><span class="mono">' + esc(LS.by) + '</span>' : '')
      + (!ONLINE ? `<br><span class="offchip">${T('no_conn_chip')}</span>` : '')
      + (LS.queue.length ? `<br><span style="color:var(--acc)">${T('not_sent_chip', { n: LS.queue.length })}</span>` : '')
    : '';
  const nh = $('#nav-hours');
  if (nh) nh.hidden = !(ME && isMgr(ME));
  for (const a of document.querySelectorAll('nav.bot a')) a.classList.remove('on');
  const h = location.hash || '#/';
  const cur = h.startsWith('#/report') ? '#nav-report' : h.startsWith('#/hours') ? '#nav-hours'
    : h.startsWith('#/list') ? '#nav-list' : h === '#/' ? '#nav-home' : null;
  if (cur) $(cur).classList.add('on');
}

/** Кнопки переключения языка. */
function langBar() {
  return '<div class="langbar">' + I18N.order.map((l) =>
    `<button data-lang="${l}"${l === I18N.lang ? ' class="on"' : ''}>${I18N.short[l]}</button>`).join('') + '</div>';
}

/** Подпись Powered by HU внизу каждой страницы. */
function applyHU() {
  const box = document.getElementById('hu'); if (!box) return;
  const a = box.querySelector('a'), t = document.getElementById('hu-t');
  if (t) t.textContent = T('powered');
  const url = (CFG && CFG.hu_url) || ((LS.cache || {}).cfg || {}).hu_url || localStorage.getItem('tesa.hu') || '';
  if (url) { a.href = url; a.removeAttribute('aria-disabled'); }
  else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); }
}

/** Адрес подписи берём публично — он нужен и до входа. */
function loadBrand() {
  fetch('api/brand').then((r) => r.json()).then((b) => {
    if (b && b.hu_url) { try { localStorage.setItem('tesa.hu', b.hu_url); } catch (e) {} applyHU(); }
  }).catch(() => {});
}

function applyNavLabels() {
  const m = { 'nav-home-t': 'nav_home', 'nav-list-t': 'nav_list', 'nav-hours-t': 'nav_hours', 'nav-report-t': 'nav_report' };
  for (const id of Object.keys(m)) { const e = document.getElementById(id); if (e) e.textContent = T(m[id]); }
}

/** Перерисовать только шапку (не трогая экран). */
function chrome0() {
  if (!ME || $('#top').hidden) return;
  $('#who').innerHTML =
    `<span class="rolechip ${isMgr(ME) ? 'ed' : 'ro'}" id="rolechip">${esc(ME.name)}</span>`
    + (LS.by ? '<br><span class="mono">' + esc(LS.by) + '</span>' : '')
    + (!ONLINE ? `<br><span class="offchip">${T('no_conn_chip')}</span>` : '')
    + (LS.queue.length ? `<br><span style="color:var(--acc)">${T('not_sent_chip', { n: LS.queue.length })}</span>` : '');
}

/* --- вход --- */
function logos(cls) {
  return `<div class="logos${cls ? ' ' + cls : ''}">
    <img class="bti" src="logos/bti.png" alt="BTI Service">
    <img class="upm" src="logos/upm.png" alt="UPM">
    <img class="valmet" src="logos/valmet.png" alt="Valmet">
  </div>`;
}

async function viewLogin() {
  $('#top').hidden = true; $('#nav').hidden = true;
  const app = $('#app');
  app.innerHTML = `<div class="login">
    ${logos()}
    <h1 style="margin-top:16px">Tervasaari PM5</h1>
    <p class="muted small" style="margin:0 0 14px">${T('app_sub')}</p>

    ${langBar()}

    <div class="roles">
      <div class="role"><b>${T('role_foreman')}</b><span>${T('role_foreman_d')}</span></div>
      <div class="role"><b>${T('role_viewer')}</b><span>${T('role_viewer_d')}</span></div>
    </div>

    <p class="muted small" style="margin:16px 0 6px;text-align:center">${T('enter_pin')}</p>
    <div class="pindots" id="dots">${'<i></i>'.repeat(4)}</div>
    <div class="pinpad" id="pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button data-d="${d}">${d}</button>`).join('')}
      <button data-a="c">⌫</button><button data-d="0">0</button><button data-a="ok" style="color:var(--acc)">${T('login_btn')}</button>
    </div>
    <p style="margin-top:18px;text-align:center"><a href="/setup" class="btn" style="text-decoration:none">📱 ${T('connect_phone')}</a></p>
    <p class="muted small" style="margin-top:14px">${T('pins_default')}</p>
  </div>`;
  let pin = '';
  let lens = [4];
  fetch('api/pinlens').then((r) => r.json()).then((l) => { if (Array.isArray(l) && l.length) { lens = l; draw(); } }).catch(() => {});
  const draw = () => {
    const max = Math.max(...lens);
    const dots = $('#dots');
    if (dots.children.length !== max) dots.innerHTML = '<i></i>'.repeat(max);
    [...dots.children].forEach((i, k) => i.classList.toggle('on', k < pin.length));
  };
  const submit = async () => {
    if (!pin) return;
    try {
      const r = await (await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) })).json();
      if (r.error) { toast(r.error, 3000); pin = ''; draw(); return; }
      LS.t = r.token; ME = r.user; LS.me = r.user;
      toast(T('mode_is', { x: r.user.name }));
      location.hash = '#/'; render();
    } catch (e) { toast(T('no_server')); }
  };
  $('#pad').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.d) { if (pin.length < 12) pin += b.dataset.d; draw(); if (lens.includes(pin.length)) submit(); }
    else if (b.dataset.a === 'c') { pin = pin.slice(0, -1); draw(); }
    else submit();
  });
}

/* --- дом / поиск --- */
let filt = { q: '', f: '' };
function viewHome() {
  chrome(T('search_title'), T('lines_in_reg', { n: LINES.length }), false);
  const app = $('#app');
  const tA = LINES.reduce((a, x) => a + x.area_m2, 0);
  const tM = LINES.reduce((a, x) => a + x.length_m, 0);
  const pA = tA ? LINES.reduce((a, x) => a + x.area_m2 * x.percent, 0) / tA : 0;
  const pM = tM ? LINES.reduce((a, x) => a + x.length_m * x.percent, 0) / tM : 0;
  const rel = LINES.filter((x) => x.released).length;
  app.innerHTML = `
    ${logos('flat')}
    <div class="langrow">${langBar()}</div>
    <a class="card pad mb" data-go="#/report" style="display:block">
      <div class="spread">
        <div>
          <div class="small muted" style="text-transform:uppercase;letter-spacing:.06em">${T('project_progress')}</div>
          <div class="mono" style="font-size:26px;font-weight:700;letter-spacing:-.02em;color:${pctColor(pA)}">${n1(pA)}% <span style="font-size:14px;color:var(--ink3);font-weight:500">${T('by_area')}</span></div>
          <div class="small muted mono">${n1(pM)}% ${T('by_len')} · ${T('released_of', { a: rel, b: LINES.length })}</div>
        </div>
        ${dial(pA)}
      </div>
      <div style="margin-top:10px">${bar(pA)}</div>
    </a>
    <div class="searchbox">
      <input id="q" type="search" inputmode="search" autocomplete="off"
        placeholder="${T('search_ph')}" value="${esc(filt.q)}">
      <button class="clr" id="clr">×</button>
    </div>
    <div class="chips" id="chips"></div>
    <div id="res" style="margin-top:12px"></div>`;
  const chips = [
    ['', T('f_all')], ['open', T('f_open')], ['todo', T('f_todo')], ['done', T('f_done')],
    ['rel', T('f_rel')], ['part', T('f_part')],
    ['HMP', 'HMP'], ['HVP', 'HVP'], ['VLA', 'VLA'],
  ];
  $('#chips').innerHTML = chips.map(([k, t]) => `<button class="chip${filt.f === k ? ' on' : ''}" data-f="${k}">${t}</button>`).join('');
  $('#chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; filt.f = b.dataset.f; viewHome(); $('#q').blur(); });
  const inp = $('#q');
  inp.addEventListener('input', () => { filt.q = inp.value; results(); });
  $('#clr').addEventListener('click', () => { filt.q = ''; inp.value = ''; results(); inp.focus(); });
  results();

  function results() {
    const q = filt.q.trim().toLowerCase();
    const terms = q.split(/[\s,]+/).filter(Boolean);
    let rows = LINES.filter((l) => {
      const hay = [l.name, l.short, l.medium, 'dn' + l.dn, l.dn, l.pipe_od, l.ins, l.clad_od, (l.al || []).join(' ')].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const f = filt.f;
    if (f === 'open') rows = rows.filter((l) => l.percent > 0 && l.percent < 100);
    else if (f === 'todo') rows = rows.filter((l) => l.percent <= 0);
    else if (f === 'done') rows = rows.filter((l) => l.percent >= 100);
    else if (f === 'rel') rows = rows.filter((l) => l.released);
    else if (f === 'part') rows = rows.filter((l) => l.partial);
    else if (f) rows = rows.filter((l) => l.medium === f);
    rows.sort((a, b) => a.name.localeCompare(b.name));
    $('#res').innerHTML = rows.length
      ? `<div class="small muted mb">${T('found', { n: rows.length, m: n1(rows.reduce((s, x) => s + x.length_m, 0)), a: n1(rows.reduce((s, x) => s + x.area_m2, 0)) })}</div>
         <div class="lst">${rows.map(lineCard).join('')}</div>`
      : `<div class="empty">${T('nothing')}<br><span class="small">${T('nothing_hint')}</span></div>`;
  }
}

/* --- страница линии --- */
async function viewLine(id) {
  chrome(T('h_line'), id, true);
  const app = $('#app');
  app.innerHTML = `<div class="empty">${T('loading')}</div>`;
  let L = DETAIL[id];
  try { L = await api('lines/' + encodeURIComponent(id)); saveDetail(id, L); ONLINE = true; }
  catch (e) {
    ONLINE = false;
    if (!L) {
      app.innerHTML = `<div class="empty">${T('no_offline_line')}<br>
        <span class="small">${T('no_offline_hint')}</span></div>`;
      return;
    }
  }

  const q = LS.queue.find((x) => x.id === id);
  let checks = q ? sanitize(q.checks, L) : sanitize(L.checks, L);
  let note = q ? q.note : (L.note || '');
  let dirty = false;

  const canEdit = isMgr(ME);
  const BR = L.branches || [];
  const multi = BR.length > 1;
  const OPEN = {};
  BR.forEach((b, i) => { OPEN[b.id] = !multi || i === 0; });

  chrome(L.short, L.name, true);
  const sizes = L.sizes || [];

  app.innerHTML = `
    <div class="card mb">
      <div class="hero">
        <div class="nm">${esc(L.short)}</div>
        <div class="fullnm mono">${esc(L.name)} · ${esc(L.oper_temp || '')} / ${esc(L.design_temp || '')}${L.partial ? ` · <span class="badge p">${T('partial_ins')}</span>` : ''}</div>
        <div class="dims mono">${L.pipe_od ? n0(L.pipe_od) : '—'} <em>/</em> ${L.ins ? n0(L.ins) : '—'} <em>/</em> ${L.clad_od ? n0(L.clad_od) : '—'} <em>${T('mm')}</em></div>
        <div class="devel mono">${T('developed')} <b>${n0(L.dev)} ${T('mm')}</b></div>
        <div class="small relline" id="relline" style="margin-top:5px;color:var(--rel)"></div>
        <div class="small muted" style="margin-top:5px">${T('cladding_mat')} ${esc((L.al || []).join(', ') || '—')}${multi ? ` · ${T('branches_on_line')} <b>${BR.length}</b>` : ''}</div>
        ${L.drawing ? `<a class="dwg" href="drawings/${encodeURIComponent(L.drawing)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>
            <span><b>${T('open_drawing')}</b><i>${T('iso_pdf', { r: esc(L.drawing_rev || '') })}</i></span>
            <em>→</em></a>` : ''}
      </div>
      <div class="kpis">
        <div class="kpi"><b class="mono">${n0(L.elbows)}</b><span>${T('k_elbows')}</span></div>
        <div class="kpi"><b class="mono">${n1(L.straight_m)}</b><span>${T('k_straight')}</span></div>
        <div class="kpi"><b class="mono">${n0(L.ties)}</b><span>${T('k_ties')}</span></div>
        <div class="kpi"><b class="mono">${n0(L.cones)}</b><span>${T('k_cones')}</span></div>
        <div class="kpi"><b class="mono">${n0(L.cases)}</b><span>${T('k_cases')}</span></div>
      </div>
      <div class="total">
        ${dial(0)}
        <div style="flex:1">
          <div class="spread"><b>${T('line_progress')}</b><span class="mono small muted" id="upd"></span></div>
          <div id="tbar">${bar(0)}</div>
          <div class="small muted mono" style="margin-top:5px">${T('of_cladding', { m: n1(L.length_m), a: n1(L.area_m2) })}</div>
        </div>
      </div>
    </div>

    <div class="spread mb" style="padding:0 2px">
      <b style="font-size:14px">${multi ? T('progress_branches') : T('progress_title')}</b>
      ${multi ? `<button class="btn small" id="expall" style="padding:6px 11px;min-height:34px;font-size:13px">${T('expand_all')}</button>` : ''}
    </div>
    ${multi ? `<div class="small muted mb" style="padding:0 2px">${T('branches_hint')}</div>` : ''}
    <div id="brs"></div>

    <div class="card pad mb">
      <div class="small muted" style="margin-bottom:6px">${T('note')}</div>
      <textarea id="note" rows="2" ${canEdit ? '' : 'readonly'} style="width:100%;border:1.5px solid var(--line);border-radius:9px;padding:9px;background:var(--card);resize:vertical" placeholder="${canEdit ? T('note_ph') : T('note_none')}">${esc(note)}</textarea>
      <div class="btns" style="margin-top:10px">
        ${canEdit
          ? `<button class="btn pri wide" id="save">${T('save_btn')}</button>`
          : `<div class="rolenote">${T('viewer_note')}</div>`}
      </div>
    </div>

    ${(L.boxes || []).length ? `<div class="card pad mb">
      <div class="spread mb"><b>${T('boxes_title')}</b><span class="small muted">${T('boxes_n', { n: n0(L.cases) })}</span></div>
      <div class="small muted" style="margin-bottom:8px">${T('boxes_hint')}</div>
      <div class="scrollx"><table class="tbl">
        <thead><tr><th>№</th><th>${T('c_qty')}</th><th>DN</th><th>${T('b_ins')}</th><th>${T('b_pos')}</th><th>${T('b_what')}</th></tr></thead>
        <tbody>${L.boxes.map((b) => `<tr>
          <td class="mono">${esc(b.n || '')}</td>
          <td class="mono">${b.qty > 1 ? '<b>' + n0(b.qty) + '</b>' : n0(b.qty)}</td>
          <td class="mono">${esc(b.dn || '')}</td>
          <td class="mono">${b.ins ? n0(b.ins) : ''}</td>
          <td class="mono">${esc(b.pos || '')}</td>
          <td style="text-align:left;white-space:normal">${esc([b.info, b.valve].filter(Boolean).join(' · '))}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}

    <div class="card pad mb">
      <div class="spread mb"><b>${T('connects')}</b><span class="small muted">${(L.connect || []).length}</span></div>
      <div class="btns">${(L.connect || []).length
        ? L.connect.map((c) => {
            const t = LINES.find((x) => x.name === c);
            return t ? `<button class="btn" data-go="#/line/${t.id}">${esc(t.short)}</button>`
                     : `<button class="btn" disabled title="${T('not_in_reg')}">${esc(c)}</button>`;
          }).join('')
        : `<span class="muted small">${T('not_listed')}</span>`}</div>
    </div>

    <div class="card pad mb">
      <div class="spread"><b>${T('composition')}</b><button class="btn small" id="tgl">${T('show')}</button></div>
      <div id="rows" hidden style="margin-top:10px"></div>
    </div>

    <div class="btns noprint" style="margin-bottom:20px">
      <button class="btn" data-go="#/">${T('nav_home')}</button>
      <button class="btn" data-go="#/list">${T('nav_list')}</button>
      <button class="btn" data-go="#/report">${T('nav_report')}</button>
      <button class="btn" onclick="window.print()">${T('print_line')}</button>
    </div>`;

  $('#tgl').addEventListener('click', () => {
    const r = $('#rows'); r.hidden = !r.hidden;
    $('#tgl').textContent = r.hidden ? T('show') : T('hide');
    if (!r.innerHTML) r.innerHTML = `<div class="scrollx"><table class="tbl">
      <thead><tr><th>${T('c_part')}</th><th>${T('c_dn')}</th><th>${T('c_pipe')}</th><th>${T('c_ins')}</th><th>${T('c_metal')}</th><th>${T('c_dev')}</th><th>${T('c_qty')}</th><th>${T('c_deg')}</th><th>${T('c_m')}</th><th>${T('c_m2')}</th></tr></thead>
      <tbody>${(L.rows || []).map((x) => `<tr><td>${esc(x.part)}</td><td class="mono">${x.dn || ''}</td><td class="mono">${n0(x.id) || ''}</td><td class="mono">${n0(x.ins) || ''}</td><td class="mono">${n0(x.od) || ''}</td><td class="mono">${n0(x.dev) || ''}</td><td class="mono">${x.qty || ''}</td><td class="mono">${x.deg == null ? '' : x.deg}</td><td class="mono">${x.summ ? n1(x.summ) : ''}</td><td class="mono">${x.area ? n1(x.area) : ''}</td></tr>`).join('')}</tbody></table></div>`;
  });

  function drawBranches() {
    $('#brs').innerHTML = BR.map((b) => {
      const bp = branchPercent(checks, b.id, L);
      const c = checks.branches[b.id];
      const bx = (L.boxes || []).filter((x) => (x.branch || (BR[0] && BR[0].id)) === b.id);
      // чемоданы разворачиваем поштучно: строка с qty 2 даёт два чек-бокса
      const boxItems = [];
      for (const x of bx) for (let i = 0; i < (x.qty || 1); i++)
        boxItems.push({ id: (x.qty > 1 ? x.n + '#' + (i + 1) : String(x.n)), n: x.n, dn: x.dn, ins: x.ins });

      const info = [
        [T('k_straight'), n1(metreBase(b))], [T('k_elbows'), n0(b.elbows)],
        [T('k_cases'), n0(b.cases)], [T('c_m2'), n1(b.area_m2)],
        [T('k_hours'), n1((b.hours && b.hours.total) || 0)],
      ];

      const grid = (key, kind, items, done) => `<div class="cbs">${items.map((it) => {
        const on = done.includes(it.v);
        return `<button class="cb${on ? ' on' : ''}" data-b="${b.id}" data-st="${key}" data-${kind}="${esc(it.v)}"
          ${canEdit ? '' : 'disabled'} title="${esc(it.t || '')}">${esc(it.l)}</button>`;
      }).join('')}</div>`;

      const rel = branchRelease(checks, b.id);
      const relBlock = `<div class="pos rel">
          <div class="ph">
            <span class="w mono rw">R</span>
            <span class="t"><b>Release</b> <i>${T('rel_sub')}</i></span>
            ${multi && canEdit ? `<button class="allbtn" data-relall="1" data-from="${b.id}" title="${T('to_all_t')}">${T('to_all')}</button>` : ''}
            <span class="p mono" style="color:${rel > 0 ? 'var(--rel)' : 'var(--ink3)'}">${n1(rel)}%</span>
          </div>
          <div class="inrow">
            <input class="numin" type="number" inputmode="decimal" min="0" max="100" step="5" value="${rel || ''}"
              data-b="${b.id}" data-rel="1" placeholder="0" ${canEdit ? '' : 'disabled'}>
            <span class="unit">%</span>
            ${canEdit ? `<span class="quick">
              <button class="btn sm" data-b="${b.id}" data-relset="50">50</button>
              <button class="btn sm" data-b="${b.id}" data-relset="100">100</button>
              <button class="btn sm" data-b="${b.id}" data-relset="0">0</button></span>` : ''}
          </div>
        </div>`;

      const body = STAGES.map((s) => {
        const p = branchStagePercent(checks, b.id, s.key, L);
        let ctrl = '';

        if (s.kind === 'pct') {
          const v = c[s.key] || 0;
          ctrl = `<div class="inrow">
            <input class="numin" type="number" inputmode="decimal" min="0" max="100" step="5" value="${v || ''}"
              data-b="${b.id}" data-pct="${s.key}" placeholder="0" ${canEdit ? '' : 'disabled'}>
            <span class="unit">%</span>
            ${canEdit ? `<span class="quick">
              <button class="btn sm" data-b="${b.id}" data-set="${s.key}" data-v="50">50</button>
              <button class="btn sm" data-b="${b.id}" data-set="${s.key}" data-v="100">100</button>
              <button class="btn sm" data-b="${b.id}" data-set="${s.key}" data-v="0">0</button></span>` : ''}
          </div>`;

        } else if (s.kind === 'insp') {
          ctrl = `<div class="lv two">${INSP_LEVELS.map((lv) => {
            const on = c.inspection.levels.includes(lv);
            return `<button class="${on ? 'on' + (lv === 100 ? ' full' : '') : ''}" data-b="${b.id}" data-insp="${lv}" ${canEdit ? '' : 'disabled'}>${lv}%</button>`;
          }).join('')}</div>`;

        } else {  // qty: метры + отводы (+ чемоданы для металла)
          const st = c[s.key] || { m: 0, el: [], bx: [] };
          const isClad = s.key === 'cladding';
          const els = Array.from({ length: b.elbows || 0 }, (_, i) => ({ v: String(i), l: String(i + 1) }));
          ctrl = `
            ${metreBase(b) > 0 ? `<div class="inrow">
              <input class="numin" type="number" inputmode="decimal" min="0" max="${metreBase(b)}" step="0.5"
                value="${st.m || ''}" data-b="${b.id}" data-m="${s.key}" placeholder="0" ${canEdit ? '' : 'disabled'}>
              <span class="unit">${T('of_m', { n: n1(metreBase(b)) })}</span>
              ${canEdit ? `<span class="quick"><button class="btn sm" data-b="${b.id}" data-mall="${s.key}">${T('all_m')}</button></span>` : ''}
            </div>` : ''}
            ${els.length ? `<div class="cbwrap">
              <div class="cbt small">${T('elbows_done', { n: st.el.length, t: els.length })}
                ${canEdit ? `<button class="btn sm" data-b="${b.id}" data-elall="${s.key}">${T('all_short')}</button>` : ''}</div>
              ${grid(s.key, 'el', els.map((e) => ({ v: e.v, l: e.l })), st.el.map(String))}
            </div>` : ''}
            ${isClad && boxItems.length ? `<div class="cbwrap">
              <div class="cbt small">${T('boxes_done', { n: (st.bx || []).length, t: boxItems.length })}
                ${canEdit ? `<button class="btn sm" data-b="${b.id}" data-bxall="1">${T('all_short')}</button>` : ''}</div>
              ${grid(s.key, 'bx', boxItems.map((x) => ({ v: x.id, l: '№' + x.n, t: `DN${x.dn} · ${x.ins} ${T('mm')}` })), (st.bx || []).map(String))}
            </div>` : ''}`;
        }

        return `<div class="pos">
          <div class="ph">
            <span class="w mono">${s.weight}%</span>
            <span class="t"><b>${s.title}</b> <i>${s[I18N.lang] || s.ru}</i></span>
            ${multi && canEdit ? `<button class="allbtn" data-all="${s.key}" data-from="${b.id}" title="${T('to_all_t')}">${T('to_all')}</button>` : ''}
            <span class="p mono" style="color:${pctColor(p)}">${n1(p)}%</span>
          </div>${ctrl}</div>`;
      }).join('');

      return `<div class="branch card mb" data-open="${OPEN[b.id] ? 1 : 0}" data-id="${b.id}">
        <div class="bh">
          <div class="bl">
            <b class="mono">${esc(b.label)}</b>
            <span class="dn">DN${b.dn || '—'}</span>
          </div>
          <div class="bp mono" style="color:${pctColor(bp)}">${n1(bp)}%</div>
          <div class="bx">${OPEN[b.id] ? '▾' : '▸'}</div>
        </div>
        <div class="bmeta small mono">${T('br_meta', { d: n0(b.dev), m: n1(b.length_m), a: n1(b.area_m2) })}${multi ? T('br_share', { w: n1(b.weight) }) : ''}</div>
        <div class="bbar">${bar(bp)}</div>
        <div class="bd">
          <div class="binfo">${info.map(([k, v]) => `<div><b class="mono">${v}</b><span>${k}</span></div>`).join('')}</div>
          ${relBlock}
          ${body}
        </div>
      </div>`;
    }).join('');

    const tot = linePercent(L, checks);
    $('.total').firstElementChild.outerHTML = dial(tot);
    $('#tbar').innerHTML = bar(tot);
    $('#upd').textContent = dirty ? T('not_saved') : (L.updated ? new Date(L.updated).toLocaleString(loc(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · ' + (L.updated_by || '') : T('no_marks'));
    $('#upd').style.color = dirty ? 'var(--acc)' : '';
  }
  drawBranches();
  relTotal();

  if (multi) $('#expall').addEventListener('click', () => {
    const any = !BR.every((b) => OPEN[b.id]);
    for (const b of BR) OPEN[b.id] = any;
    $('#expall').textContent = any ? T('collapse_all') : T('expand_all');
    drawBranches();
  });

  /* ввод чисел — без перерисовки, чтобы не сбивать курсор */
  $('#brs').addEventListener('input', (e) => {
    const i = e.target;
    if (!canEdit || !i.classList || !i.classList.contains('numin')) return;
    const bc = checks.branches[i.dataset.b];
    if (!bc) return;
    const v = Math.max(0, +i.value || 0);
    if (i.dataset.rel) bc.release = Math.min(100, v);
    else if (i.dataset.pct) bc[i.dataset.pct] = Math.min(100, v);
    else if (i.dataset.m) {
      const b = BR.find((x) => x.id === i.dataset.b) || {};
      bc[i.dataset.m].m = Math.min(v, metreBase(b));
    }
    dirty = true;
    const pos = i.closest('.pos');
    if (i.dataset.rel) {
      const el3 = pos && pos.querySelector('.p');
      if (el3) { el3.textContent = n1(bc.release) + '%'; el3.style.color = bc.release > 0 ? 'var(--rel)' : 'var(--ink3)'; }
      relTotal();
      $('#upd').textContent = T('not_saved'); $('#upd').style.color = 'var(--acc)';
      return;
    }
    const key = i.dataset.pct || i.dataset.m;
    if (pos) {
      const p = branchStagePercent(checks, i.dataset.b, key, L);
      const el2 = pos.querySelector('.p'); if (el2) { el2.textContent = n1(p) + '%'; el2.style.color = pctColor(p); }
    }
    liveTotals();
  });

  /** Обновляет строку «выдано под изоляцию» в шапке линии. */
  function relTotal() {
    const el4 = $('#relline');
    if (!el4) return;
    const r = lineRelease(L, checks);
    el4.innerHTML = `${T('rel_line')}: <b>${n1(r)}%</b>`
      + (L.release_note || L.release_date ? ` <span class="muted">· ${T('rel_reg')}: ${esc(L.release_date ? dLabelFull(L.release_date) : L.release_note)}</span>` : '');
    el4.style.opacity = r > 0 ? 1 : 0.65;
  }

  function liveTotals() {
    const tot = linePercent(L, checks);
    $('#tbar').innerHTML = bar(tot);
    const d = $('.total .dial b'); if (d) d.textContent = n1(tot);
    for (const b of BR) {
      const card = $(`.branch[data-id="${b.id}"]`);
      if (!card) continue;
      const p = branchPercent(checks, b.id, L);
      const t = card.querySelector('.bp'); if (t) { t.textContent = n1(p) + '%'; t.style.color = pctColor(p); }
      const bb = card.querySelector('.bbar'); if (bb) bb.innerHTML = bar(p);
    }
    $('#upd').textContent = T('not_saved'); $('#upd').style.color = 'var(--acc)';
  }

  $('#brs').addEventListener('click', (e) => {
    const bh = e.target.closest('.bh');
    if (bh) { const id2 = bh.parentElement.dataset.id; OPEN[id2] = !OPEN[id2]; drawBranches(); return; }
    const btn = e.target.closest('button'); if (!btn || !canEdit) return;

    // «всем» для выдачи под изоляцию
    if (btn.dataset.relall) {
      const v = checks.branches[btn.dataset.from].release;
      for (const b of BR) checks.branches[b.id].release = v;
      dirty = true; drawBranches(); relTotal(); toast(T('applied_all'));
      return;
    }

    // «всем» — скопировать позицию на все ветки линии
    if (btn.dataset.all) {
      const st = btn.dataset.all, from = checks.branches[btn.dataset.from];
      for (const b of BR) {
        const t = checks.branches[b.id];
        if (st === 'inspection') t.inspection.levels = from.inspection.levels.slice();
        else if (st === 'materials' || st === 'finishing') t[st] = from[st];
        else {
          // метры и отводы копируем долей: та же готовность позиции
          const src = BR.find((x) => x.id === btn.dataset.from) || {};
          const share = (() => {
            const tot = metreBase(src) + 1.5 * (+src.elbows || 0);
            const done = Math.min(from[st].m || 0, metreBase(src)) + 1.5 * ((from[st].el || []).length);
            return tot > 0 ? Math.min(1, done / tot) : 0;
          })();
          t[st].m = Math.round(metreBase(b) * share * 10) / 10;
          const ne = Math.round((+b.elbows || 0) * share);
          t[st].el = Array.from({ length: ne }, (_, i) => i);
          if (st === 'cladding' && t[st].bx) {
            const all = (L.boxes || []).filter((x) => x.branch === b.id).length;
            t[st].bx = share >= 1 ? t[st].bx : t[st].bx;
          }
        }
      }
      dirty = true; drawBranches(); toast(T('applied_all'));
      return;
    }

    const bc = checks.branches[btn.dataset.b];
    if (!bc) return;

    if (btn.dataset.relset != null) { bc.release = +btn.dataset.relset; }
    else if (btn.dataset.set) { bc[btn.dataset.set] = +btn.dataset.v; }
    else if (btn.dataset.mall) {
      const b = BR.find((x) => x.id === btn.dataset.b) || {};
      const st = bc[btn.dataset.mall];
      st.m = (st.m >= metreBase(b)) ? 0 : metreBase(b);
    } else if (btn.dataset.elall) {
      const b = BR.find((x) => x.id === btn.dataset.b) || {};
      const st = bc[btn.dataset.elall];
      st.el = st.el.length >= (b.elbows || 0) ? [] : Array.from({ length: b.elbows || 0 }, (_, i) => i);
    } else if (btn.dataset.bxall) {
      const items = (L.boxes || []).filter((x) => x.branch === btn.dataset.b);
      const all = [];
      for (const x of items) for (let i = 0; i < (x.qty || 1); i++) all.push(x.qty > 1 ? x.n + '#' + (i + 1) : String(x.n));
      bc.cladding.bx = (bc.cladding.bx || []).length >= all.length ? [] : all;
    } else if (btn.dataset.el != null) {
      const st = bc[btn.dataset.st], v = +btn.dataset.el, i = st.el.indexOf(v);
      i >= 0 ? st.el.splice(i, 1) : st.el.push(v);
    } else if (btn.dataset.bx != null) {
      const st = bc[btn.dataset.st];
      st.bx = st.bx || [];
      const v = btn.dataset.bx, i = st.bx.indexOf(v);
      i >= 0 ? st.bx.splice(i, 1) : st.bx.push(v);
    } else if (btn.dataset.insp) {
      const lv = +btn.dataset.insp, a = bc.inspection.levels, i = a.indexOf(lv);
      i >= 0 ? a.splice(i, 1) : a.push(lv);
    } else return;
    dirty = true; drawBranches();
  });

  if (canEdit) $('#note').addEventListener('input', () => { dirty = true; $('#upd').textContent = T('not_saved'); $('#upd').style.color = 'var(--acc)'; });

  if (canEdit) $('#save').addEventListener('click', async () => {
    const nt = $('#note').value;
    try {
      const r = await api('lines/' + encodeURIComponent(id) + '/progress', { method: 'PUT', body: { checks, note: nt, by: LS.by } });
      saveDetail(id, Object.assign(L, r, { checks, note: nt }));
      L = DETAIL[id];
      ONLINE = true;
      const i = LINES.findIndex((x) => x.id === id);
      if (i >= 0) LINES[i] = r;
      LS.queue = LS.queue.filter((x) => x.id !== id);
      dirty = false; drawBranches(); chrome(L.short, L.name, true);
      toast(T('saved'));
    } catch (e) {
      ONLINE = false;
      queuePut(id, checks, nt);
      saveDetail(id, Object.assign(L, { checks, note: nt }));
      dirty = false; drawBranches(); chrome(L.short, L.name, true);
      toast(T('saved_offline'), 3600);
    }
  });
}

/* --- полный список --- */
let sortBy = { k: 'name', d: 1 };
function viewList() {
  chrome(T('list_title'), T('list_sub', { n: LINES.length, m: n1(LINES.reduce((s, x) => s + x.length_m, 0)) }), false);
  const cols = [
    ['name', T('h_line'), (l) => esc(l.short)],
    ['dn', 'DN', (l) => l.dn || ''],
    ['pipe_od', T('h_size'), (l) => (l.pipe_od && l.clad_od) ? `${n0(l.pipe_od)}/${n0(l.ins)}/${n0(l.clad_od)}` : ''],
    ['branch_count', T('h_branches'), (l) => l.branch_count || 1],
    ['elbows', T('h_elbows'), (l) => n0(l.elbows)],
    ['straight_m', T('h_straight'), (l) => n1(l.straight_m)],
    ['ties', T('h_ties'), (l) => n0(l.ties)],
    ['cones', T('h_cones'), (l) => n0(l.cones)],
    ['cases', T('h_cases'), (l) => n0(l.cases)],
    ['length_m', T('h_len'), (l) => n1(l.length_m)],
    ['area_m2', T('h_area'), (l) => n1(l.area_m2)],
    ['release', 'R', (l) => (l.release ? `<span style="color:var(--rel)">${n1(l.release)}</span>` : '·')],
    ['percent', T('h_pct'), (l) => `<b style="color:${pctColor(l.percent)}">${n1(l.percent)}</b>`],
  ];
  const rows = LINES.slice().sort((a, b) => {
    const k = sortBy.k;
    const va = a[k], vb = b[k];
    return (typeof va === 'string' ? va.localeCompare(vb) : (va - vb)) * sortBy.d;
  });
  const sum = (k) => rows.reduce((s, x) => s + (x[k] || 0), 0);
  $('#app').innerHTML = `
    <div class="card pad mb"><div class="row wrap small">
      <span>${T('sum_line', { lines: rows.length, el: n0(sum('elbows')), ti: n0(sum('ties')),
        co: n0(sum('cones')), ca: n0(sum('cases')), m: n1(sum('length_m')), a: n1(sum('area_m2')) })}</span>
    </div></div>
    <div class="card"><div class="scrollx"><table class="tbl">
      <thead><tr>${cols.map(([k, t]) => `<th data-s="${k}" style="cursor:pointer">${t}${sortBy.k === k ? (sortBy.d > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((l) => `<tr data-go="#/line/${l.id}" style="cursor:pointer">${cols.map(([k, t, f]) => `<td class="${k === 'name' ? '' : 'mono'}">${f(l)}</td>`).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr style="font-weight:700;border-top:2px solid var(--line)">
        <td>${T('h_total')}</td><td></td><td></td><td></td>
        <td class="mono">${n0(sum('elbows'))}</td><td class="mono">${n1(sum('straight_m'))}</td>
        <td class="mono">${n0(sum('ties'))}</td><td class="mono">${n0(sum('cones'))}</td>
        <td class="mono">${n0(sum('cases'))}</td><td class="mono">${n1(sum('length_m'))}</td>
        <td class="mono">${n1(sum('area_m2'))}</td>
        <td class="mono">${n1(sum('length_m') ? rows.reduce((s, x) => s + x.percent * x.length_m, 0) / sum('length_m') : 0)}</td>
      </tr></tfoot>
    </table></div></div>
    <div class="btns noprint" style="margin:14px 0 20px">
      <button class="btn" id="csv">${T('csv_btn')}</button>
      <button class="btn" onclick="window.print()">${T('print_btn')}</button>
    </div>`;
  $('#app').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-s]'); if (!th) return;
    if (sortBy.k === th.dataset.s) sortBy.d *= -1; else { sortBy.k = th.dataset.s; sortBy.d = 1; }
    viewList();
  });
  $('#csv').addEventListener('click', () => {
    const head = cols.map(([k, t]) => t).join(';');
    const body = rows.map((l) => [l.short, l.dn, `${l.pipe_od}/${l.ins}/${l.clad_od}`, l.branch_count || 1, l.elbows, l.straight_m, l.ties, l.cones, l.cases, l.length_m, l.area_m2, l.percent].join(';')).join('\n');
    dl('TESA_lines.csv', '﻿' + head + '\n' + body, 'text/csv');
  });
}

function dl(name, text, type) {
  const b = new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* --- отчёт --- */
async function viewReport() {
  chrome(T('rep_title'), T('rep_sub'), false);
  const app = $('#app');
  app.innerHTML = `<div class="empty">${T('rep_calc')}</div>`;
  let R;
  try { R = await api('report'); LS.cache = Object.assign(LS.cache || {}, { report: R }); }
  catch (e) { R = (LS.cache || {}).report; if (!R) { app.innerHTML = `<div class="empty">${T('no_offline')}</div>`; return; } }
  const TT = R.totals;
  const date = new Date(R.generated).toLocaleString('ru-RU');

  const srow = (s) => `<div class="srow">
      <div class="t"><b>${s.title} <span class="muted" style="font-weight:400">— ${s[I18N.lang] || s.ru}</span></b>
        <span class="mono">${T('weight', { w: s.weight })}</span></div>
      <div class="dual" style="margin-bottom:5px"><span class="lab">${T('c_m2')}</span>${bar(s.percent_a)}<span class="mono small" style="width:52px;text-align:right">${n1(s.percent_a)}%</span></div>
      <div class="dual"><span class="lab">${T('c_m')}</span>${bar(s.percent_m)}<span class="mono small" style="width:52px;text-align:right">${n1(s.percent_m)}%</span></div>
      <div class="small muted mono" style="margin-top:4px">${T('done_approx', { a: n1(s.done_a), m: n1(s.done_m) })}</div>
    </div>`;

  app.innerHTML = `
    <div class="printhead">
      <div class="printlogos">
        <img class="bti" src="logos/bti.png" alt="BTI Service">
        <img class="upm" src="logos/upm.png" alt="UPM">
        <img class="valmet" src="logos/valmet.png" alt="Valmet">
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div><b style="font-size:15pt">${T('rep_head')}</b>
        <div style="font-size:9pt">${T('rep_src', { s: esc(R.meta.source || '') })}</div></div>
        <div style="font-size:9pt;text-align:right">${T('rep_made', { d: date })}<br>${esc((ME && ME.name) || '')}</div>
      </div>
    </div>
    ${logos('flat')}

    <div class="stats mb">
      ${isMgr(ME) && TT.percent_h != null ? `<div class="stat"><b class="mono" style="color:${pctColor(TT.percent_h)}">${n1(TT.percent_h)}%</b><span>${T('st_hours')}</span>
        <div class="sub2 mono">${n1(TT.earned_h)} ${T('st_norm_h', { n: n0(TT.norm_h) })}</div></div>` : ''}
      <div class="stat"><b class="mono" style="color:${pctColor(TT.percent_a)}">${n1(TT.percent_a)}%</b><span>${T('st_area')}</span>
        <div class="sub2 mono">${T('st_of', { a: n1(TT.area_m2 * TT.percent_a / 100), b: n1(TT.area_m2), u: T('c_m2') })}</div></div>
      <div class="stat"><b class="mono" style="color:${pctColor(TT.percent_m)}">${n1(TT.percent_m)}%</b><span>${T('st_len')}</span>
        <div class="sub2 mono">${T('st_of', { a: n1(TT.length_m * TT.percent_m / 100), b: n1(TT.length_m), u: T('c_m') })}</div></div>
      <div class="stat"><b class="mono">${TT.released}<span style="font-size:15px;color:var(--ink3)">/${TT.lines}</span></b><span>${T('st_released')}</span>
        <div class="sub2 mono">${T('st_of_all', { p: n1(TT.released / TT.lines * 100) })}</div></div>
      <div class="stat"><b class="mono">${TT.insulated_100}<span style="font-size:15px;color:var(--ink3)">/${TT.lines}</span></b><span>${T('st_insulated')}</span>
        <div class="sub2 mono">${T('st_metal_acc', { c: TT.cladded_100, i: TT.accepted_100 })}</div></div>
    </div>

    <div class="card pad mb">
      <div class="spread mb"><b>${T('rel_title')}</b>
        <span class="small muted">${T('rel_lines_n', { a: TT.released_100 || 0, b: TT.released || 0, t: TT.lines })}</span></div>
      <div class="dual" style="margin-top:6px"><span class="lab">${T('c_m2')}</span>${bar(TT.release_a || 0, 'rel')}<span class="mono small" style="width:52px;text-align:right">${n1(TT.release_a || 0)}%</span></div>
      <div class="dual" style="margin-top:4px"><span class="lab">${T('c_m')}</span>${bar(TT.release_m || 0, 'rel')}<span class="mono small" style="width:52px;text-align:right">${n1(TT.release_m || 0)}%</span></div>
      <div class="small muted" style="margin-top:7px">${T('rel_hint', {
        a: n1(TT.area_m2 * (TT.release_a || 0) / 100), b: n1(TT.area_m2),
        m: n1(TT.length_m * (TT.release_m || 0) / 100), n: n1(TT.length_m) })}</div>
    </div>

    <div class="card pad mb">
      <div class="spread mb"><b>${T('positions')}</b><span class="small muted">${T('area_len')}</span></div>
      ${R.stages.map(srow).join('')}
    </div>

    <div class="card mb">
      <div class="pad spread"><b>${T('by_lines')}</b><span class="small muted">${T('pcs', { n: R.lines.length })}</span></div>
      <div class="scrollx"><table class="tbl">
        <thead><tr><th>${T('h_line')}</th><th>${T('h_branches')}</th><th>${T('c_m')}</th><th>${T('c_m2')}</th><th>R</th><th>${T('h_mat')}</th><th>${T('h_ins')}</th><th>${T('h_clad')}</th><th>${T('h_fin')}</th><th>${T('h_insp')}</th><th>${T('h_pct')}</th></tr></thead>
        <tbody>${R.lines.slice().sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name)).map((l) => `
          <tr data-go="#/line/${l.id}" style="cursor:pointer">
            <td>${esc(l.short)}</td>
            <td class="mono">${l.branch_count || 1}</td>
            <td class="mono">${n1(l.length_m)}</td><td class="mono">${n1(l.area_m2)}</td>
            <td class="mono" style="color:var(--rel)">${l.release ? n1(l.release) : '·'}</td>
            <td class="mono">${n1(l.stages.materials)}</td>
            <td class="mono">${n1(l.stages.insulation)}</td>
            <td class="mono">${n1(l.stages.cladding)}</td>
            <td class="mono">${n1(l.stages.finishing)}</td>
            <td class="mono">${n1(l.stages.inspection)}</td>
            <td class="mono"><b style="color:${pctColor(l.percent)}">${n1(l.percent)}</b></td>
          </tr>`).join('')}</tbody>
        <tfoot><tr style="font-weight:700;border-top:2px solid var(--line)">
          <td>${T('h_total')}</td>
          <td class="mono">${R.lines.reduce((a, l) => a + (l.branch_count || 1), 0)}</td>
          <td class="mono">${n1(TT.length_m)}</td><td class="mono">${n1(TT.area_m2)}</td>
          <td class="mono" style="color:var(--rel)">${n1(TT.release_a || 0)}</td>
          ${['materials', 'insulation', 'cladding', 'finishing', 'inspection'].map((k) => {
            const s = R.stages.find((x) => x.key === k); return `<td class="mono">${n1(s.percent_a)}</td>`;
          }).join('')}
          <td class="mono">${n1(TT.percent_a)}</td>
        </tr></tfoot>
      </table></div>
    </div>

    <div class="small muted mb">${T('rep_note', { d: date })}</div>

    <div class="btns noprint" style="margin-bottom:24px">
      <button class="btn pri" id="pdf">${T('pdf_print')}</button>
      <button class="btn" id="share">${T('share')}</button>
      <button class="btn" id="csv">CSV</button>
      <button class="btn" id="json">${T('backup')}</button>
    </div>`;

  $('#pdf').addEventListener('click', () => window.print());
  $('#csv').addEventListener('click', () => {
    const head = [T('h_line'), T('h_branches'), T('h_len'), T('h_area'), 'Release', 'Materials',
      'Insulation', 'Cladding', 'Finishing', 'Inspection', T('h_pct')].join(';');
    const body = R.lines.map((l) => [l.short, l.branch_count || 1, l.length_m, l.area_m2, l.release || 0, l.stages.materials, l.stages.insulation, l.stages.cladding, l.stages.finishing, l.stages.inspection, l.percent].join(';')).join('\n');
    dl('TESA_progress_report.csv', '﻿' + head + '\n' + body, 'text/csv');
  });
  $('#json').addEventListener('click', async () => {
    try { const e2 = await api('export'); dl('TESA_backup_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(e2, null, 1), 'application/json'); }
    catch (e) { toast(T('export_fail')); }
  });
  $('#share').addEventListener('click', async () => {
    const txt = T('share_txt', { d: date }) + '\n'
      + T('share_l1', { a: n1(TT.percent_a), m: n1(TT.percent_m) }) + '\n'
      + T('share_l2', { a: n1(TT.area_m2), m: n1(TT.length_m), n: TT.lines }) + '\n'
      + T('share_l3', { n: TT.released }) + '\n'
      + R.stages.map((s) => `${s.title}: ${n1(s.percent_a)}% (${n1(s.done_a)} ${T('c_m2')})`).join('\n');
    if (navigator.share) { try { await navigator.share({ title: T('rep_title') + ' — ' + T('app_title'), text: txt }); return; } catch (e) {} }
    try { await navigator.clipboard.writeText(txt); toast(T('copied')); }
    catch (e) { dl('TESA_report.txt', txt); }
  });
}

/* --- меню режима: имя работника и выход --- */
function roleMenu() {
  const canEdit = isMgr(ME);
  const box = el(`<div class="sheetwrap"><div class="sheet">
    <div class="spread mb"><b>${T('mode', { x: esc(ME.name) })}</b><button class="btn small" id="cls" style="min-height:34px;padding:6px 12px">✕</button></div>
    <p class="small muted" style="margin:0 0 12px">${canEdit
      ? T('foreman_desc') : T('viewer_desc')}</p>
    ${canEdit ? `<label class="small muted">${T('your_name')}</label>
    <input id="byname" value="${esc(LS.by)}" placeholder="${T('your_name_ph')}"
      style="width:100%;padding:11px;border:1.5px solid var(--line);border-radius:9px;background:var(--card);margin:6px 0 12px;font-size:16px">` : ''}
    <div class="syncbox">
      <div class="spread"><span class="small"><b>${T('conn')}</b></span>
        <span class="small mono" id="syncst" style="color:${ONLINE ? 'var(--ok)' : 'var(--acc)'}">${ONLINE ? T('conn_yes') : T('conn_no')}</span></div>
      <div class="small muted" style="margin-top:3px">${T('not_sent_n', { q: LS.queue.length, d: Object.keys(DETAIL).length, t: LINES.length })}</div>
      <div class="small muted" id="stor" style="margin-top:3px"></div>
      <div class="btns" style="margin-top:9px">
        <button class="btn small" id="sync" style="min-height:38px">${T('sync_now')}</button>
        <button class="btn small" id="pre" style="min-height:38px">${T('load_lines')}</button>
        <button class="btn small" id="predw" style="min-height:38px">${T('load_drawings')}</button>
      </div>
    </div>
    <button class="btn wide" id="log" style="margin-top:10px">${T('log_title')}</button>
    ${canEdit ? `<button class="btn wide" id="outall" style="margin-top:8px">${T('logout_all')}</button>
    <div class="small muted" style="margin-top:4px">${T('logout_all_hint')}</div>` : ''}
    <button class="btn wide" id="out" style="margin-top:8px">${T('switch_user')}</button>
  </div></div>`);
  document.body.appendChild(box);
  const close = () => box.remove();
  box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('#cls')) close(); });
  fetch('api/health').then((r) => r.json()).then((h) => {
    const el2 = $('#stor', box); if (!el2) return;
    const where = h.storage === 'drive' ? T('st_drive') : T('st_file');
    el2.innerHTML = h.ok
      ? T('storage', { s: where })
      : T('storage_err', { s: where }) + `<br><span class="mono" style="font-size:11px">${esc((h.error || '').slice(0, 160))}</span>`;
  }).catch(() => {});

  const inp = $('#byname', box);
  if (inp) inp.addEventListener('input', () => { LS.by = inp.value.trim(); });
  $('#sync', box).addEventListener('click', async () => {
    const btn = $('#sync', box); btn.disabled = true; btn.textContent = T('checking');
    await syncTick();
    $('#syncst', box).textContent = ONLINE ? T('conn_yes') : T('conn_no');
    $('#syncst', box).style.color = ONLINE ? 'var(--ok)' : 'var(--acc)';
    $('#qn', box).textContent = LS.queue.length;
    btn.disabled = false; btn.textContent = T('sync_now');
    toast(ONLINE ? (LS.queue.length ? T('sync_left', { n: LS.queue.length }) : T('sync_ok')) : T('sync_off'));
  });

  $('#pre', box).addEventListener('click', async () => {
    const btn = $('#pre', box); btn.disabled = true;
    const r = await prefetchAll(true, (d, t) => { btn.textContent = `${d} / ${t}`; });
    btn.disabled = false; btn.textContent = T('load_lines');
    $('#dn', box).textContent = Object.keys(DETAIL).length;
    toast(r && r.failed ? T('part_offline') : T('all_offline'));
  });

  $('#predw', box).addEventListener('click', async () => {
    const btn = $('#predw', box); btn.disabled = true;
    let done = 0, failed = 0;
    try {
      const list = await api('drawings');
      for (const d of list) {
        try { await fetch('drawings/' + encodeURIComponent(d.file), { cache: 'reload' }); done++; }
        catch (e) { failed++; if (failed > 3) break; }
        btn.textContent = `${done} / ${list.length}`;
      }
      toast(failed ? T('dwg_part', { n: done }) : T('dwg_loaded', { n: done }));
    } catch (e) { toast(T('no_server')); }
    btn.disabled = false; btn.textContent = T('load_drawings');
  });

  $('#log', box).addEventListener('click', () => { close(); location.hash = '#/log'; });

  const oa = $('#outall', box);
  if (oa) oa.addEventListener('click', async () => {
    if (!confirm(T('logout_all_q'))) return;
    oa.disabled = true;
    try {
      const r = await api('logout-all', { method: 'POST' });
      toast(T('logout_all_ok', { n: r.closed || 0 }), 3200);
    } catch (e) { toast(e.message, 3000); }
    oa.disabled = false;
  });

  $('#out', box).addEventListener('click', async () => {
    try { await api('logout', { method: 'POST' }); } catch (e) {}
    LS.t = null; ME = null; LS.me = null; LINES = []; DETAIL = {};
    close(); location.hash = '#/'; render();
  });
}

/* --- табель часов --- */
const WD_SHORT = { ru: ['вс','пн','вт','ср','чт','пт','сб'], en: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], et: ['P','E','T','K','N','R','L'] };
const dLabel = (iso) => {
  const d = HOURS.parse(iso); if (!d) return iso;
  const w = (WD_SHORT[I18N.lang] || WD_SHORT.ru)[d.getDay()];
  return `${d.getDate()}.${(d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1)}`;
};
const dLabelFull = (iso) => {
  const d = HOURS.parse(iso); if (!d) return iso;
  return d.toLocaleDateString(loc(), { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const dWeek = (iso) => {
  const d = HOURS.parse(iso); if (!d) return '';
  return (WD_SHORT[I18N.lang] || WD_SHORT.ru)[d.getDay()];
};


/** S-кривая готовности: план, факт, прогноз. Чистый SVG, без библиотек. */
function curveSVG(cv, plan) {
  if (!cv || !cv.plan || !cv.plan.length) return '';
  const W = 640, Hh = 260, ML = 38, MR = 12, MT = 14, MB = 30;
  const days = cv.plan.map((p) => p.d);
  const x0 = HOURS.parse(days[0]), x1 = HOURS.parse(days[days.length - 1]);
  const span = Math.max(1, (x1 - x0) / 86400000);
  const X = (d) => ML + ((HOURS.parse(d) - x0) / 86400000 / span) * (W - ML - MR);
  const Y = (v) => MT + (1 - Math.max(0, Math.min(100, v)) / 100) * (Hh - MT - MB);
  const path = (arr) => arr.length ? 'M' + arr.map((p) => `${X(p.d).toFixed(1)},${Y(p.v).toFixed(1)}`).join('L') : '';

  const grid = [0, 25, 50, 75, 100].map((v) =>
    `<line x1="${ML}" y1="${Y(v)}" x2="${W - MR}" y2="${Y(v)}" stroke="var(--line2)" stroke-width="1"/>
     <text x="${ML - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--ink3)">${v}</text>`).join('');

  // подписи месяцев/дат по краям и «сегодня»
  const tx = (d, label, col, anchor) => `<line x1="${X(d)}" y1="${MT}" x2="${X(d)}" y2="${Hh - MB}" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="${X(d) + (anchor === 'end' ? -3 : 0)}" y="${Hh - MB + 15}" text-anchor="${anchor || 'middle'}" font-size="12" fill="${col}">${label}</text>`;

  const last = cv.fact.length ? cv.fact[cv.fact.length - 1] : null;
  return `<svg viewBox="0 0 ${W} ${Hh}" class="curve" role="img">
    ${grid}
    <path d="${path(cv.plan)}" fill="none" stroke="var(--ink3)" stroke-width="2" stroke-dasharray="6 4"/>
    ${cv.forecast.length ? `<path d="${path(cv.forecast)}" fill="none" stroke="var(--rel)" stroke-width="2.5" stroke-dasharray="2 4"/>` : ''}
    <path d="${path(cv.fact)}" fill="none" stroke="var(--acc)" stroke-width="3"/>
    ${last ? `<circle cx="${X(last.d)}" cy="${Y(last.v)}" r="5" fill="var(--acc)"/>
      <text x="${X(last.d) + 10}" y="${Y(last.v) - 12}" font-size="14" font-weight="700" fill="var(--acc)">${n1(last.v)}%</text>` : ''}
    ${tx(cv.today, T('curve_today'), 'var(--ink2)')}
    ${tx(cv.deadline, T('curve_deadline'), 'var(--ok)', 'end')}
    <text x="${ML}" y="${Hh - MB + 15}" font-size="11" fill="var(--ink3)">${dLabel(cv.start)}</text>
  </svg>`;
}

/* какую клетку табеля подсветить после перерисовки */
let HRS_FOCUS = null;

async function viewHours() {
  chrome(T('hrs_title'), '', false);
  const app = $('#app');
  app.innerHTML = `<div class="empty">${T('rep_calc')}</div>`;

  let H;
  try { H = await api('hours'); LS.cache = Object.assign(LS.cache || {}, { hours: H }); }
  catch (e) { H = (LS.cache || {}).hours; if (!H) { app.innerHTML = `<div class="empty">${T('no_offline')}</div>`; return; } }

  const canEdit = isMgr(ME);
  const s = H.summary, plan = H.plan;
  const crew = H.crew.slice();
  for (const d of Object.keys(H.hours)) for (const who of Object.keys(H.hours[d])) if (!crew.includes(who)) crew.push(who);

  chrome(T('hrs_title'), T('hrs_sub', { b: n0(plan.budget), d: dLabelFull(plan.deadline) }), false);

  const usedPct = Math.max(0, Math.min(100, s.usedPct));
  const overspend = s.gap < 0;
  const days = Object.keys(H.hours).sort();
  const today = HOURS.today();
  const cols = days.slice();
  if (!cols.includes(today)) cols.push(today);

  const rowsHtml = crew.map((who) => {
    const tot = s.byPerson[who] || 0;
    const extra = !H.crew.includes(who);
    return `<tr><td>${esc(who)}${extra ? ` <span class="warnmark" title="${T('hrs_extra')}">•</span>` : ''}</td>${cols.map((d) => {
      const v = (H.hours[d] || {})[who] || 0;
      return `<td class="mono hcell${canEdit ? ' ed' : ''}" data-d="${d}" data-who="${esc(who)}">${v ? n1(v) : '<span class="muted">·</span>'}</td>`;
    }).join('')}<td class="mono"><b>${tot ? n1(tot) : '—'}</b></td></tr>`;
  }).join('');

  const fc = s.finishDate ? {
    late: s.lateDays > 0,
    days: Math.abs(s.lateDays || 0),
  } : null;

  app.innerHTML = `
    <div class="printhead">
      <div class="printlogos">
        <img class="bti" src="logos/bti.png" alt="BTI Service">
        <img class="upm" src="logos/upm.png" alt="UPM">
        <img class="valmet" src="logos/valmet.png" alt="Valmet">
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div><b style="font-size:15pt">${T('hrs_head')}</b>
        <div style="font-size:9pt">${T('hrs_sub', { b: n0(plan.budget), d: dLabelFull(plan.deadline) })}</div></div>
        <div style="font-size:9pt;text-align:right">${T('hrs_made', { d: new Date().toLocaleString(loc()) })}<br>${esc((ME && ME.name) || '')}</div>
      </div>
    </div>

    <div class="card pad mb">
      <div class="spread">
        <div>
          <div class="small muted" style="text-transform:uppercase;letter-spacing:.06em">${T('hrs_left')}</div>
          <div class="mono" style="font-size:30px;font-weight:700;letter-spacing:-.02em;color:${s.remaining > 0 ? 'var(--ink)' : 'var(--acc)'}">${n1(s.remaining)} <span style="font-size:15px;color:var(--ink3);font-weight:500">${T('c_h')}</span></div>
          <div class="small muted mono">${T('hrs_used_of', { s: n1(s.spent), b: n0(s.budget) })}</div>
        </div>
        ${dial(usedPct)}
      </div>
      <div style="margin-top:10px">${bar(usedPct)}</div>
      <div class="dual2 small" style="margin-top:8px">
        <span><b class="mono">${n1(s.spent)} ${T('c_h')}</b> · ${n1(s.usedPct)}% <span class="muted">${T('hrs_spent')}</span></span>
        <span><b class="mono">${n1(s.remaining)} ${T('c_h')}</b> · ${n1(s.remainingPct)}% <span class="muted">${T('hrs_left')}</span></span>
      </div>
      <div class="small muted" style="margin-top:8px">
        <b>${T('hrs_deadline')}: ${dLabelFull(plan.deadline)}</b> —
        ${s.overdue ? `<span style="color:var(--acc)">${T('hrs_overdue')}</span>`
                    : T('hrs_days_left', { n: s.daysLeft }) + ' · ' + T('hrs_workdays', { n: s.workdaysLeft })}
      </div>
    </div>

    <div class="stats mb">
      <div class="stat"><b class="mono">${n1(s.crewAffordable)}</b><span>${T('hrs_k_afford')}</span>
        <div class="sub2 small">${T('hrs_s_afford', { d: dLabelFull(plan.deadline) })}</div></div>
      <div class="stat"><b class="mono">${n1(s.crewLast)}</b><span>${T('hrs_k_now')}</span>
        <div class="sub2 small">${T('hrs_s_now', { h: n1(s.lastDayHours) })}</div></div>
      <div class="stat"><b class="mono">${n1(s.pace)}</b><span>${T('hrs_k_pace')}</span>
        <div class="sub2 small">${T('hrs_s_pace')}</div></div>
      <div class="stat"><b class="mono" style="color:${overspend ? 'var(--acc)' : 'var(--ok)'}">${overspend ? '−' : '+'}${n1(Math.abs(s.gap))}</b>
        <span>${overspend ? T('hrs_k_gap_bad') : T('hrs_k_gap_ok')}</span>
        <div class="sub2 small">${T('hrs_s_gap', { d: dLabelFull(plan.deadline) })}</div></div>
    </div>

    ${s.daysAtLast != null ? `<div class="note ${s.runsOutAtLast && s.runsOutAtLast < plan.deadline ? 'warn' : 'ok'} mb">
      ${T('hrs_runs_out', { n: s.daysAtLast, d: s.runsOutAtLast ? dLabelFull(s.runsOutAtLast) : dLabelFull(plan.deadline) })}
      <div class="small muted" style="margin-top:3px">${T('hrs_crew_afford_d', { d: dLabelFull(plan.deadline) })}</div>
    </div>` : ''}

    ${H.curve ? `<div class="card pad mb">
      <div class="spread mb"><b>${T('curve_title')}</b>
        <span class="small"><span class="lgd f">${T('curve_fact')}</span> <span class="lgd p">${T('curve_plan')}</span> <span class="lgd c">${T('curve_fc')}</span></span></div>
      ${curveSVG(H.curve, plan)}
      <div class="small muted" style="margin-top:6px">${T('curve_hint')}</div>
    </div>` : ''}

    ${s.progress != null ? `<div class="card pad mb">
      <div class="spread"><b>${T('hrs_eff_title')}</b>
        <span class="mono" style="color:${s.efficiency >= 1 ? 'var(--ok)' : 'var(--acc)'};font-weight:700">${s.efficiency >= 1 ? '▲' : '▼'} ${n1(s.efficiency * 100)}%</span></div>
      <div class="small muted" style="margin-top:4px">${T('hrs_eff', { p: n1(s.progress), u: n1(s.usedPct) })} —
        ${s.efficiency >= 1 ? T('hrs_eff_good') : T('hrs_eff_bad')}</div>
      <div class="dual" style="margin-top:8px"><span class="lab">%</span>${bar(s.progress)}<span class="mono small" style="width:52px;text-align:right">${n1(s.progress)}%</span></div>
      <div class="dual" style="margin-top:4px"><span class="lab">${T('c_h')}</span>${bar(s.usedPct)}<span class="mono small" style="width:52px;text-align:right">${n1(s.usedPct)}%</span></div>
    </div>` : ''}

    <div class="card pad mb fc">
      <div class="spread"><b>${T('hrs_fc_title')}</b>
        ${s.finishDate ? `<span class="mono" style="font-weight:700;color:${fc.late ? 'var(--acc)' : 'var(--ok)'}">${dLabelFull(s.finishDate)}</span>` : ''}</div>
      ${s.finishDate ? `
        <div style="font-size:15px;margin-top:6px">${T('hrs_fc_date', { d: dLabelFull(s.finishDate) })} —
          <b style="color:${fc.late ? 'var(--acc)' : 'var(--ok)'}">${fc.late
            ? T('hrs_fc_late', { n: fc.days, dl: dLabelFull(plan.deadline) })
            : T('hrs_fc_in_time', { n: fc.days, dl: dLabelFull(plan.deadline) })}</b></div>
        <div class="small muted" style="margin-top:6px">${T('hrs_fc_hours', { t: n0(s.totalNeeded), p: n1(s.hoursPerPct), r: n0(s.hoursToFinish) })}</div>
        <div class="small" style="margin-top:4px;color:${s.budgetAtFinish >= 0 ? 'var(--ok)' : 'var(--acc)'}">${s.budgetAtFinish >= 0
            ? T('hrs_fc_budget_ok', { n: n0(s.budgetAtFinish) })
            : T('hrs_fc_budget_bad', { n: n0(-s.budgetAtFinish) })}</div>
        <div class="small muted" style="margin-top:4px">${T('hrs_fc_crew', { n: n1(s.dailyCrew) })}</div>
        <div class="timeline" style="margin-top:10px">
          <div class="tl"><i style="width:${Math.max(2, Math.min(100, s.progress))}%"></i></div>
          <div class="spread small muted mono" style="margin-top:3px"><span>${n1(s.progress)}%</span><span>100%</span></div>
        </div>`
      : `<div class="small muted" style="margin-top:6px">${T('hrs_fc_none')}</div>`}
    </div>

    <div class="card pad mb noprint" id="daybox">
      <div class="spread mb"><b>${T('hrs_day')}</b>
        <input type="date" id="hdate" value="${today}" max="${plan.deadline}" min="${plan.start}"
          style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--card)">
      </div>
      <div class="spread">
        <span class="small muted" id="dhint"></span>
        ${canEdit ? `<span class="row" style="gap:6px"><button class="btn sm" id="hfill">${T('hrs_fill_plan')}</button>
          <button class="btn sm" id="hclr">${T('hrs_clear')}</button></span>` : ''}
      </div>
      <div id="dlist" style="margin-top:8px"></div>
      <div class="daytot mono" id="dtot"></div>
      ${canEdit ? `<button class="btn pri" id="hsave" style="width:100%;margin-top:10px">${T('hrs_save')}</button>`
                : `<div class="note" style="margin-top:10px">${T('hrs_ro')}</div>`}
    </div>

    <div class="card mb">
      <div class="pad spread"><b>${T('hrs_table')}</b>
        <span class="row noprint" style="gap:6px">
          <button class="btn sm" id="hpdf">${T('hrs_print')}</button>
          <button class="btn sm" id="hcsv">${T('hrs_csv')}</button></span></div>
      <div class="scrollx" id="htbl"><table class="tbl">
        <thead><tr><th>${T('hrs_person')}</th>${cols.map((d) => `<th>${dLabel(d)}<br><span style="font-weight:400">${dWeek(d)}</span></th>`).join('')}<th>${T('hrs_total')}</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="${cols.length + 2}">${T('hrs_no_rows')}</td></tr>`}</tbody>
        <tfoot><tr><td>${T('hrs_total')}</td>${cols.map((d) => `<td class="mono"><b>${s.byDay[d] ? n1(s.byDay[d]) : '·'}</b></td>`).join('')}<td class="mono"><b>${n1(s.spent)}</b></td></tr></tfoot>
      </table></div>
      ${canEdit ? `<div class="pad small muted noprint" style="padding-top:0">${T('hrs_tap')}</div>` : ''}
    </div>

    ${canEdit ? `<div class="card pad mb noprint">
      <b>${T('hrs_settings')}</b>
      <div class="row wrap" style="margin-top:8px;gap:8px">
        <label class="small muted">${T('hrs_budget_f')}<br><input id="pbudget" class="mono" type="number" step="1" value="${plan.budget}" style="width:110px"></label>
        <label class="small muted">${T('hrs_deadline_f')}<br><input id="pdead" type="date" value="${plan.deadline}"></label>
        <label class="small muted">${T('hrs_start_f')}<br><input id="pstart" type="date" value="${plan.start}"></label>
      </div>
      <div class="small muted" style="margin-top:10px">${T('hrs_sched')}</div>
      <div class="row" style="gap:8px;margin-top:4px">
        <input id="pwd" class="mono" type="number" step="0.5" value="${plan.schedule[1]}" style="width:70px">
        <input id="psat" class="mono" type="number" step="0.5" value="${plan.schedule[6]}" style="width:70px">
        <input id="psun" class="mono" type="number" step="0.5" value="${plan.schedule[0]}" style="width:70px">
      </div>
      <div class="small muted" style="margin-top:10px">${T('hrs_crew')}</div>
      <textarea id="pcrew" rows="5" style="width:100%;margin-top:4px" class="mono">${esc(H.crew.join('\n'))}</textarea>
      <button class="btn" id="psave" style="width:100%;margin-top:10px">${T('hrs_save_plan')}</button>
    </div>` : ''}

    ${H.updated ? `<p class="small muted" style="text-align:center">${T('hrs_last', { d: new Date(H.updated).toLocaleString(loc()), u: esc(H.updated_by || '') })}</p>` : ''}
  `;

  /* ---- ввод часов за день ---- */
  const dateInp = $('#hdate');
  const drawDay = () => {
    const date = dateInp.value;
    const ph = HOURS.dayPlan(date, plan.schedule);
    $('#dhint').innerHTML = ph ? T('hrs_plan_day', { n: n1(ph) }) : `<span style="color:var(--warn)">${T('hrs_dayoff')}</span>`;
    const cur = H.hours[date] || {};
    $('#dlist').innerHTML = crew.map((who) => `<div class="hrow">
      <span>${esc(who)}</span>
      <input class="mono hinp" data-who="${esc(who)}" type="number" inputmode="decimal" step="0.5" min="0" max="24"
        value="${cur[who] || ''}" placeholder="0"${canEdit ? '' : ' disabled'}>
    </div>`).join('');
    recount();
  };
  const recount = () => {
    let t = 0;
    for (const i of document.querySelectorAll('.hinp')) t += +i.value || 0;
    $('#dtot').textContent = T('hrs_day_total', { n: n1(t) });
  };
  dateInp.addEventListener('change', drawDay);
  $('#dlist').addEventListener('input', recount);
  drawDay();

  if (canEdit) {
    $('#hfill').addEventListener('click', () => {
      const ph = HOURS.dayPlan(dateInp.value, plan.schedule) || 0;
      for (const i of document.querySelectorAll('.hinp')) i.value = ph || '';
      recount();
    });
    $('#hclr').addEventListener('click', () => {
      for (const i of document.querySelectorAll('.hinp')) i.value = '';
      recount();
    });
    $('#hsave').addEventListener('click', async () => {
      const btn = $('#hsave'); btn.disabled = true;
      const entries = {};
      for (const i of document.querySelectorAll('.hinp')) { const v = +i.value || 0; if (v > 0) entries[i.dataset.who] = v; }
      const date = dateInp.value;
      try {
        await api('hours/day', { method: 'PUT', body: { date, entries, by: LS.by } });
        toast(T('hrs_saved', { d: dLabelFull(date), n: n1(Object.values(entries).reduce((a, b) => a + b, 0)) }));
        viewHours();
      } catch (e) { toast(e.message, 3000); btn.disabled = false; }
    });
    $('#psave').addEventListener('click', async () => {
      const btn = $('#psave'); btn.disabled = true;
      const wd = +$('#pwd').value || 0, sat = +$('#psat').value || 0, sun = +$('#psun').value || 0;
      try {
        await api('hours/plan', {
          method: 'PUT',
          body: {
            budget: +$('#pbudget').value || 0,
            deadline: $('#pdead').value, start: $('#pstart').value,
            schedule: [sun, wd, wd, wd, wd, wd, sat],
            crew: $('#pcrew').value.split('\n').map((x) => x.trim()).filter(Boolean),
          },
        });
        toast(T('hrs_plan_saved'));
        viewHours();
      } catch (e) { toast(e.message, 3000); btn.disabled = false; }
    });
  }

  /* ---- правка часов прямо в таблице ---- */
  const box = $('#htbl');
  const scrollTo = (d) => {
    const c = box && box.querySelector(`.hcell[data-d="${d}"]`);
    if (c && box) box.scrollLeft = Math.max(0, c.offsetLeft - box.clientWidth + c.offsetWidth + 12);
  };
  if (HRS_FOCUS) {
    const f = HRS_FOCUS; HRS_FOCUS = null;
    scrollTo(f.d);
    const c = box && box.querySelector(`.hcell[data-d="${f.d}"][data-who="${cssq(f.who)}"]`);
    if (c) { c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1400); }
  } else scrollTo(cols[cols.length - 1]);

  if (canEdit && box) {
    box.addEventListener('click', (e) => {
      const td = e.target.closest ? e.target.closest('td.hcell.ed') : null;
      if (!td || td.querySelector('input')) return;
      const d = td.dataset.d, who = td.dataset.who;
      const cur = (H.hours[d] || {})[who] || '';
      const prev = td.innerHTML;
      td.innerHTML = `<input class="cellin mono" type="number" inputmode="decimal" step="0.5" min="0" max="24" value="${cur}">`;
      const inp = td.querySelector('input');
      inp.focus(); inp.select();
      let done = false;
      const cancel = () => { if (done) return; done = true; td.innerHTML = prev; };
      const commit = async () => {
        if (done) return; done = true;
        const v = Math.round((+inp.value || 0) * 10) / 10;
        if (v === (+cur || 0)) { td.innerHTML = prev; return; }
        td.innerHTML = '…';
        const day = Object.assign({}, H.hours[d] || {});
        if (v > 0) day[who] = Math.min(24, v); else delete day[who];
        try {
          await api('hours/day', { method: 'PUT', body: { date: d, entries: day, by: LS.by } });
          toast(T('hrs_cell_saved', { w: who, d: dLabel(d), n: n1(v) }));
          HRS_FOCUS = { d, who };
          viewHours();
        } catch (err) { toast(err.message, 3000); td.innerHTML = prev; }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
        if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      });
    });
  }

  $('#hpdf').addEventListener('click', () => window.print());

  $('#hcsv').addEventListener('click', () => {
    const rows = [[T('hrs_person'), ...cols, T('hrs_total')]];
    for (const who of crew) rows.push([who, ...cols.map((d) => (H.hours[d] || {})[who] || ''), s.byPerson[who] || 0]);
    rows.push([T('hrs_total'), ...cols.map((d) => s.byDay[d] || ''), s.spent]);
    const csv = '﻿' + rows.map((r) => r.join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'tesa-hours.csv'; a.click();
  });
}


/* --- журнал изменений: кто и когда --- */
async function viewLog() {
  chrome(T('log_title'), T('log_sub'), true);
  const app = $('#app');
  app.innerHTML = `<div class="empty">${T('loading')}</div>`;
  let H = [];
  try { H = await api('history?n=300'); }
  catch (e) { app.innerHTML = `<div class="empty">${T('no_offline')}</div>`; return; }

  if (!H.length) { app.innerHTML = `<div class="empty">${T('log_empty')}</div>`; return; }

  const dt = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString(loc(), { day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit' });
  };
  const byDay = {};
  for (const x of H) {
    const d = new Date(x.ts);
    const key = isNaN(d) ? '—' : d.toLocaleDateString(loc(), { day: '2-digit', month: '2-digit', year: 'numeric' });
    (byDay[key] = byDay[key] || []).push(x);
  }

  const row = (x) => {
    const isHours = x.what === 'hours', isPlan = x.what === 'plan';
    const delta = (x.after != null && x.before != null) ? Math.round((x.after - x.before) * 10) / 10 : null;
    const tag = isHours ? T('log_tag_hours') : isPlan ? T('log_tag_plan') : T('log_tag_line');
    const unit = isHours ? T('c_h') : isPlan ? T('c_h') : '%';
    return `<div class="logrow${isHours ? ' h' : isPlan ? ' p' : ''}">
      <div class="lg1">
        <span class="badge ${isHours || isPlan ? 'p' : 'k'}">${tag}</span>
        ${isPlan ? '' : `<b>${esc(x.short || x.line)}</b>`}
        <span class="mono small muted">${dt(x.ts)}</span>
      </div>
      <div class="lg2">
        <span class="who">${esc(x.user || '—')}</span>
        ${x.after != null ? `<span class="mono">${x.before != null ? n1(x.before) + ' → ' : ''}<b>${n1(x.after)}</b> ${unit}${
          delta ? ` <span style="color:${delta > 0 ? 'var(--ok)' : 'var(--acc)'}">${delta > 0 ? '+' : ''}${n1(delta)}</span>` : ''}</span>` : ''}
      </div>
    </div>`;
  };

  app.innerHTML = `
    <div class="small muted mb" style="padding:0 2px">${T('log_hint', { n: H.length })}</div>
    ${Object.keys(byDay).map((d) => `<div class="card pad mb">
      <div class="spread mb"><b>${d}</b><span class="small muted">${T('log_changes', { n: byDay[d].length })}</span></div>
      ${byDay[d].map(row).join('')}
    </div>`).join('')}
    <div class="btns noprint" style="margin-bottom:20px">
      <button class="btn" data-go="#/">${T('nav_home')}</button>
      <button class="btn" id="logcsv">${T('hrs_csv')}</button>
      <button class="btn" onclick="window.print()">${T('hrs_print')}</button>
    </div>`;

  $('#logcsv').addEventListener('click', () => {
    const rows = [[T('log_when'), T('log_who'), T('log_what'), T('log_obj'), T('log_before'), T('log_after')]];
    for (const x of H) rows.push([x.ts, x.user || '', x.what || 'line', x.short || x.line,
      x.before == null ? '' : x.before, x.after == null ? '' : x.after]);
    dl('TESA_log.csv', '\ufeff' + rows.map((r) => r.join(';')).join('\n'));
  });
}

/* ---------------- маршрутизация ---------------- */
async function render() {
  if (!LS.t) return viewLogin();
  if (!LINES.length) {
    $('#app').innerHTML = `<div class="empty">${T('loading_reg')}</div>`;
    try { await loadAll(); } catch (e) { $('#app').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  }
  const h = location.hash || '#/';
  window.scrollTo(0, 0);
  if (h.startsWith('#/line/')) return viewLine(decodeURIComponent(h.slice(7)));
  if (h.startsWith('#/list')) return viewList();
  if (h.startsWith('#/log')) return viewLog();
  if (h.startsWith('#/hours')) {
    if (!(ME && isMgr(ME))) { toast(T('hrs_only_foreman'), 2600); location.hash = '#/'; return viewHome(); }
    return viewHours();
  }
  if (h.startsWith('#/report')) return viewReport();
  return viewHome();
}

document.addEventListener('click', (e) => {
  const lb = e.target.closest('[data-lang]');
  if (lb) {
    e.preventDefault();
    I18N.lang = lb.dataset.lang;
    applyNavLabels(); applyHU();
    DETAIL = DETAIL; render();
    return;
  }
  if (e.target.closest('#rolechip')) { e.preventDefault(); roleMenu(); return; }
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); location.hash = g.dataset.go; }
});
window.addEventListener('hashchange', render);
window.addEventListener('online', () => { ONLINE = true; syncTick(); });
window.addEventListener('offline', () => { ONLINE = false; chrome0(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncTick(); });
setInterval(syncTick, 45000);
$('#back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#/'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
applyNavLabels();
applyHU();
loadBrand();
render();
})();
