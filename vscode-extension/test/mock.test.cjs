// node test/mock.test.cjs — needs a daemon on HANDOFF_PORT (default 7399).
const assert = require("node:assert");
const path = require("node:path");
const vscode = require("./mock-vscode.cjs");
const ext = require("../dist/extension.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = process.env.HANDOFF_PORT || "7399";
const api = async (m, p, b) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();

(async () => {
  const repo = path.resolve(__dirname, "..", "..");
  vscode.setWorkspace(repo);
  const subs = [];
  ext.activate({ subscriptions: subs });
  await sleep(800);
  const status = vscode.statusItems[0];
  assert.ok(status.text.includes("handoffs") || status.text.includes("due"), "status bar text: " + status.text);
  assert.equal(vscode.contexts["handoff.daemonDown"], false);

  // Composer: title with trailing time → created with capture (project = this repo, branch set).
  vscode.queueInputs(["smoke: check the deploy in 45m"]);
  vscode.answerNext(undefined);
  await vscode.commands.executeCommand("handoff.remindProject");
  await sleep(1500);
  let list = await api("GET", "/handoffs?status=all");
  let h = list.find((x) => x.title === "smoke: check the deploy");
  assert.ok(h, "composer created the handoff (log: " + vscode.log.slice(-5).join(" / ") + ")");
  assert.equal(h.project.name, "reminder-router");
  assert.ok(h.git_branch, "branch captured");
  assert.equal(h.created_by, "extension");

  // Composer: no time typed → preset quick pick ("in 1h").
  vscode.queueInputs(["smoke: preset flow", "in 1h"]);
  await vscode.commands.executeCommand("handoff.remindProject");
  await sleep(1500);
  list = await api("GET", "/handoffs?status=all");
  const h2 = list.find((x) => x.title === "smoke: preset flow");
  assert.ok(h2, "preset flow created");
  const delta = new Date(h2.trigger_at) - Date.now();
  assert.ok(delta > 55 * 60_000 && delta < 65 * 60_000, "≈1h away");

  // URL mode → url destination first.
  vscode.queueInputs(["https://github.com/a/b/pull/9", "smoke: review pr tomorrow 10am"]);
  await vscode.commands.executeCommand("handoff.remindUrl");
  await sleep(1500);
  list = await api("GET", "/handoffs?status=all");
  const h3 = list.find((x) => x.title === "smoke: review pr");
  assert.ok(h3 && h3.actions[0].type === "url" && h3.actions[0].label === "GitHub", "url destination");

  // Make one due, refresh → in-editor alert + status bar red.
  await api("POST", `/handoffs/${h.id}/reschedule`, { when: "in 1s" });
  await sleep(1200);
  await api("POST", "/tick");
  await vscode.commands.executeCommand("handoff.refresh");
  await sleep(600);
  assert.ok(status.text.includes("due"), "status shows due: " + status.text);
  assert.ok(vscode.log.some((l) => l.startsWith("[info]") && l.includes("smoke: check the deploy")), "in-editor alert shown");

  // Tree contents.
  const tree = subs.find((s) => s && s.provider)?.provider;
  const sections = tree.getChildren();
  const due = sections.find((s) => s.label === "Due now");
  assert.ok(due && due.items.some((x) => x.id === h.id), "due section has it");
  const node = tree.getChildren(due).find((n) => n.handoff.id === h.id);
  assert.ok(node.contextValue.includes("handoff"));

  // Actions: snooze via quick pick, done, resume in Claude (terminal + clipboard), delete.
  vscode.queueInputs(["1h"]);
  await vscode.commands.executeCommand("handoff.snooze", node);
  await sleep(300);
  assert.equal((await api("GET", `/handoffs/${h.id}`)).status, "snoozed");
  await vscode.commands.executeCommand("handoff.done", h.id);
  await sleep(300);
  assert.equal((await api("GET", `/handoffs/${h.id}`)).status, "completed");

  await api("PATCH", `/handoffs/${h2.id}`, { resumePrompt: "Read X. Summarize current status before changing code." });
  const full = await api("GET", `/handoffs/${h2.id}`);
  await vscode.commands.executeCommand("handoff.resumeInClaude", full);
  const term = vscode.terminals[vscode.terminals.length - 1];
  assert.equal(term.sent[0], "claude");
  assert.ok(vscode.env.clipboard.text.startsWith("Read X"), "resume prompt on clipboard");

  // Open a file destination in-editor.
  await api("PATCH", `/handoffs/${h2.id}`, { addDestination: `${repo}/README.md:12` });
  const withFile = await api("GET", `/handoffs/${h2.id}`);
  const fileIdx = withFile.actions.findIndex((a) => a.type === "file");
  await vscode.commands.executeCommand("handoff.details", withFile); // renders the card
  const { default: _ } = { default: null };
  vscode.queueInputs([]);
  // call openDestination through the "open" command with index via details? use API-level: extension exports none, so exercise via open command (primary) after reordering
  await api("PATCH", `/handoffs/${h2.id}`, { destinations: [withFile.actions[fileIdx]].map((a) => ({ type: a.type, uri: a.uri, label: a.label })) });
  await vscode.commands.executeCommand("handoff.open", await api("GET", `/handoffs/${h2.id}`));
  assert.ok(vscode.log.some((l) => l.includes("[showdoc]") && l.includes("README.md line 11")), "file opened at line");

  vscode.answerNext("Delete");
  await vscode.commands.executeCommand("handoff.delete", h3.id);
  await sleep(300);
  const gone = await fetch(`http://127.0.0.1:${port}/handoffs/${h3.id}`);
  assert.equal(gone.status, 404);

  for (const s of subs) s.dispose?.();
  console.log("MOCK VS CODE TEST PASSED");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  console.error(vscode.log.slice(-15).join("\n"));
  process.exit(1);
});
