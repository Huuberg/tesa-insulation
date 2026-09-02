'use strict';
/* Модель готовности Tervasaari PM5 — версия 3 (нормы времени EAI rev.2).

   Готовность отмечается ОТДЕЛЬНО ПО КАЖДОЙ ВЕТКЕ линии (свой типоразмер трубы).

   Позиции и веса:
     1. Материалы на месте   —  5%  — ручной ввод %
     2. Изоляция (вата)      — 30%  — метры (ввод) + отводы (чек-боксы)
     3. Металлопокрытие      — 40%  — метры + отводы + чемоданы (чек-боксы)
     4. Отделка              — 23%  — ручной ввод %
     5. Приёмка              —  2%  — 50 / 100

   Трудоёмкость взята из норм EAI rev.2 — часы на м² готовой изоляции,
   по НАРУЖНОМУ диаметру трубы:

     группа   OD трубы     прямые   фитинги   коэффициент
       A      28–89        1,99     3,72         1,79
       B      114          1,39     3,00–3,72    1,25
       C      140–168      1,33     3,00         1,20
       D      219–406      1,11     2,00         1,00

   Фитинг стоит примерно вдвое дороже прямой трубы той же площади (FIT_K).
   Площади прямых участков, отводов и прочих фитингов берутся из регистра
   поштучно, а не пересчитываются из метража. Чемодан — 1,5 часа сверху.

   Итог по проекту: 1275 нормо-часов на 713,5 м² (бюджет проекта — 1249 ч). */

const MODEL_VERSION = 3;

const STAGES = [
  { key: 'materials',  title: 'Materials',  weight: 5,  kind: 'pct',
    ru: 'Материалы на месте',  en: 'materials on site', et: 'materjalid kohal' },
  { key: 'insulation', title: 'Insulation', weight: 30, kind: 'qty',
    ru: 'Изоляция (вата)',     en: 'mineral wool',      et: 'isolatsioon (vill)' },
  { key: 'cladding',   title: 'Cladding',   weight: 40, kind: 'qty',
    ru: 'Металлопокрытие',     en: 'metal cladding',    et: 'plekikate' },
  { key: 'finishing',  title: 'Finishing',  weight: 23, kind: 'pct',
    ru: 'Отделка',             en: 'finishing',         et: 'viimistlus' },
  { key: 'inspection', title: 'Inspection', weight: 2,  kind: 'insp',
    ru: 'Приёмка',             en: 'vastuvõtt',         et: 'vastuvõtt' },
];

const INSP_LEVELS = [50, 100];
const QTY_STAGES = ['insulation', 'cladding'];
const PCT_STAGES = ['materials', 'finishing'];

/* ---------- нормы трудоёмкости (EAI rev.2) ---------- */
const FIT_K = 2;         // средний множитель фитинга (у каждой группы свой, см. DN_GROUPS.fk)
const BOX_HOURS = 1.5;   // один чемодан
const ELBOW_EQ = 1.5;    // осталось для совместимости со старыми вызовами

const DN_GROUPS = [
  { name: 'A', max: 89,  h: 1.99, hf: 3.72, fk: 1.87, k: 1.79, ru: 'тонкие · OD ≤89 (DN15–80)',  en: 'thin · OD ≤89',      et: 'peened · OD ≤89' },
  { name: 'B', max: 114, h: 1.39, hf: 3.36, fk: 2.42, k: 1.25, ru: 'средние · OD 114 (DN100)',   en: 'medium · OD 114',    et: 'kesk · OD 114' },
  { name: 'C', max: 168, h: 1.33, hf: 3.00, fk: 2.26, k: 1.20, ru: 'крупные · OD 140–168',       en: 'large · OD 140–168', et: 'suured · OD 140–168' },
  { name: 'D', max: 1e9, h: 1.11, hf: 2.00, fk: 1.80, k: 1.00, ru: 'толстые · OD ≥219 (DN200+)', en: 'thick · OD ≥219',    et: 'jämedad · OD ≥219' },
];

const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (v) => { const n = +v; return isFinite(n) ? n : 0; };

/** Наружный диаметр трубы; если в регистре его нет — прикидываем по DN. */
function odOf(b) {
  const od = +(b && b.pipe_od) || 0;
  if (od > 0) return od;
  const d = +(b && b.dn) || 0;
  return d > 0 ? Math.round(d * 1.15) + 10 : 0;
}

/** Группа трудоёмкости ветки. */
function groupOf(b) {
  const od = odOf(b);
  return DN_GROUPS.find((g) => od <= g.max) || DN_GROUPS[DN_GROUPS.length - 1];
}

/** Коэффициент производительности (1,00 — самые быстрые толстые трубы). */
function dnK(b) {
  if (b != null && typeof b === 'object') return groupOf(b).k;
  return groupOf({ dn: b }).k;
}

/* ---------- площади ветки ---------- */
/** Площади из регистра: прямые, отводы, прочие фитинги (тройники, конусы, врезки). */
function areasOf(b) {
  const pipe = +(b && b.m2_pipe) || 0;
  const el = +(b && b.m2_elbow) || 0;
  const fit = +(b && b.m2_fit) || 0;
  if (pipe + el + fit > 0) return { pipe, elbow: el, fit };
  // ветка без построчной разбивки в регистре — раскладываем сами
  const dev = (+(b && b.dev) || 0) / 1000;
  const nE = +(b && b.elbows) || 0;
  const mb = (+(b && b.straight_m) || 0) || (+(b && b.length_m) || 0);
  const elA = dev > 0 ? dev * 0.5 * nE : 0;          // отвод ≈ 0,5 м развёртки
  const a = +(b && b.area_m2) || 0;
  if (a > 0) return { pipe: Math.max(0, a - elA), elbow: elA, fit: 0 };
  if (dev > 0 && (mb > 0 || nE > 0)) return { pipe: dev * mb, elbow: elA, fit: 0 };
  return { pipe: 0, elbow: 0, fit: 0 };
}

/** Приведённая площадь, отслеживаемая метрами (прямые + прочие фитинги). */
function effPipe(b) { const a = areasOf(b); return a.pipe + groupOf(b).fk * a.fit; }
/** Приведённая площадь отводов — отслеживается чек-боксами. */
function effElbow(b) { return groupOf(b).fk * areasOf(b).elbow; }
/** Вся приведённая площадь ветки, кроме чемоданов. */
function effArea(b) { return effPipe(b) + effElbow(b); }
/** Чемодан в м²-эквиваленте этой ветки (1,5 часа). */
function boxEqA(b) { const h = groupOf(b).h; return h > 0 ? BOX_HOURS / h : 1.35; }

/** База метров ветки: прямая труба, а если её нет — вся длина ветки. */
function metreBase(b) {
  const st = +b.straight_m || 0;
  if (st > 0) return st;
  const len = +b.length_m || 0;
  return len > 0 ? Math.round(len * 10) / 10 : 0;
}

/** Метровый эквивалент чемодана — для подписей в интерфейсе. */
function boxEqM(b) {
  const p = effPipe(b), mb = metreBase(b);
  return mb > 0 && p > 0 ? r2(boxEqA(b) * mb / p) : 6;
}

/** Объём работ ветки в приведённых м². */
function unitsOf(b, withBoxes) {
  const u = effArea(b);
  return withBoxes ? u + boxEqA(b) * (+b.cases || 0) : u;
}

/** Нормо-часы ветки по позициям и всего. */
function branchHours(b) {
  const base = effArea(b) * groupOf(b).h;
  const ins = base * 30 / 100;
  const clad = base * 40 / 100 + BOX_HOURS * (+b.cases || 0);
  const rest = base * 30 / 100;      // материалы 5 + отделка 23 + приёмка 2
  return { ins: r2(ins), clad: r2(clad), rest: r2(rest), total: r2(ins + clad + rest) };
}

function lineHours(line) {
  let t = 0;
  for (const b of branches(line)) t += branchHours(b).total;
  return r2(t);
}

/* ---------- ветки ---------- */
function branches(line) {
  const bs = (line && line.branches) || [];
  if (bs.length) return bs;
  return [{
    id: 'main', label: 'main', dn: line && line.dn, pipe_od: line && line.pipe_od,
    dev: (line && line.dev) || 0, area_m2: (line && line.area_m2) || 0,
    straight_m: (line && line.straight_m) || 0, elbows: (line && line.elbows) || 0,
    cases: (line && line.cases) || 0,
  }];
}

/** Доли веток внутри линии — по нормо-часам. */
function branchWeights(line) {
  const bs = branches(line);
  const h = bs.map((b) => Math.max(0.01, branchHours(b).total));
  const sum = h.reduce((a, x) => a + x, 0) || 1;
  const out = {};
  bs.forEach((b, i) => { out[b.id] = h[i] / sum; });
  return out;
}

/* ---------- пустые отметки ---------- */
function emptyBranchChecks() {
  return {
    release: 0,
    materials: 0,
    insulation: { m: 0, el: [] },
    cladding: { m: 0, el: [], bx: [] },
    finishing: 0,
    inspection: { levels: [] },
  };
}

function emptyChecks(line) {
  const out = { v: MODEL_VERSION, branches: {} };
  for (const b of branches(line)) out.branches[b.id] = emptyBranchChecks();
  return out;
}

/* ---------- приведение к формату ---------- */
function sanitizeBranch(src, b) {
  const c = emptyBranchChecks();
  if (!src || typeof src !== 'object') return c;
  const maxM = metreBase(b);
  const maxE = +b.elbows || 0;
  const maxB = +b.cases || 0;

  c.release = Math.round(clamp(num(src.release), 0, 100) * 10) / 10;
  c.materials = Math.round(clamp(num(src.materials), 0, 100) * 10) / 10;
  c.finishing = Math.round(clamp(num(src.finishing), 0, 100) * 10) / 10;

  const qty = (s, withBoxes) => {
    const o = { m: 0, el: [], bx: [] };
    if (!s || typeof s !== 'object') return o;
    o.m = Math.round(clamp(num(s.m), 0, maxM) * 10) / 10;
    const el = Array.isArray(s.el) ? s.el : [];
    o.el = [...new Set(el.map((x) => Math.floor(num(x))).filter((x) => x >= 0 && x < maxE))].sort((a, z) => a - z);
    if (withBoxes) {
      const bx = Array.isArray(s.bx) ? s.bx : [];
      o.bx = [...new Set(bx.map((x) => String(x)).filter((x) => x))].slice(0, Math.max(0, maxB));
    } else delete o.bx;
    return o;
  };
  c.insulation = qty(src.insulation, false);
  c.cladding = qty(src.cladding, true);

  const lv = (src.inspection && Array.isArray(src.inspection.levels)) ? src.inspection.levels : [];
  c.inspection = { levels: INSP_LEVELS.filter((x) => lv.map(Number).includes(x)) };
  return c;
}

/** Приводит присланные отметки к текущей модели. */
function sanitize(input, line) {
  const out = emptyChecks(line);
  const src = (input && input.branches) || {};
  for (const b of branches(line)) out.branches[b.id] = sanitizeBranch(src[b.id], b);
  return out;
}

/* ---------- выдача под изоляцию (release) ---------- */
/** Сколько процентов ветки выдано заказчиком под изоляцию. В готовность не входит. */
function branchRelease(checks, branchId) {
  const c = (checks && checks.branches && checks.branches[branchId]) || null;
  return c ? clamp(num(c.release), 0, 100) : 0;
}

/** Выдача по линии: средневзвешенно по площади ветки. */
function lineRelease(line, checks) {
  const bs = branches(line);
  if (!bs.length) return 0;
  let w = bs.map((b) => +b.area_m2 || 0);
  if (w.reduce((a, x) => a + x, 0) <= 0) w = bs.map((b) => +b.length_m || 0);
  if (w.reduce((a, x) => a + x, 0) <= 0) w = bs.map(() => 1);
  const sum = w.reduce((a, x) => a + x, 0) || 1;
  let p = 0;
  bs.forEach((b, i) => { p += (w[i] / sum) * branchRelease(checks, b.id); });
  return Math.round(p * 10) / 10;
}

/* ---------- проценты ---------- */
function branchStagePercent(checks, branchId, stageKey, line) {
  const b = branches(line).find((x) => x.id === branchId)
         || { straight_m: 0, elbows: 0, cases: 0, area_m2: 0, dn: 0 };
  const c = (checks && checks.branches && checks.branches[branchId]) || emptyBranchChecks();

  if (stageKey === 'materials') return clamp(num(c.materials), 0, 100);
  if (stageKey === 'finishing') return clamp(num(c.finishing), 0, 100);
  if (stageKey === 'inspection') {
    const lv = (c.inspection && c.inspection.levels) || [];
    return lv.length ? Math.max(...lv) : 0;
  }
  const withBoxes = stageKey === 'cladding';
  const P = effPipe(b), E = effElbow(b);
  const nE = +b.elbows || 0, mb = metreBase(b);
  const total = P + E + (withBoxes ? boxEqA(b) * (+b.cases || 0) : 0);
  if (total <= 0) return 0;
  const s = c[stageKey] || {};
  let done = (mb > 0 ? clamp(num(s.m), 0, mb) / mb : 0) * P
           + (nE > 0 ? (s.el || []).length / nE : 0) * E;
  if (withBoxes) done += boxEqA(b) * ((s.bx || []).length);
  return clamp((done / total) * 100, 0, 100);
}

function branchPercent(checks, branchId, line) {
  let p = 0;
  for (const s of STAGES) p += s.weight * branchStagePercent(checks, branchId, s.key, line) / 100;
  return p;
}

/** Процент позиции по линии — средневзвешенно по долям веток. */
function stagePercent(line, checks, stageKey) {
  const w = branchWeights(line);
  let p = 0;
  for (const b of branches(line)) p += w[b.id] * branchStagePercent(checks, b.id, stageKey, line);
  return p;
}

function linePercent(line, checks) {
  const w = branchWeights(line);
  let p = 0;
  for (const b of branches(line)) p += w[b.id] * branchPercent(checks, b.id, line);
  return p;
}

/** Освоенные нормо-часы линии. */
function lineEarnedHours(line, checks) {
  let h = 0;
  for (const b of branches(line)) {
    const bh = branchHours(b);
    const per = { insulation: bh.ins, cladding: bh.clad };
    for (const s of STAGES) {
      const base = per[s.key] != null ? per[s.key] : bh.rest * (s.weight / (5 + 23 + 2));
      h += base * branchStagePercent(checks, b.id, s.key, line) / 100;
    }
  }
  return r2(h);
}

/** Нормо-часы «safety insulation» — материалы + вата (35% трудоёмкости). */
function lineSafetyHours(line) {
  let h = 0;
  for (const b of branches(line)) {
    const bh = branchHours(b);
    h += bh.ins + bh.rest * (5 / 30);
  }
  return r2(h);
}

function lineSafetyEarned(line, checks) {
  let h = 0;
  for (const b of branches(line)) {
    const bh = branchHours(b);
    h += bh.ins * branchStagePercent(checks, b.id, 'insulation', line) / 100
       + bh.rest * (5 / 30) * branchStagePercent(checks, b.id, 'materials', line) / 100;
  }
  return r2(h);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MODEL_VERSION, STAGES, INSP_LEVELS, QTY_STAGES, PCT_STAGES,
    ELBOW_EQ, FIT_K, BOX_HOURS, DN_GROUPS, dnK, odOf, groupOf,
    areasOf, effPipe, effElbow, effArea, boxEqA, boxEqM, unitsOf, metreBase,
    branches, branchWeights, branchHours, lineHours, lineEarnedHours,
    lineSafetyHours, lineSafetyEarned,
    emptyChecks, emptyBranchChecks, sanitize,
    branchStagePercent, branchPercent, stagePercent, linePercent,
    branchRelease, lineRelease,
  };
}
