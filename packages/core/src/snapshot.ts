// Workspace snapshot diff: proves whether an agent run actually changed files
// on disk. It verifies PERSISTED CHANGE ONLY - never semantic correctness.
// A run whose tools reported success but whose snapshot shows no change is
// recorded as "no-change" in the outcome ledger, so the next attempt can
// escalate instead of trusting the model's own claim.
import { readdir, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

const SKIP = new Set([".git", "node_modules", ".shellcode", "dist", "build", ".next", ".cache"]);
const MAX_FILES = 5000;
const MAX_DEPTH = 8;
// Files up to this size are content-hashed, so a same-size edit inside the
// filesystem's mtime granularity is still detected. Larger files rely on
// mtime+size (documented hole: a same-size, same-mtime large-file edit).
const HASH_MAX_FILE = 1024 * 1024;
const HASH_MAX_TOTAL = 64 * 1024 * 1024;

export interface FileSig { mtimeMs: number; size: number; hash?: string; }
export type Snapshot = Map<string, FileSig>;

export async function snapshotFiles(root: string): Promise<Snapshot> {
  const out: Snapshot = new Map();
  let count = 0;
  let hashed = 0;
  async function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH || count >= MAX_FILES) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= MAX_FILES) return;
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      try {
        const s = await stat(p);
        const sig: FileSig = { mtimeMs: s.mtimeMs, size: s.size };
        if (s.size <= HASH_MAX_FILE && hashed + s.size <= HASH_MAX_TOTAL) {
          try {
            sig.hash = createHash("sha1").update(await readFile(p)).digest("hex");
            hashed += s.size;
          } catch { /* unreadable: mtime+size only */ }
        }
        out.set(relative(root, p), sig);
        count++;
      } catch { /* vanished mid-walk */ }
    }
  }
  await walk(root, 0);
  return out;
}

export interface SnapshotDiff { created: string[]; modified: string[]; deleted: string[]; }

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const created: string[] = [], modified: string[] = [], deleted: string[] = [];
  for (const [p, sig] of after) {
    const b = before.get(p);
    if (!b) created.push(p);
    else if (b.hash && sig.hash ? b.hash !== sig.hash
         : b.mtimeMs !== sig.mtimeMs || b.size !== sig.size) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

export function changedFiles(d: SnapshotDiff): string[] {
  return [...d.created, ...d.modified, ...d.deleted];
}
