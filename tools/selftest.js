/* Проверка расчётов: сверка с регистром и модель готовности. */
const M = require('../model');
const seed = require('../data/seed.json');
let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FAIL ') + m); if (!c) fail++; };
const near = (a, b, e) => Math.abs(a - b) <= (e || 0.5);

console.log('\n1. Сверка с регистром v64');
ok(seed.lines.length === 89, `линий: ${seed.lines.length} (ожидается 89)`);
const tm = seed.lines.reduce((s, l) => s + l.length_m, 0);
const ta = seed.lines.reduce((s, l) => s + l.area_m2, 0);
ok(near(tm, 832.1, 1), `длина: ${tm.toFixed(1)} м (регистр 832,1)`);
ok(near(ta, 713.0, 1), `площадь: ${ta.toFixed(1)} м² (регистр 713)`);
ok(seed.lines.reduce((s, l) => s + l.elbows, 0) === 499, `отводов: ${seed.lines.reduce((s, l) => s + l.elbows, 0)} (регистр 499)`);
ok(near(seed.lines.reduce((s, l) => s + l.straight_m, 0), 725, 1), `прямых: ${seed.lines.reduce((s, l) => s + l.straight_m, 0).toFixed(1)} м (регистр 725)`);

console.log('\n2. Модель готовности (веса 1/1/40/40/15/3)');
ok(M.STAGES.reduce((a, s) => a + s.weight, 0) === 100,
   'сумма весов позиций = ' + M.STAGES.reduce((a, s) => a + s.weight, 0));
ok(M.STAGES.map((s) => s.key).join(',') === 'release,materials,insulation,cladding,finishing,inspection',
   'шесть позиций в правильном порядке');

const L = seed.lines.find((x) => x.id === '50157');
let c = M.emptyChecks(L);
ok(M.linePercent(L, c) === 0, 'пустая линия = 0%');

const fillAll = (checks, fn) => { for (const b of L.branches) fn(checks.branches[b.id]); return checks; };

c = fillAll(M.emptyChecks(L), (t) => { t.release.done = true; });
ok(near(M.linePercent(L, c), 1, 0.01), `только Release = ${M.linePercent(L, c).toFixed(2)}% (ожидается 1)`);

c = fillAll(M.emptyChecks(L), (t) => {
  t.release.done = true; t.inspection.levels = [50, 100];
  for (const k of M.LEVEL_STAGES) t[k] = [5, 25, 75, 100];
});
ok(near(M.linePercent(L, c), 100, 0.01), `всё отмечено = ${M.linePercent(L, c).toFixed(2)}% (ожидается 100)`);

c = fillAll(M.emptyChecks(L), (t) => { t.insulation = [5, 25, 75, 100]; });
ok(near(M.linePercent(L, c), 40, 0.01), `только Insulation = ${M.linePercent(L, c).toFixed(2)}% (ожидается 40)`);

c = fillAll(M.emptyChecks(L), (t) => { t.cladding = [5, 25, 75, 100]; });
ok(near(M.linePercent(L, c), 40, 0.01), `только Cladding = ${M.linePercent(L, c).toFixed(2)}% (ожидается 40)`);

c = fillAll(M.emptyChecks(L), (t) => { t.finishing = [5, 25, 75, 100]; });
ok(near(M.linePercent(L, c), 15, 0.01), `только Finishing = ${M.linePercent(L, c).toFixed(2)}% (ожидается 15)`);

c = fillAll(M.emptyChecks(L), (t) => { t.inspection.levels = [50]; });
ok(near(M.linePercent(L, c), 1.5, 0.01), `Inspection 50% = ${M.linePercent(L, c).toFixed(2)}% (ожидается 1,5)`);

console.log('\n3. Ветки линий (отдельная форма на каждый типоразмер)');
const totalBranches = seed.lines.reduce((a, l) => a + l.branches.length, 0);
const multi = seed.lines.filter((l) => l.branches.length > 1).length;
ok(seed.lines.every((l) => l.branches.length >= 1), `у всех линий есть ветки (всего ${totalBranches}, из них линий с несколькими: ${multi})`);
ok(seed.lines.every((l) => l.branches.every((b) => b.work > 0)),
   'у каждой ветки ненулевой вес — её отметки влияют на процент');
const areaOk = Math.abs(seed.lines.reduce((a, l) => a + l.branches.reduce((x, b) => x + b.area_m2, 0), 0)
                        - seed.lines.reduce((a, l) => a + l.area_m2, 0)) < 1;
ok(areaOk, 'сумма м² по веткам совпадает с суммой по линиям');
let wOk = true;
for (const l of seed.lines) {
  const w = M.branchWeights(l);
  if (!near(Object.values(w).reduce((a, b) => a + b, 0), 1, 1e-9)) wOk = false;
}
ok(wOk, 'доли веток внутри каждой линии дают в сумме 100%');

// одна ветка отмечена полностью — линия растёт ровно на её долю
const L2 = seed.lines.find((x) => x.branches.length > 1);
c = M.emptyChecks(L2);
const b0 = L2.branches[0];
Object.assign(c.branches[b0.id], { release: { done: true }, inspection: { levels: [50, 100] } });
for (const k of M.LEVEL_STAGES) c.branches[b0.id][k] = [5, 25, 75, 100];
const expect = M.branchWeights(L2)[b0.id] * 100;
ok(near(M.linePercent(L2, c), expect, 0.01),
   `${L2.short}: ветка ${b0.label} на 100% даёт ${M.linePercent(L2, c).toFixed(1)}% линии (доля ветки ${expect.toFixed(1)}%)`);

console.log('\n3b. Перенос отметок из старого формата (до веток)');
const legacy = M.sanitize({ release: { done: true }, inspection: { levels: [50] },
  materials: { pipe: [5, 25, 75] }, insulation: { pipe: [5, 25, 75, 100] },
  cladding: { pipe: [5], fin: [5, 25, 75] } }, L);
ok(M.branchStagePercent(legacy, L.branches[0].id, 'insulation') === 100, 'старая Insulation перенесена');
ok(M.branchStagePercent(legacy, L.branches[0].id, 'finishing') === 75, 'старая подпозиция «отделка» стала позицией Finishing');

console.log('\n4. Данные линий');
ok(seed.lines.every((l) => l.main && l.main.dev > 0), 'у каждой линии есть развёртка металла');
ok(seed.lines.every((l) => l.short && l.name), 'у каждой линии есть короткое и полное имя');
const noConn = seed.lines.filter((l) => !l.connect.length).length;
console.log(`  инфо  линий без указанных связей: ${noConn}`);
const kot = seed.lines.filter((l) => l.valves_kot > 0).length;
console.log(`  инфо  линий с чемоданами из KOTELOT: ${kot}, всего чемоданов: ${seed.lines.reduce((s, l) => s + l.cases, 0)}`);

console.log('\n5. QR-код для подключения телефона');
try {
  const QR = require('../qr');
  const crypto = require('crypto');
  const m = QR.encode('http://192.168.1.25:8080');
  const h = crypto.createHash('sha1').update(JSON.stringify(m)).digest('hex');
  ok(m.length === 29, `матрица QR построена (${m.length}×${m.length})`);
  ok(h === 'c2015b61e36d24856060eb5380ff85ff86b3f954',
     'эталонный QR совпадает с проверенным образцом (декодируется сканером)');
  const s2 = QR.svg('http://10.0.0.7:8080', 5);
  ok(s2.startsWith('<svg') && s2.includes('</svg>'), 'SVG-картинка генерируется');
} catch (e) {
  ok(false, 'ошибка генератора QR: ' + e.message);
}

console.log('\n6. Хранилище');
try {
  const { createDrive } = require('../drive');
  ok(typeof createDrive === 'function', 'модуль Google Drive загружается');
  console.log('  инфо  проверить связь с Drive: node tools/test-drive.js (или --mock без Google)');
} catch (e) { ok(false, 'модуль Drive: ' + e.message); }

console.log(fail ? `\nПРОВАЛЕНО ПРОВЕРОК: ${fail}\n` : '\nВсе проверки пройдены.\n');
process.exit(fail ? 1 : 0);
