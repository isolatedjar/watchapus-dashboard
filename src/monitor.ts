import { hostname } from "node:os";

import {
  HISTORY_MS,
  type Measurement,
  type Sample,
  SAMPLE_INTERVAL_MS,
  type Snapshot,
} from "../shared/metrics.ts";
import { collect } from "./collector.ts";

export class Monitor {
  private _samples: Sample[] = [];
  private _startedAt = Date.now();
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _stopped = false;
  private _running = false;
  private _collect: () => Promise<Measurement>;
  private _log: (sample: Sample) => void;
  constructor(
    collector = collect,
    log = (sample: Sample) => {
      process.stdout.write(`${JSON.stringify({ version: 2, event: "sample", ...sample })}\n`);
    },
  ) {
    this._collect = collector;
    this._log = log;
  }
  async tick(): Promise<void> {
    if (this._running) return;
    this._running = true;
    const start = Date.now();
    let measurement: Measurement | null = null;
    let error: string | null = null;
    try {
      measurement = await this._collect();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const sample = { timestamp: Date.now(), durationMs: Date.now() - start, measurement, error };
    this._samples.push(sample);
    this._prune(sample.timestamp);
    this._running = false;
    this._log(sample);
  }
  private _prune(now: number) {
    // Keep one extra point to anchor the left edge of the window.
    while (this._samples.length > 1 && this._samples[1]!.timestamp < now - HISTORY_MS)
      this._samples.shift();
  }
  snapshot(): Snapshot {
    const now = Date.now();
    this._prune(now);
    return {
      hostname: hostname(),
      banner: process.env.WD_BANNER ?? process.env.HOST ?? hostname(),
      now,
      startedAt: this._startedAt,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      historyMs: HISTORY_MS,
      samples: [...this._samples],
    };
  }
  start() {
    this._stopped = false;
    const run = async () => {
      const start = Date.now();
      await this.tick();
      if (!this._stopped)
        this._timer = setTimeout(
          () => {
            void run();
          },
          Math.max(0, SAMPLE_INTERVAL_MS - (Date.now() - start)),
        );
    };
    void run();
  }
  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
  }
}
