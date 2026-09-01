import { describe, it, expect } from "vitest";
import { parseEvery, nextOccurrence, describeRecurrence, looksRecurring } from "../src/parse/recurrence.js";

// Tuesday Sep 1 2026 5:30 PM
const now = new Date(2026, 8, 1, 17, 30, 0);
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function every(text: string) {
  const r = parseEvery(text, { now });
  if (!r) throw new Error(`no recurrence parse for "${text}"`);
  return r;
}

describe("parseEvery", () => {
  it("daily", () => {
    expect(every("every day").recurrence).toMatchObject({ freq: "daily", interval: 1, hour: 9, minute: 0 });
    expect(every("daily at 8:30").recurrence).toMatchObject({ freq: "daily", hour: 8, minute: 30 });
    expect(every("every 2 days at 6pm").recurrence).toMatchObject({ freq: "daily", interval: 2, hour: 18 });
  });
  it("weekdays / weekends", () => {
    expect(every("every weekday").recurrence).toMatchObject({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5] });
    expect(every("weekdays 8am").recurrence).toMatchObject({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5], hour: 8 });
    expect(every("every weekend").recurrence).toMatchObject({ freq: "weekly", byWeekday: [6, 0] });
  });
  it("weekly on specific days", () => {
    expect(every("every monday 9am").recurrence).toMatchObject({ freq: "weekly", byWeekday: [1], hour: 9 });
    expect(every("every Monday at 9 AM").label).toBe("every Monday at 9:00 AM");
    expect(every("mondays and thursdays at 8").recurrence).toMatchObject({ byWeekday: [1, 4], hour: 8 });
    expect(every("every mon, wed, fri").recurrence).toMatchObject({ byWeekday: [1, 3, 5] });
    expect(every("every 2 weeks on friday").recurrence).toMatchObject({ freq: "weekly", interval: 2, byWeekday: [5] });
    expect(every("weekly").recurrence).toMatchObject({ freq: "weekly", byWeekday: [2] }); // today is Tuesday
    expect(every("every week on thursday").recurrence).toMatchObject({ byWeekday: [4] });
    expect(every("fridays").recurrence).toMatchObject({ byWeekday: [5] });
  });
  it("one-shot weekday phrases are not recurrences", () => {
    expect(parseEvery("monday 9am", { now })).toBeNull();
    expect(parseEvery("tomorrow 10am", { now })).toBeNull();
    expect(parseEvery("in 30m", { now })).toBeNull();
  });
  it("monthly", () => {
    expect(every("monthly").recurrence).toMatchObject({ freq: "monthly", byMonthDay: 1 });
    expect(every("every month on the 15th").recurrence).toMatchObject({ freq: "monthly", byMonthDay: 15 });
    expect(every("on the 1st of every month at 9am").recurrence).toMatchObject({ freq: "monthly", byMonthDay: 1, hour: 9 });
    expect(every("first business day of every month").recurrence).toMatchObject({ freq: "monthly", bySetPos: "first", byWeekday: [1, 2, 3, 4, 5] });
    expect(every("last business day of the month at 4pm").recurrence).toMatchObject({ bySetPos: "last", hour: 16 });
    expect(every("second tuesday of every month").recurrence).toMatchObject({ bySetPos: "second", byWeekday: [2] });
    expect(every("last day of the month").recurrence).toMatchObject({ byMonthDay: -1 });
    expect(every("every 3 months").recurrence).toMatchObject({ freq: "monthly", interval: 3 });
  });
  it("yearly", () => {
    expect(every("every year on september 15").recurrence).toMatchObject({ freq: "yearly", byMonth: 9, byMonthDay: 15 });
    expect(every("yearly").recurrence).toMatchObject({ freq: "yearly", byMonth: 9, byMonthDay: 1 });
  });
  it("hours / minutes", () => {
    expect(every("every 30 minutes").recurrence).toMatchObject({ freq: "minutely", interval: 30 });
    expect(every("hourly").recurrence).toMatchObject({ freq: "hourly", interval: 1 });
    expect(every("every 2 hours").recurrence).toMatchObject({ freq: "hourly", interval: 2 });
  });
  it("rejects junk", () => {
    expect(parseEvery("every banana", { now })).toBeNull();
    expect(parseEvery("finish oauth", { now })).toBeNull();
  });
  it("looksRecurring", () => {
    expect(looksRecurring("every monday 9am")).toBe(true);
    expect(looksRecurring("weekdays")).toBe(true);
    expect(looksRecurring("tomorrow 9am")).toBe(false);
  });
});

describe("nextOccurrence", () => {
  it("daily", () => {
    const r = every("every day at 9am").recurrence;
    expect(nextOccurrence(r, now).getTime()).toBe(local(2026, 9, 2, 9));
    expect(nextOccurrence(r, new Date(2026, 8, 2, 8, 0)).getTime()).toBe(local(2026, 9, 2, 9));
  });
  it("every weekday skips weekends", () => {
    const r = every("every weekday at 8am").recurrence;
    const fri = new Date(2026, 8, 4, 9, 0); // Friday after 8am
    expect(nextOccurrence(r, fri).getTime()).toBe(local(2026, 9, 7, 8)); // Monday
  });
  it("every monday 9am", () => {
    const r = every("every monday 9am").recurrence;
    expect(nextOccurrence(r, now).getTime()).toBe(local(2026, 9, 7, 9));
    expect(nextOccurrence(r, new Date(2026, 8, 7, 9, 0)).getTime()).toBe(local(2026, 9, 14, 9));
  });
  it("every 2 weeks on friday honors the anchor", () => {
    const r = every("every 2 weeks on friday").recurrence;
    const anchor = new Date(2026, 8, 4, 9, 0); // Fri Sep 4
    expect(nextOccurrence(r, anchor, anchor).getTime()).toBe(local(2026, 9, 18, 9));
  });
  it("first business day of every month", () => {
    const r = every("first business day of every month").recurrence;
    // Oct 1 2026 is a Thursday → Oct 1
    expect(nextOccurrence(r, now).getTime()).toBe(local(2026, 10, 1, 9));
    // Nov 1 2026 is a Sunday → Nov 2
    expect(nextOccurrence(r, new Date(2026, 9, 2)).getTime()).toBe(local(2026, 11, 2, 9));
  });
  it("last business day of month", () => {
    const r = every("last business day of the month at 4pm").recurrence;
    // Sep 30 2026 is a Wednesday
    expect(nextOccurrence(r, now).getTime()).toBe(local(2026, 9, 30, 16));
    // Oct 31 2026 is Saturday → Oct 30
    expect(nextOccurrence(r, new Date(2026, 9, 1)).getTime()).toBe(local(2026, 10, 30, 16));
  });
  it("second tuesday", () => {
    const r = every("second tuesday of every month at 10am").recurrence;
    expect(nextOccurrence(r, now).getTime()).toBe(local(2026, 9, 8, 10));
  });
  it("31st clamps to month length", () => {
    const r = every("every month on the 31st").recurrence;
    expect(nextOccurrence(r, new Date(2026, 8, 1)).getTime()).toBe(local(2026, 9, 30, 9));
  });
  it("last day of month", () => {
    const r = every("last day of the month").recurrence;
    expect(nextOccurrence(r, new Date(2027, 1, 1)).getTime()).toBe(local(2027, 2, 28, 9));
  });
  it("yearly", () => {
    const r = every("every year on september 15").recurrence;
    expect(nextOccurrence(r, now).getTime()).toBe(local(2026, 9, 15, 9));
    expect(nextOccurrence(r, new Date(2026, 8, 16)).getTime()).toBe(local(2027, 9, 15, 9));
  });
  it("every 30 minutes from anchor", () => {
    const r = every("every 30 minutes").recurrence;
    expect(nextOccurrence(r, now, now).getTime()).toBe(now.getTime() + 30 * 60_000);
  });
  it("describeRecurrence round trips labels", () => {
    expect(describeRecurrence(every("every weekday at 8am").recurrence)).toBe("every weekday at 8:00 AM");
    expect(describeRecurrence(every("first business day of every month").recurrence)).toBe("first business day of every month at 9:00 AM");
  });
});
