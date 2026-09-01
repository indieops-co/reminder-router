import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/core/db.js";
import { Store, HandoffError } from "../src/core/store.js";

const now = new Date(2026, 8, 1, 17, 30, 0); // Tue Sep 1 2026 5:30 PM
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

let store: Store;
beforeEach(() => {
  store = new Store(openDb(":memory:"));
});

describe("Store.create", () => {
  it("creates a simple one-shot reminder", () => {
    const h = store.create({ title: "Call hosting company", when: "tomorrow 10am", createdBy: "cli" }, now);
    expect(h.id).toBe(1);
    expect(h.status).toBe("scheduled");
    expect(h.trigger_at).toBe(local(2026, 9, 2, 10));
    expect(h.recurrence).toBeNull();
    expect(h.destinations).toEqual([]);
    expect(store.events(h.id).map((e) => e.kind)).toEqual(["created"]);
  });

  it("creates a rich handoff with project + destinations", () => {
    const h = store.create(
      {
        title: "Google OAuth verification",
        when: "tomorrow 10am",
        project: "Acme Auth",
        repoPath: "/Users/me/projects/acme-auth",
        reasonPaused: "Waiting for production-domain verification.",
        nextAction: "Finish OAuth branding",
        destination: "https://console.cloud.google.com/apis/credentials",
        resumePrompt: "Read AUTH.md and continue.",
        agent: "claude",
      },
      now,
    );
    expect(h.project_id).toBe(1);
    const p = store.getProject(1)!;
    expect(p.name).toBe("Acme Auth");
    expect(p.path).toBe("/Users/me/projects/acme-auth");
    expect(h.destinations).toEqual([{ type: "url", uri: "https://console.cloud.google.com/apis/credentials", label: "Google Cloud" }]);
    expect(h.resume_prompt).toBe("Read AUTH.md and continue.");
  });

  it("reuses a project by path and by name", () => {
    store.create({ title: "a", when: "in 1h", project: "PressPal", repoPath: "/p/presspal" }, now);
    store.create({ title: "b", when: "in 1h", repoPath: "/p/presspal" }, now);
    store.create({ title: "c", when: "in 1h", project: "presspal" }, now);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.findProject("P-001")?.name).toBe("PressPal");
    expect(store.findProject("press")?.name).toBe("PressPal");
  });

  it("creates recurring handoffs from `every` or from a recurring `when`", () => {
    const a = store.create({ title: "Review deps", every: "monday 9am" }, now);
    expect(a.recurrence?.freq).toBe("weekly");
    expect(a.trigger_at).toBe(local(2026, 9, 7, 9));
    expect(a.recurrence_label).toBe("every Monday at 9:00 AM");
    const b = store.create({ title: "Submit hours", when: "every friday 4pm" }, now);
    expect(b.recurrence?.byWeekday).toEqual([5]);
    expect(b.trigger_at).toBe(local(2026, 9, 4, 16));
  });

  it("rejects missing or bad times", () => {
    expect(() => store.create({ title: "x" }, now)).toThrow(HandoffError);
    expect(() => store.create({ title: "x", when: "banana o'clock" }, now)).toThrow(/understand/);
  });
});

describe("Store lifecycle", () => {
  it("scheduled → due → snoozed → due → completed", () => {
    const h = store.create({ title: "check deploy", when: "in 30m" }, now);
    const t1 = new Date(now.getTime() + 31 * 60_000);
    expect(store.pending(now)).toHaveLength(0);
    expect(store.pending(t1).map((x) => x.id)).toEqual([h.id]);

    store.markFired(h.id, t1);
    expect(store.get(h.id)!.status).toBe("due");
    expect(store.due()).toHaveLength(1);
    expect(store.pending(t1)).toHaveLength(0);

    const until = new Date(t1.getTime() + 15 * 60_000);
    store.snooze(h.id, until, t1);
    const s = store.get(h.id)!;
    expect(s.status).toBe("snoozed");
    expect(s.trigger_at).toBe(until.toISOString());
    expect(store.pending(new Date(until.getTime() + 1000))).toHaveLength(1);

    store.markFired(h.id, until);
    store.complete(h.id, until);
    const c = store.get(h.id)!;
    expect(c.status).toBe("completed");
    expect(c.completed_at).toBe(until.toISOString());
    expect(store.list()).toHaveLength(0);
    expect(store.list({ status: "completed" })).toHaveLength(1);
    expect(store.events(h.id).map((e) => e.kind)).toEqual(["completed", "fired", "snoozed", "fired", "created"]);
  });

  it("completing a recurring handoff advances it", () => {
    const h = store.create({ title: "deps", every: "every monday 9am" }, now);
    const mon = new Date(2026, 8, 7, 9, 0, 30);
    store.markFired(h.id, mon);
    const done = store.complete(h.id, new Date(2026, 8, 7, 10));
    expect(done.status).toBe("scheduled");
    expect(done.trigger_at).toBe(local(2026, 9, 14, 9));
    expect(done.occurrences).toBe(1);
    expect(done.completed_at).not.toBeNull();
    // stop for good
    store.stop(h.id);
    expect(store.get(h.id)!.status).toBe("dismissed");
  });

  it("reschedule + update", () => {
    const h = store.create({ title: "x", when: "in 1h" }, now);
    store.reschedule(h.id, "friday at 3", now);
    expect(store.get(h.id)!.trigger_at).toBe(local(2026, 9, 4, 15));
    store.update(h.id, { title: "y", addDestination: "https://github.com/a/b", nextAction: "merge" }, now);
    const u = store.get(h.id)!;
    expect(u.title).toBe("y");
    expect(u.destinations[0]).toMatchObject({ type: "url", label: "GitHub" });
    expect(u.next_action).toBe("merge");
    store.update(h.id, { every: "weekdays 8am" }, now);
    expect(store.get(h.id)!.recurrence?.byWeekday).toEqual([1, 2, 3, 4, 5]);
    store.update(h.id, { every: null }, now);
    expect(store.get(h.id)!.recurrence).toBeNull();
  });

  it("list ordering puts due first, then soonest", () => {
    const a = store.create({ title: "later", when: "in 3h" }, now);
    const b = store.create({ title: "soon", when: "in 1h" }, now);
    const c = store.create({ title: "overdue", when: "in 10m" }, now);
    store.markFired(c.id, new Date(now.getTime() + 11 * 60_000));
    expect(store.list().map((h) => h.id)).toEqual([c.id, b.id, a.id]);
    expect(store.counts()).toMatchObject({ due: 1, scheduled: 2 });
  });

  it("delete and not-found", () => {
    const h = store.create({ title: "x", when: "in 1h" }, now);
    store.delete(h.id);
    expect(store.get(h.id)).toBeNull();
    expect(() => store.complete(h.id)).toThrow(/not found/);
  });
});
