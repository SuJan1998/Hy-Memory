import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { cursorLayout, DISCOVERY_KEY } from "@one-memory/host-bridge/installer";
import { describe, expect, it } from "vitest";

import {
  type CompanionConfig,
  type CompanionHostReport,
  configPath,
  formatReport,
  inspectHost,
  isOriginAllowed,
  loadConfig,
  serve,
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

const hostReport: CompanionHostReport = {
  hostId: "cursor",
  label: "Cursor",
  present: true,
  configPath: "/home/me/.cursor/mcp.json",
  configExists: true,
  wired: true,
  unreadable: null,
};

const anyPort: CompanionConfig["listen"] = { host: "127.0.0.1", port: 0 };

async function startCompanion(
  allowedOrigins: string[],
  inspect: () => Promise<CompanionHostReport[]> = async () => [hostReport],
): Promise<{ port: number; base: string; close: () => Promise<void> }> {
  const server = await serve({ listen: anyPort, allowedOrigins }, { stdout: () => {} }, inspect);
  return { port: server.port, base: `http://127.0.0.1:${server.port}`, close: server.close };
}

interface HttpAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Talk to the companion with `node:http` rather than `fetch`.
 *
 * `Origin` is a forbidden header for `fetch`, and the whole point of these tests
 * is to send one; `agent: false` also keeps the socket from outliving the test
 * and holding `close()` open.
 */
function call(
  url: string,
  init: { method?: string; origin?: string } = {},
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: init.method ?? "GET",
        headers: init.origin === undefined ? {} : { origin: init.origin },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("companion config", () => {
  it("binds loopback and admits no browser when the file is absent", async () => {
    const home = await scratchHome();

    const config = await loadConfig(configPath(home));

    expect(config.listen).toEqual({ host: "127.0.0.1", port: 18_767 });
    // Not "any origin": a page the user happens to have open can reach loopback,
    // so the default has to be nobody rather than everybody.
    expect(config.allowedOrigins).toEqual([]);
  });

  it("reads the listen address and the allowed origins", async () => {
    const home = await scratchHome();
    const target = configPath(home);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      JSON.stringify({
        listen: { host: "127.0.0.1", port: 19_000 },
        allowedOrigins: ["http://192.168.0.108:8765"],
      }),
      "utf8",
    );

    const config = await loadConfig(target);

    expect(config.listen).toEqual({ host: "127.0.0.1", port: 19_000 });
    expect(config.allowedOrigins).toEqual(["http://192.168.0.108:8765"]);
  });

  it("refuses a config that is not JSON instead of quietly binding a default", async () => {
    const home = await scratchHome();
    const target = configPath(home);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{ not json", "utf8");

    await expect(loadConfig(target)).rejects.toThrow(/JSON/);
  });

  it("refuses a port outside the range a socket can bind", async () => {
    const home = await scratchHome();
    const target = configPath(home);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ listen: { host: "127.0.0.1", port: 70_000 } }), "utf8");

    await expect(loadConfig(target)).rejects.toThrow(/listen/);
  });

  it("refuses an origin list that is not a list of strings", async () => {
    const home = await scratchHome();
    const target = configPath(home);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ allowedOrigins: [8765] }), "utf8");

    await expect(loadConfig(target)).rejects.toThrow(/allowedOrigins/);
  });
});

describe("companion origin check", () => {
  const allowed: CompanionConfig = {
    listen: anyPort,
    allowedOrigins: ["http://192.168.0.108:8765"],
  };

  it("admits a caller with no origin, which is not a browser", () => {
    expect(isOriginAllowed(allowed, undefined)).toBe(true);
  });

  it("admits an exact origin and rejects a host that merely starts with one", () => {
    expect(isOriginAllowed(allowed, "http://192.168.0.108:8765")).toBe(true);
    expect(isOriginAllowed(allowed, "http://192.168.0.108:8765.evil.example")).toBe(false);
    expect(isOriginAllowed(allowed, "http://192.168.0.108:8766")).toBe(false);
  });

  it("rejects every browser when the allowlist is empty", () => {
    expect(isOriginAllowed({ ...allowed, allowedOrigins: [] }, "http://127.0.0.1:5173")).toBe(
      false,
    );
  });
});

describe("companion serve", () => {
  it("answers health with no browser origin at all", async () => {
    const server = await startCompanion([]);
    try {
      const response = await call(`${server.base}/health`);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        status: "ok",
        service: "one-memory-companion",
      });
    } finally {
      await server.close();
    }
  });

  it("serves the host report", async () => {
    const server = await startCompanion([]);
    try {
      const response = await call(`${server.base}/hosts`);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual([hostReport]);
    } finally {
      await server.close();
    }
  });

  it("refuses a browser origin that is not on the allowlist", async () => {
    const server = await startCompanion(["http://192.168.0.108:8765"]);
    try {
      const response = await call(`${server.base}/hosts`, { origin: "http://evil.example" });

      expect(response.status).toBe(403);
      // Without the header the browser discards the body anyway; asserting it is
      // absent keeps the refusal from being read as a permission.
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("answers an allowed origin and echoes it back", async () => {
    const origin = "http://192.168.0.108:8765";
    const server = await startCompanion([origin]);
    try {
      const response = await call(`${server.base}/hosts`, { origin });

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers.vary).toBe("Origin");
      expect(JSON.parse(response.body)).toEqual([hostReport]);
    } finally {
      await server.close();
    }
  });

  it("completes the preflight a browser sends before a cross-origin GET", async () => {
    const origin = "http://192.168.0.108:8765";
    const server = await startCompanion([origin]);
    try {
      const response = await call(`${server.base}/hosts`, { method: "OPTIONS", origin });

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-methods"]).toBe("GET, OPTIONS");
    } finally {
      await server.close();
    }
  });

  it("refuses a write, because this endpoint is read-only", async () => {
    const server = await startCompanion([]);
    try {
      const response = await call(`${server.base}/hosts`, { method: "POST" });

      expect(response.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("answers an unknown path with 404 rather than the report", async () => {
    const server = await startCompanion([]);
    try {
      const response = await call(`${server.base}/anything`);

      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("reports an inspection failure instead of an empty machine", async () => {
    const server = await startCompanion([], async () => {
      throw new Error("boom");
    });
    try {
      const response = await call(`${server.base}/hosts`);

      expect(response.status).toBe(500);
      expect(JSON.parse(response.body).error).toBe("inspect_failed");
    } finally {
      await server.close();
    }
  });
});
