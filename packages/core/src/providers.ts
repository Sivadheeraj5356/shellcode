import type { ModelInfo, Tier } from "./types";

export interface ProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  /** env var holding the API key. null = no key needed (local). */
  keyEnv: string | null;
  cost: ModelInfo["cost"];
  note: string;
  signup?: string;
  /** official page the cost label was checked against (2026-10-21) */
  terms?: string;
}

/**
 * OpenAI-compatible chat/completions endpoints. "free-tier" means the provider
 * documents a no-card free plan with rate limits; limits and model lists change,
 * so models are discovered live from GET /models instead of being hardcoded.
 */
export const PROVIDERS: ProviderSpec[] = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", cost: "free-tier", note: "Only models listed at price 0 (':free') count as free. Without bought credits the docs state about 50 free-model requests per day", signup: "https://openrouter.ai/keys", terms: "https://openrouter.ai/docs/faq" },
  { id: "gemini", name: "Google Gemini (AI Studio)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", cost: "free-tier", note: "Free tier exists but not for every model, and Google's pricing page says free-tier content may be used to improve its products", signup: "https://aistudio.google.com/apikey", terms: "https://ai.google.dev/gemini-api/docs/pricing" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", cost: "unverified", note: "Free access not confirmed from current docs. Add \"groq\" to allowFree in config if your account is free", signup: "https://console.groq.com/keys", terms: "https://console.groq.com/docs/rate-limits" },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", cost: "unverified", note: "Docs describe $5 trial credits that need a verified payment method. Not treated as free", signup: "https://cloud.cerebras.ai", terms: "https://inference-docs.cerebras.ai/support/rate-limits" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", cost: "unverified", note: "Free access and training-data terms not confirmed. Add \"mistral\" to allowFree in config if your account is free", signup: "https://console.mistral.ai", terms: "https://docs.mistral.ai/admin/billing-usage/usage-limits" },
  { id: "ollama", name: "Local server :11434", baseUrl: "http://localhost:11434/v1", keyEnv: null, cost: "local", note: "Any OpenAI-compatible server on port 11434 (Ollama default; llama.cpp llama-server works if started with --port 11434). Runs on your machine, no key" },
  { id: "lmstudio", name: "Local server :1234", baseUrl: "http://localhost:1234/v1", keyEnv: null, cost: "local", note: "Runs on your machine, no key" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", cost: "paid", note: "Paid per token" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", cost: "paid", note: "Paid per token (OpenAI-compatible endpoint)" },
];

export function providerById(id: string, extra: ProviderSpec[] = []): ProviderSpec | undefined {
  return [...extra, ...PROVIDERS].find((p) => p.id === id);
}

export function apiKey(p: ProviderSpec, env: Record<string, string | undefined> = process.env): string | undefined {
  return p.keyEnv ? env[p.keyEnv] : "local";
}

/** Guess a capability tier from a model id. Overridable via config.tierOverrides. */
export function classifyModel(id: string): Tier {
  const s = id.toLowerCase();
  if (/(opus|ultra|405b|671b|550b|480b|235b|\b1\d\db\b|-pro\b|gpt-5(?!.*(mini|nano))|o3(?!-mini)|sonnet|large|reasoner|r1\b|thinking)/.test(s)) return "heavy";
  if (/(nano|mini|lite|flash|small|tiny|haiku|instant|\b[1-9]b\b|\b1[0-4]b\b|lightning|-xs|-s\b)/.test(s)) return "light";
  const m = s.match(/(\d+)b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 60) return "heavy";
    if (n <= 14) return "light";
  }
  return "standard";
}

const NON_CHAT = /(embed|whisper|tts|guard|safety|moderation|rerank|image|vision-only|audio|transcribe)/i;

export async function discoverModels(
  p: ProviderSpec,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; tierOverrides?: Record<string, Tier>; allowFree?: string[] } = {},
): Promise<ModelInfo[]> {
  const f = opts.fetchImpl ?? fetch;
  const key = apiKey(p, opts.env);
  if (!key) return [];
  const res = await f(`${p.baseUrl}/models`, {
    headers: p.keyEnv ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${p.id} /models -> HTTP ${res.status}`);
  const body: any = await res.json();
  const rows: any[] = body.data ?? body.models ?? [];
  const out: ModelInfo[] = [];
  for (const r of rows) {
    const raw: string = r.id ?? r.name;
    if (!raw || NON_CHAT.test(raw)) continue;
    const id = raw.replace(/^models\//, "");
    let cost = p.cost;
    if (cost === "unverified" && opts.allowFree?.includes(p.id)) cost = "free-tier";
    if (p.id === "openrouter") {
      const pr = r.pricing;
      const zero = pr && Number(pr.prompt) === 0 && Number(pr.completion) === 0;
      cost = zero ? "free" : "paid";
    }
    out.push({
      provider: p.id,
      id,
      tier: opts.tierOverrides?.[`${p.id}/${id}`] ?? classifyModel(id),
      free: cost === "free" || cost === "local",
      cost,
      contextLength: r.context_length,
    });
  }
  return out;
}
