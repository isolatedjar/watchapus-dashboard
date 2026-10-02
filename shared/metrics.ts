import { z } from "zod";

export const SAMPLE_INTERVAL_MS = 10_000;
export const HISTORY_MS = 30 * 60_000;
export const groups = ["lake", "watchdog", "worker", "otherLean"] as const;
export type Group = (typeof groups)[number];
const bytes = z.number().finite().nonnegative();
const groupMetrics = z.object({
  count: z.number().int().nonnegative(),
  rss: bytes,
  pss: bytes,
  filePss: bytes,
  nonFilePss: bytes,
});
export const zMeasurement = z.object({
  total: bytes,
  free: bytes,
  used: bytes,
  filePss: bytes,
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
  now: z.number(),
  startedAt: z.number(),
  sampleIntervalMs: z.number().positive(),
  historyMs: z.number().positive(),
  samples: z.array(zSample),
});
export type Snapshot = z.infer<typeof zSnapshot>;
