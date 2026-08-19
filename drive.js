'use strict';
/* Хранение данных в Google Drive. Без внешних библиотек — только fetch из Node 18+.
   Область доступа drive.file: приложение видит только те файлы, которые само создало. */

const OAUTH_URL = process.env.TESA_GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com/token';
const API = process.env.TESA_GOOGLE_API || 'https://www.googleapis.com/drive/v3';
const UPLOAD = process.env.TESA_GOOGLE_UPLOAD || 'https://www.googleapis.com/upload/drive/v3';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function createDrive(cfg) {
  const clientId = cfg.clientId;
  const clientSecret = cfg.clientSecret;
  const refreshToken = cfg.refreshToken;
  const folderName = cfg.folderName || 'Tervasaari PM5 — данные';
  let folderId = cfg.folderId || null;

  let token = null, tokenExp = 0;
  const ids = new Map();                     // имя файла -> id в Drive
  const state = { ok: false, lastError: null, lastRead: null, lastWrite: null, folderId: null };

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const body = new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    });
    const r = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const hint = j.error === 'invalid_grant'
        ? ' — токен отозван или протух. Обычно это значит, что экран согласия остался в режиме '
          + '«Testing» (там токен живёт 7 дней). Переведите приложение в «In production» '
          + 'и получите refresh_token заново: node tools/google-auth.js'
        : '';
      throw new Error(`Google OAuth: ${j.error || r.status}${j.error_description ? ' (' + j.error_description + ')' : ''}${hint}`);
    }
    token = j.access_token;
    tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
    return token;
  }

  async function api(url, opt) {
    opt = opt || {};
    const t = await accessToken();
    const r = await fetch(url, {
      method: opt.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + t }, opt.headers || {}),
      body: opt.body,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Google Drive ${r.status}: ${txt.slice(0, 300)}`);
    }
    return opt.raw ? r : r.json();
  }

  const q = (s) => encodeURIComponent(s);

  async function findChild(name, mime) {
    let query = `name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
    if (mime) query += ` and mimeType = '${mime}'`;
    if (folderId && mime !== FOLDER_MIME) query += ` and '${folderId}' in parents`;
    const j = await api(`${API}/files?q=${q(query)}&fields=${q('files(id,name,modifiedTime)')}&pageSize=10`);
    return (j.files || [])[0] || null;
  }

  /** Находит или создаёт папку проекта в «Моём диске». */
  async function ensureFolder() {
    if (folderId) { state.folderId = folderId; return folderId; }
    const found = await findChild(folderName, FOLDER_MIME);
    if (found) { folderId = found.id; state.folderId = folderId; return folderId; }
    const j = await api(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME }),
    });
    folderId = j.id; state.folderId = folderId;
    return folderId;
  }

  async function init() {
    await accessToken();
    await ensureFolder();
    state.ok = true; state.lastError = null;
    return state;
  }

  async function readJSON(name, fallback) {
    try {
      let f = ids.has(name) ? { id: ids.get(name) } : await findChild(name, null);
      if (!f) return fallback;
      ids.set(name, f.id);
      const r = await api(`${API}/files/${f.id}?alt=media`, { raw: true });
      const txt = await r.text();
      state.lastRead = new Date().toISOString();
      state.ok = true; state.lastError = null;
      return txt ? JSON.parse(txt) : fallback;
    } catch (e) {
      state.ok = false; state.lastError = String(e.message || e);
      throw e;
    }
  }

  async function writeJSON(name, obj) {
    const content = JSON.stringify(obj, null, 1);
    try {
      let id = ids.get(name);
      if (!id) {
        const f = await findChild(name, null);
        if (f) { id = f.id; ids.set(name, id); }
      }
      if (id) {
        await api(`${UPLOAD}/files/${id}?uploadType=media&fields=id`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: content,
        });
      } else {
        const boundary = 'tesa' + Math.abs(content.length * 2654435761 % 1e9).toString(36) + 'b';
        const meta = JSON.stringify({ name, parents: folderId ? [folderId] : undefined });
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
          + `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
        const j = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
        ids.set(name, j.id);
      }
      state.lastWrite = new Date().toISOString();
      state.ok = true; state.lastError = null;
      return true;
    } catch (e) {
      state.ok = false; state.lastError = String(e.message || e);
      throw e;
    }
  }

  return { init, readJSON, writeJSON, status: () => Object.assign({}, state), get folderId() { return folderId; } };
}

module.exports = { createDrive };
