import * as vscode from "vscode";
import { HandoffApi, type Handoff, type Inbox } from "./api";
import { projectDir } from "./capture";

type Node = SectionNode | HandoffNode;

class SectionNode extends vscode.TreeItem {
  constructor(public readonly key: keyof Inbox, label: string, public readonly items: Handoff[]) {
    super(label, items.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.description = String(items.length);
    this.contextValue = "section";
  }
}

export class HandoffNode extends vscode.TreeItem {
  constructor(public readonly handoff: Handoff, showProject: boolean) {
    super(handoff.title, vscode.TreeItemCollapsibleState.None);
    const h = handoff;
    const proj = showProject && h.project ? `${h.project.name} · ` : "";
    this.description = `${proj}${h.status === "due" ? "due " : ""}${h.when_label}${h.recurrence_label ? " ↻" : ""}${h.status === "snoozed" ? " (snoozed)" : ""}`;
    this.id = `handoff-${h.id}`;
    this.iconPath = new vscode.ThemeIcon(
      h.status === "due" ? "circle-filled" : "circle-outline",
      new vscode.ThemeColor(h.status === "due" ? "charts.red" : soon(h) ? "charts.orange" : "charts.green"),
    );
    this.contextValue = "handoff" + (h.resume_prompt || h.source_session_id ? " resumable" : "");
    this.tooltip = tooltip(h);
    this.command = { command: "handoff.details", title: "Show", arguments: [this] };
  }
}

function soon(h: Handoff): boolean {
  return new Date(h.trigger_at).getTime() - Date.now() < 60 * 60_000;
}

function tooltip(h: Handoff): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${h.title}** \`#${h.id}\`  \n`);
  md.appendMarkdown(`${new Date(h.trigger_at).toLocaleString()} (${h.when_label})${h.recurrence_label ? ` · ↻ ${h.recurrence_label}` : ""}  \n`);
  if (h.project) md.appendMarkdown(`$(folder) ${h.project.code} ${h.project.name}${h.git_branch ? ` · $(git-branch) ${h.git_branch}` : ""}  \n`);
  if (h.reason_paused) md.appendMarkdown(`\n**Paused:** ${h.reason_paused}  \n`);
  if (h.next_action) md.appendMarkdown(`**Next:** ${h.next_action}  \n`);
  if (h.actions.length) md.appendMarkdown(`\n${h.actions.map((a) => `$(arrow-right) ${a.label}`).join(" · ")}`);
  return md;
}

export class HandoffTree implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private inbox: Inbox | null = null;
  private projectId: number | null = null;
  daemonUp = true;

  constructor(private api: HandoffApi) {}

  async refresh(): Promise<Inbox | null> {
    try {
      const dir = projectDir();
      const showAll = vscode.workspace.getConfiguration("handoff").get<boolean>("showAllProjectsInTree", false);
      const [inbox, ctx] = await Promise.all([this.api.inbox(), dir && !showAll ? this.api.context(dir).catch(() => null) : Promise.resolve(null)]);
      this.projectId = ctx?.project?.id ?? null;
      this.inbox = showAll || !this.projectId ? inbox : filterInbox(inbox, this.projectId);
      this.daemonUp = true;
    } catch {
      this.inbox = null;
      this.daemonUp = false;
    }
    const empty = !this.inbox || ["due", "today", "tomorrow", "later"].every((k) => (this.inbox as any)[k].length === 0);
    vscode.commands.executeCommand("setContext", "handoff.daemonDown", !this.daemonUp);
    vscode.commands.executeCommand("setContext", "handoff.empty", empty);
    this._onDidChange.fire(undefined);
    return this.inbox;
  }

  getTreeItem(el: Node): vscode.TreeItem {
    return el;
  }

  getChildren(el?: Node): Node[] {
    if (!this.inbox) return [];
    if (!el) {
      const showProject = !this.projectId;
      const sections: SectionNode[] = [
        new SectionNode("due", "Due now", this.inbox.due),
        new SectionNode("today", "Today", this.inbox.today),
        new SectionNode("tomorrow", "Tomorrow", this.inbox.tomorrow),
        new SectionNode("later", "Later", this.inbox.later),
        new SectionNode("recurring", "Recurring", this.inbox.recurring),
        new SectionNode("completed", "Completed", this.inbox.completed.slice(0, 8)),
      ];
      (sections as any).showProject = showProject;
      return sections.filter((s) => s.items.length > 0 || s.key === "due");
    }
    if (el instanceof SectionNode) {
      const showProject = !this.projectId;
      const items = el.key === "completed" ? el.items : el.items;
      return items.map((h) => new HandoffNode(h, showProject));
    }
    return [];
  }
}

function filterInbox(inbox: Inbox, projectId: number): Inbox {
  const mine = (arr: Handoff[]) => arr.filter((h) => h.project?.id === projectId);
  return {
    ...inbox,
    // Due items from other projects still show (that's the whole point), but nothing else.
    due: inbox.due,
    today: mine(inbox.today),
    tomorrow: mine(inbox.tomorrow),
    later: mine(inbox.later),
    recurring: mine(inbox.recurring),
    completed: mine(inbox.completed),
  };
}
