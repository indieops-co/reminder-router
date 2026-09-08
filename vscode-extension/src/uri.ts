import type * as vscode from "vscode";

export type DeepLink =
  | { kind: "handoff"; id: number }
  | { kind: "new"; title?: string; when?: string; url?: string }
  | { kind: "due" };

/**
 * The links the extension answers to (scheme = vscode:// in VS Code, cursor:// in Cursor, …):
 *   …/handoff/12   …/open/12   …/handoff?id=12      → show handoff #12
 *   …/new?title=…&when=…&url=…                     → composer, prefilled
 *   …/due                                          → What Needs Me Now
 */
export function parseDeepLink(uri: Pick<vscode.Uri, "path" | "query">): DeepLink | null {
  const parts = uri.path.split("/").filter(Boolean);
  const q = new URLSearchParams(uri.query ?? "");
  const head = (parts[0] ?? "").toLowerCase();
  const idFrom = (raw: string | null | undefined): DeepLink | null => {
    const id = Number((raw ?? "").replace(/^#/, ""));
    return Number.isInteger(id) && id > 0 ? { kind: "handoff", id } : null;
  };
  if (head === "handoff" || head === "open" || head === "show") return idFrom(parts[1] ?? q.get("id"));
  if (head === "new" || head === "add" || head === "remind") {
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = q.get(k)?.trim();
        if (v) return v;
      }
      return undefined;
    };
    return { kind: "new", title: pick("title", "what", "text"), when: pick("when", "at", "in"), url: pick("url") };
  }
  if (head === "due" || head === "now") return { kind: "due" };
  if (!head && q.get("id")) return idFrom(q.get("id"));
  return null;
}
