'use strict';
/* Минимальный генератор QR-кода (byte mode, уровень коррекции M, версии 1–10).
   Без внешних зависимостей. Возвращает матрицу true/false. */

const EC_Q = { // уровень Q (~25% восстановления) — используется по умолчанию
  1:  [13, 13, 1, 13, 0, 0],
  2:  [22, 22, 1, 22, 0, 0],
  3:  [34, 18, 2, 17, 0, 0],
  4:  [48, 26, 2, 24, 0, 0],
  5:  [62, 18, 2, 15, 2, 16],
  6:  [76, 24, 4, 19, 0, 0],
  7:  [88, 18, 2, 14, 4, 15],
  8:  [110, 22, 4, 18, 2, 19],
  9:  [132, 20, 4, 16, 4, 17],
  10: [154, 24, 6, 19, 2, 20],
};

const EC_M = { // [всего кодовых слов данных, ec на блок, блоков группы1, слов в блоке г1, блоков г2, слов г2]
  1:  [16, 10, 1, 16, 0, 0],
  2:  [28, 16, 1, 28, 0, 0],
  3:  [44, 26, 1, 44, 0, 0],
  4:  [64, 18, 2, 32, 0, 0],
  5:  [86, 24, 2, 43, 0, 0],
  6:  [108, 16, 4, 27, 0, 0],
  7:  [124, 18, 4, 31, 0, 0],
  8:  [154, 22, 2, 38, 2, 39],
  9:  [182, 22, 3, 36, 2, 37],
  10: [216, 26, 4, 43, 1, 44],
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* --- поле Галуа GF(256) --- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= mul(g[j], EXP[i]);
      ng[j + 1] ^= g[j];
    }
    g = ng;
  }
  return g.reverse();   // старший коэффициент первым (многочлен приведённый)
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift(); res.push(0);
    if (factor !== 0) for (let i = 0; i < gen.length - 1; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

/* --- сборка потока данных --- */
function buildData(text, version) {
  const bytes = [];
  for (const ch of unescape(encodeURIComponent(text))) bytes.push(ch.charCodeAt(0));
  const [totalData, ecPerBlock, g1n, g1c, g2n, g2c] = EC_Q[version];
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);              // версии 1–9: 8 бит; версия 10 — тоже 8 для byte до 255
  for (const b of bytes) push(b, 8);
  const cap = totalData * 8;
  if (bits.length > cap) return null;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const pad = [0xec, 0x11];
  let p = 0;
  while (bits.length < cap) { push(pad[p++ % 2], 8); }
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }
  // разбиение на блоки
  const blocks = [], ecs = [];
  let idx = 0;
  for (let i = 0; i < g1n; i++) { const b = codewords.slice(idx, idx + g1c); idx += g1c; blocks.push(b); ecs.push(rsEncode(b, ecPerBlock)); }
  for (let i = 0; i < g2n; i++) { const b = codewords.slice(idx, idx + g2c); idx += g2c; blocks.push(b); ecs.push(rsEncode(b, ecPerBlock)); }
  // чередование
  const out = [];
  const maxLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

/* --- матрица --- */
function makeMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inR = r >= 0 && r <= 6, inC = c >= 0 && c <= 6;
      let v = false;
      if (inR && inC) {
        v = (r === 0 || r === 6 || c === 0 || c === 6) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
      set(r0 + r, c0 + c, v);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0; m[i][6] = i % 2 === 0; }

  const al = ALIGN[version];
  for (const r of al) for (const c of al) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
  }

  m[size - 8][8] = true;   // тёмный модуль
  // резерв под информацию о формате
  for (let i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = false; if (m[i][8] === null) m[i][8] = false; }
  for (let i = 0; i < 8; i++) { if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false; if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false; }
  return m;
}

function reserved(version, r, c) {
  const size = version * 4 + 17;
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 8) return true;
  if (r >= size - 8 && c <= 8) return true;
  if (r === 6 || c === 6) return true;
  const al = ALIGN[version];
  for (const ar of al) for (const ac of al) {
    if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
    if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
  }
  return false;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function placeData(version, codewords, mask) {
  const size = version * 4 + 17;
  const m = makeMatrix(version);
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bi = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved(version, row, c)) continue;
        let bit = bi < bits.length ? bits[bi++] : 0;
        if (MASKS[mask](row, c)) bit ^= 1;
        m[row][c] = bit === 1;
      }
    }
    up = !up;
  }
  return m;
}

function placeFormat(m, version, mask) {
  const size = version * 4 + 17;
  const data = (0b11 << 3) | mask;            // уровень коррекции Q = 11
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10);
  const fmt = ((data << 10) | rem) ^ 0b101010000010010;
  const bit = (i) => ((fmt >> i) & 1) === 1;  // i = 14 — старший бит

  // копия 1 — вокруг верхнего левого поискового шаблона, биты 14…0
  const p1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
              [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  // копия 2 — снизу слева и справа сверху, биты 14…0
  const p2 = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8],
              [size - 6, 8], [size - 7, 8],
              [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
              [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
  for (let i = 0; i < 15; i++) {
    const v = bit(14 - i);
    m[p1[i][0]][p1[i][1]] = v;
    m[p2[i][0]][p2[i][1]] = v;
  }
  m[size - 8][8] = true;                      // всегда тёмный модуль
  return m;
}

function penalty(m) {
  const n = m.length; let p = 0;
  const runScore = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  for (let i = 0; i < n; i++) { p += runScore(m[i]); p += runScore(m.map((r) => r[i])); }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }
  // правило 3: шаблоны, похожие на поисковые (1:1:3:1:1) — мешают сканеру
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const hit = (line, at, pat) => {
    for (let k = 0; k < pat.length; k++) if ((line[at + k] ? 1 : 0) !== pat[k]) return false;
    return true;
  };
  const scan = (raw) => {
    // за границей символа считаем светлые модули — так требует стандарт
    const line = [false, false, false, false, ...raw, false, false, false, false];
    let s2 = 0;
    for (let i = 0; i + 11 <= line.length; i++) {
      if (hit(line, i, P1)) s2 += 40;
      if (hit(line, i, P2)) s2 += 40;
    }
    return s2;
  };
  for (let i = 0; i < n; i++) { p += scan(m[i]); p += scan(m.map((r) => r[i])); }

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/** Строит QR-матрицу для текста. */
function encode(text) {
  for (let version = 1; version <= 10; version++) {
    const cw = buildData(text, version);
    if (!cw) continue;
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = placeFormat(placeData(version, cw, mask), version, mask);
      const p = penalty(m);
      if (p < bestP) { bestP = p; best = m; }
    }
    return best;
  }
  throw new Error('Слишком длинный текст для QR');
}

/** SVG-картинка QR-кода. */
function svg(text, px) {
  const m = encode(text);
  const n = m.length, q = 4, size = (n + q * 2);
  const s = px || 6;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (m[r][c]) path += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * s}" height="${size * s}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { encode, svg, _debug: { buildData, placeData, placeFormat, penalty, makeMatrix, reserved } };
