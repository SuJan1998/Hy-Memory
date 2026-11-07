/**
 * Pushing this machine's transcripts to a Core that keeps the memory.
 *
 * The loop has no local state on purpose. What we hold is whatever the server's
 * manifest says we hold, so a host that crashes mid-push, is restarted, or is
 * offline for a week resumes from the same answer it would have got on day one:
 * ask again, compare, send the tail. There is no queue to corrupt and no queue
 * to disagree with the server about.
 *
 * A conflict is not retried. `409` means the bytes we were about to extend are
 * not the bytes the server holds -- the host rewrote the file while it could not
 * reach us -- and pushing anyway would splice two different histories into one
 * transcript. The next pass asks again and starts from the new answer.
 *
 * Root discovery is deliberately *not* asked of the server. The server knows
 * where a source root sits on its own disk, which says nothing about this
 * machine: `~/.codex/sessions` here is not `/home/sujan/.codex/sessions` there.
 * The host states its roots in its own config, and the server only ever learns
 * the paths relative to those roots.
 */

import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** sha256 of nothing: the tail of a file the server does not hold yet. */
export const EMPTY_TAIL = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** One append carries at most this much; the server refuses more. */
export const MAX_APPEND_BYTES = 4 * 1024 * 1024;

/** How many trailing bytes `tail_hash` covers. Mirrors the server's window. */
const TAIL_BYTES = 4096;

export interface SyncSourceConfig {
  sourceId: string;
  /** This machine's directory for that source. `~` is expanded. */
  root: string;
}

export interface SyncConfig {
  enabled: boolean;
  /**
   * A file has to sit still this long before it is pushed.
   *
   * Transcripts are appended to while the host is running, and sending a file
   * mid-append means the next pass finds a tail that does not match what it
   * last sent. Waiting costs one pass of latency and removes that whole class
   * of conflict.
   */
  settleSeconds: number;
  /** How often `sync watch` starts a pass. */
  intervalSeconds: number;
  sources: SyncSourceConfig[];
}

export interface SyncSourceOutcome {
  sourceId: string;
  /** Files extended this pass. */
  pushed: number;
  /** Bytes accepted by the server this pass. */
  bytes: number;
  /** Appends refused with 409; the next pass starts from a fresh manifest. */
  conflicts: number;
  /** Appends that failed for any other reason; retried next pass. */
  failed: number;
  /** Files the server is already level with, or that are still settling. */
  skipped: number;
  /** Set when the whole source could not be attempted. */
  error?: string;
}

export interface ServerFile {
  path: string;
  size: number;
  tail_hash: string;
}

export interface SyncOptions {
  serverUrl: string;
  /** The `omhg_v1_…` host credential. */
  credential: string;
  sources: SyncSourceConfig[];
  settleSeconds?: number;
  home?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * The absolute directory a configured root names.
 *
 * A relative root resolves against the home directory rather than the working
 * directory: this runs from a scheduled task, where the working directory is
 * whatever the scheduler felt like, and "sessions" silently meaning two
 * different places depending on who started us is not a bug worth having.
 */
function resolveRoot(root: string, home: string): string {
  if (root === "~") return home;
  if (root.startsWith("~/") || root.startsWith("~\\")) return path.join(home, root.slice(2));
  return path.isAbsolute(root) ? root : path.join(home, root);
}

/** Every regular file under `root`, as paths relative to it, POSIX-separated. */
async function listFiles(root: string, home: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // A symlink is not this root's file, and following one would push
      // whatever it happens to point at.
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        found.push(relative);
      }
    }
  }
  await walk(resolveRoot(root, home), "");
  found.sort();
  return found;
}

async function readRange(target: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

function endpoint(serverUrl: string, sourceId: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/api/v1/sources/${encodeURIComponent(sourceId)}/files`;
}

async function manifestFor(
  options: Required<Pick<SyncOptions, "fetchImpl">> & SyncOptions,
  sourceId: string,
): Promise<Map<string, ServerFile>> {
  const response = await options.fetchImpl(endpoint(options.serverUrl, sourceId), {
    headers: { Authorization: `Bearer ${options.credential}` },
  });
  if (!response.ok) {
    throw new Error(`manifest_failed:${response.status}`);
  }
  const body = (await response.json()) as { files?: ServerFile[] };
  return new Map((body.files ?? []).map((file) => [file.path, file]));
}

async function pushChunk(
  options: Required<Pick<SyncOptions, "fetchImpl">> & SyncOptions,
  sourceId: string,
  relative: string,
  offset: number,
  tailHash: string,
  chunk: Buffer,
): Promise<{ size: number; tail_hash: string }> {
  const response = await options.fetchImpl(endpoint(options.serverUrl, sourceId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: relative,
      offset,
      tail_hash: tailHash,
      data: chunk.toString("base64"),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 409) {
    throw Object.assign(new Error("sync_conflict"), { conflict: true });
  }
  if (!response.ok) {
    throw new Error(`append_failed:${response.status}:${String(body.detail ?? "")}`);
  }
  return { size: Number(body.size), tail_hash: String(body.tail_hash) };
}

async function syncSource(
  options: Required<Pick<SyncOptions, "fetchImpl" | "now" | "home">> & SyncOptions,
  source: SyncSourceConfig,
): Promise<SyncSourceOutcome> {
  const outcome: SyncSourceOutcome = {
    sourceId: source.sourceId,
    pushed: 0,
    bytes: 0,
    conflicts: 0,
    failed: 0,
    skipped: 0,
  };
  const settleMs = (options.settleSeconds ?? 2) * 1000;
  const root = resolveRoot(source.root, options.home);
  let manifest: Map<string, ServerFile>;
  try {
    manifest = await manifestFor(options, source.sourceId);
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
    return outcome;
  }

  for (const relative of await listFiles(source.root, options.home)) {
    const absolute = path.join(root, ...relative.split("/"));
    let info;
    try {
      info = await stat(absolute);
    } catch {
      continue;
    }
    if (options.now() - info.mtimeMs < settleMs) {
      outcome.skipped += 1;
      continue;
    }
    const known = manifest.get(relative);
    if (known !== undefined && info.size <= known.size) {
      outcome.skipped += 1;
      continue;
    }
    let offset = known?.size ?? 0;
    let tail = known?.tail_hash ?? EMPTY_TAIL;
    if (known === undefined && info.size === 0) {
      outcome.skipped += 1;
      continue;
    }
    if (known !== undefined && offset > 0) {
      // Check *our own* bytes against what the server says it holds before
      // extending it. The server re-checks the same window, but by then we have
      // already sent the tail: if the host rewrote this file to be longer while
      // it could not reach us, appending would splice two different histories
      // into one transcript and no later pass could tell.
      const window = Math.min(offset, TAIL_BYTES);
      const local = await readRange(absolute, offset - window, window);
      const digest = createHash("sha256").update(local).digest("hex");
      if (digest !== known.tail_hash) {
        outcome.conflicts += 1;
        continue;
      }
    }

    let conflicted = false;
    while (offset < info.size) {
      const length = Math.min(info.size - offset, MAX_APPEND_BYTES);
      let chunk: Buffer;
      try {
        chunk = await readRange(absolute, offset, length);
      } catch {
        outcome.failed += 1;
        conflicted = true;
        break;
      }
      if (chunk.length === 0) break;
      try {
        const accepted = await pushChunk(options, source.sourceId, relative, offset, tail, chunk);
        offset = accepted.size;
        tail = accepted.tail_hash;
        outcome.pushed += 1;
        outcome.bytes += chunk.length;
      } catch (error) {
        if (error instanceof Error && "conflict" in error) {
          outcome.conflicts += 1;
        } else {
          outcome.failed += 1;
        }
        conflicted = true;
        break;
      }
    }
  }
  return outcome;
}

export async function syncOnce(options: SyncOptions): Promise<SyncSourceOutcome[]> {
  const resolved = {
    ...options,
    settleSeconds: options.settleSeconds ?? 2,
    home: options.home ?? homedir(),
    now: options.now ?? (() => Date.now()),
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const outcomes: SyncSourceOutcome[] = [];
  for (const source of options.sources) {
    outcomes.push(await syncSource(resolved, source));
  }
  return outcomes;
}

/** A digest of what a pass moved, for a log line that is not a wall of text. */
export function summarize(outcomes: SyncSourceOutcome[]): string {
  const pushed = outcomes.reduce((total, item) => total + item.pushed, 0);
  const bytes = outcomes.reduce((total, item) => total + item.bytes, 0);
  const conflicts = outcomes.reduce((total, item) => total + item.conflicts, 0);
  const failed = outcomes.reduce((total, item) => total + item.failed, 0);
  const errors = outcomes.filter((item) => item.error !== undefined);
  const parts = [`${pushed} 个文件 / ${bytes} 字节`];
  if (conflicts > 0) parts.push(`${conflicts} 个冲突待下轮`);
  if (failed > 0) parts.push(`${failed} 个失败待重试`);
  for (const item of errors) parts.push(`${item.sourceId}: ${item.error}`);
  return parts.join("，");
}
