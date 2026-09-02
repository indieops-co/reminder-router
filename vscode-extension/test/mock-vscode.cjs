/**
 * Minimal `vscode` API stand-in so the bundled extension can be exercised in plain
 * Node against a live daemon (the sandbox can't download VS Code). The real
 * VS Code run is test/runTest.mjs.
 */
const Module = require("node:module");
const path = require("node:path");

const log = [];
const commands = new Map();
const contexts = {};
let workspaceRoot = process.cwd();
let config = { port: Number(process.env.HANDOFF_PORT || 7399), cliPath: "handoff", notifyInEditor: true, showAllProjectsInTree: false, claudeCommand: "claude", pollSeconds: 30 };
let nextMessageAnswer = undefined;
let nextInputs = [];
const terminals = [];

class Emitter { constructor() { this.ls = []; } get event() { return (l) => { this.ls.push(l); return { dispose() {} }; }; } fire(v) { this.ls.forEach((l) => l(v)); } dispose() {} }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString { constructor() { this.value = ""; } appendMarkdown(s) { this.value += s; return this; } }
class Uri { constructor(fsPath) { this.fsPath = fsPath; this.scheme = "file"; } static file(p) { return new Uri(p); } static parse(s) { const u = new Uri(s); u.scheme = s.split(":")[0]; return u; } toString() { return this.fsPath; } }
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }

const statusItems = [];
const vscode = {
  log, contexts, statusItems, terminals,
  setWorkspace(root) { workspaceRoot = root; },
  answerNext(v) { nextMessageAnswer = v; },
  queueInputs(arr) { nextInputs = arr; },
  EventEmitter: Emitter, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Uri, Range,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  commands: {
    registerCommand(id, fn) { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
    async executeCommand(id, ...args) {
      if (id === "setContext") { contexts[args[0]] = args[1]; return; }
      const fn = commands.get(id);
      if (!fn) { log.push(`(no command ${id})`); return; }
      return fn(...args);
    },
    async getCommands() { return [...commands.keys()]; },
  },
  window: {
    createOutputChannel: (name) => ({ name, appendLine: (s) => log.push(`[out] ${s}`), dispose() {} }),
    createTreeView: (id, opts) => ({ id, provider: opts.treeDataProvider, dispose() {} }),
    createStatusBarItem: () => { const it = { show() {}, hide() {}, dispose() {} }; statusItems.push(it); return it; },
    setStatusBarMessage: (s) => log.push(`[status] ${s}`),
    showInformationMessage: async (msg, ...btns) => { log.push(`[info] ${msg} ${btns.filter((b) => typeof b === "string").join("|")}`); const a = nextMessageAnswer; nextMessageAnswer = undefined; return a; },
    showWarningMessage: async (msg, ...btns) => { log.push(`[warn] ${msg}`); const a = nextMessageAnswer; nextMessageAnswer = undefined; return a; },
    showErrorMessage: async (msg) => { log.push(`[error] ${msg}`); },
    showQuickPick: async (items, opts) => { log.push(`[quickpick] ${opts?.title ?? ""} (${items.length})`); const a = nextInputs.shift(); return a === undefined ? undefined : items.find((i) => i.label === a || i.label.includes(a)) ?? a; },
    showInputBox: async (opts) => { log.push(`[input] ${opts?.title ?? ""}`); return nextInputs.shift(); },
    createInputBox() {
      const box = { value: "", handlers: {}, show() { const v = nextInputs.shift(); if (v === undefined) return this.handlers.hide?.(); this.value = v; this.handlers.change?.(v); setTimeout(() => this.handlers.accept?.(), 400); }, hide() { this.handlers.hide?.(); }, dispose() {},
        onDidChangeValue(f) { this.handlers.change = f; }, onDidAccept(f) { this.handlers.accept = f; }, onDidHide(f) { this.handlers.hide = f; } };
      return box;
    },
    createQuickPick() {
      const qp = { value: "", items: [], selectedItems: [], handlers: {}, show() { const v = nextInputs.shift(); if (v === undefined) return this.handlers.hide?.(); this.value = v; this.handlers.change?.(v); setTimeout(() => { this.selectedItems = this.items.filter((i) => i.when === v || i.description === v).slice(0, 1); this.handlers.accept?.(); }, 400); }, hide() { this.handlers.hide?.(); }, dispose() {},
        onDidChangeValue(f) { this.handlers.change = f; }, onDidAccept(f) { this.handlers.accept = f; }, onDidHide(f) { this.handlers.hide = f; } };
      return qp;
    },
    createTerminal: (opts) => { const t = { name: opts.name, cwd: opts.cwd, sent: [], show() {}, sendText(s) { this.sent.push(s); } }; terminals.push(t); return t; },
    showTextDocument: async (doc, opts) => { log.push(`[showdoc] ${doc.fileName} line ${opts?.selection?.start.line}`); },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    get activeTextEditor() { return undefined; },
    get activeTerminal() { return terminals[terminals.length - 1]; },
  },
  workspace: {
    get workspaceFolders() { return [{ uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }]; },
    getWorkspaceFolder: (uri) => ({ uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot) }),
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async (k, v) => { config[k] = v; } }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async (p) => ({ fileName: p }),
  },
  env: { clipboard: { text: "", async writeText(t) { this.text = t; } }, openExternal: async (uri) => { log.push(`[open] ${uri.fsPath}`); return true; } },
  extensions: { getExtension: () => undefined },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return origLoad.call(this, request, ...rest);
};
module.exports = vscode;
