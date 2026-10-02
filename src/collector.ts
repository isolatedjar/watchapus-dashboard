import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { type Group, groups, type Measurement } from "../shared/metrics.ts";

// Linux spells these units kB, but means KiB.
export function memoryFields(text: string): Map<string, number> {
  return new Map(
    [...text.matchAll(/^([A-Za-z_]+):\s+(\d+) kB$/gm)].map((m) => [m[1]!, Number(m[2]) * 1024]),
  );
}
function required(fields: Map<string, number>, name: string): number {
  const value = fields.get(name);
  if (value === undefined || !Number.isSafeInteger(value)) {
    throw new Error(`Missing or invalid ${name}; Linux procfs with Pss_File is required.`);
  }
  return value;
}
export function classify(comm: string, args: string[]): Group | null {
  if (comm === "lake") return "lake";
  if (comm !== "lean") return null;
  const options = args.slice(1, args.indexOf("--") < 0 ? undefined : args.indexOf("--"));
  if (options.includes("--worker")) return "worker";
  if (options.includes("--server")) return "watchdog";
  return "otherLean";
}
export function startTime(stat: string): string {
  // comm can contain spaces and parentheses. Field 22 is starttime.
  const value = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (!value) throw new Error("Malformed /proc stat");
  return value;
}
function isGone(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}
export async function collect(procRoot = "/proc"): Promise<Measurement> {
  const result: Measurement = {
    total: 0,
    free: 0,
    used: 0,
    filePss: 0,
    other: 0,
    vanished: 0,
    groups: {
      lake: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0 },
      watchdog: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0 },
      worker: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0 },
      otherLean: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0 },
    },
  };
  const pids = (await readdir(procRoot)).filter((pid) => /^\d+$/.test(pid));
  let cursor = 0;
  async function scan() {
    while (cursor < pids.length) {
      const pid = pids[cursor++]!;
      const dir = join(procRoot, pid);
      try {
        const comm = (await readFile(join(dir, "comm"), "utf8")).trim();
        if (comm !== "lean" && comm !== "lake") continue;
        const before = startTime(await readFile(join(dir, "stat"), "utf8"));
        const args = (await readFile(join(dir, "cmdline"), "utf8")).split("\0").filter(Boolean);
        if (!args.length) continue; // zombies have no address space
        if (basename(args[0]!) !== comm) continue;
        const group = classify(comm, args)!;
        const fields = memoryFields(await readFile(join(dir, "smaps_rollup"), "utf8"));
        const after = startTime(await readFile(join(dir, "stat"), "utf8"));
        if (before !== after) {
          result.vanished++;
          continue;
        }
        const pss = required(fields, "Pss");
        const filePss = required(fields, "Pss_File");
        if (filePss > pss) throw new Error("Inconsistent procfs PSS fields");
        const values = result.groups[group];
        values.count++;
        values.rss += required(fields, "Rss");
        values.pss += pss;
        values.filePss += filePss;
        values.nonFilePss += pss - filePss;
      } catch (error) {
        if (isGone(error)) {
          result.vanished++;
          continue;
        }
        throw new Error(
          `Cannot sample PID ${pid}: ${error instanceof Error ? error.message : String(error)}. Run with permission to read all Lean/Lake smaps_rollup files.`,
          { cause: error },
        );
      }
    }
  }
  // Bounded page-table walks. Wait for all scanners even on failure, avoiding overlap.
  const scans = await Promise.allSettled(Array.from({ length: 8 }, scan));
  for (const scanResult of scans) {
    if (scanResult.status === "rejected") throw scanResult.reason;
  }
  const mem = memoryFields(await readFile(join(procRoot, "meminfo"), "utf8"));
  result.total = required(mem, "MemTotal");
  result.free = required(mem, "MemFree");
  result.used = result.total - result.free;
  let processPss = 0;
  for (const group of groups) {
    result.filePss += result.groups[group].filePss;
    processPss += result.groups[group].pss;
  }
  result.other = result.used - processPss;
  if (result.other < 0 || result.used < 0)
    throw new Error("Inconsistent snapshot: process PSS exceeds used RAM; sample discarded.");
  return result;
}
