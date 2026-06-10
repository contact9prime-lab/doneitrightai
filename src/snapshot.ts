import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export interface SnapshotEntry {
  /** Absolute path this entry protects. */
  path: string;
  /** Whether the path existed when the snapshot was taken. */
  existed: boolean;
}

export interface SnapshotManifest {
  type: "fs";
  dir: string;
  entries: SnapshotEntry[];
}

const PATH_KEY = /path|file|dir|folder|source|destination|target|dest/i;

/**
 * Best-effort extraction of filesystem paths an MCP tool call may touch:
 * absolute-path string values under path-shaped keys (recursing into
 * objects and arrays). Relative paths are ignored — we cannot know the
 * downstream server's working directory.
 */
export function extractPaths(args: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, keyHint: string): void => {
    if (typeof value === "string") {
      if (PATH_KEY.test(keyHint) && isAbsolute(value)) found.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, key);
    }
  };
  visit(args, "");
  return [...found];
}

function sizeOf(path: string, budget: number): number {
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const name of readdirSync(path)) {
    total += sizeOf(join(path, name), budget - total);
    if (total > budget) return total; // early bail
  }
  return total;
}

/**
 * Copy the current state of `paths` under `snapshotRoot/<id>/`.
 * Returns null when the content exceeds `maxBytes` — the caller must then
 * escalate the action to a hold instead of pretending it is recoverable.
 */
export function takeSnapshot(
  id: string,
  paths: string[],
  snapshotRoot: string,
  maxBytes: number,
): SnapshotManifest | null {
  const dir = join(snapshotRoot, id);
  const entries: SnapshotEntry[] = [];
  let budget = maxBytes;
  mkdirSync(dir, { recursive: true });
  for (const [index, path] of paths.entries()) {
    const existed = existsSync(path);
    if (existed) {
      const size = sizeOf(path, budget);
      budget -= size;
      if (budget < 0) {
        rmSync(dir, { recursive: true, force: true });
        return null;
      }
      cpSync(path, join(dir, String(index)), { recursive: true });
    }
    entries.push({ path, existed });
  }
  return { type: "fs", dir, entries };
}

/**
 * Put the world back: restore overwritten/deleted paths from the snapshot,
 * delete paths that did not exist before the action.
 */
export function restoreSnapshot(manifest: SnapshotManifest): void {
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry.existed) {
      rmSync(entry.path, { recursive: true, force: true });
      cpSync(join(manifest.dir, String(index)), entry.path, { recursive: true });
    } else {
      rmSync(entry.path, { recursive: true, force: true });
    }
  }
}
