'use strict';
/* Хранилище. Два режима:
   - файлы на диске (по умолчанию — сервер на ПК или облако с диском);
   - Google Drive (TESA_STORE=drive) — данные лежат в вашем «Моём диске».
   Внешних зависимостей нет. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = process.env.TESA_DATA || path.join(__dirname, 'data');
const USE_DRIVE = String(process.env.TESA_STORE || '').toLowerCase() === 'drive';

const F = {
  seed:     path.join(DATA, 'seed.json'),
  state:    path.join(DATA, 'state.json'),
  users:    path.join(DATA, 'users.json'),
  history:  path.join(DATA, 'history.json'),
  sessions: path.join(DATA, 'sessions.json'),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

let writing = Promise.resolve();
function writeFileJSON(file, obj) {
  writing = writing.then(() => new Promise((res) => {
    const tmp = file + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, file); }
    catch (e) { console.error('запись не удалась', file, e.message); }
    res();
  }));
  return writing;
}

fs.mkdirSync(DATA, { recursive: true });

/* ---------- регистр линий: всегда из файла рядом с приложением ---------- */
const seed = readJSON(F.seed, null) || readJSON(path.join(__dirname, 'data', 'seed.json'), { meta: {}, lines: [] });
const linesById = new Map(seed.lines.map((l) => [l.id, l]));

/* ---------- состояние ---------- */
let state = { version: 1, updated: new Date().toISOString(), lines: {} };
let history = [];
let sessions = {};

let users = readJSON(F.users, null) || [
  { id: 'foreman', name: 'Foreman', pin: '2468', role: 'foreman' },
  { id: 'viewer',  name: 'Viewer',  pin: '1357', role: 'viewer'  },
];
// Пароли из переменных окружения перекрывают файл (так удобно в облаке).
(() => {
  const env = { foreman: process.env.TESA_FOREMAN_PIN, viewer: process.env.TESA_VIEWER_PIN };
  for (const u of users) {
    const v = env[u.role];
    if (v && String(v).trim()) u.pin = String(v).trim();
  }
})();

/* ---------- бэкенд Google Drive ---------- */
let drive = null;
const driveState = { mode: USE_DRIVE ? 'drive' : 'file', ok: !USE_DRIVE, lastError: null, pending: 0 };

function driveCfgMissing() {
  const need = ['TESA_GOOGLE_CLIENT_ID', 'TESA_GOOGLE_CLIENT_SECRET', 'TESA_GOOGLE_REFRESH_TOKEN'];
  return need.filter((k) => !process.env[k]);
}

const pending = new Map();          // имя файла -> таймер
const DEBOUNCE = Number(process.env.TESA_DRIVE_DEBOUNCE || 1200);

function scheduleDriveWrite(name, getObj) {
  if (pending.has(name)) clearTimeout(pending.get(name));
  driveState.pending = pending.size + 1;
  const t = setTimeout(async () => {
    pending.delete(name);
    driveState.pending = pending.size;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await drive.writeJSON(name, getObj());
        driveState.ok = true; driveState.lastError = null;
        return;
      } catch (e) {
        driveState.ok = false;
        driveState.lastError = String(e.message || e);
        console.error(`Google Drive: не записан ${name} (попытка ${attempt}) — ${driveState.lastError}`);
        if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    // не потерять данные: складываем локальную копию и продолжаем попытки в фоне
    writeFileJSON(path.join(DATA, name), getObj());
    dirty.add(name);
    startRetryLoop();
  }, DEBOUNCE);
  pending.set(name, t);
  return Promise.resolve();
}

/* Фоновые повторы, пока Google недоступен */
const dirty = new Set();
let retryTimer = null;
function objOf(name) {
  return { 'state.json': state, 'history.json': history, 'sessions.json': sessions }[name];
}
function startRetryLoop() {
  if (retryTimer || !drive) return;
  retryTimer = setInterval(async () => {
    if (!dirty.size) { clearInterval(retryTimer); retryTimer = null; return; }
    for (const name of [...dirty]) {
      try {
        await drive.writeJSON(name, objOf(name));
        dirty.delete(name);
        driveState.ok = dirty.size === 0;
        if (driveState.ok) { driveState.lastError = null; console.log('Google Drive: связь восстановлена, данные записаны'); }
      } catch (e) {
        driveState.ok = false;
        driveState.lastError = String(e.message || e);
        break;
      }
    }
  }, Number(process.env.TESA_DRIVE_RETRY || 30000));
}

/** Досылает всё несохранённое (вызывается при остановке сервера). */
async function flush() {
  if (!drive) return;
  const names = [...pending.keys()];
  for (const n of names) { clearTimeout(pending.get(n)); pending.delete(n); }
  const objs = { 'state.json': () => state, 'history.json': () => history, 'sessions.json': () => sessions };
  for (const n of names) {
    try { await drive.writeJSON(n, objs[n]()); } catch (e) { console.error('flush', n, e.message); }
  }
  driveState.pending = 0;
}

/* ---------- загрузка ---------- */
const ready = (async () => {
  if (!USE_DRIVE) {
    state = readJSON(F.state, state);
    history = readJSON(F.history, []);
    sessions = readJSON(F.sessions, {});
    if (!fs.existsSync(F.state)) writeFileJSON(F.state, state);
    if (!fs.existsSync(F.users)) writeFileJSON(F.users, users);
    return driveState;
  }
  const miss = driveCfgMissing();
  if (miss.length) {
    driveState.ok = false;
    driveState.lastError = 'Не заданы переменные окружения: ' + miss.join(', ');
    console.error('\n  Google Drive не настроен: ' + driveState.lastError);
    console.error('  Получить их: node tools/google-auth.js\n');
    return driveState;
  }
  const { createDrive } = require('./drive');
  drive = createDrive({
    clientId: process.env.TESA_GOOGLE_CLIENT_ID,
    clientSecret: process.env.TESA_GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.TESA_GOOGLE_REFRESH_TOKEN,
    folderId: process.env.TESA_DRIVE_FOLDER_ID || null,
    folderName: process.env.TESA_DRIVE_FOLDER || 'Tervasaari PM5 — данные',
  });
  try {
    await drive.init();
    state = await drive.readJSON('state.json', state);
    history = await drive.readJSON('history.json', []);
    sessions = await drive.readJSON('sessions.json', {});
    // если на локальном диске осталась более свежая копия (сервер падал во время сбоя Google) — берём её
    const localState = readJSON(F.state, null);
    if (localState && localState.updated && (!state.updated || localState.updated > state.updated)) {
      console.log('  Найдена более свежая локальная копия отметок — отправляю её в Drive');
      state = localState;
      const localHist = readJSON(F.history, null);
      if (Array.isArray(localHist) && localHist.length > history.length) history = localHist;
      dirty.add('state.json'); dirty.add('history.json');
      startRetryLoop();
    }
    driveState.ok = true;
    driveState.folderId = drive.folderId;
    console.log(`  Google Drive: подключён, отметок по линиям: ${Object.keys(state.lines || {}).length}`);
  } catch (e) {
    driveState.ok = false;
    driveState.lastError = String(e.message || e);
    console.error('\n  Google Drive недоступен: ' + driveState.lastError + '\n');
  }
  return driveState;
})();

/* ---------- сохранение ---------- */
function saveState() {
  state.updated = new Date().toISOString();
  return drive ? scheduleDriveWrite('state.json', () => state) : writeFileJSON(F.state, state);
}
function saveHistory() {
  if (history.length > 20000) history = history.slice(-20000);
  return drive ? scheduleDriveWrite('history.json', () => history) : writeFileJSON(F.history, history);
}
function saveSessions() {
  return drive ? scheduleDriveWrite('sessions.json', () => sessions) : writeFileJSON(F.sessions, sessions);
}
function saveUsers() { return writeFileJSON(F.users, users); }

/* ---------- пользователи и сессии ---------- */
function login(name, pin) {
  const p = String(pin == null ? '' : pin).trim();
  if (!p) return null;
  const u = users.find((x) => String(x.pin) === p && (!name || x.name === name));
  if (!u) return null;
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { user: u.id, name: u.name, role: u.role, ts: Date.now() };
  saveSessions();
  return { token, user: { id: u.id, name: u.name, role: u.role } };
}

const TTL = 90 * 24 * 3600 * 1000;
function auth(token) {
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() - s.ts > TTL) { delete sessions[token]; saveSessions(); return null; }
  return s;
}
function logout(token) { delete sessions[token]; saveSessions(); }
function addHistory(rec) { history.push(rec); saveHistory(); }

function storageStatus() {
  const s = Object.assign({}, driveState);
  if (drive) Object.assign(s, { drive: drive.status() });
  return s;
}

module.exports = {
  DATA, F, seed, linesById, users, ready, flush, storageStatus,
  get state() { return state; },
  set state(v) { state = v; },
  get history() { return history; },
  saveState, saveHistory, saveUsers, login, auth, logout, addHistory,
  readJSON, writeJSON: writeFileJSON,
};
