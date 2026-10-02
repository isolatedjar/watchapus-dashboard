import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";

import {
  emptyKernel,
  emptyWebGroups,
  HISTORY_MS,
  type Measurement,
  SAMPLE_INTERVAL_MS,
  zSnapshot,
} from "../shared/metrics.ts";
import { createApp } from "./app.ts";
import { Monitor } from "./monitor.ts";

const emptyGroup = { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0, nonFileStats: null };
const measurement: Measurement = {
  cpu: null,
  total: 100,
  free: 20,
  used: 80,
  filePss: 0,
  other: 80,
  pageTables: 0,
  otherSystem: 0,
  kernel: emptyKernel(),
  webPss: 0,
  webGroups: emptyWebGroups(),
  vanished: 0,
  groups: { lake: emptyGroup, watchdog: emptyGroup, worker: emptyGroup, otherLean: emptyGroup },
};
afterEach(() => {
  vi.useRealTimers();
});
it("bounds history at 30 minutes plus one boundary sample and serves it independently of browser sessions", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const log = vi.fn();
  const monitor = new Monitor(() => Promise.resolve(measurement), log);
  for (let n = 0; n <= 200; n++) {
    vi.setSystemTime(n * SAMPLE_INTERVAL_MS);
    await monitor.tick();
  }
  const snapshot = monitor.snapshot();
  expect(snapshot.samples.length).toBe(182);
  expect(snapshot.samples[0]!.timestamp).toBe(snapshot.now - HISTORY_MS - SAMPLE_INTERVAL_MS);
  expect(log).toHaveBeenCalledTimes(201);
  vi.useRealTimers();
});
it("records errors as gaps and recovers on the next sample", async () => {
  const collector = vi
    .fn()
    .mockRejectedValueOnce(new Error("Permission denied"))
    .mockResolvedValue(measurement);
  const log = vi.fn();
  const monitor = new Monitor(collector, log);
  await monitor.tick();
  await monitor.tick();
  expect(monitor.snapshot().samples[0]).toMatchObject({
    measurement: null,
    error: "Permission denied",
  });
  expect(monitor.snapshot().samples[1]).toMatchObject({ measurement, error: null });
  const response = await request(createApp(monitor)).get("/api/history").expect(200);
  expect(zSnapshot.parse(response.body).samples).toHaveLength(2);
  expect(response.headers["cache-control"]).toBe("no-store");
  await request(createApp(monitor)).get("/api/missing").expect(404);
});
it("does not overlap collection and stops its scheduled timer", async () => {
  vi.useFakeTimers();
  let resolve: (m: Measurement) => void = () => {};
  const collector = vi.fn(
    () =>
      new Promise<Measurement>((r) => {
        resolve = r;
      }),
  );
  const monitor = new Monitor(collector, vi.fn());
  monitor.start();
  await monitor.tick();
  expect(collector).toHaveBeenCalledTimes(1);
  monitor.stop();
  resolve(measurement);
  await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3);
  expect(collector).toHaveBeenCalledTimes(1);
});
