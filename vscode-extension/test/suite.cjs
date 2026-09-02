const vscode = require("vscode");
const assert = require("node:assert");

exports.run = async function run() {
  const port = process.env.HANDOFF_PORT || "7399";
  await vscode.workspace.getConfiguration("handoff").update("port", Number(port), vscode.ConfigurationTarget.Global);
  const ext = vscode.extensions.getExtension("indieops.reminder-router");
  assert.ok(ext, "extension not found");
  await ext.activate();
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ["handoff.remindProject", "handoff.showDue", "handoff.refresh", "handoff.done", "handoff.resumeInClaude", "handoff.startDaemon"]) {
    assert.ok(cmds.includes(c), `missing command ${c}`);
  }
  // Talk to the live daemon the way the extension does.
  const res = await fetch(`http://127.0.0.1:${port}/handoffs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "vscode smoke test", when: "in 1m", repoPath: vscode.workspace.workspaceFolders[0].uri.fsPath, capture: true, source: "extension" }),
  });
  const h = await res.json();
  assert.equal(h.created_by, "extension");
  assert.ok(h.project && h.project.name === "reminder-router", "project captured: " + JSON.stringify(h.project));
  assert.ok(h.git_branch, "branch captured");
  await vscode.commands.executeCommand("handoff.refresh");
  await new Promise((r) => setTimeout(r, 1500));
  await vscode.commands.executeCommand("handoff.done", h.id);
  await new Promise((r) => setTimeout(r, 500));
  const after = await (await fetch(`http://127.0.0.1:${port}/handoffs/${h.id}`)).json();
  assert.equal(after.status, "completed");
  await vscode.commands.executeCommand("handoff.details", after);
  await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  console.log("VS CODE SMOKE TEST PASSED");
};
