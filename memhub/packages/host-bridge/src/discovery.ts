import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BrokerDiscovery {
  schema_version: 1;
  service: "one-memory-recall-broker";
  status: "running" | "stopped";
  /**
   * The address a client should dial. Loopback for a local broker; the host's
   * LAN address when the memory lives on another machine
   * (`ONE_MEMORY_BROKER_PUBLIC_HOST`).
   */
  host: string;
  port: number | null;
  instance_id: string;
  pid: number;
  updated_at: string;
}

export async function writeDiscovery(
  targetPath: string,
  discovery: BrokerDiscovery,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(discovery, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
}

export async function readDiscovery(
  targetPath: string,
): Promise<BrokerDiscovery> {
  let raw: string;
  try {
    raw = await readFile(targetPath, "utf8");
  } catch (error) {
    throw new Error("MemHub is not running (broker discovery is unavailable)", {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("MemHub broker discovery is invalid", {
      cause: error,
    });
  }
  if (!isBrokerDiscovery(value)) {
    throw new Error("MemHub broker discovery is invalid");
  }
  return value;
}

/**
 * A discovery host is interpolated into `http://${host}:${port}`, so it must be
 * a bare address or hostname: no scheme, no path, no port, no whitespace.
 *
 * This was an equality test against `127.0.0.1` while the broker could only
 * listen on loopback. A host that keeps its memory on another machine needs the
 * real address here, so the check becomes a shape check — still strict enough
 * that a tampered discovery file cannot point the client at another origin,
 * because a path or a port separator is rejected.
 *
 * IPv6 literals are not accepted: the URL builder has no brackets, so `::1`
 * would produce `http://::1:18765` and fail regardless.
 */
function isDiscoveryHost(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/.test(value);
}

/**
 * Whether `value` is a well-formed broker discovery receipt.
 *
 * Exported because the runtime keeps its own copy of the read path
 * (`runtime-control/src/recall-broker-supervisor.ts`) and the two drifted: when
 * only the client-side check learned about a non-loopback host, the runtime's
 * copy kept rejecting the file the broker had just written, so a restart after a
 * LAN deploy failed with `runtime_broker_discovery_invalid` and the broker never
 * started. One definition, both readers.
 */
export function isBrokerDiscovery(value: unknown): value is BrokerDiscovery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrokerDiscovery>;
  return (
    candidate.schema_version === 1 &&
    candidate.service === "one-memory-recall-broker" &&
    (candidate.status === "running" || candidate.status === "stopped") &&
    isDiscoveryHost(candidate.host) &&
    (candidate.port === null ||
      (Number.isInteger(candidate.port) &&
        (candidate.port ?? 0) > 0 &&
        (candidate.port ?? 0) <= 65_535)) &&
    typeof candidate.instance_id === "string" &&
    typeof candidate.pid === "number" &&
    typeof candidate.updated_at === "string"
  );
}
