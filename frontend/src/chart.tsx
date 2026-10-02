import { useId } from "react";

import type { Measurement, Sample } from "../../shared/metrics.ts";

export const memorySeries = [
  { label: "Kernel page tables", color: "#ac83e8", value: (m: Measurement) => m.pageTables },
  { label: "Other system", color: "#b28d77", value: (m: Measurement) => m.otherSystem },
  { label: "File-backed · Lean + Lake", color: "#d5bb35", value: (m: Measurement) => m.filePss },
  {
    label: "Watchdogs · non-file",
    color: "#619dec",
    value: (m: Measurement) => m.groups.watchdog.nonFilePss,
  },
  {
    label: "File workers · non-file",
    color: "#ef9c46",
    value: (m: Measurement) => m.groups.worker.nonFilePss,
  },
  { label: "Other parts of Workbench", color: "#5eb9aa", value: (m: Measurement) => m.webPss },
  { label: "Other RAM + cache", color: "#647080", value: (m: Measurement) => m.other },
];
export const countSeries = [
  { label: "Watchdogs", color: "#619dec", value: (m: Measurement) => m.groups.watchdog.count },
  { label: "File workers", color: "#ef9c46", value: (m: Measurement) => m.groups.worker.count },
];
export const processMemorySeries = (["watchdog", "worker"] as const).flatMap((group) =>
  (["average", "min", "max"] as const).map((stat) => ({
    label: `${group === "watchdog" ? "Watchdogs" : "File workers"} · ${{ average: "Average", min: "Minimum", max: "Maximum" }[stat]}`,
    color: group === "watchdog" ? "#619dec" : "#ef9c46",
    dash: { average: undefined, min: "1 5", max: "8 5" }[stat],
    value: (m: Measurement) => m.groups[group].nonFileStats?.[stat] ?? null,
  })),
);
export const cpuSeries = (["average", "min", "max"] as const).map((stat) => ({
  label: { average: "Average", min: "Minimum", max: "Maximum" }[stat],
  color: "#ac83e8",
  dash: { average: undefined, min: "1 5", max: "8 5" }[stat],
  value: (m: Measurement) => m.cpu?.[stat] ?? null,
}));
export function percentage(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}
export function gib(bytes: number) {
  return `${(bytes / 2 ** 30).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
}
export function time(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
type Series = {
  label: string;
  color: string;
  dash?: string;
  value: (m: Measurement) => number | null;
};
type Props = {
  samples: Sample[];
  end: number;
  windowMs: number;
  intervalMs: number;
  series: Series[];
  stacked: boolean;
  max: number;
  unit: "bytes" | "count" | "percent";
  selected: Sample | undefined;
  onSelect: (sample: Sample | undefined) => void;
  label: string;
};

export function Chart({
  samples,
  end,
  windowMs,
  intervalMs,
  series,
  stacked,
  max,
  unit,
  selected,
  onSelect,
  label,
}: Props) {
  const clipId = useId();
  // The RAM chart is 250 units high, 20% shorter than its original 312.
  const left = 72,
    right = 1110,
    top = 18,
    bottom = stacked ? 210 : 156;
  const start = end - windowMs;
  const x = (t: number) => left + ((t - start) / windowMs) * (right - left);
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  function select(clientX: number, rect: DOMRect) {
    const svgX = ((clientX - rect.left) / rect.width) * 1140;
    const timestamp = start + ((svgX - left) / (right - left)) * windowMs;
    const nearest = samples.reduce<Sample | undefined>(
      (a, b) =>
        !a || Math.abs(b.timestamp - timestamp) < Math.abs(a.timestamp - timestamp) ? b : a,
      undefined,
    );
    onSelect(
      nearest && Math.abs(nearest.timestamp - timestamp) <= intervalMs * 2.5 ? nearest : undefined,
    );
  }
  return (
    <svg
      className="chart"
      viewBox={`0 0 1140 ${bottom + 40}`}
      role="img"
      aria-label={label}
      onPointerMove={(event) => select(event.clientX, event.currentTarget.getBoundingClientRect())}
      onPointerLeave={() => onSelect(undefined)}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={left} y={top} width={right - left} height={bottom - top} />
        </clipPath>
      </defs>
      {Array.from({ length: 5 }, (_, i) => {
        const value = (max * i) / 4;
        return (
          <g key={i}>
            <line className="grid" x1={left} x2={right} y1={y(value)} y2={y(value)} />
            <text x={left - 12} y={y(value) + 4} textAnchor="end">
              {unit === "bytes" ? gib(value) : unit === "percent" ? percentage(value) : value}
            </text>
          </g>
        );
      })}
      {Array.from({ length: 7 }, (_, i) => {
        const timestamp = start + (windowMs * i) / 6;
        return (
          <g key={i}>
            <line className="grid" x1={x(timestamp)} x2={x(timestamp)} y1={top} y2={bottom} />
            <text x={x(timestamp)} y={bottom + 26} textAnchor="middle">
              {time(timestamp)}
            </text>
          </g>
        );
      })}
      <g clipPath={`url(#${clipId})`}>
        {series.flatMap((s, seriesIndex) => {
          // Break each series at errors, long pauses, or empty process populations.
          const segments: Sample[][] = [];
          let segment: Sample[] = [];
          for (const sample of samples) {
            const present = sample.measurement && s.value(sample.measurement) !== null;
            if (
              !present ||
              (segment.length && sample.timestamp - segment.at(-1)!.timestamp > intervalMs * 2.5)
            ) {
              if (segment.length) segments.push(segment);
              segment = [];
            }
            if (present) segment.push(sample);
          }
          if (segment.length) segments.push(segment);
          return segments.map((points, segmentIndex) => {
            const lower = (m: Measurement) =>
              stacked
                ? series.slice(0, seriesIndex).reduce((n, row) => n + (row.value(m) ?? 0), 0)
                : 0;
            // Connect raw samples with straight segments; never fit or smooth the series.
            const coords = points.map(
              (point) =>
                `${x(point.timestamp)},${y(lower(point.measurement!) + s.value(point.measurement!)!)}`,
            );
            const reverse = points
              .toReversed()
              .map((point) => `${x(point.timestamp)},${y(lower(point.measurement!))}`);
            return (
              <g key={`${seriesIndex}-${segmentIndex}`}>
                {stacked && (
                  <path
                    data-layer={s.label}
                    d={`M${coords.join(" L")} L${reverse.join(" L")} Z`}
                    fill={s.color}
                    fillOpacity="0.45"
                  />
                )}
                <path
                  data-series={s.label}
                  d={`M${coords.join(" L")}`}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={stacked ? 1.2 : 2}
                  strokeDasharray={s.dash}
                  strokeLinecap={s.dash === "1 5" ? "round" : "butt"}
                />
                {points.length === 1 && (
                  <circle
                    cx={x(points[0]!.timestamp)}
                    cy={y(lower(points[0]!.measurement!) + s.value(points[0]!.measurement!)!)}
                    r="2.5"
                    fill={s.color}
                  />
                )}
              </g>
            );
          });
        })}
        {selected && (
          <line
            className="crosshair"
            x1={x(selected.timestamp)}
            x2={x(selected.timestamp)}
            y1={top}
            y2={bottom}
          />
        )}
      </g>
    </svg>
  );
}
