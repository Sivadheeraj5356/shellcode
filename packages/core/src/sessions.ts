import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChatMessage } from "./types";

export interface SessionData {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  /** model-facing history */
  history: ChatMessage[];
  /** what the UI showed, so a resumed chat looks the same */
  entries: unknown[];
}

export function sessionsDir() { return join(process.env.SHELLCODE_HOME ?? join(homedir(), ".shellcode"), "sessions"); }

export function newSessionId() { return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6); }

export async function saveSession(s: SessionData, dir = sessionsDir()) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${s.id}.json`), JSON.stringify({ ...s, updatedAt: new Date().toISOString() }));
}

export async function loadSession(id: string, dir = sessionsDir()): Promise<SessionData | null> {
  try { return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")); } catch { return null; }
}

export async function listSessions(dir = sessionsDir()): Promise<Pick<SessionData, "id" | "cwd" | "title" | "updatedAt">[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter((n) => n.endsWith(".json"))) {
    try { const s = JSON.parse(await readFile(join(dir, n), "utf8")); out.push({ id: s.id, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt }); } catch {}
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
