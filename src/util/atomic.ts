/**
 * Atomic file writes.
 *
 * state.json and manifest.json are the crash-recovery record. A partially
 * written manifest is worse than no manifest: it can hide a paid job that is
 * already running. Every write therefore goes to a temp file, is flushed to
 * disk, and is then renamed - rename being atomic within a filesystem.
 */

import {
  writeFileSync,
  readFileSync,
  renameSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';

/**
 * Write `data` to `path` atomically.
 *
 * Readers observe either the previous content or the new content, never a
 * truncated file, even if the process is killed mid-write.
 */
export function writeFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Same directory as the target: rename() is only atomic within one filesystem.
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);

  try {
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });

    // Force the bytes to disk before the rename, otherwise a power loss can
    // leave a renamed-but-empty file.
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best effort - the original file is intact either way, and failing
        // to remove a temp file must not mask the real error.
      }
    }
    throw err;
  }
}

/** Atomically write a value as pretty-printed JSON. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read and parse JSON, returning `fallback` when the file does not exist. */
export function readJsonIfExists<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Remove any stale temp files left by an interrupted write. */
export function cleanupTempFiles(dir: string, targetName: string): number {
  if (!existsSync(dir)) return 0;
  // Deliberately narrow: only files matching our own temp pattern.
  const prefix = `.${targetName}.`;
  let removed = 0;
  for (const name of readdirSafe(dir)) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) {
      try {
        unlinkSync(join(dir, name));
        removed += 1;
      } catch {
        // Ignore - a leftover temp file is harmless.
      }
    }
  }
  return removed;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
