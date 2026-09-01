import fs from "node:fs";
import path from "node:path";
import type { Destination, DestinationType } from "./types.js";
import { expandHome, collapseHome } from "./paths.js";

const KNOWN_HOSTS: Array<[RegExp, string]> = [
  [/github\.com/, "GitHub"],
  [/gitlab\.com/, "GitLab"],
  [/vercel\.com/, "Vercel"],
  [/supabase\.(com|io)/, "Supabase"],
  [/firebase\.google\.com|console\.firebase/, "Firebase"],
  [/dashboard\.stripe\.com|stripe\.com/, "Stripe"],
  [/dash\.cloudflare\.com|cloudflare\.com/, "Cloudflare"],
  [/console\.cloud\.google\.com/, "Google Cloud"],
  [/console\.aws\.amazon\.com|aws\.amazon\.com/, "AWS"],
  [/render\.com/, "Render"],
  [/railway\.app/, "Railway"],
  [/netlify\.com|netlify\.app/, "Netlify"],
  [/linear\.app/, "Linear"],
  [/notion\.so/, "Notion"],
  [/localhost|127\.0\.0\.1/, "localhost"],
];

/** Infer a destination from a bare string: URL, directory, file, or custom URI. */
export function inferDestination(raw: string, label?: string): Destination {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return { type: "url", uri: s, label: label ?? labelForUrl(s) };
  if (/^(vscode|vscode-insiders|cursor|windsurf|codium):\/\//i.test(s)) return { type: "vscode", uri: s, label: label ?? "Editor" };
  if (/^claude(-cli)?:/i.test(s)) return { type: "claude", uri: s, label: label ?? "Resume in Claude" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return { type: "uri", uri: s, label: label ?? s.split(":")[0] };
  const expanded = expandHome(s);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  // file:line[:col] suffix
  const m = abs.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const filePart = m ? m[1] : abs;
  try {
    const st = fs.statSync(filePart);
    if (st.isDirectory()) return { type: "path", uri: abs, label: label ?? path.basename(abs) };
    return { type: "file", uri: abs, label: label ?? path.basename(filePart) };
  } catch {
    // Not on disk (yet). Treat as a path if it looks like one, else a generic URI.
    if (s.startsWith("/") || s.startsWith("~") || s.startsWith(".")) {
      return { type: m ? "file" : "path", uri: abs, label: label ?? path.basename(filePart) };
    }
    return { type: "uri", uri: s, label: label ?? s };
  }
}

export function labelForUrl(url: string): string {
  for (const [re, name] of KNOWN_HOSTS) if (re.test(url)) return name;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function destinationLabel(d: Destination): string {
  if (d.label) return d.label;
  switch (d.type) {
    case "url": return labelForUrl(d.uri);
    case "path": return collapseHome(d.uri);
    case "file": return path.basename(d.uri);
    case "claude": return "Resume in Claude";
    case "terminal": return "Terminal";
    case "vscode": return "Editor";
    default: return d.uri;
  }
}

export function makeDestination(type: DestinationType, uri: string, label?: string): Destination {
  return { type, uri, label };
}
