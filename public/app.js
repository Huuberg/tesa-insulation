/* Tervasaari PM5 — клиент. Vanilla JS, офлайн-очередь, расчёт % локально. */
(() => {
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
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
    if (!CFG) CFG = await api('config');
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

function bar(p) {
  const v = Math.max(0, Math.min(100, p));
  return `<div class="bar${v >= 100 ? ' ok' : ''}"><i style="width:${v}%"></i></div>`;
}

function stageSeg(st) {
  // мини-полоса из 5 сегментов по позициям
  const cols = { release: 'var(--rel)', materials: '#94a3b8', insulation: 'var(--acc)',
                 cladding: '#0ea5e9', finishing: '#a855f7', inspection: 'var(--ok)' };
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
    ? `<span class="rolechip ${ME.role === 'foreman' ? 'ed' : 'ro'}" id="rolechip">${esc(ME.name)}</span>`
      + (LS.by ? '<br><span class="mono">' + esc(LS.by) + '</span>' : '')
      + (!ONLINE ? `<br><span class="offchip">${T('no_conn_chip')}</span>` : '')
      + (LS.queue.length ? `<br><span style="color:var(--acc)">${T('not_sent_chip', { n: LS.queue.length })}</span>` : '')
    : '';
  for (const a of document.querySelectorAll('nav.bot a')) a.classList.remove('on');
  const h = location.hash || '#/';
  const cur = h.startsWith('#/report') ? '#nav-report' : h.startsWith('#/list') ? '#nav-list' : h === '#/' ? '#nav-home' : null;
  if (cur) $(cur).classList.add('on');
}

/** Кнопки переключения языка. */
function langBar() {
  return '<div class="langbar">' + I18N.order.map((l) =>
    `<button data-lang="${l}"${l === I18N.lang ? ' class="on"' : ''}>${I18N.short[l]}</button>`).join('') + '</div>';
}

function applyNavLabels() {
  const m = { 'nav-home-t': 'nav_home', 'nav-list-t': 'nav_list', 'nav-report-t': 'nav_report' };
  for (const id of Object.keys(m)) { const e = document.getElementById(id); if (e) e.textContent = T(m[id]); }
}

/** Перерисовать только шапку (не трогая экран). */
function chrome0() {
  if (!ME || $('#top').hidden) return;
  $('#who').innerHTML =
    `<span class="rolechip ${ME.role === 'foreman' ? 'ed' : 'ro'}" id="rolechip">${esc(ME.name)}</span>`
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
  const rel = LINES.filter((x) => x.stages.release >= 100).length;
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
    else if (f === 'rel') rows = rows.filter((l) => l.stages.release >= 100);
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

  const canEdit = ME && ME.role === 'foreman';
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
      const bp = branchPercent(checks, b.id);
      const info = [
        [T('k_elbows'), n0(b.elbows)], [T('k_straight'), n1(b.straight_m)],
        [T('k_ties'), n0(b.ties)], [T('k_cones'), n0(b.cones)], [T('k_cases'), n0(b.cases)],
      ];
      const body = STAGES.map((s) => {
        const p = branchStagePercent(checks, b.id, s.key);
        let ctrl;
        if (s.kind === 'single') {
          const on = checks.branches[b.id].release.done;
          ctrl = `<div class="lv one"><button class="${on ? 'on full' : ''}" data-b="${b.id}" data-rel="1" ${canEdit ? '' : 'disabled'}>${on ? T('released_mark') : T('mark_release')}</button></div>`;
        } else if (s.kind === 'insp') {
          ctrl = `<div class="lv two">${INSP_LEVELS.map((lv) => {
            const on = checks.branches[b.id].inspection.levels.includes(lv);
            return `<button class="${on ? 'on' + (lv === 100 ? ' full' : '') : ''}" data-b="${b.id}" data-insp="${lv}" ${canEdit ? '' : 'disabled'}>${lv}%</button>`;
          }).join('')}</div>`;
        } else {
          ctrl = `<div class="lv">${LEVELS.map((lv) => {
            const on = (checks.branches[b.id][s.key] || []).includes(lv);
            return `<button class="${on ? 'on' + (lv === 100 ? ' full' : '') : ''}" data-b="${b.id}" data-st="${s.key}" data-lv="${lv}" ${canEdit ? '' : 'disabled'}>${lv}%</button>`;
          }).join('')}</div>`;
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

  if (multi) $('#expall').addEventListener('click', () => {
    const any = !BR.every((b) => OPEN[b.id]);
    for (const b of BR) OPEN[b.id] = any;
    $('#expall').textContent = any ? T('collapse_all') : T('expand_all');
    drawBranches();
  });

  $('#brs').addEventListener('click', (e) => {
    const bh = e.target.closest('.bh');
    if (bh) { const id2 = bh.parentElement.dataset.id; OPEN[id2] = !OPEN[id2]; drawBranches(); return; }
    const btn = e.target.closest('button'); if (!btn || !canEdit) return;

    if (btn.dataset.all) {
      const st = btn.dataset.all, from = checks.branches[btn.dataset.from];
      for (const b of BR) {
        const t = checks.branches[b.id];
        if (st === 'release') t.release.done = from.release.done;
        else if (st === 'inspection') t.inspection.levels = from.inspection.levels.slice();
        else t[st] = (from[st] || []).slice();
      }
      dirty = true; drawBranches(); toast(T('applied_all'));
      return;
    }
    const bc = checks.branches[btn.dataset.b];
    if (!bc) return;
    if (btn.dataset.rel) bc.release.done = !bc.release.done;
    else if (btn.dataset.insp) {
      const lv = +btn.dataset.insp, a = bc.inspection.levels, i = a.indexOf(lv);
      i >= 0 ? a.splice(i, 1) : a.push(lv);
    } else if (btn.dataset.lv) {
      const a = bc[btn.dataset.st], lv = +btn.dataset.lv, i = a.indexOf(lv);
      if (i >= 0) { for (let k = a.length - 1; k >= 0; k--) if (a[k] >= lv) a.splice(k, 1); }
      else { for (const x of LEVELS) if (x <= lv && !a.includes(x)) a.push(x); }
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
      <div class="spread mb"><b>${T('positions')}</b><span class="small muted">${T('area_len')}</span></div>
      ${R.stages.map(srow).join('')}
    </div>

    <div class="card mb">
      <div class="pad spread"><b>${T('by_lines')}</b><span class="small muted">${T('pcs', { n: R.lines.length })}</span></div>
      <div class="scrollx"><table class="tbl">
        <thead><tr><th>${T('h_line')}</th><th>${T('h_branches')}</th><th>${T('c_m')}</th><th>${T('c_m2')}</th><th>${T('h_rel')}</th><th>${T('h_mat')}</th><th>${T('h_ins')}</th><th>${T('h_clad')}</th><th>${T('h_fin')}</th><th>${T('h_insp')}</th><th>${T('h_pct')}</th></tr></thead>
        <tbody>${R.lines.slice().sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name)).map((l) => `
          <tr data-go="#/line/${l.id}" style="cursor:pointer">
            <td>${esc(l.short)}</td>
            <td class="mono">${l.branch_count || 1}</td>
            <td class="mono">${n1(l.length_m)}</td><td class="mono">${n1(l.area_m2)}</td>
            <td class="mono">${n1(l.stages.release)}</td>
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
          ${['release', 'materials', 'insulation', 'cladding', 'finishing', 'inspection'].map((k) => {
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
    const body = R.lines.map((l) => [l.short, l.branch_count || 1, l.length_m, l.area_m2, l.stages.release, l.stages.materials, l.stages.insulation, l.stages.cladding, l.stages.finishing, l.stages.inspection, l.percent].join(';')).join('\n');
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
  const canEdit = ME && ME.role === 'foreman';
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
    <button class="btn wide" id="out" style="margin-top:10px">${T('switch_user')}</button>
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

  $('#out', box).addEventListener('click', async () => {
    try { await api('logout', { method: 'POST' }); } catch (e) {}
    LS.t = null; ME = null; LS.me = null; LINES = []; DETAIL = {};
    close(); location.hash = '#/'; render();
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
  if (h.startsWith('#/report')) return viewReport();
  return viewHome();
}

document.addEventListener('click', (e) => {
  const lb = e.target.closest('[data-lang]');
  if (lb) {
    e.preventDefault();
    I18N.lang = lb.dataset.lang;
    applyNavLabels();
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
render();
})();
