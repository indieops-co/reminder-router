import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.js";
import { Store } from "../src/core/store.js";
import { HandoffService } from "../src/daemon/service.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { LogNotifier } from "../src/notify/notifier.js";
import { createApiServer } from "../src/api/server.js";

let base = "";
let server: ReturnType<typeof createApiServer>;
let store: Store;

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return { status: res.status, json };
};

beforeAll(async () => {
  store = new Store(openDb(":memory:"));
  const service = new HandoffService({ store, notifier: new LogNotifier(() => undefined), config: DEFAULT_CONFIG, log: () => undefined });
  server = createApiServer(service, { port: 0, version: "test" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("local API", () => {
  it("health", async () => {
    const { status, json } = await api("GET", "/health");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("creates with the compact PRD payload", async () => {
    const { status, json } = await api("POST", "/handoffs", {
      title: "Finish OAuth",
      when: "tomorrow 10am",
      project: "Acme",
      destination: "https://console.cloud.google.com/x",
      context: "Waiting on verification",
      resumePrompt: "Read AUTH.md",
      source: "claude",
    });
    expect(status).toBe(200);
    expect(json.id).toBe(1);
    expect(json.project.name).toBe("Acme");
    expect(json.project.code).toBe("P-001");
    expect(json.actions[0]).toMatchObject({ type: "url", label: "Google Cloud" });
    expect(json.created_by).toBe("claude");
    expect(json.resume_prompt).toBe("Read AUTH.md");
  });

  it("splits a trailing time out of the title when no `when` is given", async () => {
    const { json } = await api("POST", "/handoffs", { title: "check deployment in 30m" });
    expect(json.title).toBe("check deployment");
  });

  it("validates", async () => {
    expect((await api("POST", "/handoffs", { when: "tomorrow" })).status).toBe(400);
    expect((await api("POST", "/handoffs", { title: "x" })).status).toBe(400);
    expect((await api("GET", "/handoffs/999")).status).toBe(404);
    expect((await api("GET", "/nope")).status).toBe(404);
  });

  it("lists, patches, snoozes, completes", async () => {
    let r = await api("GET", "/handoffs");
    expect(r.json.map((h: any) => h.id)).toEqual([2, 1]);
    r = await api("PATCH", "/handoffs/1", { nextAction: "Set branding", addDestination: "https://github.com/a/b" });
    expect(r.json.next_action).toBe("Set branding");
    expect(r.json.actions.map((a: any) => a.label)).toEqual(["Google Cloud", "GitHub"]);
    r = await api("POST", "/handoffs/1/snooze", { until: "in 2h" });
    expect(r.json.handoff.status).toBe("snoozed");
    r = await api("POST", "/handoffs/2/complete");
    expect(r.json.handoff.status).toBe("completed");
    r = await api("GET", "/handoffs?status=completed");
    expect(r.json).toHaveLength(1);
    r = await api("GET", "/handoffs/1/events");
    expect(r.json.map((e: any) => e.kind)).toContain("snoozed");
  });

  it("/actions is what the notification helper calls", async () => {
    const r = await api("POST", "/actions", { id: 1, action: "tomorrow" });
    expect(r.json.ok).toBe(true);
    expect(r.json.message).toMatch(/Snoozed/);
  });

  it("/parse previews times", async () => {
    expect((await api("POST", "/parse", { when: "every weekday 8am" })).json.kind).toBe("recurring");
    expect((await api("POST", "/parse", { when: "friday at 3" })).json.kind).toBe("once");
    expect((await api("POST", "/parse", { when: "gibberish" })).status).toBe(400);
  });

  it("/inbox buckets and /projects", async () => {
    const r = await api("GET", "/inbox");
    expect(r.json).toHaveProperty("due");
    expect(r.json.counts.completed).toBe(1);
    const p = await api("GET", "/projects");
    expect(p.json[0]).toMatchObject({ name: "Acme", code: "P-001" });
    const one = await api("GET", "/projects/acme");
    expect(one.json.handoffs).toHaveLength(1);
  });

  it("serves the inbox page", async () => {
    const res = await fetch(base + "/");
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/Handoffs/);
  });
});
