'use strict';
/* Tervasaari PM5 — контроль готовности изоляции. Сервер без внешних зависимостей. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const M = require('./model');
const S = require('./store');
const QR = require('./qr');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUB = path.join(__dirname, 'public');

/* ---------------- расчёты ---------------- */

function checksOf(line) {
  const raw = S.state.lines[line.id] && S.state.lines[line.id].checks;
  return raw ? M.sanitize(raw, line) : M.emptyChecks(line);
}

function lineSummary(l) {
  const c = checksOf(l);
  const st = {};
  for (const s of M.STAGES) st[s.key] = Math.round(M.stagePercent(l, c, s.key) * 10) / 10;
  const pct = Math.round(M.linePercent(l, c) * 10) / 10;
  const meta = S.state.lines[l.id] || {};
  return {
    id: l.id, name: l.name, short: l.short, medium: l.medium,
    dn: l.main && l.main.dn, pipe_od: l.main && l.main.pipe_od,
    ins: l.main && l.main.ins, clad_od: l.main && l.main.clad_od,
    dev: l.main && l.main.dev,
    length_m: l.length_m, area_m2: l.area_m2, straight_m: l.straight_m,
    elbows: l.elbows, ties: l.ties, cones: l.cones, cases: l.cases,
    partial: l.partial, al: l.al, connect: l.connect,
    percent: pct, stages: st,
    branch_count: (l.branches || []).length,
    drawing: l.drawing || null, drawing_rev: l.drawing_rev || '',
    updated: meta.updated || null, updated_by: meta.updated_by || null,
    note: meta.note || '',
  };
}

function allSummaries() { return S.seed.lines.map(lineSummary); }

function buildReport() {
  const rows = allSummaries();
  const tot = { length_m: 0, area_m2: 0, percent_m: 0, percent_a: 0 };
  const stageTot = {};
  for (const s of M.STAGES) stageTot[s.key] = { m: 0, a: 0 };
  for (const r of rows) {
    tot.length_m += r.length_m;
    tot.area_m2 += r.area_m2;
    tot.percent_m += r.length_m * r.percent;
    tot.percent_a += r.area_m2 * r.percent;
    for (const s of M.STAGES) {
      stageTot[s.key].m += r.length_m * r.stages[s.key];
      stageTot[s.key].a += r.area_m2 * r.stages[s.key];
    }
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  const stages = M.STAGES.map((s) => ({
    key: s.key, title: s.title, ru: s.ru, weight: s.weight,
    percent_m: tot.length_m ? r1(stageTot[s.key].m / tot.length_m) : 0,
    percent_a: tot.area_m2 ? r1(stageTot[s.key].a / tot.area_m2) : 0,
    done_m: r1(tot.length_m ? stageTot[s.key].m / 100 : 0),
    done_a: r1(tot.area_m2 ? stageTot[s.key].a / 100 : 0),
  }));
  return {
    generated: new Date().toISOString(),
    meta: S.seed.meta,
    totals: {
      lines: rows.length,
      length_m: r1(tot.length_m),
      area_m2: r1(tot.area_m2),
      percent_m: tot.length_m ? r1(tot.percent_m / tot.length_m) : 0,
      percent_a: tot.area_m2 ? r1(tot.percent_a / tot.area_m2) : 0,
      released: rows.filter((r) => r.stages.release >= 100).length,
      insulated_100: rows.filter((r) => r.stages.insulation >= 100).length,
      cladded_100: rows.filter((r) => r.stages.cladding >= 100).length,
      accepted_100: rows.filter((r) => r.stages.inspection >= 100).length,
    },
    stages,
    lines: rows,
  };
}

/* ---------------- поиск ---------------- */

function search(q) {
  const rows = allSummaries();
  if (!q) return rows;
  const terms = String(q).toLowerCase().split(/[\s,]+/).filter(Boolean);
  const scored = [];
  for (const r of rows) {
    const hay = [r.name, r.short, r.medium, 'dn' + (r.dn || ''), String(r.dn || ''),
      String(r.pipe_od || ''), String(r.ins || ''), String(r.clad_od || ''),
      (r.al || []).join(' ')].join(' ').toLowerCase();
    let score = 0, ok = true;
    for (const t of terms) {
      if (hay.includes(t)) { score += r.name.toLowerCase().startsWith(t) ? 10 : 1; }
      else { ok = false; break; }
    }
    if (ok) scored.push([score, r]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  return scored.map((x) => x[1]);
}

/* ---------------- защита входа от перебора ---------------- */
const FAILS = new Map();                     // ip -> { n, until }
const MAX_FAILS = 8, LOCK_MS = 10 * 60 * 1000;

function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0] : req.socket.remoteAddress || '').trim();
}
function loginBlocked(ip) {
  const r = FAILS.get(ip);
  if (!r) return 0;
  if (r.until && r.until > Date.now()) return Math.ceil((r.until - Date.now()) / 1000);
  if (r.until && r.until <= Date.now()) FAILS.delete(ip);
  return 0;
}
function loginFailed(ip) {
  const r = FAILS.get(ip) || { n: 0, until: 0 };
  r.n++;
  if (r.n >= MAX_FAILS) { r.until = Date.now() + LOCK_MS; r.n = 0; }
  FAILS.set(ip, r);
}
function loginOk(ip) { FAILS.delete(ip); }

/* ---------------- адреса для телефонов ---------------- */

function lanUrls() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(nets))
    for (const n of nets[name] || [])
      if (n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address))
        list.push({ iface: name, ip: n.address, url: `http://${n.address}:${PORT}` });
  // сначала обычные домашние/офисные подсети
  list.sort((a, b) => {
    const score = (x) => (/^192\.168\./.test(x.ip) ? 0 : /^10\./.test(x.ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(x.ip) ? 2 : 3);
    return score(a) - score(b);
  });
  return list;
}

function publicUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!host || /^(localhost|127\.|\[?::1)/i.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host)) return null;   // это просто IP в локальной сети
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${host}`;
}

const SETUP_T = {
  ru: {
    title: 'Подключить телефон', ttl: 'Подключить телефон — Tervasaari PM5',
    lead: 'Наведите камеру телефона на QR-код — приложение откроется само. Вводить адрес вручную не нужно.',
    badge_net: 'адрес приложения', badge_lan: 'скорее всего этот',
    net_any: 'работает из любой сети, в том числе с мобильного интернета', net_iface: 'сеть: ',
    s1_any: 'Работает из любой сети — Wi-Fi объекта, контора, мобильный интернет.',
    s1_lan: 'Телефон должен быть в <b>той же Wi-Fi сети</b>, что и этот компьютер (не мобильный интернет).',
    s2: 'Откройте камеру и наведите на QR-код → нажмите на всплывшую ссылку.',
    s3: 'В Chrome: меню (три точки) → <b>«Добавить на главный экран»</b> — появится иконка приложения.',
    s4: 'Если QR не читается, наберите адрес вручную в браузере телефона.',
    go: 'Открыть приложение на этом компьютере →',
    foot: 'Если адресов несколько — попробуйте по очереди: подходит тот, который в одной сети с телефоном. Страницу можно распечатать и повесить в бытовке.',
    warn: '<b>Сетевой адрес не найден.</b><br>Компьютер не подключён к Wi-Fi или локальной сети. Подключите его к той же сети, что и телефоны, и обновите эту страницу.',
  },
  en: {
    title: 'Connect a phone', ttl: 'Connect a phone — Tervasaari PM5',
    lead: 'Point your phone camera at the QR code — the app opens by itself. No need to type the address.',
    badge_net: 'app address', badge_lan: 'most likely this one',
    net_any: 'works from any network, mobile data included', net_iface: 'network: ',
    s1_any: 'Works from any network — site Wi-Fi, the office, mobile data.',
    s1_lan: 'The phone must be on <b>the same Wi-Fi network</b> as this computer (not mobile data).',
    s2: 'Open the camera, point it at the QR code, then tap the link that pops up.',
    s3: 'In Chrome: menu (three dots) → <b>Add to Home screen</b> — an app icon appears.',
    s4: 'If the QR code does not scan, type the address into the phone browser.',
    go: 'Open the app on this computer →',
    foot: 'If there are several addresses, try them in turn: the right one is on the same network as the phone. This page can be printed and put up in the site cabin.',
    warn: '<b>No network address found.</b><br>The computer is not connected to Wi-Fi or a local network. Connect it to the same network as the phones and refresh this page.',
  },
  et: {
    title: 'Ühenda telefon', ttl: 'Ühenda telefon — Tervasaari PM5',
    lead: 'Suunake telefoni kaamera QR-koodile — rakendus avaneb ise. Aadressi käsitsi sisestada pole vaja.',
    badge_net: 'rakenduse aadress', badge_lan: 'tõenäoliselt see',
    net_any: 'töötab igast võrgust, ka mobiilse internetiga', net_iface: 'võrk: ',
    s1_any: 'Töötab igast võrgust — objekti Wi-Fi, kontor, mobiilne internet.',
    s1_lan: 'Telefon peab olema <b>samas Wi-Fi võrgus</b> kui see arvuti (mitte mobiilne internet).',
    s2: 'Avage kaamera ja suunake QR-koodile, seejärel puudutage ilmuvat linki.',
    s3: 'Chrome-is: menüü (kolm punkti) → <b>Lisa avaekraanile</b> — tekib rakenduse ikoon.',
    s4: 'Kui QR-kood ei loe, sisestage aadress telefoni brauserisse käsitsi.',
    go: 'Ava rakendus selles arvutis →',
    foot: 'Kui aadresse on mitu, proovige järjest: sobib see, mis on telefoniga samas võrgus. Lehe saab välja printida ja olmeruumi seinale panna.',
    warn: '<b>Võrguaadressi ei leitud.</b><br>Arvuti pole ühendatud Wi-Fi ega kohtvõrguga. Ühendage see telefonidega samasse võrku ja värskendage lehte.',
  },
};

function pickLang(req, q) {
  if (q && SETUP_T[q]) return q;
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  for (const l of ['et', 'en', 'ru']) if (al.startsWith(l)) return l;
  return 'ru';
}

const LANG_SHORT = { en: 'ENG', et: 'EST', ru: 'RUS' };

function setupPage(req, lang) {
  const t = SETUP_T[lang] || SETUP_T.ru;
  const pub = publicUrl(req);
  const urls = pub ? [{ iface: 'internet', ip: pub, url: pub }] : lanUrls();
  const cards = urls.length ? urls.map((u, i) => `
    <div class="c">
      <div class="qr">${QR.svg(u.url, 5)}</div>
      <div class="t">
        ${i === 0 ? `<div class="badge">${pub ? t.badge_net : t.badge_lan}</div>` : ''}
        <div class="u">${u.url}</div>
        <div class="i">${pub ? t.net_any : t.net_iface + u.iface}</div>
      </div>
    </div>`).join('') : `<div class="warn">${t.warn}</div>`;

  const langbar = ['en', 'et', 'ru'].map((l) =>
    `<a href="/setup?lang=${l}"${l === lang ? ' class="on"' : ''}>${LANG_SHORT[l]}</a>`).join('');

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.ttl}</title>
<style>
 body{font:16px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#e9e9ec;color:#131316;margin:0;padding:28px 20px}
 .w{max-width:820px;margin:0 auto}
 .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
 h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
 .sub{color:#75818c;margin:0 0 22px}
 .lang{display:inline-flex;border:1.5px solid #d6d6dc;border-radius:999px;overflow:hidden;background:#fbfbfc}
 .lang a{padding:7px 14px;font-size:12.5px;font-weight:700;letter-spacing:.04em;color:#75818c;text-decoration:none}
 .lang a+a{border-left:1px solid #d6d6dc}
 .lang a.on{background:#131316;color:#fbfbfc}
 .c{display:flex;gap:20px;align-items:center;background:#fbfbfc;border:1px solid #d6d6dc;border-radius:14px;
    padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(17,24,31,.06)}
 .qr{flex:0 0 auto;line-height:0}
 .qr svg{display:block;border-radius:6px}
 .t{min-width:0}
 .u{font-family:Consolas,ui-monospace,monospace;font-size:26px;font-weight:700;letter-spacing:-.02em;word-break:break-all}
 .i{color:#75818c;font-size:13px;margin-top:4px}
 .badge{display:inline-block;background:#b72971;color:#fff;font-size:11px;font-weight:700;letter-spacing:.05em;
        text-transform:uppercase;padding:3px 9px;border-radius:99px;margin-bottom:7px}
 ol{background:#fbfbfc;border:1px solid #d6d6dc;border-radius:14px;padding:16px 18px 16px 38px;margin:0 0 14px}
 li{margin-bottom:7px}
 .warn{background:#fdf6e3;border-left:4px solid #a16207;padding:14px 16px;border-radius:8px;margin-bottom:14px}
 .go{display:inline-block;background:#131316;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600}
 .lg{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fbfbfc;border:1px solid #d6d6dc;
     border-radius:14px;padding:12px 20px;margin:22px 0 6px}
 .lg img{display:block;width:auto}
 .lg img.b{height:26px}.lg img.u{height:44px}.lg img.v{height:22px}
 @media print{body{background:#fff}.go,ol,.lang{display:none}}
</style></head><body><div class="w">
<div class="top"><div><h1>${t.title}</h1><p class="sub">${t.lead}</p></div><div class="lang">${langbar}</div></div>
${cards}
<ol>
  <li>${pub ? t.s1_any : t.s1_lan}</li>
  <li>${t.s2}</li>
  <li>${t.s3}</li>
  <li>${t.s4}</li>
</ol>
<p><a class="go" href="/">${t.go}</a></p>
<p class="sub" style="margin-top:18px">${t.foot}</p>
<div class="lg"><img class="b" src="/logos/bti.png" alt="BTI Service"><img class="u" src="/logos/upm.png" alt="UPM"><img class="v" src="/logos/valmet.png" alt="Valmet"></div>
</div></body></html>`;
}

function writeAddressFile() {
  const urls = lanUrls();
  const txt = [
    'Tervasaari PM5 — контроль изоляции',
    '===================================',
    '',
    'Адрес для телефонов (открыть в браузере, телефон в той же Wi-Fi сети):',
    '',
    ...(urls.length ? urls.map((u) => `    ${u.url}      (сеть: ${u.iface})`)
                    : ['    сетевой адрес не найден — компьютер не в Wi-Fi/локальной сети']),
    '',
    'На этом компьютере:  http://localhost:' + PORT,
    'QR-коды для телефона: http://localhost:' + PORT + '/setup',
    '',
    'Файл обновляется при каждом запуске start.bat.',
    'Создан: ' + new Date().toLocaleString('ru-RU'),
    '',
  ].join('\r\n');
  try { fs.writeFileSync(path.join(__dirname, 'АДРЕС ДЛЯ ТЕЛЕФОНА.txt'), '\ufeff' + txt); } catch (e) {}
}

/* ---------------- HTTP ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

function send(res, code, body, type) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
  });
  res.end(b);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), MIME['.json']);

function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function tokenOf(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)tesa=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUB, 'index.html'), (e2, idx) =>
        e2 ? send(res, 404, 'not found', 'text/plain')
           : send(res, 200, idx, MIME['.html']));
      return;
    }
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const query = Object.fromEntries(u.searchParams);

  if (p === '/setup' || p === '/setup/')
    return send(res, 200, setupPage(req, pickLang(req, u.searchParams.get('lang'))), MIME['.html']);
  if (p === '/setup.json') return json(res, 200, { port: PORT, urls: lanUrls() });

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  try {
    /* --- открытые эндпоинты --- */
    if (p === '/api/ping') return json(res, 200, { ok: true, time: new Date().toISOString() });

    if (p === '/api/health') {
      const st = S.storageStatus();
      return json(res, 200, {
        ok: !!st.ok, storage: st.mode, error: st.lastError || null,
        pending: st.pending || 0, lines: S.seed.lines.length,
        lastWrite: (st.drive && st.drive.lastWrite) || null,
      });
    }

    if (p === '/api/users' && req.method === 'GET')
      return json(res, 200, S.users.map((x) => ({ name: x.name, role: x.role })));

    // длины паролей (не сами пароли) — чтобы клавиатура понимала, когда отправлять
    if (p === '/api/pinlens' && req.method === 'GET')
      return json(res, 200, [...new Set(S.users.map((x) => String(x.pin).length))].sort((a, b) => a - b));

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const wait = loginBlocked(ip);
      if (wait) return json(res, 429, {
        error: `Слишком много попыток. Повторите через ${Math.ceil(wait / 60)} мин.` });
      const b = await body(req);
      const r = S.login(b.name, b.pin);
      if (!r) { loginFailed(ip); return json(res, 401, { error: 'Неверный пароль' }); }
      loginOk(ip);
      res.setHeader('Set-Cookie',
        `tesa=${encodeURIComponent(r.token)}; Path=/; Max-Age=7776000; SameSite=Lax`);
      return json(res, 200, r);
    }

    /* --- защищённые --- */
    const sess = S.auth(tokenOf(req));
    if (!sess) return json(res, 401, { error: 'Требуется вход' });
    const canEdit = sess.role === 'admin' || sess.role === 'foreman';

    if (p === '/api/me') return json(res, 200, { name: sess.name, role: sess.role });

    if (p === '/api/whoami' && req.method === 'GET')
      return json(res, 200, { name: sess.name, role: sess.role, canEdit });

    if (p === '/api/logout' && req.method === 'POST') {
      S.logout(tokenOf(req));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/config')
      return json(res, 200, {
        stages: M.STAGES, levels: M.LEVELS,
        insp: M.INSP_LEVELS, meta: S.seed.meta,
      });

    if (p === '/api/drawings' && req.method === 'GET')
      return json(res, 200, S.seed.lines.filter((l) => l.drawing)
        .map((l) => ({ id: l.id, short: l.short, file: l.drawing, rev: l.drawing_rev })));

    if (p === '/api/lines' && req.method === 'GET')
      return json(res, 200, search(query.q || ''));

    const mLine = /^\/api\/lines\/([^/]+)$/.exec(p);
    if (mLine && req.method === 'GET') {
      const l = S.linesById.get(decodeURIComponent(mLine[1]));
      if (!l) return json(res, 404, { error: 'Линия не найдена' });
      const c = checksOf(l);
      const w = M.branchWeights(l);
      return json(res, 200, {
        ...lineSummary(l),
        sizes: l.sizes, rows: l.rows,
        branches: (l.branches || []).map((b) => ({
          ...b,
          weight: Math.round(w[b.id] * 1000) / 10,
          percent: Math.round(M.branchPercent(c, b.id) * 10) / 10,
          stages: Object.fromEntries(M.STAGES.map((s) =>
            [s.key, M.branchStagePercent(c, b.id, s.key)])),
        })),
        oper_temp: l.oper_temp, design_temp: l.design_temp,
        flanges: l.flanges, valves_kot: l.valves_kot, valves_reg: l.valves_reg,
        checks: c,
      });
    }

    const mProg = /^\/api\/lines\/([^/]+)\/progress$/.exec(p);
    if (mProg && req.method === 'PUT') {
      if (!canEdit) return json(res, 403, { error: 'Нет прав на изменение' });
      const id = decodeURIComponent(mProg[1]);
      const l = S.linesById.get(id);
      if (!l) return json(res, 404, { error: 'Линия не найдена' });
      const b = await body(req);
      const before = checksOf(l);
      const checks = M.sanitize(b.checks, l);
      const prev = S.state.lines[id] || {};
      const by = (typeof b.by === 'string' && b.by.trim())
        ? sess.name + ' · ' + b.by.trim().slice(0, 40) : sess.name;
      S.state.lines[id] = {
        checks,
        note: typeof b.note === 'string' ? b.note.slice(0, 500) : (prev.note || ''),
        updated: new Date().toISOString(),
        updated_by: by,
      };
      await S.saveState();
      S.addHistory({
        ts: new Date().toISOString(), user: by, line: id,
        before: Math.round(M.linePercent(l, before) * 10) / 10,
        after: Math.round(M.linePercent(l, checks) * 10) / 10,
      });
      return json(res, 200, lineSummary(l));
    }

    if (p === '/api/report' && req.method === 'GET') return json(res, 200, buildReport());

    if (p === '/api/history' && req.method === 'GET') {
      const id = query.line;
      const h = id ? S.history.filter((x) => x.line === id) : S.history;
      return json(res, 200, h.slice(-200).reverse());
    }

    if (p === '/api/export' && req.method === 'GET')
      return json(res, 200, { exported: new Date().toISOString(), state: S.state, history: S.history });

    if (p === '/api/import' && req.method === 'POST') {
      if (!canEdit) return json(res, 403, { error: 'Доступно только для Foreman' });
      const b = await body(req);
      if (!b.state || !b.state.lines) return json(res, 400, { error: 'Неверный формат' });
      S.state = b.state;
      await S.saveState();
      return json(res, 200, { ok: true, lines: Object.keys(S.state.lines).length });
    }

    return json(res, 404, { error: 'Неизвестный метод API' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

async function start() {
  const st = await S.ready;
  if (st.mode === 'drive' && !st.ok) {
    console.error('  ВНИМАНИЕ: отметки не смогут сохраняться, пока Drive не настроен.');
  }
  server.listen(PORT, HOST, onListen);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await S.flush(); } catch (e) {}
    process.exit(0);
  });
}

function onListen() {
  writeAddressFile();
  const urls = lanUrls();
  const line = '  ' + '='.repeat(56);
  console.log('');
  console.log('  Tervasaari PM5 — контроль изоляции   (линий: ' + S.seed.lines.length + ')');
  console.log(line);
  if (urls.length) {
    console.log('  АДРЕС ДЛЯ ТЕЛЕФОНОВ — ввести в браузере телефона:');
    console.log('');
    for (const u of urls) console.log('        ' + u.url + '        (сеть: ' + u.iface + ')');
    console.log('');
    console.log('  Проще: открыть на этом ПК http://localhost:' + PORT + '/setup');
    console.log('  и навести камеру телефона на QR-код.');
  } else {
    console.log('  Компьютер не подключён к Wi-Fi / локальной сети —');
    console.log('  телефоны подключить не получится. Подключите сеть и перезапустите.');
  }
  console.log(line);
  console.log('  На этом компьютере:  http://localhost:' + PORT);
  console.log('  Тот же адрес записан в файл "АДРЕС ДЛЯ ТЕЛЕФОНА.txt"');
  console.log('  Остановить: Ctrl+C — окно не закрывать, пока приложение нужно.');
  console.log('');
}

start();
