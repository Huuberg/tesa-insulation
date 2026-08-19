'use strict';
/* Модель готовности Tervasaari PM5.
   Готовность отмечается ОТДЕЛЬНО ПО КАЖДОЙ ВЕТКЕ линии (свой типоразмер трубы).
   Готовность линии = средневзвешенная по объёму работ веток. */

const STAGES = [
  { key: 'release',    title: 'Release',    weight: 1,  kind: 'single',
    ru: 'Выдача под изоляцию', en: 'released for insulation', et: 'väljastatud isoleerimiseks' },
  { key: 'materials',  title: 'Materials',  weight: 1,  kind: 'levels',
    ru: 'Материалы на месте',  en: 'materials on site',       et: 'materjalid kohal' },
  { key: 'insulation', title: 'Insulation', weight: 40, kind: 'levels',
    ru: 'Изоляция (вата)',     en: 'mineral wool',            et: 'isolatsioon (vill)' },
  { key: 'cladding',   title: 'Cladding',   weight: 40, kind: 'levels',
    ru: 'Металлопокрытие',     en: 'metal cladding',          et: 'plekikate' },
  { key: 'finishing',  title: 'Finishing',  weight: 15, kind: 'levels',
    ru: 'Отделка',             en: 'finishing',               et: 'viimistlus' },
  { key: 'inspection', title: 'Inspection', weight: 3,  kind: 'insp',
    ru: 'Приёмка',             en: 'inspection',              et: 'vastuvõtt' },
];

const LEVEL_STAGES = STAGES.filter((s) => s.kind === 'levels').map((s) => s.key);
const LEVELS = [5, 25, 75, 100];       // чек-боксы позиций
const INSP_LEVELS = [50, 100];         // чек-боксы приёмки

function branches(line) {
  const b = (line && line.branches) || [];
  return b.length ? b : [{ id: 'all', label: '—', work: 1 }];
}

/** Доли веток в готовности линии — по расчётному объёму работ. */
function branchWeights(line) {
  const bs = branches(line);
  let sum = 0;
  for (const b of bs) sum += Math.max(0, b.work || 0);
  const w = {};
  if (sum <= 0) { for (const b of bs) w[b.id] = 1 / bs.length; return w; }
  for (const b of bs) w[b.id] = Math.max(0, b.work || 0) / sum;
  return w;
}

function emptyBranchChecks() {
  const c = { release: { done: false }, inspection: { levels: [] } };
  for (const k of LEVEL_STAGES) c[k] = [];
  return c;
}

function emptyChecks(line) {
  const c = { branches: {} };
  for (const b of branches(line)) c.branches[b.id] = emptyBranchChecks();
  return c;
}

/** Старый формат (до веток): позиции на всю линию с подпозициями отводы/прямой/отделка/чемоданы. */
function migrateLegacy(input, line) {
  const c = emptyChecks(line);
  const pick = (v) => (Array.isArray(v) ? LEVELS.filter((lv) => v.includes(lv)) : []);
  const base = {
    release: !!(input.release && input.release.done),
    materials: pick(input.materials && input.materials.pipe),
    insulation: pick(input.insulation && input.insulation.pipe),
    cladding: pick(input.cladding && input.cladding.pipe),
    // «отделка» была подпозицией — теперь это отдельная позиция Finishing
    finishing: pick((input.cladding && input.cladding.fin) || (input.insulation && input.insulation.fin)),
    inspection: INSP_LEVELS.filter((lv) =>
      Array.isArray(input.inspection && input.inspection.levels) && input.inspection.levels.includes(lv)),
  };
  for (const id of Object.keys(c.branches)) {
    const t = c.branches[id];
    t.release.done = base.release;
    t.inspection.levels = base.inspection.slice();
    for (const k of LEVEL_STAGES) t[k] = (base[k] || []).slice();
  }
  return c;
}

/** Нормализация присланного клиентом объекта (защита от мусора и старого формата). */
function sanitize(input, line) {
  if (input && !input.branches && (input.release || input.insulation || input.cladding))
    return migrateLegacy(input, line);
  const c = emptyChecks(line);
  const src = (input && input.branches) || {};
  for (const id of Object.keys(c.branches)) {
    const s = src[id] || {};
    const t = c.branches[id];
    t.release.done = !!(s.release && s.release.done);
    const il = (s.inspection && s.inspection.levels) || [];
    t.inspection.levels = INSP_LEVELS.filter((lv) => Array.isArray(il) && il.includes(lv));
    for (const k of LEVEL_STAGES) {
      const arr = Array.isArray(s[k]) ? s[k] : [];
      t[k] = LEVELS.filter((lv) => arr.includes(lv));
    }
  }
  return c;
}

/** % позиции внутри одной ветки. */
function branchStagePercent(checks, branchId, stage) {
  const st = STAGES.find((s) => s.key === stage);
  if (!st) return 0;
  const bc = (checks && checks.branches && checks.branches[branchId]) || null;
  if (!bc) return 0;
  if (st.kind === 'single') return bc.release && bc.release.done ? 100 : 0;
  if (st.kind === 'insp') {
    const arr = (bc.inspection && bc.inspection.levels) || [];
    let p = 0;
    for (const lv of INSP_LEVELS) if (arr.includes(lv)) p = Math.max(p, lv);
    return p;
  }
  const arr = bc[stage] || [];
  let p = 0;
  for (const lv of LEVELS) if (arr.includes(lv)) p = Math.max(p, lv);
  return p;
}

/** Общая готовность одной ветки, %. */
function branchPercent(checks, branchId) {
  let t = 0;
  for (const s of STAGES) t += (s.weight / 100) * branchStagePercent(checks, branchId, s.key);
  return t;
}

/** % позиции по всей линии — взвешенно по веткам. */
function stagePercent(line, checks, stage) {
  const w = branchWeights(line);
  let p = 0;
  for (const b of branches(line)) p += w[b.id] * branchStagePercent(checks, b.id, stage);
  return p;
}

/** Готовность линии, % (веса 1/1/40/40/15/3). */
function linePercent(line, checks) {
  const w = branchWeights(line);
  let p = 0;
  for (const b of branches(line)) p += w[b.id] * branchPercent(checks, b.id);
  return p;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STAGES, LEVELS, INSP_LEVELS, LEVEL_STAGES,
    branches, branchWeights, emptyChecks, emptyBranchChecks, sanitize,
    branchStagePercent, branchPercent, stagePercent, linePercent, migrateLegacy,
  };
}
