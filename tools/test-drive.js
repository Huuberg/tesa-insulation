'use strict';
/* Проверка связи с Google Drive.
   node tools/test-drive.js          — проверяет настоящее подключение по переменным окружения
   node tools/test-drive.js --mock   — проверяет сам код на локальной заглушке (без Google) */

const path = require('path');
const { spawn } = require('child_process');

const MOCK = process.argv.includes('--mock');
let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FAIL ') + m); if (!c) fail++; };

async function run() {
  let mockProc = null;
  if (MOCK) {
    const port = 9123;
    process.env.TESA_GOOGLE_OAUTH_URL = `http://localhost:${port}/token`;
    process.env.TESA_GOOGLE_API = `http://localhost:${port}/drive/v3`;
    process.env.TESA_GOOGLE_UPLOAD = `http://localhost:${port}/upload/drive/v3`;
    process.env.TESA_GOOGLE_CLIENT_ID = 'mock';
    process.env.TESA_GOOGLE_CLIENT_SECRET = 'mock';
    process.env.TESA_GOOGLE_REFRESH_TOKEN = 'mock';
    mockProc = spawn(process.execPath, [path.join(__dirname, 'mock-google.js'), String(port)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
    console.log('\n  Проверка кода на локальной заглушке (Google не используется)\n');
  } else {
    const need = ['TESA_GOOGLE_CLIENT_ID', 'TESA_GOOGLE_CLIENT_SECRET', 'TESA_GOOGLE_REFRESH_TOKEN'];
    const miss = need.filter((k) => !process.env[k]);
    if (miss.length) {
      console.error('\n  Не заданы переменные: ' + miss.join(', '));
      console.error('  Получить их: node tools/google-auth.js');
      console.error('  Либо проверьте только код: node tools/test-drive.js --mock\n');
      process.exit(1);
    }
    console.log('\n  Проверка подключения к вашему Google Drive\n');
  }

  const { createDrive } = require('../drive');
  const d = createDrive({
    clientId: process.env.TESA_GOOGLE_CLIENT_ID,
    clientSecret: process.env.TESA_GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.TESA_GOOGLE_REFRESH_TOKEN,
    folderId: process.env.TESA_DRIVE_FOLDER_ID || null,
    folderName: process.env.TESA_DRIVE_FOLDER || 'Tervasaari PM5 — данные',
  });

  try {
    await d.init();
    ok(true, 'вход выполнен, папка на диске: ' + d.folderId);
  } catch (e) {
    ok(false, 'подключиться не удалось — ' + e.message);
    if (mockProc) mockProc.kill();
    process.exit(1);
  }

  const probe = { проверка: true, время: new Date().toISOString(), значение: Math.floor(Date.now() / 1000) };
  try {
    await d.writeJSON('_проверка.json', probe);
    ok(true, 'запись файла прошла');
  } catch (e) { ok(false, 'запись не удалась — ' + e.message); }

  try {
    const back = await d.readJSON('_проверка.json', null);
    ok(back && back.значение === probe.значение, 'чтение вернуло то же самое значение');
  } catch (e) { ok(false, 'чтение не удалось — ' + e.message); }

  try {
    probe.значение += 1;
    await d.writeJSON('_проверка.json', probe);
    const back = await d.readJSON('_проверка.json', null);
    ok(back && back.значение === probe.значение, 'перезапись существующего файла работает');
  } catch (e) { ok(false, 'перезапись не удалась — ' + e.message); }

  const big = { lines: {} };
  for (let i = 0; i < 89; i++) big.lines['5' + (150 + i)] = { checks: { branches: {} }, updated: new Date().toISOString() };
  try {
    const t0 = Date.now();
    await d.writeJSON('_проверка.json', big);
    ok(true, `запись файла размером с реальные данные (${Math.round(JSON.stringify(big).length / 1024)} КБ) — ${Date.now() - t0} мс`);
  } catch (e) { ok(false, 'большой файл не записался — ' + e.message); }

  console.log(fail
    ? `\n  ПРОБЛЕМ: ${fail}. Проверьте переменные окружения и статус экрана согласия.\n`
    : '\n  Всё в порядке. Файл «_проверка.json» можно удалить из папки на диске.\n');

  if (mockProc) mockProc.kill();
  process.exit(fail ? 1 : 0);
}
run();
