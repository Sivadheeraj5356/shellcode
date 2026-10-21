import { spawn } from "node:child_process";
import type { AgentEvent } from "../types";

export interface CliHarnessSpec {
  id: string;
  name: string;
  bin: string;
  /** build argv for a one-shot, non-interactive run. Only flags found in the vendor's own docs are used. */
  args: (prompt: string, o: { model?: string; yolo?: boolean; cwd?: string }) => string[];
  /** true only when the vendor docs show a model flag for this headless mode */
  supportsModel: boolean;
  install: string;
  /** official doc page the flags below were checked against (2026-10-21) */
  docs: string;
  /** what `yolo` maps to for this harness (never a full permission bypass) */
  yoloMeaning: string;
  /** how the CLI is authenticated: it uses its own login/keys, Shellcode never sees them */
  auth: string;
}

/**
 * Headless invocations, each checked against the vendor's official docs on 2026-10-21.
 * Shellcode never passes a "skip all permissions" flag. `yolo` only maps to the narrowest
 * documented switch that lets a headless run write files. Adapters have not been run
 * against the real binaries: `shellcode doctor` reports "installed" (binary found), never "verified".
 */
export const CLI_HARNESSES: CliHarnessSpec[] = [
  { id: "claude-code", name: "Claude Code", bin: "claude", supportsModel: true,
    args: (p, o) => ["-p", p, ...(o.model ? ["--model", o.model] : []), ...(o.yolo ? ["--permission-mode", "acceptEdits"] : [])],
    install: "see docs", docs: "https://code.claude.com/docs/en/cli-reference", yoloMeaning: "--permission-mode acceptEdits (auto-approve file edits only)", auth: "own login or API key" },
  { id: "codex", name: "OpenAI Codex CLI", bin: "codex", supportsModel: false,
    args: (p, o) => ["exec", ...(o.yolo ? ["--sandbox", "workspace-write"] : []), p],
    install: "see docs", docs: "https://developers.openai.com/codex/noninteractive", yoloMeaning: "--sandbox workspace-write (default is read-only)", auth: "own saved login or CODEX_API_KEY" },
  { id: "cursor", name: "Cursor CLI", bin: "agent", supportsModel: true,
    args: (p, o) => ["-p", ...(o.model ? ["--model", o.model] : []), ...(o.cwd ? ["--workspace", o.cwd] : []), ...(o.yolo ? ["--force"] : []), p],
    install: "curl https://cursor.com/install -fsS | bash", docs: "https://cursor.com/docs/cli/reference/parameters", yoloMeaning: "--force (documented as allowing commands too; without it print mode only proposes changes)", auth: "own Cursor login" },
  { id: "antigravity", name: "Google Antigravity CLI", bin: "agy", supportsModel: true,
    args: (p, o) => ["-p", p, ...(o.model ? ["--model", o.model] : []), "--output-format", "text"],
    install: "see docs", docs: "https://antigravity.google/docs/cli/headless/", yoloMeaning: "none passed (workspace file writes are already allowed; shell commands are soft-denied headless)", auth: "cached login from an interactive `agy` session" },
  { id: "gemini-cli", name: "Gemini CLI", bin: "gemini", supportsModel: true,
    args: (p, o) => ["-p", p, ...(o.model ? ["-m", o.model] : []), ...(o.yolo ? ["--approval-mode", "auto_edit"] : [])],
    install: "see docs", docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md", yoloMeaning: "--approval-mode auto_edit", auth: "own login or GEMINI_API_KEY" },
  { id: "opencode", name: "OpenCode", bin: "opencode", supportsModel: true,
    args: (p, o) => ["run", ...(o.model ? ["-m", o.model] : []), ...(o.cwd ? ["--dir", o.cwd] : []), p],
    install: "see docs", docs: "https://opencode.ai/docs/cli/", yoloMeaning: "none passed", auth: "own provider config; model is provider/model" },
  { id: "aider", name: "Aider", bin: "aider", supportsModel: true,
    args: (p, o) => ["--message", p, "--yes-always", ...(o.model ? ["--model", o.model] : [])],
    install: "python -m pip install aider-chat", docs: "https://aider.chat/docs/scripting.html", yoloMeaning: "always passes --yes-always (needed to run headless; it edits files in your git repo)", auth: "provider keys in env" },
  { id: "goose", name: "Goose", bin: "goose", supportsModel: false,
    args: (p) => ["run", "-t", p],
    install: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash", docs: "https://block.github.io/goose/docs/guides/goose-cli-commands/", yoloMeaning: "none passed", auth: "own provider config" },
];

export async function which(bin: string, env = process.env): Promise<string | null> {
  const dirs = (env.PATH ?? "").split(":");
  const { access, constants } = await import("node:fs/promises");
  for (const d of dirs) {
    const p = `${d}/${bin}`;
    try { await access(p, constants.X_OK); return p; } catch {}
  }
  return null;
}

export async function* runCli(spec: CliHarnessSpec, bin: string, prompt: string, o: { cwd: string; model?: string; yolo?: boolean; signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
  const child = spawn(bin, spec.args(prompt, { ...o }), { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], signal: o.signal });
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let stderr = "";
  const push = (e: AgentEvent) => { queue.push(e); wake?.(); };
  child.stdout.on("data", (d) => push({ type: "text", text: String(d) }));
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", (e) => { push({ type: "error", message: `${spec.bin}: ${e.message}` }); finished = true; wake?.(); });
  child.on("close", (code) => {
    if (code !== 0) push({ type: "error", message: `${spec.bin} exited ${code}${stderr ? `: ${stderr.slice(-400).trim()}` : ""}` });
    finished = true; wake?.();
  });
  while (true) {
    while (queue.length) yield queue.shift()!;
    if (finished) break;
    await new Promise<void>((r) => (wake = r));
  }
  yield { type: "done", harness: spec.id, model: o.model };
}

/** Ask OpenCode's own catalog whether provider/model is priced at exactly zero. Anything unknown or unparsable is "not free". */
export async function opencodeModelIsZeroPriced(bin: string, pin: string, env = process.env): Promise<boolean> {
  const provider = pin.split("/")[0];
  if (!provider || !pin.includes("/")) return false;
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise<string>((res, rej) => execFile(bin, ["models", provider, "--verbose"], { env: env as any, timeout: 20000, maxBuffer: 20_000_000 }, (e, so) => (e ? rej(e) : res(String(so)))));
    const parts = out.split(/^([A-Za-z0-9._-]+\/[^\s]+)\n/m);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      if (parts[i] !== pin) continue;
      const m = JSON.parse(parts[i + 1]!.trim());
      return m?.cost?.input === 0 && m?.cost?.output === 0 && m?.cost?.cache?.read === 0 && m?.cost?.cache?.write === 0;
    }
  } catch {}
  return false;
}
