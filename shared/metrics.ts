import { z } from "zod";

export const SAMPLE_INTERVAL_MS = 10_000;
export const HISTORY_MS = 30 * 60_000;
export const groups = ["lake", "watchdog", "worker", "otherLean"] as const;
export type Group = (typeof groups)[number];
const bytes = z.number().finite().nonnegative();
export const webGroups = [
  "next",
  "shardManager",
  "collaboration",
  "vscode",
  "extensions",
  "watchers",
  "languageServers",
  "nginx",
] as const;
export type WebGroup = (typeof webGroups)[number];
export const webGroupLabels: Record<WebGroup, string> = {
  next: "Next.js",
  shardManager: "Shard manager",
  collaboration: "Collaboration server",
  vscode: "VS Code server + helpers",
  extensions: "VS Code extension hosts",
  watchers: "VS Code file watchers",
  languageServers: "VS Code language servers",
  nginx: "Nginx",
};
const webMetrics = z.object({
  count: z.number().int().nonnegative(),
  rss: bytes,
  pss: bytes,
  filePss: bytes,
});
export function emptyWebGroups(): Record<WebGroup, z.infer<typeof webMetrics>> {
  return Object.fromEntries(
    webGroups.map((group) => [group, { count: 0, rss: 0, pss: 0, filePss: 0 }]),
  ) as Record<WebGroup, z.infer<typeof webMetrics>>;
}
export const zKernel = z.object({
  primaryPageTables: bytes,
  secondaryPageTables: bytes,
  slab: bytes,
  slabReclaimable: bytes,
  slabUnreclaimable: bytes,
  kernelStack: bytes,
  percpu: bytes,
});
export function emptyKernel(): z.infer<typeof zKernel> {
  return {
    primaryPageTables: 0,
    secondaryPageTables: 0,
    slab: 0,
    slabReclaimable: 0,
    slabUnreclaimable: 0,
    kernelStack: 0,
    percpu: 0,
  };
}
const groupMetrics = z.object({
  count: z.number().int().nonnegative(),
  rss: bytes,
  pss: bytes,
  filePss: bytes,
  nonFilePss: bytes,
  nonFileStats: z.object({ average: bytes, min: bytes, max: bytes }).nullable(),
});
export const zMeasurement = z.object({
  total: bytes,
  free: bytes,
  used: bytes,
  filePss: bytes,
  pageTables: bytes,
  otherSystem: bytes,
  kernel: zKernel,
  webPss: bytes,
  webGroups: z.record(z.enum(webGroups), webMetrics),
  other: bytes,
  groups: z.object({
    lake: groupMetrics,
    watchdog: groupMetrics,
    worker: groupMetrics,
    otherLean: groupMetrics,
  }),
  vanished: z.number().int().nonnegative(),
});
export type Measurement = z.infer<typeof zMeasurement>;
export const zSample = z.object({
  timestamp: z.number(),
  durationMs: z.number().nonnegative(),
  measurement: zMeasurement.nullable(),
  error: z.string().nullable(),
});
export type Sample = z.infer<typeof zSample>;
export const zSnapshot = z.object({
  hostname: z.string(),
  banner: z.string(),
  now: z.number(),
  startedAt: z.number(),
  sampleIntervalMs: z.number().positive(),
  historyMs: z.number().positive(),
  samples: z.array(zSample),
});
export type Snapshot = z.infer<typeof zSnapshot>;
