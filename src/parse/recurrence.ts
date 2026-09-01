import type { Recurrence } from "../core/types.js";
import { DEFAULT_CONFIG } from "../core/config.js";

export interface ParsedRecurrence {
  recurrence: Recurrence;
  label: string;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6,
};
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const ORDINALS: Record<string, Recurrence["bySetPos"]> = {
  first: "first", "1st": "first", second: "second", "2nd": "second", third: "third", "3rd": "third",
  fourth: "fourth", "4th": "fourth", last: "last",
};
const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, other: 2,
};

interface TimeOfDay { hour: number; minute: number; text: string }

/** Pull an explicit time-of-day out of the phrase; returns remaining text. */
function extractTime(s: string, morningHour: number): { time: TimeOfDay | null; rest: string } {
  const cfg = DEFAULT_CONFIG;
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => TimeOfDay]> = [
    [/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/, (m) => {
      let h = Number(m[1]); const min = Number(m[2] ?? 0);
      const pm = m[3].startsWith("p");
      if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0;
      return { hour: h, minute: min, text: m[0] };
    }],
    [/\bat\s+(\d{1,2}):(\d{2})\b/, (m) => {
      let h = Number(m[1]); const min = Number(m[2]);
      if (h >= 1 && h <= 6) h += 12;
      return { hour: h, minute: min, text: m[0] };
    }],
    [/\bat\s+(\d{1,2})\b/, (m) => {
      let h = Number(m[1]);
      if (h >= 1 && h <= 6) h += 12;
      return { hour: h, minute: 0, text: m[0] };
    }],
    [/\b(\d{1,2}):(\d{2})\b/, (m) => {
      let h = Number(m[1]); const min = Number(m[2]);
      if (h >= 1 && h <= 6) h += 12;
      return { hour: h, minute: min, text: m[0] };
    }],
    [/\b(?:at\s+)?noon\b/, (m) => ({ hour: 12, minute: 0, text: m[0] })],
    [/\b(?:at\s+)?midnight\b/, (m) => ({ hour: 0, minute: 0, text: m[0] })],
    [/\b(?:in\s+the\s+)?morning\b/, (m) => ({ hour: morningHour, minute: 0, text: m[0] })],
    [/\b(?:in\s+the\s+)?afternoon\b/, (m) => ({ hour: cfg.afternoonHour, minute: 0, text: m[0] })],
    [/\b(?:in\s+the\s+)?evening\b/, (m) => ({ hour: cfg.eveningHour, minute: 0, text: m[0] })],
    [/\b(?:at\s+)?(?:eod|end of day)\b/, (m) => ({ hour: 17, minute: 0, text: m[0] })],
  ];
  for (const [re, fn] of patterns) {
    const m = s.match(re);
    if (m) {
      const time = fn(m);
      const rest = (s.slice(0, m.index) + " " + s.slice((m.index ?? 0) + m[0].length)).replace(/\s+/g, " ").trim();
      return { time, rest };
    }
  }
  return { time: null, rest: s };
}

function fmtTime(h: number, m: number): string {
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function numberWord(w: string): number | null {
  if (/^\d+$/.test(w)) return Number(w);
  return WORD_NUM[w] ?? null;
}

/**
 * Parse recurrence phrases:
 *   every day · daily · every weekday · weekdays · every monday 9am · mondays and thursdays at 8
 *   every 2 weeks on friday · weekly · monthly · every month on the 15th · on the 1st of every month
 *   first business day of every month · last business day · first monday of the month · second tuesday
 *   every year on september 15 · yearly · every 30 minutes · hourly · every 2 hours
 */
export function parseEvery(input: string, opts: { morningHour?: number; now?: Date } = {}): ParsedRecurrence | null {
  const morningHour = opts.morningHour ?? DEFAULT_CONFIG.morningHour;
  const now = opts.now ?? new Date();
  let s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  s = s.replace(/^(repeat|repeating|recurring|recur)\s+/, "");
  s = s.replace(/\b(the|each|of|on|and|&)\b/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^every\s+/, "every ");

  const { time, rest } = extractTime(s, morningHour);
  const hour = time?.hour ?? morningHour;
  const minute = time?.minute ?? 0;
  const timeLabel = fmtTime(hour, minute);
  let body = rest.replace(/^every\s+/, "").replace(/\bevery\b/g, "").replace(/\s+/g, " ").trim();
  const hadEvery = /^every\b/.test(rest) || /\bevery\b/.test(rest);

  // --- minutes / hours -----------------------------------------------------
  let m: RegExpMatchArray | null;
  if (hadEvery && (m = body.match(/^(\d+|[a-z]+)?\s*(minutes?|mins?)$/))) {
    const n = m[1] ? numberWord(m[1]) ?? 1 : 1;
    return { recurrence: { freq: "minutely", interval: n, hour, minute }, label: n === 1 ? "every minute" : `every ${n} minutes` };
  }
  if (body === "hourly" || (hadEvery && (m = body.match(/^(\d+|[a-z]+)?\s*(hours?|hrs?)$/)))) {
    const n = body === "hourly" ? 1 : m && m[1] ? numberWord(m[1]) ?? 1 : 1;
    return { recurrence: { freq: "hourly", interval: n, hour, minute }, label: n === 1 ? "every hour" : `every ${n} hours` };
  }

  // --- daily -----------------------------------------------------------------
  if (body === "daily" || body === "day" || body === "days" ||
      ((m = body.match(/^(\d+|[a-z]+)\s+days?$/)) && numberWord(m[1]) !== null)) {
    const n = m && body !== "days" ? numberWord(m[1]) ?? 1 : 1;
    return { recurrence: { freq: "daily", interval: n, hour, minute }, label: (n === 1 ? "every day" : `every ${n} days`) + ` at ${timeLabel}` };
  }
  if (body === "weekday" || body === "weekdays" || body === "business day" || body === "business days" || body === "work day" || body === "workday" || body === "workdays") {
    return { recurrence: { freq: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5], hour, minute }, label: `every weekday at ${timeLabel}` };
  }
  if (body === "weekend" || body === "weekends") {
    return { recurrence: { freq: "weekly", interval: 1, byWeekday: [6, 0], hour, minute }, label: `every weekend day at ${timeLabel}` };
  }

  // --- monthly: business day / ordinal weekday / day-of-month -----------------
  if ((m = body.match(/^(first|1st|last)\s+(business|work|working)\s*day(?:\s+(?:month|every month))?$/)) ||
      (m = body.match(/^month\s+(first|1st|last)\s+(business|work|working)\s*day$/))) {
    const pos = ORDINALS[m[1]]!;
    return {
      recurrence: { freq: "monthly", interval: 1, byWeekday: [1, 2, 3, 4, 5], bySetPos: pos, hour, minute },
      label: `${pos} business day of every month at ${timeLabel}`,
    };
  }
  if ((m = body.match(/^(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+([a-z]+)(?:\s+month)?$/)) && WEEKDAYS[m[2]] !== undefined) {
    const pos = ORDINALS[m[1]]!;
    const wd = WEEKDAYS[m[2]];
    return {
      recurrence: { freq: "monthly", interval: 1, byWeekday: [wd], bySetPos: pos, hour, minute },
      label: `${pos} ${WEEKDAY_NAMES[wd]} of every month at ${timeLabel}`,
    };
  }
  if (body === "monthly" || body === "month" ||
      ((m = body.match(/^(\d+|[a-z]+)\s+months?$/)) && numberWord(m[1]) !== null)) {
    const n = m && body !== "month" && body !== "monthly" ? numberWord(m[1]) ?? 1 : 1;
    const day = now.getDate();
    return {
      recurrence: { freq: "monthly", interval: n, byMonthDay: day, hour, minute },
      label: (n === 1 ? "every month" : `every ${n} months`) + ` on the ${ordinal(day)} at ${timeLabel}`,
    };
  }
  if ((m = body.match(/^(?:month\s+)?(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:day\s+)?(?:month|every month))?$/)) ||
      (m = body.match(/^(?:month\s+)?(last)\s+day(?:\s+month)?$/))) {
    const day = m[1] === "last" ? -1 : Number(m[1]);
    if (day === -1 || (day >= 1 && day <= 31)) {
      return {
        recurrence: { freq: "monthly", interval: 1, byMonthDay: day, hour, minute },
        label: `${day === -1 ? "last day" : "the " + ordinal(day)} of every month at ${timeLabel}`,
      };
    }
  }

  // --- yearly ----------------------------------------------------------------
  if (body === "yearly" || body === "annually" || body === "year") {
    return {
      recurrence: { freq: "yearly", interval: 1, byMonth: now.getMonth() + 1, byMonthDay: now.getDate(), hour, minute },
      label: `every year on ${monthName(now.getMonth() + 1)} ${now.getDate()} at ${timeLabel}`,
    };
  }
  if ((m = body.match(/^(?:year\s+)?([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+year)?$/)) && MONTHS[m[1]] !== undefined) {
    const mon = MONTHS[m[1]];
    const day = Number(m[2]);
    return {
      recurrence: { freq: "yearly", interval: 1, byMonth: mon, byMonthDay: day, hour, minute },
      label: `every year on ${monthName(mon)} ${day} at ${timeLabel}`,
    };
  }

  // --- weekly: weekday lists, "weekly", "every 2 weeks [on friday]" -----------
  let interval = 1;
  let weeklyWord = false; // "weekly", "week", "2 weeks" present → definitely recurring
  let wk = body.match(/^(\d+|[a-z]+)\s+weeks?\s*(.*)$/);
  if (wk && numberWord(wk[1]) !== null) {
    interval = numberWord(wk[1])!;
    body = wk[2].trim();
    weeklyWord = true;
  } else if (body === "weekly" || body === "week") {
    body = "";
    weeklyWord = true;
  } else if ((wk = body.match(/^weekly\s+(.*)$/)) || (wk = body.match(/^week\s+(.*)$/))) {
    body = wk[1].trim();
    weeklyWord = true;
  }
  const tokens = body.split(" ").filter(Boolean);
  const days: number[] = [];
  for (const t of tokens) {
    if (WEEKDAYS[t] !== undefined) days.push(WEEKDAYS[t]);
    else return null; // unknown word → not a recurrence we understand
  }
  if (days.length === 0) {
    if (!hadEvery && !weeklyWord) return null;
    days.push(now.getDay());
  } else if (!hadEvery && !weeklyWord && !tokens.every((t) => /s$/.test(t))) {
    // "monday 9am" alone is a one-shot; "mondays 9am" is recurring.
    return null;
  }
  const uniq = [...new Set(days)].sort((a, b) => a - b);
  const dayLabel = uniq.length === 5 && uniq.join() === "1,2,3,4,5" ? "weekday" : uniq.map((d) => WEEKDAY_NAMES[d]).join(", ");
  const every = interval === 1 ? "every" : `every ${interval} weeks on`;
  return {
    recurrence: { freq: "weekly", interval, byWeekday: uniq, hour, minute },
    label: `${every} ${dayLabel} at ${timeLabel}`,
  };
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function monthName(m: number): string {
  return new Date(2000, m - 1, 1).toLocaleDateString("en-US", { month: "long" });
}

/** Whether a phrase looks like a recurrence rather than a one-shot time. */
export function looksRecurring(text: string): boolean {
  const s = text.trim().toLowerCase();
  return /\b(every|daily|weekly|monthly|yearly|annually|hourly|weekdays|weekends|business day|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/.test(s);
}

// ---------------------------------------------------------------------------
// Next-occurrence computation (local time).
// ---------------------------------------------------------------------------

function at(d: Date, hour: number, minute: number): Date {
  const out = new Date(d);
  out.setHours(hour, minute, 0, 0);
  return out;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** Resolve the concrete day-of-month for a monthly rule inside (year, month0). Returns null if none. */
function monthlyDay(rule: Recurrence, year: number, month0: number): number | null {
  const dim = daysInMonth(year, month0);
  if (rule.bySetPos && rule.byWeekday && rule.byWeekday.length) {
    const matches: number[] = [];
    for (let d = 1; d <= dim; d++) {
      if (rule.byWeekday.includes(new Date(year, month0, d).getDay())) matches.push(d);
    }
    if (matches.length === 0) return null;
    const idx = { first: 0, second: 1, third: 2, fourth: 3, last: matches.length - 1 }[rule.bySetPos];
    return matches[idx] ?? null;
  }
  const md = rule.byMonthDay ?? 1;
  if (md === -1) return dim;
  return Math.min(md, dim); // "31st" in a 30-day month → 30th
}

/**
 * Compute the first occurrence strictly after `after`.
 * Deterministic and cheap: scans forward at the rule's granularity.
 */
export function nextOccurrence(rule: Recurrence, after: Date, anchor?: Date): Date {
  const interval = Math.max(1, rule.interval || 1);
  const base = anchor ?? after;

  switch (rule.freq) {
    case "minutely": {
      const step = interval * 60_000;
      const start = base.getTime();
      const n = Math.floor((after.getTime() - start) / step) + 1;
      return new Date(start + Math.max(1, n) * step);
    }
    case "hourly": {
      const step = interval * 3_600_000;
      const start = base.getTime();
      const n = Math.floor((after.getTime() - start) / step) + 1;
      return new Date(start + Math.max(1, n) * step);
    }
    case "daily": {
      let d = at(after, rule.hour, rule.minute);
      if (d.getTime() <= after.getTime()) d = at(addDays(d, 1), rule.hour, rule.minute);
      if (interval > 1 && anchor) {
        const anchorDay = at(anchor, rule.hour, rule.minute);
        while (true) {
          const diffDays = Math.round((d.getTime() - anchorDay.getTime()) / 86_400_000);
          if (diffDays >= 0 && diffDays % interval === 0) break;
          d = at(addDays(d, 1), rule.hour, rule.minute);
        }
      }
      return d;
    }
    case "weekly": {
      const days = rule.byWeekday && rule.byWeekday.length ? rule.byWeekday : [base.getDay()];
      let d = at(after, rule.hour, rule.minute);
      if (d.getTime() <= after.getTime()) d = at(addDays(d, 1), rule.hour, rule.minute);
      for (let i = 0; i < 7 * interval + 7; i++) {
        if (days.includes(d.getDay())) {
          if (interval === 1) return d;
          // week index relative to the anchor's week (Monday-based)
          const anchorWeek = startOfWeek(anchor ?? after);
          const thisWeek = startOfWeek(d);
          const weeks = Math.round((thisWeek.getTime() - anchorWeek.getTime()) / (7 * 86_400_000));
          if (weeks % interval === 0) return d;
        }
        d = at(addDays(d, 1), rule.hour, rule.minute);
      }
      return d;
    }
    case "monthly": {
      let y = after.getFullYear();
      let mo = after.getMonth();
      for (let i = 0; i < 24 * interval; i++) {
        const day = monthlyDay(rule, y, mo);
        if (day !== null) {
          const cand = new Date(y, mo, day, rule.hour, rule.minute, 0, 0);
          if (cand.getTime() > after.getTime()) {
            if (interval === 1 || !anchor) return cand;
            const monthsFromAnchor = (y - anchor.getFullYear()) * 12 + (mo - anchor.getMonth());
            if (monthsFromAnchor % interval === 0) return cand;
          }
        }
        mo += 1;
        if (mo > 11) { mo = 0; y += 1; }
      }
      throw new Error("Could not compute next monthly occurrence");
    }
    case "yearly": {
      const mon = (rule.byMonth ?? base.getMonth() + 1) - 1;
      const day = rule.byMonthDay ?? base.getDate();
      let y = after.getFullYear();
      for (let i = 0; i < 8; i++) {
        const dim = daysInMonth(y, mon);
        const cand = new Date(y, mon, Math.min(day, dim), rule.hour, rule.minute, 0, 0);
        if (cand.getTime() > after.getTime()) return cand;
        y += 1;
      }
      throw new Error("Could not compute next yearly occurrence");
    }
  }
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const dow = (out.getDay() + 6) % 7; // Monday = 0
  out.setDate(out.getDate() - dow);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function describeRecurrence(rule: Recurrence): string {
  const t = fmtTime(rule.hour, rule.minute);
  const n = rule.interval;
  switch (rule.freq) {
    case "minutely": return n === 1 ? "every minute" : `every ${n} minutes`;
    case "hourly": return n === 1 ? "every hour" : `every ${n} hours`;
    case "daily": return (n === 1 ? "every day" : `every ${n} days`) + ` at ${t}`;
    case "weekly": {
      const days = rule.byWeekday ?? [];
      const lbl = days.join() === "1,2,3,4,5" ? "weekday" : days.map((d) => WEEKDAY_NAMES[d]).join(", ");
      return (n === 1 ? `every ${lbl}` : `every ${n} weeks on ${lbl}`) + ` at ${t}`;
    }
    case "monthly": {
      if (rule.bySetPos && rule.byWeekday) {
        const isBiz = rule.byWeekday.join() === "1,2,3,4,5";
        return `${rule.bySetPos} ${isBiz ? "business day" : WEEKDAY_NAMES[rule.byWeekday[0]]} of every month at ${t}`;
      }
      const md = rule.byMonthDay ?? 1;
      return `${md === -1 ? "last day" : "the " + ordinal(md)} of every ${n === 1 ? "month" : n + " months"} at ${t}`;
    }
    case "yearly":
      return `every year on ${monthName(rule.byMonth ?? 1)} ${rule.byMonthDay ?? 1} at ${t}`;
  }
}
