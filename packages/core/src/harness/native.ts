import type { AgentEvent, ChatMessage, ModelInfo, Policy, Tier } from "../types";
import { chat, LLMError } from "../llm";
import { TOOL_DEFS, runTool, type ToolContext } from "../tools";
import type { ProviderSpec } from "../providers";
import { isAllowed } from "../router";

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
}

export async function* runNative(o: NativeOptions): AsyncGenerator<AgentEvent> {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...(o.history ?? []), { role: "user", content: o.prompt }];
  let idx = 0;
  const maxSteps = o.maxSteps ?? 25;
  if (o.chain.length === 0) { yield { type: "error", message: "No models available. Set a provider key (see `shellcode doctor`) or start Ollama." }; return; }
  for (let step = 0; step < maxSteps; step++) {
    let completion;
    while (true) {
      const model = o.chain[idx]!;
      if (o.policy && !isAllowed(model, o.policy, o.tier)) {
        yield { type: "error", message: `blocked: ${model.provider}/${model.id} is ${model.cost} and the ${o.policy} policy does not allow it. No request was sent.` };
        return;
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
        if (completion.usage) yield { type: "usage", inputTokens: completion.usage.prompt, outputTokens: completion.usage.completion, model: `${model.provider}/${model.id}` };
        break;
      } catch (e: any) {
        const retry = e instanceof LLMError ? e.retryable : false;
        if (retry && idx + 1 < o.chain.length) {
          const next = o.chain[idx + 1]!;
          yield { type: "fallback", from: `${model.provider}/${model.id}`, to: `${next.provider}/${next.id}`, reason: e.message.slice(0, 160) };
          idx++;
          continue;
        }
        yield { type: "error", message: e.message };
        return;
      }
    }
    const msg = completion.message;
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const m = o.chain[idx]!;
      yield { type: "done", harness: "native", model: `${m.provider}/${m.id}` };
      return;
    }
    for (const c of calls) {
      let input: any = {};
      let out: string;
      try { input = JSON.parse(c.function.arguments || "{}"); out = await runTool(c.function.name, input, o.tool); }
      catch (e: any) { out = `error: ${e.message}`; }
      yield { type: "tool", name: c.function.name, input, output: out.slice(0, 2000), error: out.startsWith("error") };
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  yield { type: "error", message: `stopped after ${maxSteps} steps` };
}
