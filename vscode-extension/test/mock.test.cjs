// node test/mock.test.cjs — needs a daemon on HANDOFF_PORT (default 7399).
const assert = require("node:assert");
const path = require("node:path");
const vscode = require("./mock-vscode.cjs");
const ext = require("../dist/extension.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = process.env.HANDOFF_PORT || "7399";
const api = async (m, p, b) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();
/** Log lines appended since `mark`. */
const since = (mark) => vscode.log.slice(mark);

(async () => {
  const repo = path.resolve(__dirname, "..", "..");
  vscode.setWorkspace(repo);
  const subs = [];
  // globalState is shared across windows in VS Code; here one memento stands in for all of them.
  const memento = { data: {}, get(k, d) { return k in this.data ? this.data[k] : d; }, async update(k, v) { if (v === undefined) delete this.data[k]; else this.data[k] = v; } };
  ext.activate({ subscriptions: subs, globalState: memento });
  await sleep(800);
  const status = vscode.statusItems[0];
  assert.ok(status.text.includes("handoffs") || status.text.includes("due"), "status bar text: " + status.text);
  assert.equal(vscode.contexts["handoff.daemonDown"], false);
  assert.ok(vscode.uriHandler, "uri handler registered");

  // Composer: title with trailing time → created with capture (project = this repo, branch set).
  vscode.queueInputs(["smoke: check the deploy in 45m"]);
  vscode.answerNext(undefined);
  await vscode.commands.executeCommand("handoff.remindProject");
  await sleep(2200);
  let list = await api("GET", "/handoffs?status=all");
  let h = list.find((x) => x.title === "smoke: check the deploy");
  assert.ok(h, "composer created the handoff (log: " + vscode.log.slice(-5).join(" / ") + ")");
  assert.equal(h.project.name, "reminder-router");
  assert.ok(h.git_branch, "branch captured");
  assert.equal(h.created_by, "extension");

  // Composer: no time typed → preset quick pick ("in 1h").
  vscode.queueInputs(["smoke: preset flow", "in 1h"]);
  await vscode.commands.executeCommand("handoff.remindProject");
  await sleep(2200);
  list = await api("GET", "/handoffs?status=all");
  const h2 = list.find((x) => x.title === "smoke: preset flow");
  assert.ok(h2, "preset flow created");
  const delta = new Date(h2.trigger_at) - Date.now();
  assert.ok(delta > 55 * 60_000 && delta < 65 * 60_000, "≈1h away");

  // URL mode → url destination first.
  vscode.queueInputs(["https://github.com/a/b/pull/9", "smoke: review pr tomorrow 10am"]);
  await vscode.commands.executeCommand("handoff.remindUrl");
  await sleep(2200);
  list = await api("GET", "/handoffs?status=all");
  const h3 = list.find((x) => x.title === "smoke: review pr");
  assert.ok(h3 && h3.actions[0].type === "url" && h3.actions[0].label === "GitHub", "url destination");

  // Make one due, refresh → in-editor alert + status bar red.
  await api("POST", `/handoffs/${h.id}/reschedule`, { when: "in 1s" });
  await sleep(2200);
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
  assert.ok(/\bhandoff\b/.test(node.contextValue) && /\bopen\b/.test(node.contextValue) && /\bdue\b/.test(node.contextValue), "flags: " + node.contextValue);

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
  vscode.queueInputs([]);
  await api("PATCH", `/handoffs/${h2.id}`, { destinations: [withFile.actions[fileIdx]].map((a) => ({ type: a.type, uri: a.uri, label: a.label })) });
  await vscode.commands.executeCommand("handoff.open", await api("GET", `/handoffs/${h2.id}`));
  assert.ok(vscode.log.some((l) => l.includes("[showdoc]") && l.includes("README.md line 11")), "file opened at line");

  // ------------------------------------------------------------ deep links
  // …/handoff/<id> with the project open in this window → the details card.
  let mark = vscode.log.length;
  await vscode.uriHandler.handleUri(vscode.Uri.parse(`vscode://indieops.reminder-router/handoff/${h2.id}`));
  await sleep(300);
  assert.ok(since(mark).some((l) => l.includes(`[quickpick] #${h2.id}`)), "deep link showed the card");

  // Same link in a window that doesn't have the project → note left in globalState + offer; the right window consumes it on refresh.
  vscode.setWorkspace("/tmp");
  vscode.answerNext(undefined);
  mark = vscode.log.length;
  await vscode.uriHandler.handleUri(vscode.Uri.parse(`vscode://indieops.reminder-router/handoff/${h2.id}`));
  await sleep(300);
  assert.equal(memento.get("handoff.pendingLanding")?.id, h2.id, "pending landing recorded");
  assert.ok(since(mark).some((l) => l.startsWith("[info]") && l.includes("isn't open in this window")), "wrong-window offer shown");
  assert.ok(!since(mark).some((l) => l.includes(`[quickpick] #${h2.id}`)), "no card in the wrong window");
  vscode.setWorkspace(repo);
  mark = vscode.log.length;
  await vscode.commands.executeCommand("handoff.refresh");
  await sleep(600);
  assert.equal(memento.get("handoff.pendingLanding"), undefined, "pending landing consumed");
  assert.ok(since(mark).some((l) => l.includes(`[quickpick] #${h2.id}`)), "right window showed the card");

  // …/new?title&when → composer prefilled; nothing queued, so the prefilled value is accepted as typed.
  await vscode.uriHandler.handleUri(vscode.Uri.parse("vscode://indieops.reminder-router/new?title=smoke%3A%20from%20link&when=in%2020m"));
  await sleep(2200);
  list = await api("GET", "/handoffs?status=all");
  const h4 = list.find((x) => x.title === "smoke: from link");
  assert.ok(h4, "deep-link composer created (log: " + vscode.log.slice(-4).join(" / ") + ")");
  const d4 = new Date(h4.trigger_at) - Date.now();
  assert.ok(d4 > 17 * 60_000 && d4 < 23 * 60_000, "≈20m away: " + h4.trigger_at);

  // Unknown link → warning, no crash.
  mark = vscode.log.length;
  await vscode.uriHandler.handleUri(vscode.Uri.parse("vscode://indieops.reminder-router/whatever"));
  assert.ok(since(mark).some((l) => l.startsWith("[warn]") && l.includes("unrecognized")), "unknown link warned");

  // ------------------------------------------------------------ reschedule / edit / reopen / stop / search / copy link
  vscode.queueInputs(["in 2h"]);
  await vscode.commands.executeCommand("handoff.reschedule", h2.id);
  await sleep(2200);
  const r2 = await api("GET", `/handoffs/${h2.id}`);
  const d2 = new Date(r2.trigger_at) - Date.now();
  assert.ok(d2 > 115 * 60_000 && d2 < 125 * 60_000, "rescheduled ≈2h: " + r2.trigger_at);

  vscode.queueInputs(["Next action", "Ship it"]);
  await vscode.commands.executeCommand("handoff.edit", h2.id);
  await sleep(400);
  assert.equal((await api("GET", `/handoffs/${h2.id}`)).next_action, "Ship it", "next action edited");

  vscode.queueInputs(["Add URL", "https://vercel.com/me/app"]);
  await vscode.commands.executeCommand("handoff.edit", h2.id);
  await sleep(400);
  assert.ok((await api("GET", `/handoffs/${h2.id}`)).actions.some((a) => a.label === "Vercel"), "url added via edit");

  await vscode.commands.executeCommand("handoff.reopen", h.id);
  await sleep(300);
  assert.equal((await api("GET", `/handoffs/${h.id}`)).status, "due", "reopened → due");
  await api("POST", `/handoffs/${h.id}/complete`);

  const rec = await api("POST", "/handoffs", { title: "smoke: weekly", every: "every monday 9am", source: "extension", repoPath: repo, capture: true });
  assert.ok(rec.recurrence_label, "recurring created");
  vscode.queueInputs(["every tuesday 10am"]);
  await vscode.commands.executeCommand("handoff.reschedule", rec.id);
  await sleep(400);
  assert.ok(/Tuesday/.test((await api("GET", `/handoffs/${rec.id}`)).recurrence_label), "recurring rule changed");
  await vscode.commands.executeCommand("handoff.stopRecurring", rec.id);
  await sleep(300);
  assert.equal((await api("GET", `/handoffs/${rec.id}`)).status, "dismissed", "recurring stopped");

  mark = vscode.log.length;
  vscode.queueInputs(["preset", "smoke: preset flow"]);
  await vscode.commands.executeCommand("handoff.search");
  await sleep(400);
  assert.ok(since(mark).some((l) => l.includes("[quickpick] Handoffs matching")), "search quick pick shown");
  assert.ok(since(mark).some((l) => l.includes(`[quickpick] #${h2.id}`)), "search → details card");

  await vscode.commands.executeCommand("handoff.copyLink", h2.id);
  assert.equal(vscode.env.clipboard.text, `vscode://indieops.reminder-router/handoff/${h2.id}`, "link copied");

  await vscode.commands.executeCommand("handoff.refresh");
  await sleep(600);
  const nodes = tree.getChildren().flatMap((s) => tree.getChildren(s));
  const n2 = nodes.find((n) => n.handoff.id === h2.id);
  assert.ok(n2 && /\bopen\b/.test(n2.contextValue) && /\bresumable\b/.test(n2.contextValue), "open+resumable flags: " + n2?.contextValue);
  const nDone = nodes.find((n) => n.handoff.id === h.id);
  assert.ok(nDone && /\bclosed\b/.test(nDone.contextValue), "closed flag: " + nDone?.contextValue);

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
