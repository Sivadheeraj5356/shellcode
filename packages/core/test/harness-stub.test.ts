// Synthetic stub-binary verification: proves the spawn wiring, argv mapping and
// doctor detection for CLI harness adapters WITHOUT installing vendor CLIs.
// The stubs are not the real tools; no vendor auth, network or billing involved.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent, harnessStatus } from "../src/agent";
import { CLI_HARNESSES } from "../src/harness/cli";
import { DEFAULT_CONFIG } from "../src/config";
import type { ModelInfo } from "../src/types";

let dir: string;
let env: Record<string, string | undefined>;

function makeStub(bin: string) {
  const p = join(dir, bin);
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo stub-1.0; exit 0; fi\nprintf '%s\\n' "$@" > "${dir}/${bin}.argv"\necho stub-output\nexit 0\n`);
  chmodSync(p, 0o755);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "shellcode-stub-"));
  makeStub("claude");
  makeStub("gemini");
  env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const paidModel: ModelInfo = { provider: "anthropic", id: "claude-stub", tier: "standard", free: false, cost: "paid" };

async function drain(gen: AsyncGenerator<any>) {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

test("claude-code adapter: spawn wiring + documented argv, no yolo flag by default", async () => {
  const events = await drain(runAgent(
    { prompt: "say hi", cwd: dir, harness: "claude-code", model: "anthropic/claude-stub", acknowledgeExternalCost: true },
    { cfg: { ...DEFAULT_CONFIG, harness: "claude-code" }, env, models: [paidModel] }
  ));
  expect(events.some(e => e.type === "done" && e.harness === "claude-code")).toBe(true);
  const argv = readFileSync(join(dir, "claude.argv"), "utf8").split("\n").filter(Boolean);
  expect(argv).toContain("-p");
  expect(argv).toContain("say hi");
  expect(argv).toContain("--model");
  expect(argv).toContain("anthropic/claude-stub"); // pin passed exactly as given (documented behavior)
  expect(argv).not.toContain("--permission-mode");
});

test("claude-code adapter: yolo maps only to documented acceptEdits", async () => {
  await drain(runAgent(
    { prompt: "say hi", cwd: dir, harness: "claude-code", model: "anthropic/claude-stub", yolo: true, acknowledgeExternalCost: true },
    { cfg: { ...DEFAULT_CONFIG, harness: "claude-code" }, env, models: [paidModel] }
  ));
  const argv = readFileSync(join(dir, "claude.argv"), "utf8").split("\n").filter(Boolean);
  expect(argv).toContain("acceptEdits");
  expect(argv).not.toContain("--dangerously-skip-permissions");
});

test("gemini-cli adapter: -m model flag wiring", async () => {
  await drain(runAgent(
    { prompt: "say hi", cwd: dir, harness: "gemini-cli", model: "google/gstub", acknowledgeExternalCost: true },
    { cfg: { ...DEFAULT_CONFIG, harness: "gemini-cli" }, env,
      models: [{ ...paidModel, provider: "google", id: "gstub" }] }
  ));
  const argv = readFileSync(join(dir, "gemini.argv"), "utf8").split("\n").filter(Boolean);
  expect(argv).toEqual(["-p", "say hi", "-m", "google/gstub"]); // full pin passed as given
});

test("doctor: stub binaries detected ready, absent harnesses report not installed", async () => {
  const statuses = await harnessStatus(env as any, false);
  const claude = statuses.find(s => s.id === "claude-code")!;
  expect(claude.ready).toBe(true);
  expect(statuses.length).toBe(1 + CLI_HARNESSES.length);
  const absent = statuses.filter(s => s.kind === "cli" && !["claude-code", "gemini-cli"].includes(s.id));
  for (const s of absent) expect(s.ready).toBe(false);
});

test("cost gate fails closed without acknowledgment", async () => {
  const events = await drain(runAgent(
    { prompt: "say hi", cwd: dir, harness: "claude-code", model: "anthropic/claude-stub" },
    { cfg: { ...DEFAULT_CONFIG, harness: "claude-code" }, env, models: [paidModel] }
  ));
  expect(events.some(e => e.type === "error" && /not started/.test(e.message))).toBe(true);
  expect(existsSync(join(dir, "claude.argv"))).toBe(true); // from earlier tests only
});
