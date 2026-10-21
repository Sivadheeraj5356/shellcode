import type { AgentEvent, ModelInfo, RunOptions } from "./types";
import { loadConfig, type Config } from "./config";
import { PROVIDERS, apiKey, discoverModels } from "./providers";
import { route } from "./router";
import { CLI_HARNESSES, runCli, which, opencodeModelIsZeroPriced, opencodeZeroPricedModels } from "./harness/cli";
import { runNative } from "./harness/native";

export interface HarnessStatus { id: string; name: string; kind: "native" | "cli"; ready: boolean; detail: string; }
export interface ProviderStatus { id: string; name: string; cost: string; ready: boolean; detail: string; models: ModelInfo[]; }

export async function providerStatus(cfg: Config, env = process.env, fetchImpl?: typeof fetch): Promise<ProviderStatus[]> {
  const all = [...cfg.providers, ...PROVIDERS];
  return Promise.all(all.map(async (p): Promise<ProviderStatus> => {
    if (!apiKey(p, env)) return { id: p.id, name: p.name, cost: p.cost, ready: false, detail: `set ${p.keyEnv}`, models: [] };
    try {
      const models = await discoverModels(p, { env, fetchImpl, tierOverrides: cfg.tierOverrides, allowFree: cfg.allowFree });
      return { id: p.id, name: p.name, cost: p.cost, ready: models.length > 0, detail: `${models.length} models`, models };
    } catch (e: any) {
      const local = p.cost === "local";
      return { id: p.id, name: p.name, cost: p.cost, ready: false, detail: local ? "not running" : e.message.slice(0, 80), models: [] };
    }
  }));
}

async function versionOk(bin: string, env: Record<string, string | undefined>): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((res) => {
    const c = spawn(bin, ["--version"], { env: env as any, stdio: "ignore", timeout: 8000 });
    c.on("error", () => res(false));
    c.on("close", (code) => res(code === 0));
  });
}

export async function harnessStatus(env = process.env, anyModels = false): Promise<HarnessStatus[]> {
  const native: HarnessStatus = { id: "native", name: "Shellcode built-in agent", kind: "native", ready: anyModels, detail: anyModels ? "uses routed models" : "needs a provider key or local model" };
  const cli = await Promise.all(CLI_HARNESSES.map(async (h): Promise<HarnessStatus> => {
    const p = await which(h.bin, env);
    if (!p) return { id: h.id, name: h.name, kind: "cli", ready: false, detail: `not installed (${h.install})` };
    const ok = await versionOk(p, env);
    return { id: h.id, name: h.name, kind: "cli", ready: ok, detail: ok ? p : `${p} found but \`--version\` failed` };
  }));
  return [native, ...cli];
}

export async function* runAgent(opts: RunOptions, deps: { cfg?: Config; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; models?: ModelInfo[]; approve?: (w: string) => Promise<boolean>; confirmExternalCost?: (harness: string) => Promise<boolean> } = {}): AsyncGenerator<AgentEvent> {
  const cfg = deps.cfg ?? (await loadConfig());
  const env = deps.env ?? process.env;
  const policy = opts.policy ?? cfg.policy;
  let models = deps.models;
  if (!models) models = (await providerStatus(cfg, env as any, deps.fetchImpl)).flatMap((s) => s.models);

  const pin = opts.model ?? cfg.model;
  let usable = models;
  if (pin) {
    const [prov, ...rest] = pin.split("/");
    const id = rest.join("/");
    const found = models.find((m) => m.provider === prov && m.id === id);
    usable = [found ?? { provider: prov!, id, tier: "standard", free: false, cost: "paid" }];
  }
  // A pin never bypasses the policy. Unknown pins are treated as paid, so under "free" they are refused.
  const decision = route({ prompt: opts.prompt, turns: opts.history?.length }, usable, policy);
  const extWanted = (opts.harness ?? cfg.harness);
  const external = extWanted !== "native" && extWanted !== "auto";
  if (pin && !external && decision.chain.length === 0) {
    yield { type: "route", decision };
    yield { type: "error", message: `Pinned model ${pin} is not allowed by the ${policy} policy (unknown or paid). Pick another model or change /policy.` };
    return;
  }
  yield { type: "route", decision };

  const wanted = opts.harness ?? cfg.harness;
  const harnesses = await harnessStatus(env as any, models.length > 0);
  let autoPin: string | undefined;
  let pick = wanted === "auto" ? harnesses.find((h) => h.id === "native" && h.ready) : harnesses.find((h) => h.id === wanted);
  if (wanted === "auto" && !pick) {
    // Native has no usable model. Only fall back to a harness whose price is verified as zero right now.
    const oc = harnesses.find((h) => h.id === "opencode" && h.ready);
    if (oc) {
      const free = await opencodeZeroPricedModels(oc.detail, env as any);
      if (free.length) { autoPin = free[0]; pick = oc; yield { type: "fallback", from: "native", to: free[0]!, reason: "no usable model for the built-in agent; OpenCode's own catalog lists this one at price 0" }; }
    }
  }
  if (!pick) { yield { type: "error", message: "No harness ready. Run `shellcode doctor`." }; return; }
  if (!pick.ready) { yield { type: "error", message: `${pick.name} is not ready: ${pick.detail}` }; return; }

  if (pick.kind === "native") {
    yield* runNative({ prompt: opts.prompt, chain: decision.chain, history: opts.history, policy, tier: decision.tier, tool: { cwd: opts.cwd, yolo: opts.yolo ?? cfg.yolo, approve: deps.approve }, env, fetchImpl: deps.fetchImpl, extraProviders: cfg.providers, signal: opts.signal });
    return;
  }
  const spec = CLI_HARNESSES.find((h) => h.id === pick!.id)!;
  // Fail closed: an external harness uses its own login/keys, so Shellcode cannot see or cap its billing.
  // Allowed only for an OpenCode pin whose own model catalog lists input, output and cache cost as exactly 0 (checked right now; unknown fails closed), or with an explicit per-run acknowledgment.
  const effPin = autoPin ?? pin;
  const knownFree = spec.id === "opencode" && !!effPin && (await opencodeModelIsZeroPriced(pick.detail, effPin, env as any));
  if (!knownFree && !opts.acknowledgeExternalCost && !(deps.confirmExternalCost && (await deps.confirmExternalCost(spec.name)))) {
    yield { type: "error", message: `${spec.name} manages its own account and billing, which Shellcode cannot verify, so it was not started (policy ${policy}). Re-run with --ack-external-cost to accept that cost yourself, or use the built-in agent or an OpenCode model whose catalog price is zero.` };
    return;
  }
  // External harnesses own their model/auth, so the free policy cannot be enforced for them. The pin is passed exactly as given (OpenCode wants provider/model).
  yield* runCli(spec, pick.detail, opts.prompt, { cwd: opts.cwd, model: effPin && spec.supportsModel ? effPin : undefined, yolo: opts.yolo ?? cfg.yolo, signal: opts.signal });
}
