import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/core/db.js";
import { Store } from "../src/core/store.js";
import { HandoffService } from "../src/daemon/service.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { Notifier, NotificationRequest } from "../src/notify/notifier.js";

class FakeNotifier implements Notifier {
  name = "fake";
  sent: NotificationRequest[] = [];
  removed: number[] = [];
  async notify(req: NotificationRequest) { this.sent.push(req); }
  async remove(id: number) { this.removed.push(id); }
}

let store: Store;
let notifier: FakeNotifier;
let clock: Date;
let service: HandoffService;
const start = new Date(2026, 8, 1, 17, 30, 0); // Tue Sep 1 2026 5:30 PM

beforeEach(() => {
  store = new Store(openDb(":memory:"));
  notifier = new FakeNotifier();
  clock = new Date(start);
  service = new HandoffService({ store, notifier, config: { ...DEFAULT_CONFIG, renotifyMinutes: 30, renotifyMax: 2 }, log: () => undefined, now: () => clock });
});
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

describe("HandoffService.tick", () => {
  it("fires due handoffs once and builds a project-aware notification", async () => {
    store.create({ title: "Finish OAuth", when: "in 10m", project: "Acme Auth", nextAction: "Configure branding", destination: "https://console.cloud.google.com" }, clock);
    expect(await service.tick()).toEqual([]);
    advance(11 * 60_000);
    expect(await service.tick()).toEqual([1]);
    expect(await service.tick()).toEqual([]); // not again
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ id: 1, title: "Acme Auth", subtitle: "Finish OAuth", body: "Next: Configure branding", primary: "Open Google Cloud" });
    expect(store.get(1)!.status).toBe("due");
    expect(store.get(1)!.notified_count).toBe(1);
  });

  it("re-notifies overdue handoffs at most renotifyMax times", async () => {
    store.create({ title: "x", when: "in 1m" }, clock);
    advance(2 * 60_000);
    await service.tick();
    expect(notifier.sent).toHaveLength(1);
    advance(31 * 60_000); await service.tick();
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[1].body).toMatch(/Still waiting/);
    advance(31 * 60_000); await service.tick();
    expect(notifier.sent).toHaveLength(3);
    advance(31 * 60_000); await service.tick();
    expect(notifier.sent).toHaveLength(3); // capped
  });

  it("silent handoffs become due without a notification", async () => {
    store.create({ title: "quiet", when: "in 1m", notify: false }, clock);
    advance(2 * 60_000);
    await service.tick();
    expect(store.get(1)!.status).toBe("due");
    expect(notifier.sent).toHaveLength(0);
  });

  it("holds notifications during quiet hours", async () => {
    service = new HandoffService({ store, notifier, config: { ...DEFAULT_CONFIG, quietStart: "22:00", quietEnd: "07:00" }, log: () => undefined, now: () => clock });
    store.create({ title: "late", when: "at 11pm" }, clock);
    clock = new Date(2026, 8, 1, 23, 5);
    await service.tick();
    expect(store.get(1)!.status).toBe("scheduled");
    clock = new Date(2026, 8, 2, 7, 1);
    await service.tick();
    expect(store.get(1)!.status).toBe("due");
    expect(notifier.sent).toHaveLength(1);
  });

  it("ignored recurring handoffs roll forward instead of piling up", async () => {
    store.create({ title: "deps", every: "every day at 9am" }, clock);
    clock = new Date(2026, 8, 2, 9, 1); // Wed 9:01
    await service.tick();
    expect(store.get(1)!.status).toBe("due");
    clock = new Date(2026, 8, 3, 9, 2); // Thu 9:02 — the Wed occurrence was never handled
    await service.tick();
    const h = store.get(1)!;
    expect(h.status).toBe("due"); // advanced then fired again
    expect(h.trigger_at).toBe(new Date(2026, 8, 3, 9, 0).toISOString());
    expect(h.occurrences).toBe(1);
  });
});

describe("HandoffService.handleAction", () => {
  it("snooze15 / snooze60 / tomorrow / done / dismiss", async () => {
    store.create({ title: "x", when: "in 1m" }, clock);
    advance(2 * 60_000);
    await service.tick();
    let r = await service.handleAction(1, "snooze15");
    expect(r.handoff.status).toBe("snoozed");
    expect(new Date(r.handoff.trigger_at).getTime()).toBe(clock.getTime() + 15 * 60_000);
    expect(notifier.removed).toEqual([1]);
    r = await service.handleAction(1, "snooze60");
    expect(new Date(r.handoff.trigger_at).getTime()).toBe(clock.getTime() + 60 * 60_000);
    r = await service.handleAction(1, "tomorrow");
    expect(new Date(r.handoff.trigger_at).getTime()).toBe(new Date(2026, 8, 2, 9, 0).getTime());
    r = await service.handleAction(1, "snooze", { until: "friday at 3" });
    expect(new Date(r.handoff.trigger_at).getTime()).toBe(new Date(2026, 8, 4, 15, 0).getTime());
    r = await service.handleAction(1, "done");
    expect(r.handoff.status).toBe("completed");
    store.create({ title: "y", when: "in 1m" }, clock);
    r = await service.handleAction(2, "dismiss");
    expect(r.handoff.status).toBe("dismissed");
  });

  it("open with no destination returns null launch", async () => {
    store.create({ title: "no dest", when: "in 1m" }, clock);
    const r = await service.handleAction(1, "open");
    expect(r.launch).toBeNull();
  });

  it("rejects unknown actions", async () => {
    store.create({ title: "x", when: "in 1m" }, clock);
    await expect(service.handleAction(1, "explode")).rejects.toThrow(/Unknown action/);
  });
});
