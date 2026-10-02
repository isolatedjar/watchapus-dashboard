import { useEffect, useState } from "react";

import {
  groups,
  type Sample,
  SAMPLE_INTERVAL_MS,
  type Snapshot,
  zSnapshot,
} from "../../shared/metrics.ts";
import { Chart, countSeries, gib, memorySeries, processMemorySeries, time } from "./chart.tsx";

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Sample | undefined>();
  const [clock, setClock] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch("api/history", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
        const data = zSnapshot.parse(await response.json());
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setReceivedAt(Date.now());
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Cannot reach server");
      }
      timer = setTimeout(() => {
        void refresh();
      }, SAMPLE_INTERVAL_MS);
    }
    void refresh();
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, []);
  const samples = snapshot?.samples ?? [];
  const latest = samples.at(-1);
  const current = selected ?? latest;
  const m = current?.measurement;
  // Keep rolling during an outage; use server time to avoid browser clock skew.
  const now = snapshot ? snapshot.now + Math.max(0, clock - receivedAt) : clock;
  const interval = snapshot?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
  const stale = latest && now - latest.timestamp > interval * 2.5;
  const failure = error ?? latest?.error ?? (stale ? "No new samples from the collector." : null);
  const maxMemory = Math.max(2 ** 30, ...samples.map((s) => s.measurement?.total ?? 0));
  const maxProcessMemory =
    Math.max(
      2 ** 28,
      ...samples.map((s) =>
        Math.max(
          s.measurement?.groups.watchdog.nonFileStats?.max ?? 0,
          s.measurement?.groups.worker.nonFileStats?.max ?? 0,
        ),
      ),
    ) * 1.05;
  const maxCount = Math.max(
    4,
    Math.ceil(
      Math.max(
        0,
        ...samples.map((s) =>
          Math.max(
            s.measurement?.groups.watchdog.count ?? 0,
            s.measurement?.groups.worker.count ?? 0,
          ),
        ),
      ) / 4,
    ) * 4,
  );
  const chartProps = {
    samples,
    end: now,
    windowMs: snapshot?.historyMs ?? 30 * 60_000,
    intervalMs: interval,
    selected,
    onSelect: setSelected,
  };
  return (
    <main>
      <header>
        <h1>{snapshot?.banner ?? "Connecting to host"}</h1>
        <span className={`status ${failure ? "bad" : ""}`}>
          <i />
          {failure ? "Collection interrupted" : latest ? "Live" : "Waiting for first sample"}
        </span>
      </header>
      {failure && (
        <div role="alert" className="alert">
          {failure} Data is retained; missing samples appear as gaps.
        </div>
      )}
      <section className="panel" aria-labelledby="memory-title">
        <div className="panel-heading">
          <div>
            <h2 id="memory-title">Physical memory</h2>
          </div>
          <span className="tag">STACKED · GiB</span>
        </div>
        <Chart
          {...chartProps}
          series={memorySeries}
          stacked
          unit="bytes"
          max={maxMemory}
          label="Stacked RAM usage over the last 30 minutes"
        />
        <div className="legend memory-legend">
          {memorySeries.map((s) => (
            <span key={s.label}>
              <i style={{ background: s.color }} />
              {s.label}
              <b>{m ? gib(s.value(m)) : "—"}</b>
            </span>
          ))}
        </div>
      </section>
      <section className="panel" aria-labelledby="process-memory-title">
        <div className="panel-heading">
          <h2 id="process-memory-title">Memory per LSP process</h2>
          <span className="tag">NON-FILE · GiB</span>
        </div>
        <Chart
          {...chartProps}
          series={processMemorySeries}
          stacked={false}
          unit="bytes"
          max={maxProcessMemory}
          label="Average, minimum and maximum non-file memory per watchdog and file worker over the last 30 minutes"
        />
        <div className="legend process-memory-legend">
          {processMemorySeries.map((s) => {
            const value = m ? s.value(m) : null;
            return (
              <span key={s.label}>
                <svg className="line-key" viewBox="0 0 30 8" aria-hidden="true">
                  <line
                    x1="1"
                    y1="4"
                    x2="29"
                    y2="4"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeDasharray={s.dash}
                    strokeLinecap={s.dash === "1 5" ? "round" : "butt"}
                  />
                </svg>
                {s.label}
                <b>{value === null ? "—" : gib(value)}</b>
              </span>
            );
          })}
        </div>
      </section>
      <section className="panel" aria-labelledby="process-title">
        <div className="panel-heading">
          <div>
            <h2 id="process-title">Lean LSP processes</h2>
          </div>
          <span className="tag">PROCESSES</span>
        </div>
        <Chart
          {...chartProps}
          series={countSeries}
          stacked={false}
          unit="count"
          max={maxCount}
          label="Watchdog and file worker process counts over the last 30 minutes"
        />
        <div className="legend counts">
          {countSeries.map((s) => (
            <span key={s.label}>
              <i style={{ background: s.color }} />
              {s.label}
              <b>{m ? s.value(m) : "—"}</b>
            </span>
          ))}
        </div>
      </section>
      <div className="sample-bar">
        <span>
          {selected ? "Inspecting" : "Latest sample"}{" "}
          {current ? new Date(current.timestamp).toLocaleTimeString([], { hour12: false }) : "—"}
        </span>
        <span>
          {current ? `${current.durationMs} ms to collect` : ""}{" "}
          {m?.vanished ? `· ${m.vanished} processes exited during scan` : ""}
        </span>
      </div>
      <details className="panel accounting">
        <summary>Memory accounting &amp; raw process measurements</summary>
        <p>
          The yellow layer is <code>Pss_File</code> across all Lean and Lake processes: resident
          file-backed mappings, including .olean files, executables and libraries. Each
          watchdog/worker layer is <code>Pss − Pss_File</code> (anonymous and shared-memory
          mappings). Shared pages are proportionally attributed, never added once per process.
        </p>
        <p>
          Other RAM is total used RAM minus the file-backed, watchdog non-file and worker non-file
          layers. It includes Lake and other Lean non-file memory, other processes, kernel memory
          and the remaining page cache. Swap is excluded. Raw RSS below is diagnostic only and is
          not added to the stack. Measurements are sequential snapshots, not an atomic host-wide
          census.
        </p>
        <p>
          The per-process chart summarizes non-file memory across the watchdogs and workers alive at
          each sample: solid average, dotted minimum, dashed maximum. An empty group has no memory
          statistic and appears as a gap, while its process count is zero.
        </p>
        <div className="table-scroll">
          <table>
            <caption>Process measurements at {current ? time(current.timestamp) : "—"}</caption>
            <thead>
              <tr>
                <th>Process group</th>
                <th>Count</th>
                <th>RSS</th>
                <th>PSS</th>
                <th>File PSS</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group}>
                  <th>
                    {
                      {
                        lake: "Lake",
                        watchdog: "Watchdogs",
                        worker: "File workers",
                        otherLean: "Other Lean",
                      }[group]
                    }
                  </th>
                  <td>{m?.groups[group].count ?? "—"}</td>
                  <td>{m ? gib(m.groups[group].rss) : "—"}</td>
                  <td>{m ? gib(m.groups[group].pss) : "—"}</td>
                  <td>{m ? gib(m.groups[group].filePss) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <footer>
        <span>Hover over any chart to inspect a sample.</span>
        <span>History held in memory · resets on server restart · times shown locally</span>
      </footer>
    </main>
  );
}
