import { Command, Option } from "commander";
import fs from "node:fs";
import path from "node:path";
import { Store, HandoffError } from "../core/store.js";
import { getDb } from "../core/db.js";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type Config } from "../core/config.js";
import { captureContext } from "../core/git.js";
import { inferDestination } from "../core/destinations.js";
import { parseId, projectCode } from "../core/ids.js";
import type { AgentType, Destination, Handoff, NewHandoffInput } from "../core/types.js";
import { parseWhen, splitTitleAndWhen, formatWhen } from "../parse/when.js";
import { parseEvery } from "../parse/recurrence.js";
import { HandoffService } from "../daemon/service.js";
import { LogNotifier } from "../notify/notifier.js";
import { runDaemon, readDaemonState, pidAlive, packageVersion } from "../daemon/daemon.js";
import { installLaunchAgent, uninstallLaunchAgent, restartLaunchAgent, launchAgentInstalled, plistPath } from "../daemon/launchd.js";
import { apiClient, daemonUp } from "./client.js";
import { handoffLine, handoffDetail, resumeMarkdown, dim, bold, green, red, yellow, cyan } from "./format.js";
import { handoffHome, dbPath, logPath, expandHome } from "../core/paths.js";
import { openUri } from "../launch/launcher.js";
import { buildNotifier } from "./build-notifier.js";

const program = new Command();
const version = packageVersion();

program
  .name("handoff")
  .description("Reminders that take you back to the work.\n\nCreate a context-aware reminder from anywhere; when it lands, one click returns you to the right project, URL, or Claude session.")
  .version(version)
  .option("--json", "machine-readable output")
  .showHelpAfterError();

const lazyStore = (() => {
  let s: Store | null = null;
  return () => (s ??= new Store(getDb()));
})();

function fail(msg: string, code = 1): never {
  console.error(red("✗ ") + msg);
  process.exit(code);
}

function jsonMode(): boolean {
  return Boolean(program.opts().json);
}

function out(obj: unknown, text: string | (() => string)): void {
  if (jsonMode()) console.log(JSON.stringify(obj, null, 2));
  else console.log(typeof text === "function" ? text() : text);
}

async function localService(): Promise<HandoffService> {
  const store = lazyStore();
  return new HandoffService({ store, notifier: new LogNotifier(() => undefined), config: loadConfig(), log: () => undefined });
}

/** Run an action through the daemon when it's up (so notifications get cleared), else locally. */
async function act(id: number, action: string, extra: { until?: string; index?: number } = {}) {
  if (await daemonUp()) {
    const r = await apiClient().post(`/handoffs/${id}/${action === "done" ? "complete" : action === "snooze15" || action === "snooze60" || action === "tomorrow" ? "snooze" : action}`, {
      until: action === "snooze15" ? "in 15m" : action === "snooze60" ? "in 1h" : action === "tomorrow" ? "tomorrow" : extra.until,
      index: extra.index,
    });
    return { message: r.message as string, handoff: r.handoff as Handoff, launch: r.launch };
  }
  const svc = await localService();
  return svc.handleAction(id, action, extra);
}

function idArg(s: string): number {
  const id = parseId(s);
  if (!id) fail(`"${s}" is not a handoff id (try: handoff list)`);
  return id;
}

async function warnIfDaemonDown(): Promise<void> {
  if (jsonMode()) return;
  if (!(await daemonUp())) {
    console.error(yellow("! ") + dim(`The reminder daemon isn't running — nothing will fire until it is. Start it: ${bold("handoff daemon install")}`));
  }
}

// ---------------------------------------------------------------- add

program
  .command("add")
  .alias("a")
  .description("Create a handoff. The time can trail the title: handoff add \"check deploy in 30m\"")
  .argument("<title...>", "what to come back to (a trailing time phrase is understood)")
  .option("-i, --in <duration>", 'relative: "30m", "2h", "3 days"')
  .option("-t, --at <when>", 'absolute: "tomorrow 10am", "friday at 3", "sept 15 noon"')
  .option("-e, --every <rule>", 'recurring: "monday 9am", "weekdays 8:30", "first business day of the month"')
  .option("-u, --url <url>", "destination URL (repeatable)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("-d, --dest <destination>", "any destination: URL, folder, file[:line], vscode:// URI (repeatable)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("-p, --path <dir>", "project directory (default: current directory)")
  .option("-P, --project <name>", "project name (default: detected from git/package.json)")
  .option("-f, --file <file>", "relevant file (default: none)")
  .option("-n, --next <text>", "next action")
  .option("-w, --why <text>", "why the work paused")
  .option("-c, --context <text>", "short context summary (use - to read stdin)")
  .option("-r, --resume <prompt>", "resume prompt for the coding agent (use - to read stdin, or @file)")
  .option("-a, --agent <agent>", "claude | cursor | codex | gemini | copilot | other")
  .option("--terminal", "add a terminal destination in the project directory")
  .option("--no-capture", "don't capture the current directory / git info")
  .option("--no-notify", "silent: track it, don't notify")
  .option("--source <source>", "who created it: cli | claude | extension | api | mcp", "cli")
  .option("--session <id>", "originating agent session id (Claude Code: ${CLAUDE_SESSION_ID}); enables Resume in Claude → claude --resume")
  .action(async (titleWords: string[], opts) => {
    const cfg = loadConfig();
    let title = titleWords.join(" ").trim();
    let when: string | undefined = opts.at;
    if (opts.in) when = parseWhenFromIn(opts.in);
    if (!when && !opts.every) {
      const split = splitTitleAndWhen(title, { config: cfg });
      if (split.when) {
        title = split.title;
        when = split.when;
      }
    }
    if (!when && !opts.every) fail(`When? Add a time: handoff add "${title}" tomorrow 10am   (or --in 30m / --every "monday 9am")`);

    const input: NewHandoffInput = {
      title,
      when,
      every: opts.every,
      nextAction: opts.next,
      reasonPaused: opts.why,
      context: readTextOpt(opts.context),
      resumePrompt: readTextOpt(opts.resume),
      agent: opts.agent as AgentType,
      notify: opts.notify,
      createdBy: opts.source,
      sourceSessionId: opts.session ?? process.env.CLAUDE_SESSION_ID ?? undefined,
      destinations: [],
    };

    if (opts.capture !== false) {
      const dir = opts.path ? path.resolve(expandHome(opts.path)) : process.cwd();
      const ctx = captureContext(dir);
      input.repoPath = ctx.repoRoot ?? dir;
      input.gitBranch = ctx.branch ?? undefined;
      input.project = opts.project ?? ctx.projectName;
      if (opts.file) input.currentFile = path.resolve(expandHome(opts.file));
      if (opts.terminal) input.destinations!.push({ type: "terminal", uri: input.repoPath!, label: "Terminal" });
      // register the repo remote on the project
      if (ctx.remote) lazyStore().upsertProject({ name: input.project, path: input.repoPath, repo: ctx.remote });
    } else if (opts.project) {
      input.project = opts.project;
    }

    for (const u of opts.url as string[]) input.destinations!.push(inferDestination(u));
    for (const d of opts.dest as string[]) input.destinations!.push(inferDestination(d));

    try {
      const h = lazyStore().create(input);
      const project = h.project_id ? lazyStore().getProject(h.project_id) : null;
      out({ ...h, project }, () => `${green("✓")} ${handoffLine(h, project)}`);
      await warnIfDaemonDown();
    } catch (err) {
      if (err instanceof HandoffError) fail(err.message);
      throw err;
    }
  });

function parseWhenFromIn(v: string): string {
  return /^in\s/i.test(v) ? v : `in ${v}`;
}

function readTextOpt(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v === "-") return fs.readFileSync(0, "utf8").trim();
  if (v.startsWith("@") && fs.existsSync(expandHome(v.slice(1)))) return fs.readFileSync(expandHome(v.slice(1)), "utf8").trim();
  return v;
}

// ---------------------------------------------------------------- list / now / show

program
  .command("list")
  .alias("ls")
  .description("Open handoffs, soonest first (due ones on top)")
  .option("-a, --all", "include completed and dismissed")
  .option("--done", "only completed/dismissed")
  .option("-r, --recurring", "only recurring")
  .option("-p, --project <name>", "filter by project name / code")
  .option("-q, --search <text>", "search titles and context")
  .option("-l, --limit <n>", "max rows", (v) => Number(v))
  .action(async (opts) => {
    const store = lazyStore();
    const project = opts.project ? store.findProject(opts.project) : null;
    if (opts.project && !project) fail(`No project matches "${opts.project}"`);
    const list = store.list({
      status: opts.done ? ["completed", "dismissed"] : opts.all ? "all" : "open",
      projectId: project?.id,
      recurringOnly: opts.recurring,
      search: opts.search,
      limit: opts.limit,
    });
    const now = new Date();
    out(list, () => {
      if (list.length === 0) return dim("No handoffs. Create one:  handoff add \"check deployment\" --in 30m");
      const projects = new Map(store.listProjects().map((p) => [p.id, p]));
      return list.map((h) => handoffLine(h, h.project_id ? projects.get(h.project_id) ?? null : null, now)).join("\n");
    });
    if (!jsonMode()) await warnIfDaemonDown();
  });

program
  .command("now")
  .description("What needs you right now (due handoffs)")
  .action(async () => {
    const store = lazyStore();
    const due = store.due();
    out(due, () => {
      if (due.length === 0) return green("Nothing is waiting on you.");
      const projects = new Map(store.listProjects().map((p) => [p.id, p]));
      return due.map((h) => handoffLine(h, h.project_id ? projects.get(h.project_id) ?? null : null)).join("\n");
    });
  });

program
  .command("show")
  .alias("s")
  .description("Everything about one handoff")
  .argument("<id>")
  .option("--events", "include the event history")
  .action((id: string, opts) => {
    const store = lazyStore();
    const h = store.get(idArg(id));
    if (!h) fail(`Handoff ${id} not found`);
    const project = h.project_id ? store.getProject(h.project_id) : null;
    const events = opts.events ? store.events(h.id) : undefined;
    out({ ...h, project, events }, () => {
      let s = handoffDetail(h, project);
      if (events) s += "\n  " + dim("history") + "\n" + events.map((e) => `    ${dim(formatWhen(new Date(e.at)))}  ${e.kind}${e.detail ? dim("  " + e.detail) : ""}`).join("\n");
      return s;
    });
  });

program
  .command("resume")
  .description("Print the handoff as Markdown a coding agent can read to pick the work back up")
  .argument("<id>")
  .action((id: string) => {
    const store = lazyStore();
    const h = store.get(idArg(id));
    if (!h) fail(`Handoff ${id} not found`);
    const project = h.project_id ? store.getProject(h.project_id) : null;
    out({ ...h, project, markdown: resumeMarkdown(h, project) }, resumeMarkdown(h, project));
  });

// ---------------------------------------------------------------- actions

program
  .command("open")
  .alias("o")
  .description("Jump to a handoff's destination (default: the primary one)")
  .argument("<id>")
  .argument("[n]", "destination index from `handoff show`", "0")
  .action(async (id: string, n: string) => {
    try {
      const r = await act(idArg(id), "open", { index: Number(n) });
      out(r, () => (r.launch?.ok === false ? red("✗ ") : green("→ ")) + r.message);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("done")
  .alias("d")
  .description("Complete a handoff (recurring ones advance to the next occurrence)")
  .argument("<ids...>")
  .action(async (ids: string[]) => {
    for (const id of ids) {
      try {
        const r = await act(idArg(id), "done");
        out(r.handoff, `${green("✓")} #${r.handoff.id} ${r.handoff.title} — ${r.message}`);
      } catch (err) {
        fail((err as Error).message);
      }
    }
  });

program
  .command("snooze")
  .alias("z")
  .description('Push a handoff back: handoff snooze 12 [15m | 2h | "tomorrow 9am"] (default 15m)')
  .argument("<id>")
  .argument("[when...]")
  .action(async (id: string, whenWords: string[]) => {
    const when = whenWords.length ? whenWords.join(" ") : "15m";
    const until = parseWhen(/^\d+\s*[smhdw]/i.test(when) ? `in ${when}` : when, { config: loadConfig() });
    if (!until) fail(`Couldn't understand "${when}"`);
    try {
      const r = await act(idArg(id), "snooze", { until: until.at.toISOString() });
      out(r.handoff, `${yellow("z")} #${r.handoff.id} ${r.handoff.title} — snoozed until ${formatWhen(until.at)}`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("skip")
  .description("Dismiss this occurrence (one-shots close; recurring ones move to the next occurrence)")
  .argument("<id>")
  .action(async (id: string) => {
    const r = await act(idArg(id), "dismiss");
    out(r.handoff, `${dim("–")} #${r.handoff.id} ${r.handoff.title} — ${r.message}`);
  });

program
  .command("stop")
  .description("Stop a recurring handoff for good")
  .argument("<id>")
  .action((id: string) => {
    const h = lazyStore().stop(idArg(id));
    out(h, `${dim("–")} #${h.id} ${h.title} — stopped`);
  });

program
  .command("reopen")
  .description("Bring a completed handoff back as due")
  .argument("<id>")
  .action((id: string) => {
    const h = lazyStore().reopen(idArg(id));
    out(h, `${red("●")} #${h.id} ${h.title} — reopened`);
  });

program
  .command("rm")
  .alias("delete")
  .description("Delete handoffs permanently")
  .argument("<ids...>")
  .action((ids: string[]) => {
    for (const id of ids) {
      try {
        lazyStore().delete(idArg(id));
        out({ deleted: idArg(id) }, `${dim("✗")} deleted #${idArg(id)}`);
      } catch (err) {
        fail((err as Error).message);
      }
    }
  });

program
  .command("edit")
  .alias("e")
  .description("Change a handoff")
  .argument("<id>")
  .option("-T, --title <title>")
  .option("-t, --at <when>", "new time")
  .option("-i, --in <duration>")
  .option("-e, --every <rule>", 'new recurrence (or "none")')
  .option("-u, --url <url>", "add a destination URL")
  .option("-d, --dest <destination>", "add a destination")
  .option("-n, --next <text>")
  .option("-w, --why <text>")
  .option("-c, --context <text>")
  .option("-r, --resume <prompt>")
  .option("-P, --project <name>")
  .option("-p, --path <dir>", "repo path")
  .option("--notify", "turn notifications on")
  .option("--no-notify", "turn notifications off")
  .action((id: string, opts) => {
    try {
      const h = lazyStore().update(idArg(id), {
        title: opts.title,
        when: opts.in ? parseWhenFromIn(opts.in) : opts.at,
        every: opts.every === "none" ? null : opts.every,
        addDestination: opts.url ?? opts.dest,
        nextAction: opts.next,
        reasonPaused: opts.why,
        context: readTextOpt(opts.context),
        resumePrompt: readTextOpt(opts.resume),
        project: opts.project,
        repoPath: opts.path ? path.resolve(expandHome(opts.path)) : undefined,
        notify: opts.notify,
      });
      const project = h.project_id ? lazyStore().getProject(h.project_id) : null;
      out(h, `${green("✓")} ${handoffLine(h, project)}`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

// ---------------------------------------------------------------- projects

const projects = program.command("projects").alias("p").description("Known projects (they appear as you create handoffs)");
projects
  .command("list", { isDefault: true })
  .description("List projects")
  .action(() => {
    const store = lazyStore();
    const list = store.listProjects();
    out(list, () => {
      if (list.length === 0) return dim("No projects yet — they're created automatically from handoffs.");
      return list
        .map((p) => {
          const open = store.list({ projectId: p.id }).length;
          return `${dim(projectCode(p.id))}  ${bold(p.name).padEnd(28)} ${dim(p.path ?? "")}${open ? cyan(`  ${open} open`) : ""}`;
        })
        .join("\n");
    });
  });
projects
  .command("show")
  .argument("<project>")
  .description("A project's open handoffs and recent history")
  .action((q: string) => {
    const store = lazyStore();
    const p = store.findProject(q);
    if (!p) fail(`No project matches "${q}"`);
    const open = store.list({ projectId: p.id });
    const history = store.history(p.id, 10).filter((h) => h.status === "completed" || h.status === "dismissed");
    out({ ...p, open, history }, () => {
      const lines = [`${dim(projectCode(p.id))} ${bold(p.name)}${p.path ? dim("  " + p.path) : ""}${p.repo ? dim("  " + p.repo) : ""}`];
      lines.push(dim("open"));
      lines.push(open.length ? open.map((h) => "  " + handoffLine(h, null)).join("\n") : dim("  none"));
      if (history.length) {
        lines.push(dim("history"));
        lines.push(history.map((h) => "  " + handoffLine(h, null)).join("\n"));
      }
      return lines.join("\n");
    });
  });
projects
  .command("rename")
  .argument("<project>")
  .argument("<name>")
  .action((q: string, name: string) => {
    const store = lazyStore();
    const p = store.findProject(q);
    if (!p) fail(`No project matches "${q}"`);
    const r = store.renameProject(p.id, name);
    out(r, `${green("✓")} ${projectCode(r.id)} ${r.name}`);
  });

// ---------------------------------------------------------------- daemon

const daemon = program.command("daemon").description("The background service that fires reminders");
daemon
  .command("run")
  .description("Run in the foreground (launchd uses this)")
  .action(async () => {
    await runDaemon({ foreground: true });
  });
daemon
  .command("install")
  .description("Install + start the launchd agent so reminders fire at login")
  .action(async () => {
    try {
      const p = await installLaunchAgent();
      await new Promise((r) => setTimeout(r, 1200));
      const up = await daemonUp();
      out({ plist: p, up }, `${green("✓")} installed ${dim(p)}\n${up ? green("✓") + " daemon is running on http://127.0.0.1:" + loadConfig().port : yellow("!") + " daemon not answering yet — check " + logPath()}`);
    } catch (err) {
      fail((err as Error).message);
    }
  });
daemon
  .command("uninstall")
  .description("Stop and remove the launchd agent")
  .action(async () => {
    await uninstallLaunchAgent();
    out({ ok: true }, `${green("✓")} removed ${dim(plistPath())}`);
  });
daemon
  .command("restart")
  .action(async () => {
    if (await launchAgentInstalled()) {
      await restartLaunchAgent();
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      const s = readDaemonState();
      if (s && pidAlive(s.pid)) process.kill(s.pid, "SIGTERM");
      fail("No launch agent installed. Run `handoff daemon install`, or `handoff daemon run` in a terminal.");
    }
    out({ up: await daemonUp() }, (await daemonUp()) ? green("✓ restarted") : red("✗ not answering"));
  });
daemon
  .command("stop")
  .action(async () => {
    const s = readDaemonState();
    if (await launchAgentInstalled()) await uninstallLaunchAgent();
    if (s && pidAlive(s.pid)) process.kill(s.pid, "SIGTERM");
    out({ ok: true }, `${green("✓")} stopped`);
  });
daemon
  .command("status")
  .action(async () => {
    const cfg = loadConfig();
    const s = readDaemonState();
    const up = await daemonUp();
    let health: any = null;
    if (up) health = await apiClient().get("/health").catch(() => null);
    const installed = await launchAgentInstalled();
    out({ up, installed, state: s, health, home: handoffHome(), db: dbPath(), log: logPath() }, () => {
      const lines = [];
      lines.push(up ? `${green("●")} daemon running  pid ${s?.pid ?? health?.pid}  http://127.0.0.1:${cfg.port}  notifier: ${health?.notifier}` : `${red("●")} daemon not running`);
      lines.push(`${dim("launchd")}   ${installed ? "installed" : "not installed (run: handoff daemon install)"}`);
      lines.push(`${dim("home")}      ${handoffHome()}`);
      lines.push(`${dim("log")}       ${logPath()}`);
      if (health?.counts) lines.push(`${dim("counts")}    due ${health.counts.due} · scheduled ${health.counts.scheduled} · snoozed ${health.counts.snoozed} · recurring ${health.counts.recurring}`);
      return lines.join("\n");
    });
  });
daemon
  .command("logs")
  .option("-n <lines>", "lines", "40")
  .action((opts) => {
    try {
      const text = fs.readFileSync(logPath(), "utf8").trimEnd().split("\n");
      console.log(text.slice(-Number(opts.n)).join("\n"));
    } catch {
      console.log(dim("no log yet"));
    }
  });

// ---------------------------------------------------------------- misc

program
  .command("inbox")
  .description("Open the tiny web inbox served by the daemon")
  .action(async () => {
    const url = `http://127.0.0.1:${loadConfig().port}/`;
    if (!(await daemonUp())) fail("Daemon isn't running — start it with `handoff daemon install`.");
    await openUri(url);
    console.log(`${green("→")} ${url}`);
  });

program
  .command("parse")
  .description("Preview how a time phrase is understood")
  .argument("<when...>")
  .action((words: string[]) => {
    const text = words.join(" ");
    const cfg = loadConfig();
    const now = new Date();
    const rec = parseEvery(text, { now, morningHour: cfg.morningHour });
    if (rec) return out({ kind: "recurring", ...rec }, `↻ ${rec.label}`);
    const one = parseWhen(text, { now, config: cfg });
    if (one) return out({ kind: "once", at: one.at.toISOString(), label: one.label }, `${one.at.toLocaleString()}  ${dim("(" + one.label + ")")}`);
    fail(`Couldn't understand "${text}"`);
  });

program
  .command("test-notify")
  .description("Send a test notification through the daemon")
  .action(async () => {
    if (!(await daemonUp())) fail("Daemon isn't running.");
    const r = await apiClient().post("/test-notification");
    out(r, `${green("✓")} sent via ${r.notifier}`);
  });

program
  .command("config")
  .description("Show or set configuration (~/.handoff/config.json)")
  .argument("[key]")
  .argument("[value]")
  .action((key?: string, value?: string) => {
    const cfg = loadConfig(true);
    if (!key) return out(cfg, Object.entries(cfg).map(([k, v]) => `${k.padEnd(16)} ${JSON.stringify(v)}${JSON.stringify(v) === JSON.stringify((DEFAULT_CONFIG as any)[k]) ? "" : dim("  (custom)")}`).join("\n"));
    if (!(key in DEFAULT_CONFIG)) fail(`Unknown key "${key}". Keys: ${Object.keys(DEFAULT_CONFIG).join(", ")}`);
    if (value === undefined) return out({ [key]: (cfg as any)[key] }, JSON.stringify((cfg as any)[key]));
    const def = (DEFAULT_CONFIG as any)[key];
    let v: unknown = value;
    if (typeof def === "number") v = Number(value);
    else if (typeof def === "boolean") v = value === "true" || value === "1" || value === "on";
    saveConfig({ [key]: v } as Partial<Config>);
    out({ [key]: v }, `${green("✓")} ${key} = ${JSON.stringify(v)}${dim("  (restart the daemon to apply: handoff daemon restart)")}`);
  });

program
  .command("build-notifier")
  .description("Compile the Swift notification helper (needs Xcode command line tools)")
  .action(async () => {
    try {
      const p = await buildNotifier((m) => console.log(dim(m)));
      out({ app: p }, `${green("✓")} built ${p}\n${dim("Restart the daemon to use it: handoff daemon restart")}`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("mcp")
  .description("Run the MCP server over stdio (for Claude Code: claude mcp add handoff -- handoff mcp)")
  .action(async () => {
    const { runMcpStdio } = await import("../mcp/server.js");
    await runMcpStdio();
    await new Promise(() => undefined);
  });

const hook = program.command("hook").description("Claude Code hook handlers (read hook JSON on stdin)");
hook
  .command("session-start")
  .description("Emit open/due handoffs for the current project as session context")
  .action(async () => {
    const { runSessionStartHook } = await import("../mcp/hooks.js");
    runSessionStartHook();
  });

program
  .command("api")
  .description("Call the local API: handoff api GET /inbox")
  .argument("<method>")
  .argument("<path>")
  .argument("[json]")
  .action(async (method: string, p: string, json?: string) => {
    const client = apiClient();
    const body = json ? JSON.parse(json) : undefined;
    const m = method.toUpperCase();
    const r = m === "GET" ? await client.get(p) : m === "POST" ? await client.post(p, body) : m === "PATCH" ? await client.patch(p, body) : await client.del(p);
    console.log(JSON.stringify(r, null, 2));
  });

program.addOption(new Option("--home <dir>", "override ~/.handoff").hideHelp());
program.hook("preAction", (cmd) => {
  const home = cmd.opts().home ?? program.opts().home;
  if (home) process.env.HANDOFF_HOME = home;
});

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
