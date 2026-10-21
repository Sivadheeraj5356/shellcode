import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shellcode run: real process, routed to the small model, edits a file", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "t-8b-instant" }, { id: "t-70b-large" }] });
    const b: any = await req.json(); seen.push(b.model);
    if (b.messages.at(-1).role === "tool") return Response.json({ choices: [{ message: { role: "assistant", content: "all done" } }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "ok" }) } }] } }] });
  } });
  const home = await mkdtemp(join(tmpdir(), "scH-")), work = await mkdtemp(join(tmpdir(), "scW-"));
  await writeFile(join(home, "config.json"), JSON.stringify({ policy: "free", harness: "auto", yolo: true, tierOverrides: {}, providers: [{ id: "mock", name: "m", baseUrl: `http://localhost:${server.port}/v1`, keyEnv: null, cost: "local", note: "" }] }));
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/index.tsx"), "run", "-y", "add out.txt"], { cwd: work, env: { ...process.env, SHELLCODE_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited; server.stop();
  expect(out).toContain("all done");
  expect(err).toContain("[route] light");
  expect(seen[0]).toBe("t-8b-instant");
  expect(await readFile(join(work, "out.txt"), "utf8")).toBe("ok");
});
