'use strict';
/* Локальная заглушка Google Drive API — нужна только для проверки кода без реального аккаунта.
   Запуск: node tools/mock-google.js [порт] */
const http = require('http');
const PORT = Number(process.argv[2] || 9111);

const files = new Map();          // id -> {id,name,mimeType,parents,content,modifiedTime}
let seq = 1;
const state = { tokenCalls: 0, failNext: 0 };

function send(res, code, obj, type) {
  const b = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': type || 'application/json' , 'Content-Length': b.length});
  res.end(b);
}
function readBody(req) {
  return new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/token') {
    state.tokenCalls++;
    const body = await readBody(req);
    if (body.includes('refresh_token=BAD'))
      return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    return send(res, 200, { access_token: 'mock-' + state.tokenCalls, expires_in: 3600, token_type: 'Bearer' });
  }

  if (state.failNext > 0 && p.includes('/drive/v3')) { state.failNext--; return send(res, 503, { error: 'backend error' }); }
  if (p === '/ctl/fail') { state.failNext = Number(u.searchParams.get('n') || 1); return send(res, 200, { ok: true }); }
  if (p === '/ctl/dump') return send(res, 200, [...files.values()].map((f) => ({ id: f.id, name: f.name, mime: f.mimeType, bytes: (f.content || '').length })));

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer mock-')) return send(res, 401, { error: 'unauthorized' });

  // GET /drive/v3/files?q=...
  if (p === '/drive/v3/files' && req.method === 'GET') {
    const q = u.searchParams.get('q') || '';
    const nameM = /name = '([^']*)'/.exec(q);
    const mimeM = /mimeType = '([^']*)'/.exec(q);
    const parentM = /'([^']*)' in parents/.exec(q);
    const out = [...files.values()].filter((f) => {
      if (nameM && f.name !== nameM[1]) return false;
      if (mimeM && f.mimeType !== mimeM[1]) return false;
      if (parentM && !(f.parents || []).includes(parentM[1])) return false;
      return true;
    }).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
    return send(res, 200, { files: out });
  }

  // POST /drive/v3/files  — создать папку
  if (p === '/drive/v3/files' && req.method === 'POST') {
    const meta = JSON.parse(await readBody(req) || '{}');
    const f = { id: 'id' + (seq++), name: meta.name, mimeType: meta.mimeType || 'application/json',
                parents: meta.parents || [], content: '', modifiedTime: new Date().toISOString() };
    files.set(f.id, f);
    return send(res, 200, { id: f.id });
  }

  // POST /upload/drive/v3/files?uploadType=multipart
  if (p === '/upload/drive/v3/files' && req.method === 'POST') {
    const raw = await readBody(req);
    const ct = req.headers['content-type'] || '';
    const bm = /boundary=([^;]+)/.exec(ct);
    if (!bm) return send(res, 400, { error: 'no boundary' });
    const parts = raw.split('--' + bm[1]).filter((x) => x.trim() && x.trim() !== '--');
    const bodies = parts.map((x) => x.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
    const meta = JSON.parse(bodies[0] || '{}');
    const f = { id: 'id' + (seq++), name: meta.name, mimeType: 'application/json',
                parents: meta.parents || [], content: bodies[1] || '', modifiedTime: new Date().toISOString() };
    files.set(f.id, f);
    return send(res, 200, { id: f.id });
  }

  // PATCH /upload/drive/v3/files/{id}?uploadType=media
  let m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (m && req.method === 'PATCH') {
    const f = files.get(m[1]);
    if (!f) return send(res, 404, { error: 'not found' });
    f.content = await readBody(req);
    f.modifiedTime = new Date().toISOString();
    return send(res, 200, { id: f.id });
  }

  // GET /drive/v3/files/{id}?alt=media
  m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (m && req.method === 'GET') {
    const f = files.get(m[1]);
    if (!f) return send(res, 404, { error: 'not found' });
    if (u.searchParams.get('alt') === 'media') return send(res, 200, f.content || '', 'application/json');
    return send(res, 200, { id: f.id, name: f.name });
  }

  send(res, 404, { error: 'no route', path: p });
}).listen(PORT, () => console.log('mock google on ' + PORT));
