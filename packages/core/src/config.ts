import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Policy, Tier } from "./types";
import type { ProviderSpec } from "./providers";

export interface Config {
  policy: Policy;
  /** harness id or "auto" */
  harness: string;
  /** pin "provider/model" for every request */
  model?: string;
  tierOverrides: Record<string, Tier>;
  /** extra OpenAI-compatible providers. Keys come from the named env var, never from this file. */
  providers: ProviderSpec[];
  yolo: boolean;
  /** provider ids you confirm are free for your account (upgrades 'unverified' providers) */
  allowFree: string[];
}

export const DEFAULT_CONFIG: Config = { policy: "free", harness: "auto", tierOverrides: {}, providers: [], yolo: false, allowFree: [] };

export function configPath(home = homedir()) { return join(process.env.SHELLCODE_HOME ?? join(home, ".shellcode"), "config.json"); }

export async function loadConfig(path = configPath()): Promise<Config> {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(path, "utf8")) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

export async function saveConfig(c: Config, path = configPath()) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(c, null, 2));
}
