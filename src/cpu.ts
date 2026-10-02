import type { Measurement } from "../shared/metrics.ts";

// /proc/stat: user nice system idle iowait irq softirq steal guest guest_nice.
// Guest time is already included in user/nice; never add it again.
function counters(text: string): Map<string, number[]> {
  const rows = new Map<string, number[]>();
  for (const line of text.split("\n")) {
    const [name, ...values] = line.trim().split(/\s+/);
    if (!/^cpu\d+$/.test(name ?? "")) continue;
    const ticks = values.slice(0, 8).map(Number);
    if (ticks.length < 8 || ticks.some((n) => !Number.isSafeInteger(n) || n < 0))
      throw new Error("Invalid per-CPU counters in /proc/stat");
    rows.set(name!, ticks);
  }
  if (!rows.size) throw new Error("Missing per-CPU counters in /proc/stat");
  return rows;
}

export class CpuTracker {
  private _previous: Map<string, number[]> | undefined;

  sample(text: string): Measurement["cpu"] {
    const current = counters(text);
    const previous = this._previous;
    this._previous = current;
    // A new baseline is needed on startup or when CPUs come online/offline.
    if (!previous || previous.size !== current.size) return null;
    const utilization: number[] = [];
    for (const [name, ticks] of current) {
      const before = previous.get(name);
      if (!before) return null;
      const delta = ticks.map((n, i) => n - before[i]!);
      // iowait can decrease on Linux. Rebase instead of inventing utilization.
      if (delta.some((n) => n < 0)) return null;
      const total = delta.reduce((a, b) => a + b, 0);
      if (!total) return null;
      const busy = delta[0]! + delta[1]! + delta[2]! + delta[5]! + delta[6]!;
      utilization.push((busy / total) * 100);
    }
    return {
      count: utilization.length,
      average: utilization.reduce((a, b) => a + b, 0) / utilization.length,
      min: Math.min(...utilization),
      max: Math.max(...utilization),
    };
  }
}
