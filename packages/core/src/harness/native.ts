import type { AgentEvent, ChatMessage, ModelInfo, Policy, Tier } from "../types";
import { chat, LLMError } from "../llm";
import { TOOL_DEFS, runTool, type ToolContext } from "../tools";
import type { ProviderSpec } from "../providers";
import { isAllowed } from "../router";
import { snapshotFiles, diffSnapshots, changedFiles } from "../snapshot";
import { appendLedger, promptHead, readCooldowns, recordModelFailure, clearModelFailure, inCooldown, type RunOutcome } from "../ledger";

export const SYSTEM_PROMPT = `You are Shellcode's built-in coding agent working inside the user's project directory.
Use the tools to inspect before you edit, make small precise changes, and run the project's tests or build when they exist.
Never touch paths outside the workspace. Be brief in your final answer: say what changed and what you verified.`;

export interface NativeOptions {
  prompt: string;
  chain: ModelInfo[];
  tool: ToolContext;
  history?: ChatMessage[];
  maxSteps?: number;
  /** enforced again right before every call: a model outside the policy is never contacted */
  policy?: Policy;
  tier?: Tier;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  extraProviders?: ProviderSpec[];
  signal?: AbortSignal;
  /** set false to skip the outcome ledger / workspace snapshot (tests, embeds) */
  recordOutcome?: boolean;
}

export async function* runNative(o: NativeOptions): AsyncGenerator<AgentEvent> {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...(o.history ?? []), { role: "user", content: o.prompt }];
  let idx = 0;
  const maxSteps = o.maxSteps ?? 25;
  const record = o.recordOutcome !== false;
  const startedAt = Date.now();
  const before = record ? await snapshotFiles(o.tool.cwd).catch(() => null) : null;
  const cooldowns = record ? await readCooldowns(o.env) : {};
  const toolsUsed: string[] = [];
  let finalOutcome: RunOutcome = "error";
  let finalError: string | undefined;
  async function finish(kind: RunOutcome, err?: string) {
    finalOutcome = kind; finalError = err;
    if (!record) return;
    let files: string[] = [];
    if (before) {
      const after = await snapshotFiles(o.tool.cwd).catch(() => null);
      if (after) files = changedFiles(diffSnapshots(before, after));
      // a run that called edit/write tools but left no persisted change is
      // an honest "no-change"; a run that never tried to edit is "answered"
      if (kind === "edited" && files.length === 0) finalOutcome = "no-change";
    }
    const m = o.chain[Math.min(idx, o.chain.length - 1)];
    await appendLedger({
      ts: new Date().toISOString(), cwd: o.tool.cwd, promptHead: promptHead(o.prompt),
      tier: o.tier ?? "standard", model: m ? `${m.provider}/${m.id}` : undefined,
      fallbacks: idx, toolsUsed, filesChanged: files, outcome: finalOutcome,
      error: err?.slice(0, 300), ms: Date.now() - startedAt,
    }, o.env).catch(() => {});
  }
  if (o.chain.length === 0) { yield { type: "error", message: "No models available. Set a provider key (see `shellcode doctor`) or start Ollama." }; return; }
  for (let step = 0; step < maxSteps; step++) {
    let completion;
    while (true) {
      const model = o.chain[idx]!;
      if (o.policy && !isAllowed(model, o.policy, o.tier)) {
        yield { type: "error", message: `blocked: ${model.provider}/${model.id} is ${model.cost} and the ${o.policy} policy does not allow it. No request was sent.` };
        return;
      }
      const key = `${model.provider}/${model.id}`;
      if (record && inCooldown(cooldowns, key) && idx + 1 < o.chain.length) {
        const nextNotCooling = o.chain.findIndex((c, i) => i > idx && !inCooldown(cooldowns, `${c.provider}/${c.id}`));
        if (nextNotCooling > idx) {
          const next = o.chain[nextNotCooling]!;
          yield { type: "fallback", from: key, to: `${next.provider}/${next.id}`, reason: `${key} is in failure cooldown; skipping to the next model that is not cooling down` };
          idx = nextNotCooling;
          continue;
        }
      }
      try {
        const chunks: string[] = [];
        let wake: (() => void) | null = null;
        let settled = false;
        const p = chat(model, messages, TOOL_DEFS, { ...o, onText: (c) => { chunks.push(c); wake?.(); } }).finally(() => { settled = true; wake?.(); });
        p.catch(() => {});
        while (true) {
          while (chunks.length) yield { type: "text", text: chunks.shift()! };
          if (settled) break;
          await new Promise<void>((r) => (wake = r));
        }
        completion = await p;
        if (record) await clearModelFailure(key, o.env).catch(() => {});
        if (completion.usage) yield { type: "usage", inputTokens: completion.usage.prompt, outputTokens: completion.usage.completion, model: key };
        break;
      } catch (e: any) {
        const retry = e instanceof LLMError ? e.retryable : false;
        if (record && retry) await recordModelFailure(key, o.env).catch(() => {});
        if (retry && idx + 1 < o.chain.length) {
          const next = o.chain[idx + 1]!;
          yield { type: "fallback", from: key, to: `${next.provider}/${next.id}`, reason: e.message.slice(0, 160) };
          idx++;
          continue;
        }
        yield { type: "error", message: e.message };
        await finish("error", e.message);
        return;
      }
    }
    const msg = completion.message;
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const m = o.chain[idx]!;
      yield { type: "done", harness: "native", model: `${m.provider}/${m.id}` };
      await finish(toolsUsed.some((t) => t === "edit_file" || t === "write_file") ? "edited" : "answered");
      return;
    }
    for (const c of calls) {
      let input: any = {};
      let out: string;
      try { input = JSON.parse(c.function.arguments || "{}"); out = await runTool(c.function.name, input, o.tool); }
      catch (e: any) { out = `error: ${e.message}`; }
      toolsUsed.push(c.function.name);
      yield { type: "tool", name: c.function.name, input, output: out.slice(0, 2000), error: out.startsWith("error") };
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  yield { type: "error", message: `stopped after ${maxSteps} steps` };
  await finish("error", `stopped after ${maxSteps} steps`);
}
