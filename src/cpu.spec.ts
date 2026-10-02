import { expect, it } from "vitest";

import { CpuTracker } from "./cpu.ts";

it("measures per-CPU interval utilization without counting guest time twice", () => {
  const cpu = new CpuTracker();
  expect(cpu.sample("cpu0 0 0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0 0 0")).toBeNull();
  expect(
    cpu.sample("cpu 999 0 0 0 0 0 0 0\ncpu0 40 0 10 30 10 5 5 0 20 0\ncpu1 10 0 0 70 0 0 0 20 0 0"),
  ).toEqual({ count: 2, average: 35, min: 10, max: 60 });
  // The second interval, not the lifetime average: CPU0 idle, CPU1 fully busy.
  expect(cpu.sample("cpu0 40 0 10 130 10 5 5 0 20 0\ncpu1 110 0 0 70 0 0 0 20 0 0")).toEqual({
    count: 2,
    average: 50,
    min: 0,
    max: 100,
  });
});

it("rebases after CPU hotplug, reset, no elapsed ticks, and decreasing iowait", () => {
  const cpu = new CpuTracker();
  expect(cpu.sample("cpu0 10 0 0 10 2 0 0 0")).toBeNull();
  expect(cpu.sample("cpu0 10 0 0 10 2 0 0 0")).toBeNull();
  expect(cpu.sample("cpu0 20 0 0 20 1 0 0 0")).toBeNull();
  expect(cpu.sample("cpu0 30 0 0 30 1 0 0 0")).toMatchObject({ average: 50 });
  expect(cpu.sample("cpu0 0 0 0 0 0 0 0 0")).toBeNull();
  expect(cpu.sample("cpu0 10 0 0 10 0 0 0 0\ncpu1 10 0 0 10 0 0 0 0")).toBeNull();
  expect(cpu.sample("cpu0 20 0 0 20 0 0 0 0")).toBeNull();
  expect(cpu.sample("cpu1 20 0 0 20 0 0 0 0")).toBeNull();
  expect(cpu.sample("cpu1 30 0 0 30 0 0 0 0")).toMatchObject({ count: 1, average: 50 });
});

it("reports missing or malformed CPU data instead of fabricating idle time", () => {
  const cpu = new CpuTracker();
  expect(() => cpu.sample("cpu 10 0 0 20 0 0 0 0")).toThrow("Missing per-CPU");
  expect(() => cpu.sample("cpu0 10 0 0 20")).toThrow("Invalid per-CPU");
  expect(() => cpu.sample("cpu0 10 0 0 nope 0 0 0 0")).toThrow("Invalid per-CPU");
});
