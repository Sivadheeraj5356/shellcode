import type { ModelInfo, Policy, RouteDecision, Tier } from "./types";

export interface RouteInput {
  prompt: string;
  /** number of files the user attached / referenced */
  fileCount?: number;
  /** turns so far in this session */
  turns?: number;
  /** a previous attempt at this task failed (tests red, tool error) -> escalate */
  previousFailures?: number;
}

const HEAVY_WORDS = /\b(refactor|architect\w*|redesign|migrat\w+|race condition|deadlock|concurren\w+|security|vulnerab\w+|performance|optimi[sz]e|rewrite|implement (a|an|the)? ?\w+ (system|service|engine|pipeline)|debug|root cause|across (the )?(repo|codebase|files)|multi[- ]file|from scratch|algorithm|schema|end[- ]to[- ]end|audit|whole (project|codebase|app)|entire (project|codebase|app)|distributed|offline|sync\w*|benchmark\w*|query planner|sliding window|idempoten\w+|monolith)\b/i;
const LIGHT_WORDS = /\b(typo|rename|format|lint|comment|docstring|explain|what is|what does|summari[sz]e|one[- ]liner|add a log|bump|version|readme|translate|list)\b/i;

const MEDIUM_WORDS = /\b(fail\w*|error|bug|broken|why|tests?|crash\w*|exception|regression|investigate|diagnose)\b/i;

export function scoreTask(input: RouteInput): { score: number; tier: Tier; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const p = input.prompt;
  const words = p.trim().split(/\s+/).length;
  if (words > 120) { score += 2; reasons.push(`long request (${words} words)`); }
  else if (words > 40) { score += 1; reasons.push(`medium request (${words} words)`); }
  
  const heavy = p.match(new RegExp(HEAVY_WORDS.source, "gi"));
  if (heavy) { score += Math.min(3, heavy.length * 2); reasons.push(`complex work: ${[...new Set(heavy.map((s) => s.toLowerCase()))].join(", ")}`); }
  const light = p.match(new RegExp(LIGHT_WORDS.source, "gi"));
  if (words < 8 && !heavy && !MEDIUM_WORDS.test(p)) { score -= 1; reasons.push("very short request"); }
  else if (light && words < 12) { score -= 1; reasons.push("short request"); }
  if (light) { score -= Math.min(2, light.length); reasons.push(`simple work: ${[...new Set(light.map((s) => s.toLowerCase()))].join(", ")}`); }
  if (MEDIUM_WORDS.test(p)) { score += 1; reasons.push("diagnosis or testing work"); }
  if (/```|stack trace|traceback|\bat \S+:\d+/.test(p)) { score += 1; reasons.push("contains code or a stack trace"); }
  if ((input.fileCount ?? 0) >= 4) { score += 2; reasons.push(`${input.fileCount} files involved`); }
  else if ((input.fileCount ?? 0) >= 2) { score += 1; reasons.push(`${input.fileCount} files involved`); }
  if ((input.turns ?? 0) > 12) { score += 1; reasons.push("long session"); }
  if (input.previousFailures) { score += 2 * input.previousFailures; reasons.push(`escalating after ${input.previousFailures} failed attempt(s)`); }
  const tier: Tier = score >= 2 ? "heavy" : score <= -1 ? "light" : "standard";
  if (reasons.length === 0) reasons.push("no strong signals, default tier");
  return { score, tier, reasons };
}

/** The single place that decides whether a model may be called. Also enforced at call time. */
export function isAllowed(m: ModelInfo, policy: Policy, tier: Tier = "heavy"): boolean {
  const free = m.cost === "free" || m.cost === "free-tier" || m.cost === "local";
  if (policy === "free") return free;
  if (policy === "balanced") return free || tier === "heavy";
  return true;
}

const ORDER: Tier[] = ["light", "standard", "heavy"];

/**
 * Build an ordered fallback chain. Policy:
 *  free     only cost free/local, then free-tier providers; never paid
 *  balanced free first, paid only for heavy tier
 *  quality  paid/strongest first
 * Paid models are only included when policy allows AND the caller passed them (i.e. the user configured a key).
 */
export function route(input: RouteInput, models: ModelInfo[], policy: Policy = "free"): RouteDecision {
  const { score, tier, reasons } = scoreTask(input);
  const allowed = models.filter((m) => isAllowed(m, policy, tier));
  const costRank = (m: ModelInfo) => ({ local: 0, free: 1, "free-tier": 2, unverified: 3, paid: 4 })[m.cost];
  const dist = (m: ModelInfo) => {
    const d = ORDER.indexOf(m.tier) - ORDER.indexOf(tier);
    // prefer an exact tier, then a stronger one over a weaker one
    return d === 0 ? 0 : d > 0 ? d : -d + 0.5;
  };
  const chain = [...allowed].sort((a, b) => {
    if (policy === "quality") return dist(a) - dist(b) || -(costRank(a) - costRank(b));
    return dist(a) - dist(b) || costRank(a) - costRank(b) || (b.contextLength ?? 0) - (a.contextLength ?? 0);
  });
  if (chain.length === 0) reasons.push("no usable models: configure a provider key or start a local model");
  return { tier, score, reasons, chain };
}
