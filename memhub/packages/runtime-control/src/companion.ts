/**
 * What this machine has, and whether One Memory is already wired into it.
 *
 * A host that keeps its memory on another machine still needs its own apps
 * configured here: the config files live on this disk, and no server can reach
 * them. This command is that half — it reads, it never writes, so it is safe to
 * run at any time and against any state.
 *
 * `install` is deliberately absent. Wiring a host needs the pairing exchange and
 * a rollback journal, and both belong with the code that already does them
 * (`planRecallInstall` / `applyRecallInstall`) rather than in a second copy
 * here. Read-only first also means the answer to "what does this machine have"
 * can be checked before anything is allowed to change it.
 */

import { readdir, readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import { DISCOVERY_KEY, mcpConfigPath } from "@one-memory/host-bridge/installer";

import { isHostPresent, recallHosts, type RecallHostDescriptor } from "./recall-hosts.js";
import { summarize, type SyncConfig, syncOnce } from "./sync.js";

export interface CompanionHostReport {
  hostId: string;
  label: string;
  /** The host's own directory exists, so the app is installed here. */
  present: boolean;
  /** Where this host keeps its MCP servers, or null when it has no such file. */
  configPath: string | null;
  /** The file exists on disk. */
  configExists: boolean;
  /** The file already names a One Memory server. */
  wired: boolean;
  /** Why `wired` could not be determined, when it could not. */
  unreadable: string | null;
}

async function readIfPresent(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

/**
 * Whether the config already names our server.
 *
 * Matched on `ONE_MEMORY_BROKER_DISCOVERY`, not on the server key: only this
 * installer writes that variable, while the key itself differs by host. DeepSeek
 * Harness takes its servers as an `mcp-defer` array item (`serverName:
 * onememory`) rather than as a `mcpServers` map, and a hand-made entry there
 * carries no `"one-memory"` string at all. Text rather than a parse, because the
 * hosts disagree on the format (json, toml, yaml, and DSH's own) and the
 * question here is only whether our entry is present.
 */
function namesOurServer(contents: string): boolean {
  return contents.includes(DISCOVERY_KEY);
}

export async function inspectHost(
  descriptor: RecallHostDescriptor,
): Promise<CompanionHostReport> {
  const present = await isHostPresent(descriptor);
  let configPath: string | null = null;
  try {
    configPath = mcpConfigPath(descriptor.layout);
  } catch {
    // A host with no MCP config at all (Pi extends through a skill only).
    configPath = null;
  }
  if (configPath === null) {
    return {
      hostId: descriptor.hostId,
      label: descriptor.label,
      present,
      configPath: null,
      configExists: false,
      wired: false,
      unreadable: null,
    };
  }
  const contents = await readIfPresent(configPath);
  if (contents === null) {
    return {
      hostId: descriptor.hostId,
      label: descriptor.label,
      present,
      configPath,
      configExists: false,
      wired: false,
      unreadable: null,
    };
  }
  return {
    hostId: descriptor.hostId,
    label: descriptor.label,
    present,
    configPath,
    configExists: true,
    wired: namesOurServer(contents),
    unreadable: null,
  };
}

export async function inspectMachine(
  home: string = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CompanionHostReport[]> {
  const descriptors = await recallHosts(home, environment);
  const reports: CompanionHostReport[] = [];
  for (const descriptor of descriptors) {
    reports.push(await inspectHost(descriptor));
  }
  return reports;
}

const STATE_LABEL: Record<string, string> = {
  wired: "已接入",
  absent: "未安装",
  unwired: "已安装，未接入",
  unreadable: "配置读不到",
};

function stateOf(report: CompanionHostReport): keyof typeof STATE_LABEL {
  if (!report.present) return "absent";
  if (report.unreadable !== null) return "unreadable";
  return report.wired ? "wired" : "unwired";
}

function pad(value: string, width: number): string {
  // Pad by display width, counting a CJK character as two columns. Without it
  // the label column drifts once a Chinese state name is in the same table.
  let columns = 0;
  for (const character of value) {
    columns += (character.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  }
  return value + " ".repeat(Math.max(0, width - columns));
}

function displayWidth(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns += (character.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  }
  return columns;
}

export function formatReport(reports: CompanionHostReport[]): string {
  if (reports.length === 0) {
    return "本机没有检测到可接入的应用。\n";
  }
  // Sized to the widest label: a profile-qualified Harness host is far longer
  // than "Cursor", and a fixed width would run the state into the name.
  const labelWidth = Math.max(...reports.map((report) => displayWidth(report.label))) + 2;
  const rows = reports.map((report) => {
    const state = STATE_LABEL[stateOf(report)] ?? "?";
    return `  ${pad(report.label, labelWidth)}${pad(state, 16)}${report.configPath ?? "（无配置文件）"}`;
  });
  const wired = reports.filter((report) => stateOf(report) === "wired").length;
  const present = reports.filter((report) => report.present).length;
  return [
    `本机检测到 ${present} 个应用，其中 ${wired} 个已接入 One Memory：`,
    "",
    ...rows,
    "",
  ].join("\n");
}

export interface CompanionConfig {
  listen: { host: string; port: number };
  /**
   * Browser origins allowed to call this server.
   *
   * Required rather than permissive: a page the user happens to have open can
   * reach `127.0.0.1`, so without this any website could read the list of apps
   * installed here. An empty list means no browser may call it — the CLI still
   * works, and curl with no `Origin` header still works.
   */
  allowedOrigins: string[];
  /** Where the Core that keeps this machine's memory lives. */
  server?: {
    url: string;
    /**
     * The `omhg_v1_…` credential file. Optional: pairing already leaves one in
     * a fixed place, and a machine that has paired once has exactly one.
     */
    credentialFile?: string;
  };
  sync?: SyncConfig;
}

const DEFAULT_CONFIG: CompanionConfig = {
  listen: { host: "127.0.0.1", port: 18_767 },
  allowedOrigins: [],
};

export function configPath(home: string = homedir()): string {
  return path.join(home, ".one-memory", "companion.json");
}

function readSync(value: unknown, target: string): SyncConfig | undefined {
  if (value === undefined) return undefined;
  const candidate = value as Partial<SyncConfig>;
  if (typeof candidate.enabled !== "boolean") {
    throw new Error(`companion 配置的 sync.enabled 无效: ${target}`);
  }
  const settleSeconds = candidate.settleSeconds ?? 2;
  if (typeof settleSeconds !== "number" || !Number.isFinite(settleSeconds) || settleSeconds < 0) {
    throw new Error(`companion 配置的 sync.settleSeconds 无效: ${target}`);
  }
  const intervalSeconds = candidate.intervalSeconds ?? 60;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 5
  ) {
    throw new Error(`companion 配置的 sync.intervalSeconds 无效: ${target}`);
  }
  const sources = candidate.sources ?? [];
  if (!Array.isArray(sources)) {
    throw new Error(`companion 配置的 sync.sources 无效: ${target}`);
  }
  for (const source of sources) {
    if (
      typeof source?.sourceId !== "string" ||
      source.sourceId === "" ||
      typeof source.root !== "string" ||
      source.root === ""
    ) {
      throw new Error(`companion 配置的 sync.sources 项无效: ${target}`);
    }
  }
  return { enabled: candidate.enabled, settleSeconds, intervalSeconds, sources };
}

/** The config file is optional: absent means the defaults, which bind loopback. */
export async function loadConfig(target: string = configPath()): Promise<CompanionConfig> {
  const raw = await readFile(target, "utf8").catch(() => null);
  if (raw === null) return DEFAULT_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`companion 配置不是合法 JSON: ${target}`);
  }
  const value = parsed as Partial<CompanionConfig>;
  const listen = value.listen ?? DEFAULT_CONFIG.listen;
  if (
    typeof listen.host !== "string" ||
    typeof listen.port !== "number" ||
    !Number.isInteger(listen.port) ||
    listen.port <= 0 ||
    listen.port > 65_535
  ) {
    throw new Error(`companion 配置的 listen 无效: ${target}`);
  }
  const allowedOrigins = value.allowedOrigins ?? DEFAULT_CONFIG.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.every((item) => typeof item === "string")) {
    throw new Error(`companion 配置的 allowedOrigins 无效: ${target}`);
  }
  if (value.server !== undefined && typeof value.server?.url !== "string") {
    throw new Error(`companion 配置的 server.url 无效: ${target}`);
  }
  if (
    value.server?.credentialFile !== undefined &&
    typeof value.server.credentialFile !== "string"
  ) {
    throw new Error(`companion 配置的 server.credentialFile 无效: ${target}`);
  }
  const sync = readSync(value.sync, target);
  return {
    listen: { host: listen.host, port: listen.port },
    allowedOrigins,
    ...(value.server === undefined
      ? {}
      : {
          server: {
            url: value.server.url,
            ...(value.server.credentialFile === undefined
              ? {}
              : { credentialFile: value.server.credentialFile }),
          },
        }),
    ...(sync === undefined ? {} : { sync }),
  };
}

/**
 * The host credential this machine paired with.
 *
 * Order matters: an explicit path wins, then the variable a host application
 * would have set, then the one installation pairing leaves behind. The install
 * directory is named by a hash of the source root, so it cannot be derived here
 * -- which is why more than one is an error rather than a guess.
 */
async function resolveCredential(configured: string | undefined): Promise<string> {
  const candidates = [configured, process.env.ONE_MEMORY_HOST_CREDENTIAL_FILE];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "") {
      return (await readFile(candidate, "utf8")).trim();
    }
  }
  const installations = path.join(homedir(), ".one-memory", "host-permissions", "installations");
  const entries = await readdir(installations, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 1) {
    const file = path.join(installations, directories[0]!.name, "credential");
    return (await readFile(file, "utf8")).trim();
  }
  throw new Error(
    directories.length === 0
      ? "找不到 host 凭据：这台机器还没配对过"
      : `找到 ${directories.length} 份 host 凭据，请在 companion.json 里用 server.credentialFile 指定`,
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

/**
 * Whether a request may be answered.
 *
 * A missing `Origin` is not a browser (curl, a test) and is allowed: browsers
 * always send one on a cross-origin request, which is the case worth guarding.
 * The list is exact-match, not a prefix: `http://192.168.0.108:8765.evil.example`
 * starts with an allowed origin and must not pass.
 */
export function isOriginAllowed(config: CompanionConfig, origin: string | undefined): boolean {
  return origin === undefined || config.allowedOrigins.includes(origin);
}

/**
 * Serve the host report over loopback HTTP, for a browser on this machine.
 *
 * Read-only on purpose. Wiring a host writes another application's config file,
 * so it needs an authorization model the browser does not have yet; a read
 * endpoint needs only the origin allowlist. Shipping the read half first is what
 * lets the Web Console show what this machine actually has, which is the
 * question that has to be answered before anything is allowed to change it.
 */
/**
 * A running companion server.
 *
 * The bound port is reported rather than assumed: a caller that asks for port 0
 * gets one the kernel picks, and a server nothing can close is a server a test
 * cannot use.
 */
export interface CompanionServer {
  port: number;
  close: () => Promise<void>;
}

export function serve(
  config: CompanionConfig,
  io: { stdout: (text: string) => void } = { stdout: (text) => process.stdout.write(text) },
  inspect: () => Promise<CompanionHostReport[]> = () => inspectMachine(),
): Promise<CompanionServer> {
  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (!isOriginAllowed(config, origin)) {
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (origin !== undefined) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (request.url === "/health") {
      sendJson(response, 200, { status: "ok", service: "one-memory-companion" });
      return;
    }
    if (request.url === "/hosts") {
      void inspect().then(
        (reports) => sendJson(response, 200, reports),
        (error: unknown) =>
          sendJson(response, 500, {
            error: "inspect_failed",
            detail: error instanceof Error ? error.message : String(error),
          }),
      );
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });
  return new Promise<CompanionServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : config.listen.port;
      io.stdout(
        `companion 已启动: http://${config.listen.host}:${port}\n` +
          `允许的浏览器来源: ${config.allowedOrigins.join(", ") || "（无，浏览器无法调用）"}\n`,
      );
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}

const USAGE = `用法: node companion.cjs <command>

  list      列出本机装了哪些可接入的应用，以及是否已接入
  status    同 list，但输出 JSON
  serve     在 127.0.0.1 上提供 HTTP，供本机浏览器里的 Web Console 查询
  sync once   把本机源目录里新增的字节推给服务器，跑一轮就退出
  sync watch  同上，但按 sync.intervalSeconds 一直跑

只读 list/status，不会修改任何文件。serve 的允许来源、sync 的目标与源目录
都读 ~/.one-memory/companion.json。
`;

export async function main(
  argv: string[] = process.argv.slice(2),
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "serve") {
    const config = await loadConfig();
    await serve(config, { stdout: io.stdout });
    return 0;
  }
  if (command === "sync") {
    const [mode] = argv.slice(1);
    if (mode !== undefined && mode !== "once" && mode !== "watch") {
      io.stderr(`未知的 sync 子命令: ${mode}\n\n${USAGE}`);
      return 2;
    }
    const config = await loadConfig();
    if (config.sync === undefined || !config.sync.enabled) {
      io.stderr("同步未启用：在 companion.json 里设 sync.enabled = true\n");
      return 2;
    }
    if (config.server === undefined) {
      io.stderr("缺少 server.url：companion 不知道把文件推给谁\n");
      return 2;
    }
    if (config.sync.sources.length === 0) {
      // The server knows where a source root sits on *its* disk, which says
      // nothing about this machine. Only the host can name its own paths.
      io.stderr("sync.sources 为空：这台机器的源目录必须在这里写清楚\n");
      return 2;
    }
    const server = config.server;
    const sync = config.sync;
    const credential = await resolveCredential(server.credentialFile);
    const run = async () => {
      const outcomes = await syncOnce({
        serverUrl: server.url,
        credential,
        sources: sync.sources,
        settleSeconds: sync.settleSeconds,
      });
      io.stdout(`${new Date().toISOString()}  ${summarize(outcomes)}\n`);
    };
    await run();
    if (mode !== "watch") return 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, sync.intervalSeconds * 1000));
      await run();
    }
  }
  if (command !== "list" && command !== "status") {
    io.stderr(`未知命令: ${command}\n\n${USAGE}`);
    return 2;
  }
  const reports = await inspectMachine();
  if (command === "status") {
    io.stdout(`${JSON.stringify(reports, null, 2)}\n`);
    return 0;
  }
  io.stdout(formatReport(reports));
  return 0;
}
