export type Tier = "light" | "standard" | "heavy";
export type Policy = "free" | "balanced" | "quality";

export interface ModelInfo {
  provider: string;
  id: string;
  tier: Tier;
  /** true only when the provider's own listing says the price is zero (OpenRouter) or the provider is local. */
  free: boolean;
  /** free: priced 0 in the provider listing. free-tier: provider documents a free plan (limits, account and region terms apply).
   *  local: runs on this machine. unverified: free plan not confirmed or needs a card/trial, treated like paid unless the user allowlists it.
   *  paid: billed per token. */
  cost: "free" | "free-tier" | "local" | "unverified" | "paid";
  contextLength?: number;
}

export interface RouteDecision {
  tier: Tier;
  score: number;
  reasons: string[];
  chain: ModelInfo[];
}

export type AgentEvent =
  | { type: "route"; decision: RouteDecision }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown; output?: string; error?: boolean }
  | { type: "fallback"; from: string; to: string; reason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; model: string }
  | { type: "error"; message: string }
  | { type: "done"; harness: string; model?: string };

export interface RunOptions {
  prompt: string;
  cwd: string;
  harness?: string; // id, or undefined for auto
  policy?: Policy;
  model?: string; // "provider/model" pin
  /** auto-approve file writes and shell commands (native harness) */
  yolo?: boolean;
  signal?: AbortSignal;
  history?: ChatMessage[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
