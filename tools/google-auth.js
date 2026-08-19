'use strict';
/* Однократное получение refresh_token для Google Drive.
   Запуск:  node tools/google-auth.js
   Спросит Client ID и Client Secret, откроет браузер, вернёт готовые строки для Render. */

const http = require('http');
const readline = require('readline');
const { exec } = require('child_process');

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

(async () => {
  console.log('');
  console.log('  Подключение Google Drive к Tervasaari PM5');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  Перед запуском в Google Cloud Console должно быть сделано:');
  console.log('   1) создан проект;');
  console.log('   2) включён Google Drive API;');
  console.log('   3) экран согласия переведён в «In production» (иначе доступ');
  console.log('      будет отваливаться каждые 7 дней);');
  console.log('   4) создан OAuth client типа «Desktop app».');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('');

  const clientId = process.env.TESA_GOOGLE_CLIENT_ID || await ask('  Client ID: ');
  const clientSecret = process.env.TESA_GOOGLE_CLIENT_SECRET || await ask('  Client secret: ');
  if (!clientId || !clientSecret) { console.error('  Нужны оба значения.'); process.exit(1); }

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
  }).toString();

  console.log('');
  console.log('  Сейчас откроется браузер. Войдите тем аккаунтом Google,');
  console.log('  на диске которого должны лежать данные, и разрешите доступ.');
  console.log('');
  console.log('  Если браузер не открылся — скопируйте ссылку вручную:');
  console.log('  ' + authUrl);
  console.log('');

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font:16px/1.5 sans-serif;padding:40px;background:#e8eae4">
        <h2>${c ? 'Готово — доступ выдан' : 'Отказано в доступе'}</h2>
        <p>${c ? 'Вернитесь в окно консоли, там будут значения для Render.' : (err || '')}</p>
        </body></html>`);
      srv.close();
      c ? resolve(c) : reject(new Error(err || 'нет кода'));
    });
    srv.listen(PORT, () => openBrowser(authUrl));
    setTimeout(() => { try { srv.close(); } catch (e) {} reject(new Error('время ожидания истекло')); }, 300000);
  });

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: REDIRECT, grant_type: 'authorization_code',
    }).toString(),
  });
  const j = await r.json();
  if (!j.refresh_token) {
    console.error('\n  Не удалось получить refresh_token:', JSON.stringify(j));
    console.error('  Попробуйте ещё раз — важно, чтобы в ссылке был prompt=consent.');
    process.exit(1);
  }

  console.log('');
  console.log('  ГОТОВО. Впишите это в переменные окружения (Render → Environment):');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  TESA_STORE                  = drive');
  console.log('  TESA_GOOGLE_CLIENT_ID       = ' + clientId);
  console.log('  TESA_GOOGLE_CLIENT_SECRET   = ' + clientSecret);
  console.log('  TESA_GOOGLE_REFRESH_TOKEN   = ' + j.refresh_token);
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  Проверить локально:');
  console.log('    Windows:  set TESA_STORE=drive && set TESA_GOOGLE_CLIENT_ID=... && node server.js');
  console.log('  Данные появятся в «Моём диске», папка «Tervasaari PM5 — данные».');
  console.log('');
  rl.close();
})().catch((e) => { console.error('\n  Ошибка: ' + e.message + '\n'); process.exit(1); });
