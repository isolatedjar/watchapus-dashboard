import { useId } from "react";

import type { Measurement, Sample } from "../../shared/metrics.ts";

export const memorySeries = [
  { label: "File-backed · Lean + Lake", color: "#d5bb35", value: (m: Measurement) => m.filePss },
  {
    label: "Lake · non-file",
    color: "#ac83e8",
    value: (m: Measurement) => m.groups.lake.nonFilePss,
  },
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
  {
    label: "Other Lean · non-file",
    color: "#5eb9aa",
    value: (m: Measurement) => m.groups.otherLean.nonFilePss,
  },
  { label: "Other RAM + cache", color: "#647080", value: (m: Measurement) => m.other },
];
export const countSeries = [
  { label: "Watchdogs", color: "#619dec", value: (m: Measurement) => m.groups.watchdog.count },
  { label: "File workers", color: "#ef9c46", value: (m: Measurement) => m.groups.worker.count },
];
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
type Series = (typeof memorySeries)[number];
type Props = {
  samples: Sample[];
  end: number;
  windowMs: number;
  intervalMs: number;
  series: Series[];
  stacked: boolean;
  max: number;
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
  selected,
  onSelect,
  label,
}: Props) {
  const clipId = useId();
  const left = 72,
    right = 1110,
    top = 18,
    bottom = stacked ? 272 : 156;
  const start = end - windowMs;
  const x = (t: number) => left + ((t - start) / windowMs) * (right - left);
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  // Neither failed samples nor long pauses should be bridged by a plausible-looking line.
  const segments: Sample[][] = [];
  let segment: Sample[] = [];
  for (const sample of samples) {
    if (
      !sample.measurement ||
      (segment.length && sample.timestamp - segment.at(-1)!.timestamp > intervalMs * 2.5)
    ) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (sample.measurement) segment.push(sample);
  }
  if (segment.length) segments.push(segment);
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
              {stacked ? `${+(value / 2 ** 30).toFixed(1)} GiB` : value}
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
        {segments.flatMap((points, segmentIndex) =>
          series.map((s, seriesIndex) => {
            const lower = (m: Measurement) =>
              stacked ? series.slice(0, seriesIndex).reduce((n, row) => n + row.value(m), 0) : 0;
            // Connect raw samples with straight segments; never fit or smooth the series.
            const coords = points.map(
              (point) =>
                `${x(point.timestamp)},${y(lower(point.measurement!) + s.value(point.measurement!))}`,
            );
            const reverse = points
              .toReversed()
              .map((point) => `${x(point.timestamp)},${y(lower(point.measurement!))}`);
            return (
              <g key={`${segmentIndex}-${seriesIndex}`}>
                {stacked && (
                  <path
                    data-layer={s.label}
                    d={`M${coords.join(" L")} L${reverse.join(" L")} Z`}
                    fill={s.color}
                    fillOpacity="0.45"
                  />
                )}
                <path
                  d={`M${coords.join(" L")}`}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={stacked ? 1.2 : 2}
                />
                {points.length === 1 && (
                  <circle
                    cx={x(points[0]!.timestamp)}
                    cy={y(lower(points[0]!.measurement!) + s.value(points[0]!.measurement!))}
                    r="2.5"
                    fill={s.color}
                  />
                )}
              </g>
            );
          }),
        )}
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
