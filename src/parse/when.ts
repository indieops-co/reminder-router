import * as chrono from "chrono-node";
import type { Config } from "../core/config.js";
import { DEFAULT_CONFIG } from "../core/config.js";

export interface ParsedWhen {
  at: Date;
  /** Human label like "tomorrow 9:00 AM". */
  label: string;
  /** The portion of the input that was interpreted as time. */
  matched: string;
}

export interface WhenOptions {
  now?: Date;
  config?: Pick<Config, "morningHour" | "afternoonHour" | "eveningHour">;
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  half: 0.5, quarter: 0.25, couple: 2, few: 3,
};

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, wks: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/**
 * Parse compact / natural durations: "30m", "in 30 min", "1h30m", "in three hours",
 * "in a couple of days", "2 weeks". Returns milliseconds or null.
 */
export function parseDuration(text: string): { ms: number; matched: string } | null {
  let s = text.trim().toLowerCase();
  s = s.replace(/^in\s+/, "").replace(/\s+from now$/, "").replace(/\s+of\s+/g, " ");
  if (!s) return null;
  s = s.replace(/^(a|an)\s+(couple|few)\b/, "$2");
  // word numbers -> digits
  s = s.replace(/\b([a-z]+)\b/g, (w) => (w in WORD_NUMBERS ? String(WORD_NUMBERS[w]) : w));
  // "1h30m", "2 hours 15 minutes", "1.5h"
  const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)(?![a-z])/g;
  let ms = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(s))) {
    // must start at the beginning, and tokens must be contiguous (allow "and"/commas/spaces between)
    const gap = s.slice(lastEnd, m.index);
    if (consumed === 0 && gap.trim() !== "") return null;
    if (consumed > 0 && !/^[\s,]*(and\s+)?$/.test(gap)) break;
    ms += Number(m[1]) * UNIT_MS[m[2]];
    consumed += 1;
    lastEnd = m.index + m[0].length;
  }
  if (consumed === 0) return null;
  if (s.slice(lastEnd).trim() !== "") return null; // trailing junk → not a pure duration
  return { ms, matched: text.trim() };
}

function setTime(d: Date, hour: number, minute = 0): Date {
  const out = new Date(d);
  out.setHours(hour, minute, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Parse a one-shot time phrase into an absolute Date. Understands compact durations,
 * casual times of day, and anything chrono-node understands ("Friday at 3",
 * "next Tuesday", "September 15 at noon", "in 20 minutes").
 */
export function parseWhen(input: string, opts: WhenOptions = {}): ParsedWhen | null {
  const now = opts.now ?? new Date();
  const cfg = opts.config ?? DEFAULT_CONFIG;
  const raw = input.trim();
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/\s+/g, " ");

  // 1. Pure durations.
  const dur = parseDuration(s);
  if (dur) {
    const at = new Date(now.getTime() + dur.ms);
    return { at, label: formatWhen(at, now), matched: raw };
  }

  // 2. Casual shortcuts that chrono either misreads or doesn't know.
  const casual = parseCasual(s, now, cfg);
  if (casual) return { at: casual, label: formatWhen(casual, now), matched: raw };

  // 3. chrono-node for everything else.
  const results = chrono.parse(s, now, { forwardDate: true });
  if (results.length === 0) return null;
  const r = results[0];
  let at = r.date();

  const hourCertain = r.start.isCertain("hour");
  const meridiemCertain = r.start.isCertain("meridiem");

  if (!hourCertain) {
    // Date-only phrases ("tomorrow", "next tuesday", "sept 15"): choose a time of day.
    if (/\bmorning\b/.test(s)) at = setTime(at, cfg.morningHour);
    else if (/\bafternoon\b/.test(s)) at = setTime(at, cfg.afternoonHour);
    else if (/\b(evening|tonight)\b/.test(s)) at = setTime(at, cfg.eveningHour);
    else if (/^in \d+ (day|days|week|weeks|month|months)$/.test(s)) {
      /* keep the same time of day */
    } else at = setTime(at, cfg.morningHour);
  } else if (!meridiemCertain) {
    // "Friday at 3" → 3 PM. "at 7" → 7 AM. Developers rarely mean 3 AM.
    const h = at.getHours();
    if (h >= 1 && h <= 6) at = new Date(at.getTime() + 12 * 3_600_000);
  }

  // Never schedule in the past for time-only phrases: "at 3" when it's 5 PM means tomorrow.
  if (at.getTime() <= now.getTime()) {
    const bumped = addDays(at, 1);
    if (bumped.getTime() > now.getTime() && !r.start.isCertain("day")) at = bumped;
  }

  return { at, label: formatWhen(at, now), matched: r.text };
}

function parseCasual(s: string, now: Date, cfg: WhenOptions["config"] & object): Date | null {
  const morning = cfg.morningHour, afternoon = cfg.afternoonHour, evening = cfg.eveningHour;
  const todayAt = (h: number, m = 0) => {
    const d = setTime(now, h, m);
    return d.getTime() > now.getTime() ? d : setTime(addDays(now, 1), h, m);
  };
  switch (s) {
    case "now":
      return new Date(now.getTime() + 60_000);
    case "later":
    case "later today":
    case "in a bit":
    case "in a while":
      return new Date(now.getTime() + 3 * 3_600_000);
    case "soon":
      return new Date(now.getTime() + 30 * 60_000);
    case "morning":
    case "this morning":
      return todayAt(morning);
    case "afternoon":
    case "this afternoon":
      return todayAt(afternoon);
    case "evening":
    case "this evening":
      return todayAt(evening);
    case "tonight":
      return todayAt(Math.max(evening, 20));
    case "eod":
    case "end of day":
    case "end of the day":
    case "close of business":
    case "cob":
      return todayAt(17);
    case "eow":
    case "end of week":
    case "end of the week": {
      const d = new Date(now);
      const dow = d.getDay();
      const delta = dow <= 5 ? 5 - dow : 6; // to Friday
      const fri = setTime(addDays(d, delta), 17);
      return fri.getTime() > now.getTime() ? fri : setTime(addDays(fri, 7), 17);
    }
    case "tomorrow":
      return setTime(addDays(now, 1), morning);
    case "tomorrow morning":
      return setTime(addDays(now, 1), morning);
    case "tomorrow afternoon":
      return setTime(addDays(now, 1), afternoon);
    case "tomorrow evening":
    case "tomorrow night":
      return setTime(addDays(now, 1), evening);
    case "next week": {
      const d = new Date(now);
      const dow = d.getDay();
      const delta = ((8 - dow) % 7) || 7; // next Monday
      return setTime(addDays(d, delta), morning);
    }
    case "next month": {
      const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return setTime(d, morning);
    }
    case "first thing":
    case "first thing tomorrow":
      return setTime(addDays(now, 1), Math.min(morning, 8));
    default:
      return null;
  }
}

/** "tomorrow 9:00 AM", "Fri Sep 4, 3:00 PM", "in 30 min" */
export function formatWhen(at: Date, now: Date = new Date()): string {
  const diff = at.getTime() - now.getTime();
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (diff >= 0 && diff < 90 * 60_000) {
    const mins = Math.round(diff / 60_000);
    return `in ${mins} min (${time})`;
  }
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `today ${time}`;
  const tomorrow = at.toDateString() === addDays(now, 1).toDateString();
  if (tomorrow) return `tomorrow ${time}`;
  const withinWeek = diff > 0 && diff < 6 * 86_400_000;
  if (withinWeek) return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  const date = at.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

/** Relative description for overdue / upcoming lists: "12m ago", "in 3h", "in 2d". */
export function formatRelative(at: Date, now: Date = new Date()): string {
  const diff = at.getTime() - now.getTime();
  const abs = Math.abs(diff);
  let s: string;
  if (abs < 60_000) s = "now";
  else if (abs < 3_600_000) s = `${Math.round(abs / 60_000)}m`;
  else if (abs < 86_400_000) s = `${Math.round(abs / 3_600_000 * 10) / 10}h`.replace(".0h", "h");
  else s = `${Math.round(abs / 86_400_000)}d`;
  if (s === "now") return s;
  return diff < 0 ? `${s} ago` : `in ${s}`;
}

/**
 * Split "check deployment in 30m" → { title: "check deployment", when: "in 30m" }.
 * Only splits when a time phrase sits at the END of the text.
 */
export function splitTitleAndWhen(text: string, opts: WhenOptions = {}): { title: string; when: string | null } {
  const trimmed = text.trim();
  const now = opts.now ?? new Date();
  const words = trimmed.split(/\s+/);
  // Try progressively longer suffixes; keep the longest suffix that parses cleanly.
  let best: { title: string; when: string } | null = null;
  for (let i = words.length - 1; i >= 1; i--) {
    const suffix = words.slice(i).join(" ");
    const title = words.slice(0, i).join(" ");
    const suffixNorm = suffix.toLowerCase();
    // Reject suffixes that chrono would only partially match (e.g. "the deploy tomorrow" → not clean)
    const parsed = parseWhen(suffixNorm, { ...opts, now });
    if (!parsed) continue;
    if (parsed.matched.trim().toLowerCase() !== suffixNorm.replace(/^(at|on|by)\s+/, "") &&
        parsed.matched.trim().toLowerCase() !== suffixNorm) {
      // chrono matched only part of the suffix → the rest is title text; stop widening.
      continue;
    }
    best = { title: title.replace(/[\s,]+(at|on|by|in)$/i, "").trim(), when: suffix };
  }
  return best ? { title: best.title, when: best.when } : { title: trimmed, when: null };
}
