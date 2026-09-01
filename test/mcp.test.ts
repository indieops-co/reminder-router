import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../src/core/db.js";
import { Store } from "../src/core/store.js";
import { createMcpServer } from "../src/mcp/server.js";
import { sessionStartContext } from "../src/mcp/hooks.js";

let client: Client;
let store: Store;
const projectDir = process.cwd(); // this repo — has a git root + package.json name

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: any };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError ?? false, data: r.structuredContent };
};

beforeAll(async () => {
  store = new Store(openDb(":memory:"));
  const server = createMcpServer(store, { sessionId: "0f1e2d3c-4b5a-6978-8899-aabbccddeeff", projectDir, cwd: projectDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});
afterAll(async () => {
  await client.close();
});

describe("MCP server", () => {
  it("lists the expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "complete_handoff", "create_handoff", "dismiss_handoff", "due_now", "get_handoff", "list_handoffs",
      "list_projects", "open_handoff", "parse_when", "project_history", "resume_handoff", "snooze_handoff", "update_handoff",
    ]);
  });

  it("create_handoff captures project, repo, branch and session", async () => {
    const r = await call("create_handoff", {
      title: "Finish OAuth branding",
      when: "tomorrow 10am",
      why_paused: "Waiting for domain verification",
      next_action: "Configure consent screen",
      context: "Objective: OAuth in prod.\nState: verification pending.\nFiles: AUTH.md",
      resume_prompt: "Read AUTH.md. Verify. Continue. Summarize current status before changing code.",
      urls: ["https://console.cloud.google.com/apis"],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Created handoff #1/);
    expect(r.text).toMatch(/reminder-router/);
    const h = store.get(1)!;
    expect(h.source_session_id).toBe("0f1e2d3c-4b5a-6978-8899-aabbccddeeff");
    expect(h.repo_path).toBe(projectDir);
    expect(h.agent_type).toBe("claude");
    expect(h.created_by).toBe("mcp");
    expect(h.destinations[0]).toMatchObject({ type: "url", label: "Google Cloud" });
    expect(r.data.daemon_running).toBe(false);
  });

  it("create_handoff with no_capture and a recurrence", async () => {
    const r = await call("create_handoff", { title: "Submit hours", every: "friday 4pm", no_capture: true });
    expect(r.text).toMatch(/every Friday at 4:00 PM/);
    expect(store.get(2)!.project_id).toBeNull();
  });

  it("errors are reported, not thrown", async () => {
    const r = await call("create_handoff", { title: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/time is required/i);
  });

  it("list_handoffs defaults to the current project", async () => {
    const mine = await call("list_handoffs");
    expect(mine.text).toMatch(/#1/);
    expect(mine.text).not.toMatch(/#2/);
    const all = await call("list_handoffs", { all_projects: true });
    expect(all.text).toMatch(/#2/);
  });

  it("resume_handoff returns the markdown and logs an event", async () => {
    const r = await call("resume_handoff", { id: 1 });
    expect(r.text).toMatch(/## Resume prompt/);
    expect(r.text).toMatch(/complete_handoff with id 1/);
    expect(store.events(1).some((e) => e.kind === "opened")).toBe(true);
  });

  it("snooze / complete / dismiss / update", async () => {
    let r = await call("snooze_handoff", { id: 1, until: "2h" });
    expect(r.text).toMatch(/snoozed until/);
    expect(store.get(1)!.status).toBe("snoozed");
    r = await call("update_handoff", { id: 1, next_action: "Ship it", add_url: "https://github.com/a/b/pull/1" });
    expect(store.get(1)!.next_action).toBe("Ship it");
    r = await call("complete_handoff", { id: 1 });
    expect(store.get(1)!.status).toBe("completed");
    r = await call("dismiss_handoff", { id: 2, stop: true });
    expect(store.get(2)!.status).toBe("dismissed");
    r = await call("complete_handoff", { id: 99 });
    expect(r.isError).toBe(true);
  });

  it("project_history and list_projects", async () => {
    const h = await call("project_history");
    expect(h.text).toMatch(/reminder-router/);
    expect(h.text).toMatch(/#1 Finish OAuth branding \[completed\]/);
    const p = await call("list_projects");
    expect(p.text).toMatch(/P-001 reminder-router/);
  });

  it("parse_when", async () => {
    expect((await call("parse_when", { text: "every weekday 8am" })).text).toMatch(/Recurring/);
    expect((await call("parse_when", { text: "friday at 3" })).text).toMatch(/Once/);
    expect((await call("parse_when", { text: "???" })).isError).toBe(true);
  });

  it("due_now", async () => {
    store.create({ title: "overdue thing", when: "in 1m", repoPath: projectDir, project: "reminder-router" });
    store.markFired(3, new Date());
    const r = await call("due_now");
    expect(r.text).toMatch(/#3 \[due\]/);
  });
});

describe("SessionStart hook", () => {
  it("emits open + due handoffs for the project", () => {
    const ctx = sessionStartContext(store, { cwd: projectDir, session_id: "abc" });
    expect(ctx).toMatch(/1 open handoff for reminder-router/);
    expect(ctx).toMatch(/#3 overdue thing \(DUE/);
  });
  it("is silent when there is nothing", () => {
    const empty = new Store(openDb(":memory:"));
    expect(sessionStartContext(empty, { cwd: "/tmp" })).toBeNull();
  });
});
