import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readDiscovery, writeDiscovery, type BrokerDiscovery } from "./discovery.js";

async function scratchPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "one-memory-discovery-"));
  return path.join(directory, "cursor-broker.json");
}

function discovery(overrides: Partial<BrokerDiscovery> = {}): BrokerDiscovery {
  return {
    schema_version: 1,
    service: "one-memory-recall-broker",
    status: "running",
    host: "127.0.0.1",
    port: 18_765,
    instance_id: "instance-1",
    pid: 4_242,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("broker discovery host", () => {
  it("reads a loopback broker, which is what a single-machine install writes", async () => {
    const target = await scratchPath();
    await writeDiscovery(target, discovery());

    await expect(readDiscovery(target)).resolves.toMatchObject({ host: "127.0.0.1" });
  });

  it("reads a LAN address, so a host can keep its memory on another machine", async () => {
    const target = await scratchPath();
    await writeDiscovery(target, discovery({ host: "192.168.0.108" }));

    await expect(readDiscovery(target)).resolves.toMatchObject({ host: "192.168.0.108" });
  });

  it("reads a hostname, for a broker published under a name rather than an address", async () => {
    const target = await scratchPath();
    await writeDiscovery(target, discovery({ host: "memhub.home.arpa" }));

    await expect(readDiscovery(target)).resolves.toMatchObject({ host: "memhub.home.arpa" });
  });

  it.each([
    ["a scheme", "http://192.168.0.108"],
    ["a path", "192.168.0.108/api"],
    ["an embedded port", "192.168.0.108:18765"],
    ["an empty host", ""],
    ["whitespace", "192.168.0.108 "],
  ])("rejects a host carrying %s", async (_label, host) => {
    const target = await scratchPath();
    // Written by hand: `writeDiscovery` does not validate, so this is the shape a
    // tampered file would have.
    await writeFile(target, JSON.stringify(discovery({ host })), "utf8");

    await expect(readDiscovery(target)).rejects.toThrow("broker discovery is invalid");
  });

  it("keeps the rest of the contract, so an older file still reads", async () => {
    const target = await scratchPath();
    await writeDiscovery(target, discovery({ status: "stopped", port: null }));

    await expect(readDiscovery(target)).resolves.toMatchObject({
      schema_version: 1,
      service: "one-memory-recall-broker",
      status: "stopped",
      port: null,
    });
  });

  it("writes the file atomically with a trailing newline", async () => {
    const target = await scratchPath();
    await writeDiscovery(target, discovery());

    const contents = await readFile(target, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(JSON.parse(contents)).toMatchObject({ host: "127.0.0.1" });
  });
});
