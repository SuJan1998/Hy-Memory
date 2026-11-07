/**
 * Pushing this machine's transcripts to a Core that keeps the memory.
 *
 * These pin the client's half of the protocol against a fake that implements
 * the *server's* rules rather than echoing the client: an append is accepted
 * only when the offset and the tail hash both describe what the server holds.
 * A mock that simply said yes would agree with any client.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EMPTY_TAIL, MAX_APPEND_BYTES, syncOnce } from "./sync.js";

const TAIL_BYTES = 4096;

function tailOf(data: Buffer): string {
  return createHash("sha256")
    .update(data.subarray(Math.max(0, data.length - TAIL_BYTES)))
    .digest("hex");
}

/**
 * The Core's receiving end, in memory.
 *
 * Deliberately a re-implementation rather than a mock of the client's own
 * assumptions: the point of these tests is that the two sides agree about what
 * an append means, and a mock that echoes the client would agree with anything.
 */
class FakeCore {
  readonly files = new Map<string, Buffer>();
  readonly posts: { path: string; offset: number; length: number }[] = [];
  manifestFailures = 0;
  posts_ok = 0;

  private key(sourceId: string, filePath: string): string {
    return `${sourceId}\u0000${filePath}`;
  }

  put(sourceId: string, filePath: string, data: Buffer): void {
    this.files.set(this.key(sourceId, filePath), data);
  }

  read(sourceId: string, filePath: string): Buffer {
    return this.files.get(this.key(sourceId, filePath)) ?? Buffer.alloc(0);
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const sourceId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
    const method = init?.method ?? "GET";

    if (method === "GET") {
      if (this.manifestFailures > 0) {
        this.manifestFailures -= 1;
        return new Response(JSON.stringify({ detail: "boom" }), { status: 503 });
      }
      const files = [...this.files.entries()]
        .filter(([key]) => key.startsWith(`${sourceId}\u0000`))
        .map(([key, data]) => ({
          path: key.slice(key.indexOf("\u0000") + 1),
          size: data.length,
          tail_hash: tailOf(data),
        }));
      return new Response(JSON.stringify({ schema_version: 1, source_id: sourceId, files }), {
        status: 200,
      });
    }

    const body = JSON.parse(String(init?.body)) as {
      path: string;
      offset: number;
      tail_hash: string;
      data: string;
    };
    const current = this.read(sourceId, body.path);
    const payload = Buffer.from(body.data, "base64");
    this.posts.push({ path: body.path, offset: body.offset, length: payload.length });
    if (body.offset !== current.length) {
      return new Response(JSON.stringify({ detail: "sync_offset_mismatch" }), { status: 409 });
    }
    if (body.tail_hash !== tailOf(current)) {
      return new Response(JSON.stringify({ detail: "sync_tail_mismatch" }), { status: 409 });
    }
    const next = Buffer.concat([current, payload]);
    this.files.set(this.key(sourceId, body.path), next);
    this.posts_ok += 1;
    return new Response(
      JSON.stringify({ path: body.path, size: next.length, tail_hash: tailOf(next) }),
      { status: 200 },
    );
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "one-memory-sync-"));
}

async function settled(target: string, secondsAgo = 60): Promise<void> {
  const when = new Date(Date.now() - secondsAgo * 1000);
  await utimes(target, when, when);
}

function options(home: string, core: FakeCore, root = "sessions") {
  return {
    serverUrl: "http://core.invalid",
    credential: "omhg_v1_test",
    sources: [{ sourceId: "codex", root }],
    home,
    fetchImpl: core.fetch as unknown as typeof fetch,
  };
}

describe("sync pass", () => {
  it("pins the empty-tail constant the server also uses", () => {
    expect(EMPTY_TAIL).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("sends a new file whole, from offset zero", async () => {
    const home = await scratch();
    const core = new FakeCore();
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const file = path.join(home, "sessions", "a.jsonl");
    await writeFile(file, '{"id":1}\n');
    await settled(file);

    const [outcome] = await syncOnce(options(home, core));

    expect(outcome).toMatchObject({ sourceId: "codex", pushed: 1, bytes: 9, conflicts: 0 });
    expect(core.read("codex", "a.jsonl").toString()).toBe('{"id":1}\n');
    expect(core.posts).toEqual([{ path: "a.jsonl", offset: 0, length: 9 }]);
  });

  it("sends only the bytes past what the server already holds", async () => {
    const home = await scratch();
    const core = new FakeCore();
    core.put("codex", "a.jsonl", Buffer.from('{"id":1}\n'));
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const file = path.join(home, "sessions", "a.jsonl");
    await writeFile(file, '{"id":1}\n{"id":2}\n');
    await settled(file);

    const [outcome] = await syncOnce(options(home, core));

    expect(outcome).toMatchObject({ pushed: 1, bytes: 9 });
    expect(core.posts).toEqual([{ path: "a.jsonl", offset: 9, length: 9 }]);
    expect(core.read("codex", "a.jsonl").toString()).toBe('{"id":1}\n{"id":2}\n');
  });

  it("does nothing when the server is already level", async () => {
    const home = await scratch();
    const core = new FakeCore();
    core.put("codex", "a.jsonl", Buffer.from('{"id":1}\n'));
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const file = path.join(home, "sessions", "a.jsonl");
    await writeFile(file, '{"id":1}\n');
    await settled(file);

    const [outcome] = await syncOnce(options(home, core));

    expect(outcome).toMatchObject({ pushed: 0, bytes: 0, skipped: 1 });
    expect(core.posts).toEqual([]);
  });

  it("leaves a file alone until it has stopped growing", async () => {
    const home = await scratch();
    const core = new FakeCore();
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const file = path.join(home, "sessions", "a.jsonl");
    await writeFile(file, '{"id":1}\n');

    const [outcome] = await syncOnce({ ...options(home, core), settleSeconds: 30 });

    expect(outcome).toMatchObject({ pushed: 0, skipped: 1 });
    expect(core.posts).toEqual([]);
  });

  it("splits a file larger than one append into several", async () => {
    const home = await scratch();
    const core = new FakeCore();
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const file = path.join(home, "sessions", "big.jsonl");
    const size = MAX_APPEND_BYTES + 1024;
    await writeFile(file, Buffer.alloc(size, 0x61));
    await settled(file);

    const [outcome] = await syncOnce(options(home, core));

    expect(outcome.pushed).toBe(2);
    expect(outcome.bytes).toBe(size);
    expect(core.read("codex", "big.jsonl").length).toBe(size);
  });

  it("counts a conflict and stops that file instead of splicing", async () => {
    const home = await scratch();
    const core = new FakeCore();
    // The server holds a different history for the same path, and the host's
    // copy is longer -- the shape that would otherwise be appended to.
    core.put("codex", "a.jsonl", Buffer.from('{"old":true}\n'));
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const file = path.join(home, "sessions", "a.jsonl");
    await writeFile(file, '{"rewritten":true}\n{"id":2}\n');
    await settled(file);

    const [outcome] = await syncOnce(options(home, core));

    expect(outcome.conflicts).toBe(1);
    expect(core.posts).toEqual([]);
    expect(core.read("codex", "a.jsonl").toString()).toBe('{"old":true}\n');
  });

  it("reports a source it could not even ask about, and carries on", async () => {
    const home = await scratch();
    const core = new FakeCore();
    core.manifestFailures = 1;
    await mkdir(path.join(home, "sessions"), { recursive: true });

    const [outcome] = await syncOnce(options(home, core));

    expect(outcome.error).toBe("manifest_failed:503");
    expect(outcome.pushed).toBe(0);
  });

  it("skips dotfiles and symlinks rather than following them", async () => {
    const home = await scratch();
    const core = new FakeCore();
    await mkdir(path.join(home, "sessions"), { recursive: true });
    await writeFile(path.join(home, "sessions", ".hidden"), "no\n");
    await writeFile(path.join(home, "sessions", "real.jsonl"), "yes\n");
    await symlink(
      path.join(home, "sessions", "real.jsonl"),
      path.join(home, "sessions", "link.jsonl"),
    );
    await settled(path.join(home, "sessions", "real.jsonl"));

    await syncOnce(options(home, core));

    expect(core.posts.map((post) => post.path)).toEqual(["real.jsonl"]);
  });

  it("expands a leading ~ against the given home", async () => {
    const home = await scratch();
    const core = new FakeCore();
    await mkdir(path.join(home, "nested"), { recursive: true });
    const file = path.join(home, "nested", "a.jsonl");
    await writeFile(file, "x\n");
    await settled(file);

    const [outcome] = await syncOnce(options(home, core, "~/nested"));

    expect(outcome.pushed).toBe(1);
    expect(core.posts.map((post) => post.path)).toEqual(["a.jsonl"]);
  });

  it("keeps two sources apart", async () => {
    const home = await scratch();
    const core = new FakeCore();
    await mkdir(path.join(home, "a"), { recursive: true });
    await mkdir(path.join(home, "b"), { recursive: true });
    await writeFile(path.join(home, "a", "x.jsonl"), "from-a\n");
    await writeFile(path.join(home, "b", "x.jsonl"), "from-b\n");
    await settled(path.join(home, "a", "x.jsonl"));
    await settled(path.join(home, "b", "x.jsonl"));

    await syncOnce({
      ...options(home, core),
      sources: [
        { sourceId: "codex", root: "a" },
        { sourceId: "cursor", root: "b" },
      ],
    });

    expect(core.read("codex", "x.jsonl").toString()).toBe("from-a\n");
    expect(core.read("cursor", "x.jsonl").toString()).toBe("from-b\n");
  });
});
