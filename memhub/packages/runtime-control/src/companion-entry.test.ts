import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cursorLayout, DISCOVERY_KEY } from "@one-memory/host-bridge/installer";
import { describe, expect, it } from "vitest";

import {
  type CompanionHostReport,
  formatReport,
  inspectHost,
} from "./companion.js";
import type { RecallHostDescriptor } from "./recall-hosts.js";

async function scratchHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "one-memory-companion-"));
}

/** A descriptor built by the real layout, so the test cannot drift from it. */
function descriptorFor(home: string): RecallHostDescriptor {
  const directory = path.join(home, ".cursor");
  return {
    hostId: "cursor",
    label: "Cursor",
    presencePath: directory,
    layout: cursorLayout(directory),
  };
}

describe("companion inspection", () => {
  it("reports a host whose directory is absent as not installed", async () => {
    const home = await scratchHome();
    const report = await inspectHost(descriptorFor(home));

    expect(report.present).toBe(false);
    expect(report.wired).toBe(false);
    expect(report.configExists).toBe(false);
  });

  it("reports an installed host with no config file as present but unwired", async () => {
    const home = await scratchHome();
    const descriptor = descriptorFor(home);
    await mkdir(descriptor.presencePath, { recursive: true });

    const report = await inspectHost(descriptor);

    expect(report.present).toBe(true);
    expect(report.configExists).toBe(false);
    expect(report.wired).toBe(false);
  });

  it("reports a config that names the broker discovery as wired", async () => {
    const home = await scratchHome();
    const descriptor = descriptorFor(home);
    await mkdir(descriptor.presencePath, { recursive: true });
    await writeFile(
      path.join(descriptor.presencePath, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "one-memory": {
            command: "node",
            env: { [DISCOVERY_KEY]: "C:\\Users\\me\\.one-memory\\integrations\\cursor-broker.json" },
          },
        },
      }),
      "utf8",
    );

    const report = await inspectHost(descriptor);

    expect(report.configExists).toBe(true);
    expect(report.wired).toBe(true);
  });

  it("does not call a config wired just because it mentions the product name", async () => {
    const home = await scratchHome();
    const descriptor = descriptorFor(home);
    await mkdir(descriptor.presencePath, { recursive: true });
    // A comment or another server's note about one-memory must not read as an
    // install: only this installer writes the discovery variable.
    await writeFile(
      path.join(descriptor.presencePath, "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "node", args: ["one-memory"] } } }),
      "utf8",
    );

    const report = await inspectHost(descriptor);

    expect(report.wired).toBe(false);
  });

  it("formats an empty machine without a table", () => {
    expect(formatReport([])).toContain("没有检测到");
  });

  it("counts wired hosts and pads a long label clear of its state", () => {
    const reports: CompanionHostReport[] = [
      {
        hostId: "cursor",
        label: "Cursor",
        present: false,
        configPath: "/home/me/.cursor/mcp.json",
        configExists: false,
        wired: false,
        unreadable: null,
      },
      {
        hostId: "deepseek-harness:LataleAdapter",
        label: "DeepSeek Harness · LataleAdapter",
        present: true,
        configPath: "/home/me/.dsh/profiles/LataleAdapter/cordis.patch.yml",
        configExists: true,
        wired: true,
        unreadable: null,
      },
    ];

    const text = formatReport(reports);

    expect(text).toContain("其中 1 个已接入");
    // The long label must be followed by whitespace before its state, or the two
    // run together and the table reads as one word.
    expect(text).toMatch(/DeepSeek Harness · LataleAdapter\s+已接入/);
  });
});
