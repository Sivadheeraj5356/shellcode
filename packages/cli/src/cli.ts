import { runAgent, CLI_HARNESSES, listSessions, providerStatus, harnessStatus, loadConfig, PROVIDERS, route, type AgentEvent, type Policy } from "@shellcode/core";

const HELP = `shellcode - one terminal for every coding agent

Usage
  shellcode                       open the interface
  shellcode run [options] <task>  run one task headless
  shellcode route <task>          show which tier and models the router would use
  shellcode sessions              list saved sessions
  shellcode doctor                show providers, harnesses and what is missing

Options for run
  -H, --harness <id>   native (built-in), claude-code, codex, cursor, antigravity, gemini-cli, opencode, aider, goose
  -m, --model <p/m>    pin provider/model (built-in agent)
  -p, --policy <p>     free (default) | balanced | quality
  -y, --yolo           auto-approve edits and commands
`;

export async function maybeRunSubcommand(argv: string[]): Promise<boolean> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(HELP); return true; }
  if (cmd === "sessions") { for (const s of await listSessions()) console.log(`${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.title}`); return true; }
  if (cmd === "doctor") { await doctor(); return true; }
  if (cmd === "route") { await routeCmd(rest.join(" ")); return true; }
  if (cmd === "run") { await runCmd(rest); return true; }
  return false;
}

async function doctor() {
  const cfg = await loadConfig();
  const ps = await providerStatus(cfg);
  console.log("Providers");
  for (const p of ps) {
    const spec = PROVIDERS.find((s) => s.id === p.id);
    console.log(`  ${p.ready ? "●" : "○"} ${p.name.padEnd(28)} ${p.cost.padEnd(10)} ${p.ready ? p.detail : spec?.keyEnv ? `set ${spec.keyEnv}${spec.signup ? `  (${spec.signup})` : ""}` : p.detail}`);
  }
  const anyModels = ps.some((p) => p.models.length);
  console.log("\nProvider notes");
  for (const s of [...PROVIDERS]) if (s.cost === "unverified" || s.id === "gemini" || s.id === "openrouter") console.log(`  ${s.id}: ${s.note}${s.terms ? `  [${s.terms}]` : ""}`);
  console.log("\nHarnesses  (installed = binary found and `--version` works; adapters are not yet exercised against real binaries)");
  for (const h of await harnessStatus(process.env as any, anyModels)) {
    const spec = CLI_HARNESSES.find((x) => x.id === h.id);
    console.log(`  ${h.ready ? "●" : "○"} ${h.name.padEnd(28)} ${h.ready && spec ? `installed: ${h.detail}` : h.detail}`);
    if (spec) console.log(`      flags checked against ${spec.docs}\n      --yolo maps to: ${spec.yoloMeaning}${spec.supportsModel ? "" : "\n      model: chosen inside the harness"}`);
  }
  console.log(`\nPolicy: ${cfg.policy}   Harness: ${cfg.harness}${cfg.model ? `   Pinned model: ${cfg.model}` : ""}`);
  console.log("Under the free policy only local, zero-priced and documented free-tier models are called; a model outside the policy is never contacted. Free plans change, check each provider's terms.");
}

async function routeCmd(prompt: string) {
  if (!prompt) { console.log("usage: shellcode route <task>"); return; }
  const cfg = await loadConfig();
  const models = (await providerStatus(cfg)).flatMap((s) => s.models);
  const d = route({ prompt }, models, cfg.policy);
  console.log(`tier: ${d.tier} (score ${d.score})`);
  for (const r of d.reasons) console.log(`  - ${r}`);
  console.log(d.chain.length ? "chain:" : "no usable models yet. Run `shellcode doctor`.");
  for (const m of d.chain.slice(0, 5)) console.log(`  ${m.provider}/${m.id}  [${m.tier}, ${m.cost}]`);
}

async function runCmd(args: string[]) {
  let harness: string | undefined, model: string | undefined, policy: Policy | undefined, yolo = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-H" || a === "--harness") harness = args[++i];
    else if (a === "-m" || a === "--model") model = args[++i];
    else if (a === "-p" || a === "--policy") policy = args[++i] as Policy;
    else if (a === "-y" || a === "--yolo") yolo = true;
    else words.push(a);
  }
  const prompt = words.join(" ");
  if (!prompt) { console.log(HELP); process.exitCode = 1; return; }
  const approve = async (what: string) => {
    if (!process.stdin.isTTY) return false;
    process.stderr.write(`allow ${what}? [y/N] `);
    const line = await new Promise<string>((r) => process.stdin.once("data", (d) => r(String(d))));
    return /^y/i.test(line.trim());
  };
  let failed = false;
  for await (const ev of runAgent({ prompt, cwd: process.cwd(), harness: harness === "native" ? "native" : harness, model, policy, yolo }, { approve })) print(ev, () => (failed = true));
  if (failed) process.exitCode = 1;
}

function print(ev: AgentEvent, fail: () => void) {
  switch (ev.type) {
    case "route": console.error(`[route] ${ev.decision.tier}: ${ev.decision.chain[0] ? `${ev.decision.chain[0].provider}/${ev.decision.chain[0].id}` : "no model"} (${ev.decision.reasons.slice(0, 2).join("; ")})`); break;
    case "text": process.stdout.write(ev.text.endsWith("\n") ? ev.text : ev.text + "\n"); break;
    case "tool": console.error(`[${ev.error ? "fail" : "ok"}] ${ev.name} ${JSON.stringify(ev.input).slice(0, 100)}`); break;
    case "fallback": console.error(`[fallback] ${ev.from} -> ${ev.to}: ${ev.reason}`); break;
    case "error": console.error(`error: ${ev.message}`); fail(); break;
    default: break;
  }
}
