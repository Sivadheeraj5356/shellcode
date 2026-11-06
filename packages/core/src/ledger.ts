// Outcome ledger + model failure cooldown + escalation signal.
// Rebuild (2026-11-05) of features lost with local commit 84c7b19 (Oct 24);
// reimplemented from the recorded feature list in todo-01M5Q8KPGQQR1Z6PG51GA2NY13,
// not recovered source. Provenance: new code, tested here.
import { appendFile, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Tier } from "./types";

export function shellcodeHome(env: Record<string, string | undefined> = process.env): string {
  return env.SHELLCODE_HOME ?? join(homedir(), ".shellcode");
}

export type RunOutcome = "edited" | "answered" | "no-change" | "error";

export interface LedgerEntry {
  ts: string;
  cwd: string;
  /** first 200 chars of the prompt - enough to recognise a retry of the same task */
  promptHead: string;
  tier: Tier;
  model?: string;
  fallbacks: number;
  toolsUsed: string[];
  filesChanged: string[];
  outcome: RunOutcome;
  error?: string;
  /** wall time of the run */
  ms: number;
}

export function ledgerPath(env?: Record<string, string | undefined>): string {
  return join(shellcodeHome(env), "ledger.jsonl");
}

export async function appendLedger(e: LedgerEntry, env?: Record<string, string | undefined>): Promise<void> {
  const p = ledgerPath(env);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(e) + "\n", "utf8");
}

export async function readLedger(env?: Record<string, string | undefined>, limit = 200): Promise<LedgerEntry[]> {
  try {
    const text = await readFile(ledgerPath(env), "utf8");
    const lines = text.trim().split("\n").filter(Boolean).slice(-limit);
    const out: LedgerEntry[] = [];
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ } }
    return out;
  } catch { return []; }
}

export function promptHead(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Count recent failed attempts at the same task (same cwd + same prompt head)
 * so routing can escalate the tier on the next try. Only looks back 24h.
 */
export function recentFailures(entries: LedgerEntry[], cwd: string, prompt: string, now = Date.now()): number {
  const head = promptHead(prompt);
  let n = 0;
  for (const e of entries) {
    if (now - new Date(e.ts).getTime() > 24 * 3600 * 1000) continue;
    // only real failures count: "answered" (no edits needed) is a success
    if (e.cwd === cwd && e.promptHead === head && (e.outcome === "no-change" || e.outcome === "error")) n++;
  }
  return n;
}

// ---- model failure cooldown ----

export interface CooldownState { failures: number; cooldownUntil: string; }
type CooldownFile = Record<string, CooldownState>;

const MAX_COOLDOWN_MIN = 60;

export function cooldownPath(env?: Record<string, string | undefined>): string {
  return join(shellcodeHome(env), "cooldowns.json");
}

export async function readCooldowns(env?: Record<string, string | undefined>): Promise<CooldownFile> {
  try { return JSON.parse(await readFile(cooldownPath(env), "utf8")); } catch { return {}; }
}

async function writeCooldowns(c: CooldownFile, env?: Record<string, string | undefined>): Promise<void> {
  const p = cooldownPath(env);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(c, null, 1), "utf8");
}

/** Exponential backoff per model: 1, 2, 4, ... minutes, capped at 60. */
export function backoffMinutes(failures: number): number {
  return Math.min(MAX_COOLDOWN_MIN, 2 ** Math.max(0, failures - 1));
}

export async function recordModelFailure(modelKey: string, env?: Record<string, string | undefined>, now = Date.now()): Promise<CooldownState> {
  const all = await readCooldowns(env);
  const prev = all[modelKey];
  const active = prev && new Date(prev.cooldownUntil).getTime() > now;
  const failures = active ? prev.failures + 1 : 1;
  const state: CooldownState = { failures, cooldownUntil: new Date(now + backoffMinutes(failures) * 60_000).toISOString() };
  all[modelKey] = state;
  await writeCooldowns(all, env);
  return state;
}

export async function clearModelFailure(modelKey: string, env?: Record<string, string | undefined>): Promise<void> {
  const all = await readCooldowns(env);
  if (modelKey in all) { delete all[modelKey]; await writeCooldowns(all, env); }
}

/** True when the model is inside its cooldown window. */
export function inCooldown(all: CooldownFile, modelKey: string, now = Date.now()): boolean {
  const s = all[modelKey];
  return !!s && new Date(s.cooldownUntil).getTime() > now;
}
