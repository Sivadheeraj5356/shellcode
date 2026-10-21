import type { ChatMessage, ModelInfo } from "./types";
import { providerById, apiKey, type ProviderSpec } from "./providers";

export class LLMError extends Error {
  constructor(msg: string, public status?: number, public retryable = false) { super(msg); }
}

export interface Completion {
  message: ChatMessage;
  usage?: { prompt: number; completion: number };
}

export async function chat(
  model: ModelInfo,
  messages: ChatMessage[],
  tools: readonly { name: string; description: string; parameters: unknown }[] | undefined,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; extraProviders?: ProviderSpec[]; signal?: AbortSignal; onText?: (chunk: string) => void } = {},
): Promise<Completion> {
  const p = providerById(model.provider, opts.extraProviders);
  if (!p) throw new LLMError(`unknown provider ${model.provider}`);
  const key = apiKey(p, opts.env);
  if (!key) throw new LLMError(`${p.keyEnv} is not set`);
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(p.keyEnv ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: model.id,
        messages,
        ...(opts.onText ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
      }),
      signal: opts.signal ?? AbortSignal.timeout(120_000),
    });
  } catch (e: any) {
    throw new LLMError(`network error: ${e.message}`, undefined, true);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new LLMError(`${p.id}/${model.id} HTTP ${res.status}: ${body}`, res.status, res.status === 429 || res.status >= 500 || res.status === 404 || res.status === 402);
  }
  if (opts.onText && (res.headers.get("content-type") ?? "").includes("text/event-stream")) return await readStream(res, p.id + "/" + model.id, opts.onText);
  const data: any = await res.json();
  if (opts.onText && data.choices?.[0]?.message?.content) opts.onText(data.choices[0].message.content);
  const m = data.choices?.[0]?.message;
  if (!m) throw new LLMError(`${p.id}/${model.id} returned no message`, undefined, true);
  return {
    message: { role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls },
    usage: data.usage ? { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 } : undefined,
  };
}

async function readStream(res: Response, label: string, onText: (s: string) => void): Promise<Completion> {
  const dec = new TextDecoder();
  let buf = "", content = "";
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  let usage: Completion["usage"];
  const reader = res.body!.getReader();
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(payload); } catch { return; }
    if (j.error) throw new LLMError(`${label} stream error: ${JSON.stringify(j.error).slice(0, 200)}`, undefined, true);
    if (j.usage) usage = { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0 };
    const d = j.choices?.[0]?.delta;
    if (!d) return;
    if (d.content) { content += d.content; onText(d.content); }
    for (const tc of d.tool_calls ?? []) {
      const c = (calls[tc.index ?? 0] ??= { id: "", name: "", args: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) handle(buf.trim());
  const tool_calls = Object.keys(calls).length ? Object.entries(calls).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, c], n) => ({ id: c.id || `call_${n}`, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } })) : undefined;
  return { message: { role: "assistant", content: content || null, tool_calls }, usage };
}
