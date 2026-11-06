// Synthetic stub-binary wiring proof for ALL CLI harness adapters. Stubs are
// not the real vendor tools; no vendor auth, network or billing is involved.
// Expected argv below is hand-written from each vendor's documented headless
// flags (the spec table's docs field), not derived from the code under test.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent } from "../src/agent";
import { DEFAULT_CONFIG } from "../src/config";

let dir: string;
let env: Record<string, string | undefined>;
const BINS = ["claude", "codex", "agent", "agy", "gemini", "opencode", "aider", "goose"];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "shellcode-allstub-"));
  for (const bin of BINS) {
    writeFileSync(join(dir, bin), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo stub-1.0; exit 0; fi\nprintf '%s\\n' "$@" > "${dir}/${bin}.argv"\necho ok\nexit 0\n`);
    chmodSync(join(dir, bin), 0o755);
  }
  env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const model = { provider: "p", id: "m", tier: "standard", free: false, cost: "paid" } as any;
const argvOf = (bin: string) => readFileSync(join(dir, `${bin}.argv`), "utf8").split("\n").filter(Boolean);

async function runOne(harness: string, pin: string, yolo = false) {
  for await (const e of runAgent(
    { prompt: "P", cwd: dir, harness, model: pin, yolo, acknowledgeExternalCost: true },
    { cfg: { ...DEFAULT_CONFIG, harness }, env, models: [model] })) {
    if (e.type === "error") throw new Error(`${harness}: ${e.message}`);
  }
}

// [harness, bin, pin, expected argv (no yolo), extra argv with yolo]
const CASES: Array<[string, string, string, (dir: string) => string[], (dir: string) => string[]]> = [
  ["claude-code", "claude", "p/m", () => ["-p", "P", "--model", "p/m"], () => ["-p", "P", "--model", "p/m", "--permission-mode", "acceptEdits"]],
  ["codex", "codex", "p/m", () => ["exec", "P"], () => ["exec", "--sandbox", "workspace-write", "P"]], // supportsModel false: no pin passed
  ["cursor", "agent", "p/m", (dir) => ["-p", "--model", "p/m", "--workspace", dir, "P"], (dir) => ["-p", "--model", "p/m", "--workspace", dir, "--force", "P"]],
  ["antigravity", "agy", "p/m", () => ["-p", "P", "--model", "p/m", "--output-format", "text"], () => ["-p", "P", "--model", "p/m", "--output-format", "text"]], // yolo passes nothing
  ["gemini-cli", "gemini", "p/m", () => ["-p", "P", "-m", "p/m"], () => ["-p", "P", "-m", "p/m", "--approval-mode", "auto_edit"]],
  ["aider", "aider", "p/m", () => ["--message", "P", "--yes-always", "--model", "p/m"], () => ["--message", "P", "--yes-always", "--model", "p/m"]], // --yes-always always present
  ["goose", "goose", "p/m", () => ["run", "--provider", "p", "--model", "m", "-t", "P"], () => ["run", "--provider", "p", "--model", "m", "-t", "P"]],
];

for (const [harness, bin, pin, expected, expectedYolo] of CASES) {
  test(`${harness}: documented argv wiring`, async () => {
    await runOne(harness, pin);
    expect(argvOf(bin)).toEqual(expected(dir));
  });
  test(`${harness}: yolo adds only the documented flag`, async () => {
    await runOne(harness, pin, true);
    expect(argvOf(bin)).toEqual(expectedYolo(dir));
  });
}

test("opencode: run -m --dir shape", async () => {
  await runOne("opencode", "p/m");
  expect(argvOf("opencode")).toEqual(["run", "-m", "p/m", "--dir", dir, "P"]);
});

test("no adapter ever receives a permission-bypass flag", async () => {
  const FORBIDDEN = ["--dangerously-skip-permissions", "--skip-permissions", "--yolo", "--no-sandbox", "--disable-sandbox"];
  for (const [harness, bin, pin] of CASES) {
    await runOne(harness, pin, true);
    for (const a of argvOf(bin)) expect(FORBIDDEN).not.toContain(a);
  }
});
