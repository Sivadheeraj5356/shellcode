import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { realpathSync, existsSync } from "node:fs";
import { resolve, relative, dirname, sep } from "node:path";
import { spawn } from "node:child_process";

export interface ToolContext {
  cwd: string;
  yolo: boolean;
  /** called before write/exec when not yolo; return false to deny */
  approve?: (what: string) => Promise<boolean>;
}

export const TOOL_DEFS = [
  { name: "read_file", description: "Read a UTF-8 text file in the workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file in the workspace.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace one exact occurrence of old_text with new_text in a file.", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "list_dir", description: "List entries of a directory (default: workspace root).", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "grep", description: "Search files for a regular expression. Returns file:line:text.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "bash", description: "Run a shell command in the workspace and return combined output (60s timeout).", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
] as const;

/**
 * Resolve a path and require it to stay inside the workspace, following symlinks
 * (the deepest existing ancestor is realpath'd). This guards the file tools only.
 * It does NOT confine the bash tool: a shell command can do anything the user can.
 */
export function safePath(cwd: string, p: string): string {
  const root = realpathSync(cwd);
  const abs = resolve(root, p);
  let probe = abs;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = resolve(realpathSync(probe), relative(probe, abs));
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(".." + sep) || resolve(rel) === rel) throw new Error(`path escapes workspace: ${p}`);
  return abs;
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
/** Commands the agent runs never see API keys or tokens from your environment. */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
}

const SKIP = new Set([".git", "node_modules", "dist", ".next", "__pycache__"]);

async function walk(dir: string, out: string[], limit = 2000) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    if (SKIP.has(e.name)) continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) await walk(full, out, limit);
    else out.push(full);
  }
}

export async function runTool(name: string, input: any, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "read_file": {
      const p = safePath(ctx.cwd, input.path);
      const text = await readFile(p, "utf8");
      return text.length > 60_000 ? text.slice(0, 60_000) + "\n...[truncated]" : text;
    }
    case "write_file": {
      const p = safePath(ctx.cwd, input.path);
      if (!ctx.yolo && !(await ctx.approve?.(`write ${input.path}`))) return "denied by user";
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, String(input.content));
      return `wrote ${input.path} (${String(input.content).length} chars)`;
    }
    case "edit_file": {
      const p = safePath(ctx.cwd, input.path);
      const text = await readFile(p, "utf8");
      const n = text.split(input.old_text).length - 1;
      if (n === 0) return "error: old_text not found";
      if (n > 1) return `error: old_text matches ${n} places, add more context`;
      if (!ctx.yolo && !(await ctx.approve?.(`edit ${input.path}`))) return "denied by user";
      await writeFile(p, text.replace(input.old_text, () => input.new_text));
      return `edited ${input.path}`;
    }
    case "list_dir": {
      const p = safePath(ctx.cwd, input.path ?? ".");
      const ents = await readdir(p, { withFileTypes: true });
      return ents.filter((e) => !SKIP.has(e.name)).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n");
    }
    case "grep": {
      const re = new RegExp(input.pattern);
      const files: string[] = [];
      const root = safePath(ctx.cwd, input.path ?? ".");
      if ((await stat(root)).isDirectory()) await walk(root, files); else files.push(root);
      const hits: string[] = [];
      for (const f of files) {
        let t: string;
        try { t = await readFile(f, "utf8"); } catch { continue; }
        if (t.includes("\0")) continue;
        t.split("\n").forEach((line, i) => { if (hits.length < 200 && re.test(line)) hits.push(`${relative(ctx.cwd, f)}:${i + 1}:${line.slice(0, 200)}`); });
      }
      return hits.join("\n") || "no matches";
    }
    case "bash": {
      if (!ctx.yolo && !(await ctx.approve?.(`run: ${input.command}`))) return "denied by user";
      return await new Promise<string>((res) => {
        const c = spawn("bash", ["-c", String(input.command)], { cwd: ctx.cwd, env: scrubEnv() });
        let out = "";
        const t = setTimeout(() => { c.kill("SIGKILL"); out += "\n[timeout after 60s]"; }, 60_000);
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (out += d));
        c.on("close", (code) => { clearTimeout(t); res((out.length > 20_000 ? out.slice(-20_000) : out) + `\n[exit ${code}]`); });
      });
    }
    default:
      return `error: unknown tool ${name}`;
  }
}
