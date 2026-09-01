import { describe, it, expect } from "vitest";
import { parseWhen, parseDuration, splitTitleAndWhen, formatWhen } from "../src/parse/when.js";

// Tuesday Sep 1 2026, 5:30 PM local (vitest sets TZ=America/Los_Angeles)
const now = new Date(2026, 8, 1, 17, 30, 0);

function at(text: string) {
  const r = parseWhen(text, { now });
  if (!r) throw new Error(`no parse for "${text}"`);
  return r.at;
}
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("parseDuration", () => {
  it("parses compact and verbose durations", () => {
    expect(parseDuration("30m")?.ms).toBe(30 * 60_000);
    expect(parseDuration("in 30 min")?.ms).toBe(30 * 60_000);
    expect(parseDuration("in 20 minutes")?.ms).toBe(20 * 60_000);
    expect(parseDuration("2h")?.ms).toBe(2 * 3_600_000);
    expect(parseDuration("1h30m")?.ms).toBe(90 * 60_000);
    expect(parseDuration("in three hours")?.ms).toBe(3 * 3_600_000);
    expect(parseDuration("in a couple of days")?.ms).toBe(2 * 86_400_000);
    expect(parseDuration("2 weeks")?.ms).toBe(14 * 86_400_000);
    expect(parseDuration("in an hour")?.ms).toBe(3_600_000);
    expect(parseDuration("in half an hour")).toBeNull(); // ambiguous, chrono/casual path handles others
  });
  it("rejects non-durations", () => {
    expect(parseDuration("tomorrow")).toBeNull();
    expect(parseDuration("3 pm")).toBeNull();
    expect(parseDuration("in 30m check deploy")).toBeNull();
  });
});

describe("parseWhen", () => {
  it("relative durations", () => {
    expect(at("in 20 minutes").getTime()).toBe(now.getTime() + 20 * 60_000);
    expect(at("30m").getTime()).toBe(now.getTime() + 30 * 60_000);
    expect(at("in three hours").getTime()).toBe(now.getTime() + 3 * 3_600_000);
  });
  it("tomorrow defaults to morning hour", () => {
    expect(at("tomorrow").getTime()).toBe(local(2026, 9, 2, 9));
    expect(at("tomorrow morning").getTime()).toBe(local(2026, 9, 2, 9));
    expect(at("tomorrow at 2").getTime()).toBe(local(2026, 9, 2, 14));
    expect(at("tomorrow 10am").getTime()).toBe(local(2026, 9, 2, 10));
    expect(at("tomorrow afternoon").getTime()).toBe(local(2026, 9, 2, 14));
    expect(at("tomorrow evening").getTime()).toBe(local(2026, 9, 2, 18));
  });
  it("weekday phrases", () => {
    expect(at("friday at 3").getTime()).toBe(local(2026, 9, 4, 15));
    expect(at("Friday 3pm").getTime()).toBe(local(2026, 9, 4, 15));
    expect(at("next tuesday").getTime()).toBe(local(2026, 9, 8, 9));
    expect(at("monday").getTime()).toBe(local(2026, 9, 7, 9));
    expect(at("tue 9am").getTime()).toBe(local(2026, 9, 8, 9));
  });
  it("absolute dates", () => {
    expect(at("september 15 at noon").getTime()).toBe(local(2026, 9, 15, 12));
    expect(at("sept 15").getTime()).toBe(local(2026, 9, 15, 9));
    expect(at("9/15 2pm").getTime()).toBe(local(2026, 9, 15, 14));
    expect(at("2026-10-01 08:00").getTime()).toBe(local(2026, 10, 1, 8));
  });
  it("time-only phrases roll to tomorrow when already past", () => {
    expect(at("at 3").getTime()).toBe(local(2026, 9, 2, 15));
    expect(at("10am").getTime()).toBe(local(2026, 9, 2, 10));
    expect(at("at 7").getTime()).toBe(local(2026, 9, 2, 7));
    expect(at("6pm").getTime()).toBe(local(2026, 9, 1, 18));
    expect(at("noon").getTime()).toBe(local(2026, 9, 2, 12));
  });
  it("casual phrases", () => {
    expect(at("tonight").getTime()).toBe(local(2026, 9, 1, 20));
    expect(at("eod").getTime()).toBe(local(2026, 9, 2, 17)); // 5:30pm already past 5pm → tomorrow
    expect(at("end of week").getTime()).toBe(local(2026, 9, 4, 17));
    expect(at("next week").getTime()).toBe(local(2026, 9, 7, 9));
    expect(at("later").getTime()).toBe(now.getTime() + 3 * 3_600_000);
    expect(at("next month").getTime()).toBe(local(2026, 10, 1, 9));
  });
  it("returns null for junk", () => {
    expect(parseWhen("finish the oauth", { now })).toBeNull();
    expect(parseWhen("", { now })).toBeNull();
  });
});

describe("splitTitleAndWhen", () => {
  it("splits trailing time phrases", () => {
    expect(splitTitleAndWhen("check deployment in 30m", { now })).toEqual({ title: "check deployment", when: "in 30m" });
    expect(splitTitleAndWhen("finish OAuth tomorrow 10am", { now })).toEqual({ title: "finish OAuth", when: "tomorrow 10am" });
    expect(splitTitleAndWhen("call hosting company tomorrow", { now })).toEqual({ title: "call hosting company", when: "tomorrow" });
    expect(splitTitleAndWhen("review PR friday at 3", { now })).toEqual({ title: "review PR", when: "friday at 3" });
  });
  it("leaves titles without a time alone", () => {
    expect(splitTitleAndWhen("configure stripe webhook", { now })).toEqual({ title: "configure stripe webhook", when: null });
  });
});

describe("formatWhen", () => {
  it("formats relative labels", () => {
    expect(formatWhen(new Date(now.getTime() + 30 * 60_000), now)).toBe("in 30 min (6:00 PM)");
    expect(formatWhen(new Date(local(2026, 9, 2, 9)), now)).toBe("tomorrow 9:00 AM");
    expect(formatWhen(new Date(local(2026, 9, 4, 15)), now)).toBe("Fri 3:00 PM");
    expect(formatWhen(new Date(local(2026, 10, 1, 9)), now)).toBe("Thu, Oct 1, 9:00 AM");
  });
});
