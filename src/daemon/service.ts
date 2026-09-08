import type { Config } from "../core/config.js";
import type { Handoff } from "../core/types.js";
import { Store } from "../core/store.js";
import { nextOccurrence } from "../parse/recurrence.js";
import { parseWhen } from "../parse/when.js";
import type { NotificationAction, NotificationRequest, Notifier } from "../notify/notifier.js";
import { DEFAULT_ACTIONS } from "../notify/notifier.js";
import { effectiveDestinations, openDestination, type LaunchResult } from "../launch/launcher.js";
import { destinationLabel } from "../core/destinations.js";

/** "Open GitHub", but never "Open Open Project". */
export function openLabel(label: string): string {
  return /^open\b/i.test(label) ? label : `Open ${label}`;
}

export interface ServiceDeps {
  store: Store;
  notifier: Notifier;
  config: Config;
  log: (msg: string) => void;
  now?: () => Date;
}

/**
 * The scheduler brain. Pure enough to unit test: give it a store, a notifier,
 * a config and a clock, and call tick().
 */
export class HandoffService {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly config: Config;
  private log: (msg: string) => void;
  private clock: () => Date;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.config = deps.config;
    this.log = deps.log;
    this.clock = deps.now ?? (() => new Date());
  }

  now(): Date {
    return this.clock();
  }

  /** One scheduler pass. Returns the ids that fired this tick. */
  async tick(): Promise<number[]> {
    const now = this.now();
    const fired: number[] = [];
    const quiet = this.inQuietHours(now);

    // 1. Overdue: re-notify gently, and roll recurring ones forward if they were ignored past the next occurrence.
    for (const h of this.store.due()) {
      if (h.recurrence) {
        // Walk forward to the latest occurrence that has already arrived, so a week
        // of missed dailies becomes one reminder, not seven.
        const anchor = new Date(h.created_at);
        let latest: Date | null = null;
        let cursor = nextOccurrence(h.recurrence, new Date(h.trigger_at), anchor);
        for (let i = 0; i < 1000 && cursor.getTime() <= now.getTime(); i++) {
          latest = cursor;
          cursor = nextOccurrence(h.recurrence, cursor, anchor);
        }
        if (latest) {
          this.store.advance(h, now, "advanced", latest);
          this.log(`advanced recurring #${h.id} (missed occurrence) → ${latest.toISOString()}`);
          continue;
        }
      }
      if (quiet || !h.notification_enabled) continue;
      const every = this.config.renotifyMinutes;
      if (every > 0 && h.notified_count > 0 && h.notified_count <= this.config.renotifyMax) {
        const last = h.last_notified_at ? new Date(h.last_notified_at).getTime() : 0;
        if (now.getTime() - last >= every * 60_000) await this.sendNotification(h, now, true);
      }
    }
    // 2. Newly due (including recurring ones just rolled forward above).
    for (const h of this.store.pending(now)) {
      if (quiet && h.notification_enabled) continue; // hold until quiet hours end
      const due = this.store.markFired(h.id, now);
      fired.push(h.id);
      if (due.notification_enabled) await this.sendNotification(due, now);
      else this.log(`due (silent) #${h.id} ${h.title}`);
    }

    return fired;
  }

  inQuietHours(now: Date): boolean {
    const { quietStart, quietEnd } = this.config;
    if (!quietStart || !quietEnd) return false;
    const toMin = (s: string) => {
      const [h, m] = s.split(":").map(Number);
      return h * 60 + (m || 0);
    };
    const start = toMin(quietStart), end = toMin(quietEnd);
    const cur = now.getHours() * 60 + now.getMinutes();
    return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  }

  buildNotification(h: Handoff, reminder = false): NotificationRequest {
    const project = h.project_id ? this.store.getProject(h.project_id) : null;
    const primary = effectiveDestinations(h)[0];
    const title = project ? project.name : h.title;
    const subtitle = project ? h.title : undefined;
    const bodyParts: string[] = [];
    if (h.next_action) bodyParts.push(`Next: ${h.next_action}`);
    else if (h.reason_paused) bodyParts.push(h.reason_paused);
    else if (h.context_summary) bodyParts.push(h.context_summary.split("\n")[0]);
    if (reminder) bodyParts.unshift("Still waiting —");
    return {
      id: h.id,
      title,
      subtitle,
      body: bodyParts.join(" ").slice(0, 200) || (primary ? openLabel(destinationLabel(primary)) : ""),
      primary: primary ? openLabel(destinationLabel(primary)) : "Open",
      actions: DEFAULT_ACTIONS,
      sound: this.config.sound,
    };
  }

  async sendNotification(h: Handoff, now: Date, reminder = false): Promise<void> {
    try {
      await this.notifier.notify(this.buildNotification(h, reminder));
      this.store.markNotified(h.id, now);
      this.log(`${reminder ? "re-notified" : "notified"} #${h.id} ${h.title} via ${this.notifier.name}`);
    } catch (err) {
      this.log(`notification failed for #${h.id}: ${(err as Error).message}`);
    }
  }

  /** Handle a click/button from a notification, the inbox, or the CLI. */
  async handleAction(id: number, action: NotificationAction | string, extra: { until?: string; index?: number } = {}): Promise<{ handoff: Handoff; launch?: LaunchResult | null; message: string }> {
    const now = this.now();
    const h = this.store.mustGet(id);
    switch (action) {
      case "open": {
        const launch = await this.open(h, extra.index ?? 0);
        return { handoff: this.store.mustGet(id), launch, message: launch?.message ?? "Nothing to open" };
      }
      case "done": {
        const done = this.store.complete(id, now);
        await this.notifier.remove?.(id);
        return { handoff: done, message: done.recurrence ? `Done — next ${done.trigger_at}` : "Completed" };
      }
      case "dismiss": {
        const d = this.store.dismiss(id, now);
        await this.notifier.remove?.(id);
        return { handoff: d, message: "Dismissed" };
      }
      case "snooze15":
      case "snooze60":
      case "tomorrow":
      case "snooze": {
        let until: Date;
        if (action === "snooze15") until = new Date(now.getTime() + 15 * 60_000);
        else if (action === "snooze60") until = new Date(now.getTime() + 60 * 60_000);
        else if (action === "tomorrow") until = parseWhen("tomorrow", { now, config: this.config })!.at;
        else {
          const parsed = extra.until ? parseWhen(extra.until, { now, config: this.config }) : null;
          until = parsed?.at ?? new Date(now.getTime() + 15 * 60_000);
        }
        const s = this.store.snooze(id, until, now);
        await this.notifier.remove?.(id);
        return { handoff: s, message: `Snoozed until ${until.toLocaleString()}` };
      }
      default:
        throw new Error(`Unknown action "${action}"`);
    }
  }

  async open(h: Handoff, index = 0): Promise<LaunchResult | null> {
    const dests = effectiveDestinations(h);
    const d = dests[index];
    if (!d) return null;
    const res = await openDestination(h, d, this.config);
    this.store.addEvent(h.id, "opened", `${d.type} ${d.uri}${res.ok ? "" : " (failed: " + res.message.slice(0, 200) + ")"}`, this.now());
    this.log(`open #${h.id} → ${d.type} ${d.uri}: ${res.message}`);
    return res;
  }
}
