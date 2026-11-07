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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { DISCOVERY_KEY, mcpConfigPath } from "@one-memory/host-bridge/installer";

import { isHostPresent, recallHosts, type RecallHostDescriptor } from "./recall-hosts.js";

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

const USAGE = `用法: node companion.cjs <command>

  list      列出本机装了哪些可接入的应用，以及是否已接入
  status    同 list，但输出 JSON

只读，不会修改任何文件。
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
