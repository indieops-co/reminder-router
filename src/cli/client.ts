import { loadConfig } from "../core/config.js";
import { readDaemonState, pidAlive } from "../daemon/daemon.js";

export interface ApiClient {
  base: string;
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  patch<T = any>(path: string, body?: unknown): Promise<T>;
  del<T = any>(path: string): Promise<T>;
}

export function apiClient(port = loadConfig().port): ApiClient {
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text };
    }
    if (!res.ok) throw new Error(json?.error ?? `${res.status} ${res.statusText}`);
    return json;
  };
  return {
    base,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b ?? {}),
    del: (p) => call("DELETE", p),
  };
}

/** True when the daemon answers on its port. */
export async function daemonUp(port = loadConfig().port): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export function daemonLooksInstalled(): boolean {
  const s = readDaemonState();
  return !!(s && pidAlive(s.pid));
}
