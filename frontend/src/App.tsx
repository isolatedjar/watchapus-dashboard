import { useEffect, useState } from "react";

import {
  groups,
  type Sample,
  SAMPLE_INTERVAL_MS,
  type Snapshot,
  zSnapshot,
} from "../../shared/metrics.ts";
import { Chart, countSeries, gib, memorySeries, time } from "./chart.tsx";

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
        const response = await fetch("/api/history", {
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
        <div>
          <p className="eyebrow">WATCHAPUS / HOST OBSERVATORY</p>
          <h1>{snapshot?.banner ?? "Connecting to host"}</h1>
          <p className="subtitle">
            {snapshot?.hostname ?? "Connecting to host"} <span>·</span> All users, all Lean &amp;
            Lake processes
          </p>
        </div>
        <div className="status-block">
          <span className={`status ${failure ? "bad" : ""}`}>
            <i />
            {failure ? "Collection interrupted" : latest ? "Live" : "Waiting for first sample"}
          </span>
          <p>
            Last 30 minutes <span>·</span> Every {interval / 1000}s
          </p>
        </div>
      </header>
      {failure && (
        <div role="alert" className="alert">
          {failure} Data is retained; missing samples appear as gaps.
        </div>
      )}
      <section className="stats" aria-label="Selected sample totals">
        <div>
          <span>RAM in use · incl. cache</span>
          <strong>{m ? gib(m.used) : "—"}</strong>
          <small>
            {m
              ? `${((100 * m.used) / m.total).toFixed(1)}% of ${gib(m.total)} physical RAM`
              : "Waiting for a valid sample"}
          </small>
        </div>
        <div>
          <span>Lean + Lake · file-backed</span>
          <strong className="file-color">{m ? gib(m.filePss) : "—"}</strong>
          <small>Proportional resident file mappings</small>
        </div>
        <div>
          <span>Watchdogs</span>
          <strong className="watchdog-color">{m?.groups.watchdog.count ?? "—"}</strong>
          <small>lean --server</small>
        </div>
        <div>
          <span>File workers</span>
          <strong className="worker-color">{m?.groups.worker.count ?? "—"}</strong>
          <small>lean --worker</small>
        </div>
      </section>
      <section className="panel" aria-labelledby="memory-title">
        <div className="panel-heading">
          <div>
            <h2 id="memory-title">Physical memory</h2>
            <p>Every vertical slice totals used RAM, including page cache.</p>
          </div>
          <span className="tag">STACKED · GiB</span>
        </div>
        <Chart
          {...chartProps}
          series={memorySeries}
          stacked
          max={maxMemory}
          label="Stacked RAM usage over the last 30 minutes"
        />
        <div className="legend">
          {memorySeries.map((s) => (
            <span key={s.label}>
              <i style={{ background: s.color }} />
              {s.label}
              <b>{m ? gib(s.value(m)) : "—"}</b>
            </span>
          ))}
        </div>
      </section>
      <section className="panel" aria-labelledby="process-title">
        <div className="panel-heading">
          <div>
            <h2 id="process-title">Active processes</h2>
            <p>Independent counts of watchdogs and file workers across the host.</p>
          </div>
          <span className="tag">PROCESSES</span>
        </div>
        <Chart
          {...chartProps}
          series={countSeries}
          stacked={false}
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
          file-backed mappings, including .olean files, executables and libraries. Each remaining
          process layer is <code>Pss − Pss_File</code> (anonymous and shared-memory mappings).
          Shared pages are proportionally attributed, never added once per process.
        </p>
        <p>
          Other RAM is <code>MemTotal − MemFree − Σ process PSS</code>. It includes other processes,
          kernel memory and the remaining page cache. Swap is excluded. Raw RSS below is diagnostic
          only and is not added to the stack. Measurements are sequential snapshots, not an atomic
          host-wide census.
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
        <span>Hover over either chart to inspect a sample.</span>
        <span>History held in memory · resets on server restart · times shown locally</span>
      </footer>
    </main>
  );
}
