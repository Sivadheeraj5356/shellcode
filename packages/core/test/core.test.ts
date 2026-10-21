import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, scoreTask } from "../src/router";
import { classifyModel, discoverModels, PROVIDERS } from "../src/providers";
import { runAgent } from "../src/agent";
import { safePath } from "../src/tools";
import { DEFAULT_CONFIG } from "../src/config";
import type { ModelInfo, AgentEvent } from "../src/types";

const M = (provider: string, id: string, cost: ModelInfo["cost"], tier = classifyModel(id)): ModelInfo => ({ provider, id, tier, cost, free: cost === "free" || cost === "local" });

test("classifies model ids by size/name", () => {
  expect(classifyModel("llama-3.1-8b-instant")).toBe("light");
  expect(classifyModel("gemini-2.5-flash")).toBe("light");
  expect(classifyModel("llama-3.3-70b-versatile")).toBe("heavy");
  expect(classifyModel("claude-opus-4")).toBe("heavy");
});

test("router: simple task -> light, hard task -> heavy, with reasons", () => {
  expect(scoreTask({ prompt: "fix typo in readme" }).tier).toBe("light");
  const hard = scoreTask({ prompt: "Refactor the auth module across the repo and fix the race condition in the session cache, then migrate the schema", fileCount: 5 });
  expect(hard.tier).toBe("heavy");
  expect(hard.reasons.join(" ")).toContain("race condition");
});

test("router: failures escalate the tier", () => {
  const a = scoreTask({ prompt: "add a null check to parse()" });
  const b = scoreTask({ prompt: "add a null check to parse()", previousFailures: 2 });
  expect(b.score).toBeGreaterThan(a.score);
  expect(b.tier).toBe("heavy");
});

test("router: free policy never includes paid models; balanced allows paid only for heavy", () => {
  const models = [M("openrouter", "foo-7b:free", "free"), M("groq", "llama-3.3-70b-versatile", "free-tier"), M("anthropic", "claude-opus-4", "paid")];
  const light = route({ prompt: "rename x to y" }, models, "free");
  expect(light.chain.some((m) => m.cost === "paid")).toBe(false);
  expect(light.chain[0]!.id).toBe("foo-7b:free");
  const heavyPrompt = "Refactor the whole architecture and debug the deadlock across the codebase from scratch";
  expect(route({ prompt: heavyPrompt }, models, "free").chain.some((m) => m.cost === "paid")).toBe(false);
  expect(route({ prompt: heavyPrompt }, models, "balanced").chain[0]!.cost).not.toBe("local");
  expect(route({ prompt: "rename x" }, models, "balanced").chain.some((m) => m.cost === "paid")).toBe(false);
});

test("safePath blocks escapes", async () => {
  const d = await mkdtemp(join(tmpdir(), "sc-"));
  const { realpathSync } = await import("node:fs");
  const root = realpathSync(d);
  expect(() => safePath(d, "../etc/passwd")).toThrow();
  expect(() => safePath(d, "/etc/passwd")).toThrow();
  expect(safePath(d, "src/a.ts")).toBe(join(root, "src/a.ts"));
});

// ---- mock OpenAI-compatible provider -----------------------------------
function mockServer(handler: (body: any, n: number) => { status?: number; json?: any }) {
  let n = 0;
  const calls: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "tiny-8b-instant" }, { id: "big-70b-versatile" }, { id: "text-embedding-3" }] });
      const body = await req.json();
      calls.push(body);
      const r = handler(body, n++);
      return Response.json(r.json ?? {}, { status: r.status ?? 200 });
    },
  });
  return { server, calls, base: `http://localhost:${server.port}/v1` };
}

const toolCall = (name: string, args: object) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const say = (t: string) => ({ choices: [{ message: { role: "assistant", content: t } }] });

async function collect(g: AsyncGenerator<AgentEvent>) { const ev: AgentEvent[] = []; for await (const e of g) ev.push(e); return ev; }

test("provider discovery filters non-chat models and tiers the rest", async () => {
  const { server, base } = mockServer(() => ({}));
  const ms = await discoverModels({ id: "mock", name: "m", baseUrl: base, keyEnv: "MOCK_KEY", cost: "free-tier", note: "" }, { env: { MOCK_KEY: "x" } });
  server.stop();
  expect(ms.map((m) => m.id).sort()).toEqual(["big-70b-versatile", "tiny-8b-instant"]);
  expect(ms.find((m) => m.id === "tiny-8b-instant")!.tier).toBe("light");
});

test("openrouter: only zero-priced models are marked free", async () => {
  const f = (async () => Response.json({ data: [{ id: "a/b:free", pricing: { prompt: "0", completion: "0" } }, { id: "c/d", pricing: { prompt: "0.001", completion: "0.002" } }] })) as any;
  const or = PROVIDERS.find((p) => p.id === "openrouter")!;
  const ms = await discoverModels(or, { env: { OPENROUTER_API_KEY: "k" }, fetchImpl: f });
  expect(ms.find((m) => m.id === "a/b:free")!.cost).toBe("free");
  expect(ms.find((m) => m.id === "c/d")!.cost).toBe("paid");
});

test("e2e native harness: routes light task to small model, edits a real file, runs a command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  await writeFile(join(dir, "a.txt"), "hello world\n");
  const mock = mockServer((body, n) => {
    if (n === 0) return { json: toolCall("edit_file", { path: "a.txt", old_text: "world", new_text: "shellcode" }) };
    if (n === 1) return { json: toolCall("bash", { command: "cat a.txt" }) };
    return { json: say("done") };
  });
  const models = [M("mock", "tiny-8b-instant", "free-tier"), M("mock", "big-70b-versatile", "free-tier")];
  const cfg = { ...DEFAULT_CONFIG, providers: [{ id: "mock", name: "m", baseUrl: mock.base, keyEnv: "MOCK_KEY", cost: "free-tier" as const, note: "" }] };
  const ev = await collect(runAgent({ prompt: "rename the word in a.txt", cwd: dir, harness: "native", yolo: true }, { cfg, models, env: { MOCK_KEY: "k" } }));
  mock.server.stop();
  const r = ev.find((e) => e.type === "route") as any;
  expect(r.decision.tier).toBe("light");
  expect(mock.calls[0].model).toBe("tiny-8b-instant");
  expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello shellcode\n");
  const bash = ev.find((e) => e.type === "tool" && e.name === "bash") as any;
  expect(bash.output).toContain("hello shellcode");
  expect(ev.at(-1)!.type).toBe("done");
});

test("e2e fallback: 429 on first model switches to next in chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  const mock = mockServer((body) => body.model === "tiny-8b-instant" ? { status: 429, json: { error: "rate limited" } } : { json: say("ok from big") });
  const models = [M("mock", "tiny-8b-instant", "free-tier"), M("mock", "big-70b-versatile", "free-tier")];
  const cfg = { ...DEFAULT_CONFIG, providers: [{ id: "mock", name: "m", baseUrl: mock.base, keyEnv: "MOCK_KEY", cost: "free-tier" as const, note: "" }] };
  const ev = await collect(runAgent({ prompt: "explain this", cwd: dir, harness: "native" }, { cfg, models, env: { MOCK_KEY: "k" } }));
  mock.server.stop();
  expect(ev.some((e) => e.type === "fallback")).toBe(true);
  expect(ev.filter((e) => e.type === "text").map((e: any) => e.text)).toContain("ok from big");
});

test("permission gate: without yolo, a denied write leaves the file untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  await writeFile(join(dir, "k.txt"), "keep");
  const mock = mockServer((_, n) => n === 0 ? { json: toolCall("write_file", { path: "k.txt", content: "gone" }) } : { json: say("ok") });
  const models = [M("mock", "tiny-8b-instant", "free-tier")];
  const cfg = { ...DEFAULT_CONFIG, providers: [{ id: "mock", name: "m", baseUrl: mock.base, keyEnv: "MOCK_KEY", cost: "free-tier" as const, note: "" }] };
  await collect(runAgent({ prompt: "x", cwd: dir, harness: "native" }, { cfg, models, env: { MOCK_KEY: "k" }, approve: async () => false }));
  mock.server.stop();
  expect(await readFile(join(dir, "k.txt"), "utf8")).toBe("keep");
});

test("CLI harness adapter streams stdout of a real subprocess", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  const bin = join(dir, "bin"); await Bun.$`mkdir -p ${bin}`;
  await writeFile(join(bin, "aider"), '#!/bin/sh\necho "fake-aider got: $2"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const ev = await collect(runAgent({ prompt: "hi there", cwd: dir, harness: "aider" }, { cfg: DEFAULT_CONFIG, models: [], env }));
  expect(ev.filter((e) => e.type === "text").map((e: any) => e.text).join("")).toContain("fake-aider got: hi there");
});

// ---- hardening ----------------------------------------------------------
import { symlink } from "node:fs/promises";
import { scrubEnv, runTool } from "../src/tools";
import { saveSession, loadSession, listSessions } from "../src/sessions";
import { isAllowed } from "../src/router";
import { CLI_HARNESSES } from "../src/harness/cli";

test("safePath follows symlinks: a link pointing outside the workspace is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  const outside = await mkdtemp(join(tmpdir(), "sc-out-"));
  await writeFile(join(outside, "secret.txt"), "s3cret");
  await symlink(outside, join(dir, "link"));
  expect(() => safePath(dir, "link/secret.txt")).toThrow();
  expect(() => safePath(dir, "link/new.txt")).toThrow();
  await expect(runTool("read_file", { path: "link/secret.txt" }, { cwd: dir, yolo: true })).rejects.toThrow();
});

test("bash tool does not see API keys from the environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  process.env.FAKE_PROVIDER_API_KEY = "topsecret";
  const out = await runTool("bash", { command: "echo [$FAKE_PROVIDER_API_KEY]" }, { cwd: dir, yolo: true });
  delete process.env.FAKE_PROVIDER_API_KEY;
  expect(out).toContain("[]");
  expect(Object.keys(scrubEnv({ A: "1", OPENAI_API_KEY: "x", GITHUB_TOKEN: "y" }))).toEqual(["A"]);
});

test("bash tool is denied without approval, and nothing runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  const out = await runTool("bash", { command: "touch ran.txt" }, { cwd: dir, yolo: false, approve: async () => false });
  expect(out).toBe("denied by user");
  expect(await Bun.file(join(dir, "ran.txt")).exists()).toBe(false);
});

test("free policy fails closed at call time: a paid model in the chain is never contacted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  const mock = mockServer(() => ({ json: say("should not happen") }));
  const { runNative } = await import("../src/harness/native");
  const ev = await collect(runNative({ prompt: "x", chain: [M("mock", "pricey-70b", "paid")], policy: "free", tool: { cwd: dir, yolo: false }, env: { MOCK_KEY: "k" }, extraProviders: [{ id: "mock", name: "m", baseUrl: mock.base, keyEnv: "MOCK_KEY", cost: "paid", note: "" }] }));
  mock.server.stop();
  expect(mock.calls.length).toBe(0);
  expect(ev.some((e) => e.type === "error" && e.message.includes("blocked"))).toBe(true);
});

test("a pinned paid or unknown model is refused under the free policy, and no fallback goes paid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  const models = [M("mock", "tiny-8b-instant", "free-tier")];
  const ev = await collect(runAgent({ prompt: "x", cwd: dir, harness: "native", model: "openai/gpt-x", policy: "free" }, { cfg: DEFAULT_CONFIG, models, env: {} }));
  expect(ev.some((e) => e.type === "error" && e.message.includes("not allowed"))).toBe(true);
  expect(isAllowed(M("a", "b", "unverified"), "free")).toBe(false);
  expect(isAllowed(M("a", "b", "unverified"), "balanced", "light")).toBe(false);
});

test("unverified providers become free only when the user allowlists them", async () => {
  const { server, base } = mockServer(() => ({}));
  const spec = { id: "mock", name: "m", baseUrl: base, keyEnv: "MOCK_KEY", cost: "unverified" as const, note: "" };
  const a = await discoverModels(spec, { env: { MOCK_KEY: "x" } });
  const b = await discoverModels(spec, { env: { MOCK_KEY: "x" }, allowFree: ["mock"] });
  server.stop();
  expect(a.every((m) => m.cost === "unverified")).toBe(true);
  expect(b.every((m) => m.cost === "free-tier")).toBe(true);
});

test("streaming: SSE text arrives in chunks and streamed tool calls are assembled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  await writeFile(join(dir, "s.txt"), "one");
  let n = 0;
  const server = Bun.serve({ port: 0, fetch() {
    const sse = (objs: any[]) => new Response(objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    if (n++ === 0) return sse([
      { choices: [{ delta: { content: "Let me " } }] }, { choices: [{ delta: { content: "edit." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "edit_file", arguments: '{"path":"s.txt","old_text":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"one","new_text":"two"}' } }] } }] },
      { usage: { prompt_tokens: 5, completion_tokens: 3 }, choices: [] }]);
    return sse([{ choices: [{ delta: { content: "fin" } }] }, { choices: [{ delta: { content: "ished" } }] }]);
  } });
  const { runNative } = await import("../src/harness/native");
  const ev = await collect(runNative({ prompt: "x", chain: [M("mock", "tiny-8b", "local")], policy: "free", tool: { cwd: dir, yolo: true }, env: {}, extraProviders: [{ id: "mock", name: "m", baseUrl: `http://localhost:${server.port}/v1`, keyEnv: null, cost: "local", note: "" }] }));
  server.stop();
  const texts = ev.filter((e) => e.type === "text").map((e: any) => e.text);
  expect(texts).toEqual(["Let me ", "edit.", "fin", "ished"]);
  expect(await readFile(join(dir, "s.txt"), "utf8")).toBe("two");
});

test("sessions persist and reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  await saveSession({ id: "a1", cwd: "/x", title: "first", updatedAt: "", history: [{ role: "user", content: "hi" }], entries: [{ kind: "user", text: "hi" }] }, dir);
  const s = await loadSession("a1", dir);
  expect(s!.history[0]!.content).toBe("hi");
  expect((await listSessions(dir))[0]!.title).toBe("first");
});

test("every external harness adapter builds the documented argv and never a permission bypass", () => {
  for (const h of CLI_HARNESSES) {
    const argv = h.args("do it", { model: "m1", yolo: true, cwd: "/w" }).join(" ");
    expect(argv).not.toMatch(/dangerously|bypass|danger-full-access/);
    expect(argv).toContain("do it");
    expect(h.docs.startsWith("https://")).toBe(true);
  }
  const by = (id: string) => CLI_HARNESSES.find((h) => h.id === id)!;
  expect(by("claude-code").args("p", { model: "opus", yolo: true })).toEqual(["-p", "p", "--model", "opus", "--permission-mode", "acceptEdits"]);
  expect(by("codex").args("p", { yolo: true })).toEqual(["exec", "--sandbox", "workspace-write", "p"]);
  expect(by("cursor").bin).toBe("agent");
  expect(by("gemini-cli").args("p", { yolo: true })).toEqual(["-p", "p", "--approval-mode", "auto_edit"]);
});

test("a binary that exists but fails --version is reported not ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-"));
  await Bun.$`mkdir -p ${dir}/bin`;
  await writeFile(join(dir, "bin", "aider"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const { harnessStatus } = await import("../src/agent");
  const st = await harnessStatus({ ...process.env, PATH: `${dir}/bin:${process.env.PATH}` }, false);
  expect(st.find((h) => h.id === "aider")!.ready).toBe(false);
  expect(st.find((h) => h.id === "codex")!.ready).toBe(false);
});
