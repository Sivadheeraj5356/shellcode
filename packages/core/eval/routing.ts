import { scoreTask } from "../src/router";
import tuning from "./routing-set.json";
import heldout from "./routing-heldout.json";

// Labelled by hand by the same author as the rules, so the numbers are optimistic. It measures
// agreement with human tier labels for the keyword heuristic, not model quality or task success.
function evaluate(name: string, set: [string, string][]) {
const tiers = ["light", "standard", "heavy"] as const;
const cm: Record<string, Record<string, number>> = {};
let ok = 0, far = 0;
const wrong: string[] = [];
for (const [prompt, want] of set as [string, string][]) {
  const got = scoreTask({ prompt }).tier;
  (cm[want] ??= {})[got] = ((cm[want] ??= {})[got] ?? 0) + 1;
  if (got === want) ok++; else { wrong.push(`  want ${want}, got ${got}: ${prompt}`); if (Math.abs(tiers.indexOf(got as any) - tiers.indexOf(want as any)) === 2) far++; }
}
console.log(`${name}: agreement ${ok}/${set.length} (${Math.round((100 * ok) / set.length)}%), two-tier misses ${far}`);
for (const w of tiers) console.log(`  labelled ${w.padEnd(8)}`, tiers.map((g) => `${g}:${cm[w]?.[g] ?? 0}`).join("  "));
if (wrong.length) console.log("disagreements:\n" + wrong.join("\n"));
}
evaluate("tuning set (rules were adjusted after seeing it)", tuning as [string, string][]);
console.log("");
evaluate("held-out set (written after the last rule change, not tuned on)", heldout as [string, string][]);
