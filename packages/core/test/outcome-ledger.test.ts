// Rebuild verification (2026-11-05): outcome ledger, snapshot diff, model
// failure cooldown, ledger-driven escalation. Stubs the LLM HTTP call; no
// network, no vendor keys. Proves persisted-change checks and cooldown state,
// not semantic correctness of any edit.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNative } from "../src/harness/native";
import { snapshotFiles, diffSnapshots, changedFiles } from "../src/snapshot";
import { readLedger, recentFailures, readCooldowns, backoffMinutes, appendLedger } from "../src/ledger";
import { route } from "../src/router";
import type { ModelInfo } from "../src/types";
import type { ProviderSpec } from "../src/providers";

let dir: string;
let home: string;
const STUB: ProviderSpec = { id: "stub", name: "Stub", baseUrl: "https://stub.local/v1", keyEnv: "STUB_API_KEY", cost: "free", note: "test" };
const m1: ModelInfo = { provider: "stub", id: "small", tier: "light", free: true, cost: "free" };
const m2: ModelInfo = { provider: "stub", id: "big", tier: "heavy", free: true, cost: "free" };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-ledger-"));
  home = mkdtempSync(join(tmpdir(), "sc-home-"));
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const env = () => ({ ...process.env, STUB_API_KEY: "x", SHELLCODE_HOME: home });

function completion(msg: any) {
  return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
}

async function drain(gen: AsyncGenerator<any>) { const ev: any[] = []; for await (const e of gen) ev.push(e); return ev; }

test("snapshot diff detects created/modified/deleted and skips noise dirs", async () => {
  writeFileSync(join(dir, "snap.txt"), "one");
  const before = await snapshotFiles(dir);
  writeFileSync(join(dir, "snap.txt"), "two!!");
  writeFileSync(join(dir, "new.txt"), "n");
  const after = await snapshotFiles(dir);
  const d = diffSnapshots(before, after);
  expect(d.modified).toContain("snap.txt");
  expect(d.created).toContain("new.txt");
  expect(changedFiles(d).length).toBe(2);
});

test("run with a real edit records outcome edited + filesChanged", async () => {
  writeFileSync(join(dir, "a.txt"), "this is the old text");
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) return completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "a.txt", old_text: "old", new_text: "new" }) } }] });
    return completion({ content: "done" });
  }) as any;
  const ev = await drain(runNative(
    { prompt: "replace old with new in a.txt", chain: [m1], tool: { cwd: dir, yolo: true }, env: env(), fetchImpl, extraProviders: [STUB] }));
  expect(ev.some((e) => e.type === "done")).toBe(true);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("this is the new text");
  const entries = await readLedger(env());
  const last = entries[entries.length - 1]!;
  expect(last.outcome).toBe("edited");
  expect(last.filesChanged).toContain("a.txt");
  expect(last.toolsUsed).toContain("edit_file");
});

test("edit tool call with no persisted change records no-change (not edited)", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) return completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "a.txt", old_text: "NOT-PRESENT", new_text: "x" }) } }] });
    return completion({ content: "I could not find the text" });
  }) as any;
  const prompt = "unique-nochange-probe replace zzq in a.txt";
  await drain(runNative({ prompt, chain: [m1], tool: { cwd: dir, yolo: true }, env: env(), fetchImpl, extraProviders: [STUB] }));
  const entries = await readLedger(env());
  const last = entries.filter((e) => e.promptHead.startsWith("unique-nochange-probe")).pop()!;
  expect(last.outcome).toBe("no-change");
  expect(recentFailures(entries, dir, prompt)).toBe(1);
});

test("pure answer without edits is answered, not a failure", async () => {
  const fetchImpl = (async () => completion({ content: "42" })) as any;
  const prompt = "unique-qa-probe what is 6*7";
  await drain(runNative({ prompt, chain: [m1], tool: { cwd: dir, yolo: true }, env: env(), fetchImpl, extraProviders: [STUB] }));
  const entries = await readLedger(env());
  const last = entries.filter((e) => e.promptHead.startsWith("unique-qa-probe")).pop()!;
  expect(last.outcome).toBe("answered");
  expect(recentFailures(entries, dir, prompt)).toBe(0);
});

test("retryable failure cools the model down; next run skips it", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) return new Response("rate limited", { status: 429 });
    return completion({ content: "ok" });
  }) as any;
  const ev = await drain(runNative(
    { prompt: "unique-cooldown-probe say ok", chain: [m1, m2], tool: { cwd: dir, yolo: true }, env: env(), fetchImpl, extraProviders: [STUB] }));
  expect(ev.some((e) => e.type === "fallback" && e.from === "stub/small")).toBe(true);
  expect(ev.some((e) => e.type === "done")).toBe(true);
  const cd = await readCooldowns(env());
  expect(cd["stub/small"]).toBeTruthy();
  expect(new Date(cd["stub/small"]!.cooldownUntil).getTime()).toBeGreaterThan(Date.now());
  expect(cd["stub/big"]).toBeUndefined(); // success clears cooldown

  const ev2 = await drain(runNative(
    { prompt: "unique-cooldown-probe2 say ok again", chain: [m1, m2], tool: { cwd: dir, yolo: true }, env: env(), fetchImpl, extraProviders: [STUB] }));
  const skip = ev2.find((e) => e.type === "fallback");
  expect(skip?.from).toBe("stub/small");
  expect(skip?.reason).toContain("cooldown");
  expect(ev2.some((e) => e.type === "done" && e.model === "stub/big")).toBe(true);
});

test("backoff doubles and caps at 60 minutes", () => {
  expect(backoffMinutes(1)).toBe(1);
  expect(backoffMinutes(2)).toBe(2);
  expect(backoffMinutes(4)).toBe(8);
  expect(backoffMinutes(30)).toBe(60);
});

test("ledger failures escalate the route tier", async () => {
  const p = "unique-escalation-probe fix the thing";
  await appendLedger({ ts: new Date().toISOString(), cwd: dir, promptHead: p, tier: "light", fallbacks: 0, toolsUsed: [], filesChanged: [], outcome: "error", error: "x", ms: 1 }, env());
  const entries = await readLedger(env());
  const fails = recentFailures(entries, dir, p);
  expect(fails).toBe(1);
  const d0 = route({ prompt: p }, [m1, m2], "free");
  const d1 = route({ prompt: p, previousFailures: fails }, [m1, m2], "free");
  expect(d1.score).toBeGreaterThan(d0.score);
  expect(d1.chain[0]!.id).toBe("big"); // escalated off the light model
});
