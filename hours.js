'use strict';
/* Табель: план часов, график работы, расчёт остатка и темпа.
   Модуль общий для сервера и браузера (как model.js). */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HOURS = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* график: индекс = день недели (0 — воскресенье) */
  const DEFAULT_PLAN = {
    start: '2026-08-21',
    deadline: '2026-09-30',
    budget: 1249,
    schedule: [0, 10, 10, 10, 10, 10, 6], // вс, пн, вт, ср, чт, пт, сб
  };

  const DEFAULT_CREW = [
    'W.1', 'W.2', 'W.3', 'W.4', 'W.5', 'W.6', 'W.7', 'W.8', 'W.9', 'W.10', 'W.11',
    'SUP.1', 'SUP.2',
  ];

  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const addDays = (s, n) => { const d = parse(s); if (!d) return null; d.setDate(d.getDate() + n); return iso(d); };
  const today = () => iso(new Date());

  /** Плановые часы одного человека за этот день (0 — выходной). */
  function dayPlan(dateStr, schedule) {
    const d = parse(dateStr);
    if (!d) return 0;
    const s = Array.isArray(schedule) && schedule.length === 7 ? schedule : DEFAULT_PLAN.schedule;
    return +s[d.getDay()] || 0;
  }

  /** Список дат от from до to включительно. */
  function range(from, to) {
    const out = [];
    let cur = from;
    const stop = parse(to);
    if (!parse(from) || !stop) return out;
    let guard = 0;
    while (parse(cur) <= stop && guard++ < 2000) { out.push(cur); cur = addDays(cur, 1); }
    return out;
  }

  function normPlan(p) {
    const x = Object.assign({}, DEFAULT_PLAN, p || {});
    x.budget = Math.max(0, +x.budget || 0);
    if (!Array.isArray(x.schedule) || x.schedule.length !== 7) x.schedule = DEFAULT_PLAN.schedule.slice();
    x.schedule = x.schedule.map((h) => Math.max(0, Math.min(24, +h || 0)));
    if (!parse(x.start)) x.start = DEFAULT_PLAN.start;
    if (!parse(x.deadline)) x.deadline = DEFAULT_PLAN.deadline;
    return x;
  }

  function normCrew(c) {
    const list = Array.isArray(c) && c.length ? c : DEFAULT_CREW;
    const out = [];
    for (const n of list) {
      const s = String(n || '').trim().slice(0, 24);
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= 60) break;
    }
    return out.length ? out : DEFAULT_CREW.slice();
  }

  /** Чистит {дата: {имя: часы}}: только числа 0..24, пустые дни выбрасываются. */
  function normHours(h) {
    const out = {};
    for (const date of Object.keys(h || {})) {
      if (!parse(date)) continue;
      const day = {};
      const src = h[date] || {};
      for (const who of Object.keys(src)) {
        const v = Math.round((+src[who] || 0) * 10) / 10;
        if (v > 0) day[String(who).slice(0, 24)] = Math.min(24, v);
      }
      if (Object.keys(day).length) out[date] = day;
    }
    return out;
  }

  const daySum = (day) => Object.keys(day || {}).reduce((a, k) => a + (+day[k] || 0), 0);

  /* ---------- план бригады (Manpower Plan) ---------- */
  /** {дата: [изоляторы, прочие]} → чистит и отбрасывает мусор. */
  function normManpower(m) {
    const out = {};
    for (const date of Object.keys(m || {})) {
      if (!parse(date)) continue;
      const v = m[date];
      const a = Array.isArray(v) ? v : [v, 0];
      const ins = Math.max(0, Math.min(99, Math.round(+a[0] || 0)));
      const oth = Math.max(0, Math.min(99, Math.round(+a[1] || 0)));
      if (ins || oth) out[date] = [ins, oth];
    }
    return out;
  }

  /** Ёмкость бригады по дням: сколько человеко-часов изоляторов доступно. */
  function capacityDays(manpower, plan, from, to) {
    const mp = normManpower(manpower);
    const out = [];
    for (const d of range(from, to)) {
      const m = mp[d];
      const ph = dayPlan(d, plan.schedule);
      const ins = m ? m[0] : 0;
      const oth = m ? m[1] : 0;
      out.push({ d, ins, oth, h: Math.round(ins * ph * 10) / 10, hAll: Math.round((ins + oth) * ph * 10) / 10 });
    }
    return out;
  }

  /**
   * Успеваем ли: посуточно сводит ёмкость бригады с фронтом, который открывает выдача.
   * o = { plan, manpower, items: [{ d: 'ГГГГ-ММ-ДД'|null, h }], today }
   *   items — ОСТАВШИЕСЯ нормо-часы; d — когда работа станет доступна (null — даты нет).
   */
  function feasibility(o) {
    const plan = normPlan(o.plan);
    const now = o.today || today();
    const from = parse(now) < parse(plan.start) ? plan.start : now;
    const to = parse(plan.deadline) > parse(from) ? plan.deadline : from;
    const items = Array.isArray(o.items) ? o.items : [];

    const unlockOn = {};
    let scheduled = 0, unscheduled = 0;
    for (const it of items) {
      const h = Math.max(0, +it.h || 0);
      if (!h) continue;
      if (!it.d || !parse(it.d)) { unscheduled += h; continue; }
      const d = parse(it.d) < parse(from) ? from : it.d;
      unlockOn[d] = (unlockOn[d] || 0) + h;
      scheduled += h;
    }

    const caps = capacityDays(o.manpower, plan, from, to);
    let backlog = 0, done = 0, idle = 0, capTotal = 0, capAll = 0;
    let finish = null, firstIdle = null;
    const days = [];
    for (const c of caps) {
      backlog += unlockOn[c.d] || 0;
      const work = Math.min(backlog, c.h);
      backlog -= work; done += work; capTotal += c.h; capAll += c.hAll;
      const free = Math.round((c.h - work) * 10) / 10;
      if (free > 0 && c.h > 0 && !firstIdle) firstIdle = c.d;
      idle += free;
      if (!finish && backlog <= 0.05 && done >= scheduled - 0.05 && scheduled > 0) finish = c.d;
      days.push({ d: c.d, cap: c.h, ins: c.ins, unlock: Math.round((unlockOn[c.d] || 0) * 10) / 10,
        done: Math.round(work * 10) / 10, idle: free, backlog: Math.round(backlog * 10) / 10 });
    }

    const left = Math.round(backlog * 10) / 10;
    const r1 = (x) => Math.round(x * 10) / 10;
    let verdict = 'ok';
    if (unscheduled > 0.5) verdict = 'unknown';
    if (left > 0.5) verdict = 'late';
    else if (finish && parse(finish) >= parse(plan.deadline) && capTotal - done < capTotal * 0.08) verdict = 'tight';

    return {
      from, to, deadline: plan.deadline,
      capTotal: r1(capTotal), capAll: r1(capAll),
      work: r1(scheduled), unscheduled: r1(unscheduled), total: r1(scheduled + unscheduled),
      done: r1(done), left, idle: r1(idle), firstIdle,
      finish, verdict, days,
      spare: r1(capTotal - scheduled),
      needAfter: r1(left + unscheduled),
    };
  }


  function totals(hours) {
    const byDay = {}, byPerson = {};
    let spent = 0, first = null, last = null;
    for (const date of Object.keys(hours || {}).sort()) {
      const s = daySum(hours[date]);
      byDay[date] = s;
      spent += s;
      if (s > 0) { if (!first) first = date; last = date; }
      for (const who of Object.keys(hours[date])) byPerson[who] = (byPerson[who] || 0) + (+hours[date][who] || 0);
    }
    return { spent: Math.round(spent * 10) / 10, byDay, byPerson, first, last };
  }

  /**
   * Полная сводка по часам.
   * @param {object} o { plan, crew, hours, progress } progress — готовность проекта в % (по м²)
   */
  function summary(o) {
    const plan = normPlan(o.plan);
    const hours = normHours(o.hours);
    const t = totals(hours);
    const now = o.today || today();

    const spent = t.spent;
    const remaining = Math.round((plan.budget - spent) * 10) / 10;
    const usedPct = plan.budget ? (spent / plan.budget) * 100 : 0;

    // сколько осталось календарных и рабочих дней, и часов по графику на одного человека
    const from = parse(now) > parse(plan.deadline) ? plan.deadline : now;
    const days = range(from, plan.deadline);
    let workdays = 0, perPerson = 0;
    for (const d of days) { const h = dayPlan(d, plan.schedule); if (h > 0) { workdays++; perPerson += h; } }
    const daysLeft = Math.max(0, days.length - (parse(now) > parse(plan.deadline) ? 1 : 0));
    const overdue = parse(now) > parse(plan.deadline);

    // сколько человек можно держать на объекте, чтобы уложиться в бюджет
    const crewAffordable = perPerson > 0 ? remaining / perPerson : 0;

    // темп: среднее по последним 7 дням с записями
    const worked = Object.keys(t.byDay).filter((d) => t.byDay[d] > 0).sort();
    const lastN = worked.slice(-7);
    const pace = lastN.length ? lastN.reduce((a, d) => a + t.byDay[d], 0) / lastN.length : 0;
    const crewNow = pace && lastN.length ? pace / (dayPlan(lastN[lastN.length - 1], plan.schedule) || 10) : 0;

    // прогноз: сколько уйдёт до дедлайна, если темп сохранится
    const forecast = Math.round((spent + pace * workdays) * 10) / 10;
    const gap = Math.round((plan.budget - forecast) * 10) / 10;

    // темп последнего рабочего дня — сколько людей реально стоит сейчас
    const lastDay = worked.length ? worked[worked.length - 1] : null;
    const lastDayHours = lastDay ? t.byDay[lastDay] : 0;
    const lastPlan = lastDay ? (dayPlan(lastDay, plan.schedule) || 10) : 10;
    const crewLast = lastDayHours ? Math.round((lastDayHours / lastPlan) * 10) / 10 : 0;
    // при таком же составе бригады: на сколько рабочих дней хватит остатка
    let daysAtLast = null, runsOutAtLast = null;
    if (lastDayHours > 0) {
      let left = remaining, d = now, guard = 0, cnt = 0;
      while (left > 0 && guard++ < 400) {
        const ph = dayPlan(d, plan.schedule);
        if (ph > 0) { left -= crewLast * ph; cnt++; if (left <= 0) { runsOutAtLast = d; break; } }
        d = addDays(d, 1);
      }
      daysAtLast = cnt;
    }

    // на сколько рабочих дней хватит остатка при текущем темпе
    let daysOfBudget = null, runsOut = null;
    if (pace > 0) {
      let left = remaining, d = now, guard = 0, cnt = 0;
      while (left > 0 && guard++ < 400) {
        if (dayPlan(d, plan.schedule) > 0) { left -= pace; cnt++; if (left <= 0) { runsOut = d; break; } }
        d = addDays(d, 1);
      }
      daysOfBudget = cnt;
    }

    // прогноз финиша по темпу готовности
    const progress0 = o.progress == null ? null : +o.progress;
    let hoursPerPct = null, hoursToFinish = null, totalNeeded = null, budgetAtFinish = null;
    let finishDate = null, lateDays = null, dailyRate = null;
    if (progress0 != null && progress0 > 0 && spent > 0) {
      hoursPerPct = spent / progress0;
      hoursToFinish = hoursPerPct * Math.max(0, 100 - progress0);
      totalNeeded = spent + hoursToFinish;
      budgetAtFinish = plan.budget - totalNeeded;
      const people = crewLast > 0 ? crewLast : (pace > 0 ? pace / 10 : 0);
      dailyRate = people;
      if (people > 0) {
        let need = hoursToFinish, d = now, guard = 0;
        while (need > 0 && guard++ < 900) {
          const ph = dayPlan(d, plan.schedule);
          if (ph > 0) { need -= people * ph; if (need <= 0) { finishDate = d; break; } }
          d = addDays(d, 1);
        }
        if (finishDate) lateDays = Math.round((parse(finishDate) - parse(plan.deadline)) / 86400000);
      }
    }

    // освоение: готовность в % против потраченных часов в %
    const progress = o.progress == null ? null : +o.progress;
    const efficiency = (progress != null && usedPct > 0) ? progress / usedPct : null;

    return {
      plan, spent, remaining, budget: plan.budget,
      usedPct: Math.round(usedPct * 10) / 10,
      remainingPct: Math.round((100 - usedPct) * 10) / 10,
      hoursPerPct: hoursPerPct == null ? null : Math.round(hoursPerPct * 10) / 10,
      hoursToFinish: hoursToFinish == null ? null : Math.round(hoursToFinish),
      totalNeeded: totalNeeded == null ? null : Math.round(totalNeeded),
      budgetAtFinish: budgetAtFinish == null ? null : Math.round(budgetAtFinish),
      finishDate, lateDays, dailyCrew: dailyRate == null ? null : Math.round(dailyRate * 10) / 10,
      today: now, overdue,
      daysLeft, workdaysLeft: workdays, hoursPerPersonLeft: Math.round(perPerson * 10) / 10,
      crewAffordable: Math.round(crewAffordable * 10) / 10,
      pace: Math.round(pace * 10) / 10,
      crewNow: Math.round(crewNow * 10) / 10,
      forecast, gap,
      daysOfBudget, runsOut,
      lastDay, lastDayHours: Math.round(lastDayHours * 10) / 10, crewLast, daysAtLast, runsOutAtLast,
      first: t.first, last: t.last,
      byDay: t.byDay, byPerson: t.byPerson,
      progress, efficiency: efficiency == null ? null : Math.round(efficiency * 100) / 100,
    };
  }

  return {
    DEFAULT_PLAN, DEFAULT_CREW, normManpower, capacityDays, feasibility,
    iso, parse, addDays, today, dayPlan, range,
    normPlan, normCrew, normHours, totals, summary, daySum,
  };
});
