import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BrokerDiscovery } from "@one-memory/host-bridge";
import { describe, expect, it, vi } from "vitest";

import { RecallBrokerSupervisor } from "./recall-broker-supervisor.js";

const discovery: BrokerDiscovery = {
  schema_version: 1,
  service: "one-memory-recall-broker",
  status: "running",
  host: "127.0.0.1",
  port: 18765,
  instance_id: "runtime-test",
  pid: 1234,
  updated_at: "2026-09-19T01:00:00Z",
};

function broker() {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("RecallBrokerSupervisor", () => {
  it("attaches to the matching live broker and does not stop it", async () => {
    const owned = broker();
    const createBroker = vi.fn(() => owned);
    const probeBroker = vi.fn(async () => undefined);
    const supervisor = new RecallBrokerSupervisor({
      discoveryPath: "/runtime/broker.json",
      instanceId: "runtime-test",
      createBroker,
      processIsAlive: () => true,
      readBrokerDiscovery: async () => discovery,
      probeBroker,
    });

    await supervisor.start();
    await supervisor.stop();

    expect(probeBroker).toHaveBeenCalledWith(discovery);
    expect(createBroker).not.toHaveBeenCalled();
    expect(owned.stop).not.toHaveBeenCalled();
  });

  it("starts and stops an owned broker when discovery is absent", async () => {
    const owned = broker();
    const supervisor = new RecallBrokerSupervisor({
      discoveryPath: "/runtime/broker.json",
      instanceId: "runtime-test",
      createBroker: () => owned,
      readBrokerDiscovery: async () => {
        throw new Error(
          "MemHub is not running (broker discovery is unavailable)",
        );
      },
    });

    await supervisor.start();
    await supervisor.stop();

    expect(owned.start).toHaveBeenCalledOnce();
    expect(owned.stop).toHaveBeenCalledOnce();
  });

  it("refuses a live broker owned by another Runtime", async () => {
    const supervisor = new RecallBrokerSupervisor({
      discoveryPath: "/runtime/broker.json",
      instanceId: "runtime-test",
      createBroker: broker,
      processIsAlive: () => true,
      readBrokerDiscovery: async () => ({
        ...discovery,
        instance_id: "other-runtime",
      }),
    });

    await expect(supervisor.start()).rejects.toThrow("another Runtime");
  });

  it("replaces stopped or stale broker discovery", async () => {
    for (const candidate of [
      { ...discovery, status: "stopped" as const, port: null },
      discovery,
    ]) {
      const owned = broker();
      const supervisor = new RecallBrokerSupervisor({
        discoveryPath: "/runtime/broker.json",
        instanceId: "runtime-test",
        createBroker: () => owned,
        processIsAlive: () => candidate.status === "stopped",
        readBrokerDiscovery: async () => candidate,
      });

      await supervisor.start();
      expect(owned.start).toHaveBeenCalledOnce();
      await supervisor.stop();
    }
  });

  // The tests above inject `readBrokerDiscovery`, so they never exercise the
  // real parse. That is how a host published by a broker on another machine got
  // past the client check but not past this package's own copy of it: the
  // supervisor rejected the file it had just written and the runtime failed to
  // start. These two go through the real reader.
  async function supervisorFor(
    written: BrokerDiscovery,
    probeBroker: () => Promise<void>,
  ): Promise<RecallBrokerSupervisor> {
    const directory = await mkdtemp(path.join(tmpdir(), "one-memory-broker-"));
    const discoveryPath = path.join(directory, "cursor-broker.json");
    await writeFile(discoveryPath, JSON.stringify(written), "utf8");
    return new RecallBrokerSupervisor({
      discoveryPath,
      instanceId: "runtime-test",
      createBroker: broker,
      processIsAlive: () => true,
      probeBroker,
    });
  }

  it("attaches to a discovery file that publishes a LAN address", async () => {
    const probeBroker = vi.fn(async () => undefined);
    const remote = { ...discovery, host: "192.168.0.108" };
    const supervisor = await supervisorFor(remote, probeBroker);

    await supervisor.start();
    await supervisor.stop();

    expect(probeBroker).toHaveBeenCalledWith(remote);
  });

  it("rejects a discovery file whose host is not a bare address", async () => {
    const supervisor = await supervisorFor(
      { ...discovery, host: "192.168.0.108/api" },
      async () => undefined,
    );

    await expect(supervisor.start()).rejects.toThrow("discovery is invalid");
  });
});
