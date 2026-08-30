'use strict';
/* Модель готовности Tervasaari PM5 — версия 2 (учёт по объёмам работ).

   Готовность отмечается ОТДЕЛЬНО ПО КАЖДОЙ ВЕТКЕ линии (свой типоразмер трубы).

   Позиции и веса:
     1. Материалы на месте   —  5%  — ручной ввод %
     2. Изоляция (вата)      — 30%  — метры (ввод) + отводы (чек-боксы)
     3. Металлопокрытие      — 40%  — метры + отводы + чемоданы (чек-боксы)
     4. Отделка              — 23%  — ручной ввод %
     5. Приёмка              —  2%  — 50 / 100

   Внутри позиции работа считается не «на глаз», а по трудоёмкости:
     — отвод приравнен к 1,5 м прямой трубы;
     — чемодан = 1,5 часа, переведённые в метровый эквивалент этой ветки;
     — на тонких трубах производительность ниже: коэффициент по DN.

   Нормо-часы откалиброваны так, чтобы весь проект давал бюджет 1249 ч. */

const MODEL_VERSION = 2;

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
    ru: 'Приёмка',             en: 'inspection',        et: 'vastuvõtt' },
];

const INSP_LEVELS = [50, 100];
const QTY_STAGES = ['insulation', 'cladding'];
const PCT_STAGES = ['materials', 'finishing'];

/* ---------- нормы трудоёмкости ---------- */
const ELBOW_EQ = 1.5;    // отвод = 1,5 м прямой трубы
const BOX_HOURS = 1.5;   // один чемодан
const HPM_INS = 0.25069;  // ч на 1 м² приведённой площади — вата
const HPM_CLAD = 0.24995; // то же для металла (чемоданы считаются отдельно)

/** Коэффициент производительности: на тонких трубах м² даются медленнее. */
function dnK(dn) {
  const d = +dn || 0;
  if (d <= 50) return 1.8;
  if (d <= 150) return 1.25;
  return 1.0;
}

const devM = (b) => (+b.dev || 0) / 1000;

/** База метров ветки: прямая труба, а если её нет — вся длина ветки (только арматура). */
function metreBase(b) {
  const st = +b.straight_m || 0;
  if (st > 0) return st;
  const len = +b.length_m || 0;
  return len > 0 ? Math.round(len * 10) / 10 : 0;
}

/** Метровый эквивалент одного чемодана на этой ветке. */
function boxEqM(b) {
  const base = devM(b) * dnK(b.dn) * HPM_CLAD;
  return base > 0 ? BOX_HOURS / base : 6;
}

/** Объём работ ветки в «метрах трубы»: прямые + отводы (+ чемоданы для металла). */
function unitsOf(b, withBoxes) {
  const u = metreBase(b) + ELBOW_EQ * (+b.elbows || 0);
  return withBoxes ? u + boxEqM(b) * (+b.cases || 0) : u;
}

/** Нормо-часы ветки по позициям и всего. */
function branchHours(b) {
  const q = devM(b) * dnK(b.dn);
  const ins = unitsOf(b, false) * q * HPM_INS;
  const clad = unitsOf(b, false) * q * HPM_CLAD + BOX_HOURS * (+b.cases || 0);
  const rest = (ins + clad) * (5 + 23 + 2) / (30 + 40);
  return { ins: r2(ins), clad: r2(clad), rest: r2(rest), total: r2(ins + clad + rest) };
}

function lineHours(line) {
  let t = 0;
  for (const b of branches(line)) t += branchHours(b).total;
  return r2(t);
}

const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (v) => { const n = +v; return isFinite(n) ? n : 0; };

/* ---------- ветки ---------- */
function branches(line) {
  const bs = (line && line.branches) || [];
  if (bs.length) return bs;
  return [{
    id: 'main', label: 'main', dn: line && line.dn, dev: (line && line.dev) || 0,
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

/** Приводит присланные отметки к текущей модели. Старый формат (v1) не переносится. */
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

/** Выдача по линии: средневзвешенно по площади ветки (при нуле — по метрам, иначе поровну). */
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
         || { straight_m: 0, elbows: 0, cases: 0, dev: 0, dn: 0 };
  const c = (checks && checks.branches && checks.branches[branchId]) || emptyBranchChecks();

  if (stageKey === 'materials') return clamp(num(c.materials), 0, 100);
  if (stageKey === 'finishing') return clamp(num(c.finishing), 0, 100);
  if (stageKey === 'inspection') {
    const lv = (c.inspection && c.inspection.levels) || [];
    return lv.length ? Math.max(...lv) : 0;
  }
  const withBoxes = stageKey === 'cladding';
  const total = unitsOf(b, withBoxes);
  if (total <= 0) return 0;
  const s = c[stageKey] || {};
  let done = clamp(num(s.m), 0, metreBase(b)) + ELBOW_EQ * ((s.el || []).length);
  if (withBoxes) done += boxEqM(b) * ((s.bx || []).length);
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

/** Освоенные нормо-часы линии (для отчёта и прогноза). */
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MODEL_VERSION, STAGES, INSP_LEVELS, QTY_STAGES, PCT_STAGES,
    ELBOW_EQ, BOX_HOURS, HPM_INS, HPM_CLAD, dnK, boxEqM, unitsOf, metreBase,
    branches, branchWeights, branchHours, lineHours, lineEarnedHours,
    emptyChecks, emptyBranchChecks, sanitize,
    branchStagePercent, branchPercent, stagePercent, linePercent,
    branchRelease, lineRelease,
  };
}
