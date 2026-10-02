import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  emptyKernel,
  emptyWebGroups,
  type Group,
  groups,
  type Measurement,
  webGroups,
} from "../shared/metrics.ts";
import { CpuTracker } from "./cpu.ts";
import { classifyWeb } from "./web-processes.ts";

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
export function createCollector(procRoot = "/proc") {
  const cpu = new CpuTracker();
  return () => collect(procRoot, cpu);
}
export async function collect(procRoot = "/proc", cpu?: CpuTracker): Promise<Measurement> {
  const result: Measurement = {
    cpu: null,
    total: 0,
    free: 0,
    used: 0,
    filePss: 0,
    pageTables: 0,
    otherSystem: 0,
    kernel: emptyKernel(),
    webPss: 0,
    webGroups: emptyWebGroups(),
    other: 0,
    vanished: 0,
    groups: {
      lake: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0, nonFileStats: null },
      watchdog: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0, nonFileStats: null },
      worker: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0, nonFileStats: null },
      otherLean: { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0, nonFileStats: null },
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
        const before = startTime(await readFile(join(dir, "stat"), "utf8"));
        const args = (await readFile(join(dir, "cmdline"), "utf8")).split("\0").filter(Boolean);
        if (!args.length) continue; // zombies have no address space
        const group = basename(args[0]!) === comm ? classify(comm, args) : null;
        const webGroup = group === null ? classifyWeb(comm, args) : null;
        if (group === null && webGroup === null) continue;
        const fields = memoryFields(await readFile(join(dir, "smaps_rollup"), "utf8"));
        const after = startTime(await readFile(join(dir, "stat"), "utf8"));
        if (before !== after) {
          result.vanished++;
          continue;
        }
        const pss = required(fields, "Pss");
        const filePss = required(fields, "Pss_File");
        if (filePss > pss) throw new Error("Inconsistent procfs PSS fields");
        const rss = required(fields, "Rss");
        if (webGroup !== null) {
          const web = result.webGroups[webGroup];
          web.count++;
          web.rss += rss;
          web.pss += pss;
          web.filePss += filePss;
          continue;
        }
        const values = result.groups[group!];
        values.count++;
        values.rss += rss;
        values.pss += pss;
        values.filePss += filePss;
        const nonFile = pss - filePss;
        values.nonFilePss += nonFile;
        values.nonFileStats = {
          average: values.nonFilePss / values.count,
          min: Math.min(values.nonFileStats?.min ?? nonFile, nonFile),
          max: Math.max(values.nonFileStats?.max ?? nonFile, nonFile),
        };
      } catch (error) {
        if (isGone(error)) {
          result.vanished++;
          continue;
        }
        throw new Error(
          `Cannot sample PID ${pid}: ${error instanceof Error ? error.message : String(error)}. Run with permission to read all selected processes’ smaps_rollup files.`,
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
  result.kernel = {
    primaryPageTables: required(mem, "PageTables"),
    secondaryPageTables: mem.get("SecPageTables") ?? 0,
    slab: required(mem, "Slab"),
    slabReclaimable: required(mem, "SReclaimable"),
    slabUnreclaimable: required(mem, "SUnreclaim"),
    kernelStack: required(mem, "KernelStack"),
    percpu: mem.get("Percpu") ?? 0,
  };
  result.pageTables = result.kernel.primaryPageTables + result.kernel.secondaryPageTables;
  // Slab already includes both SReclaimable and SUnreclaim. VmallocUsed overlaps
  // kernel allocations, and Buffers is file cache, so neither is added here.
  result.otherSystem = result.kernel.slab + result.kernel.kernelStack + result.kernel.percpu;
  result.webPss = webGroups.reduce((total, group) => total + result.webGroups[group].pss, 0);
  let processPss = 0;
  for (const group of groups) {
    result.filePss += result.groups[group].filePss;
    processPss += result.groups[group].pss;
  }
  // PSS excludes kernel page tables/slab/stacks. Each process is classified once;
  // web-service file PSS belongs to webPss, not the Lean/Lake file-backed layer.
  result.other =
    result.used -
    result.pageTables -
    result.filePss -
    result.groups.watchdog.nonFilePss -
    result.groups.worker.nonFilePss -
    result.groups.lake.nonFilePss -
    result.webPss -
    result.otherSystem;
  if (
    result.other < 0 ||
    processPss + result.webPss + result.pageTables + result.otherSystem > result.used
  )
    throw new Error("Inconsistent snapshot: attributed memory exceeds used RAM; sample discarded.");
  if (cpu) result.cpu = cpu.sample(await readFile(join(procRoot, "stat"), "utf8"));
  return result;
}
