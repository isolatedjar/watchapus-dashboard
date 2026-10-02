# Watchapus dashboard

A standalone, single-port Linux host dashboard, based on the Sourdough
`fullstack-react` starter at commit
`3e3477ff509f18017c8daa31181fd414ea760779`. React + Vite on the frontend,
Express on Node.js 24 on the backend. It does not need watchapus, Prometheus,
Grafana, a database, or any external browser assets.

## Run

Requires Node.js 24 or newer and Linux procfs exposing `smaps_rollup` with
`Pss_File` (available on standard contemporary kernels, including Ubuntu
26.04). Run on the host whose memory you want to measure, with access to all
processes. Root normally supplies that access. A container's restricted PID
namespace would not represent all host processes.

```sh
npm ci
npm run build
sudo env PORT=3000 NODE_ENV=production node src/server.ts
```

Open the server's address on the chosen `PORT`. The default port is 3000 and
binding is `0.0.0.0`; set `HOST=127.0.0.1` to bind locally instead. The same
port serves the page, bundled assets, and `GET /api/history`. There is no
login or process-control API. The dashboard exposes aggregate host metrics.

The heading and browser tab title use `WD_BANNER` when set, otherwise `HOST`
when set, otherwise the system hostname. Set `WD_BANNER="Lean build server"`
on the server process to customize it; no frontend rebuild is needed to change
the banner. An empty `WD_BANNER` deliberately leaves the heading blank. `HOST`
also controls the listen address as described above.

Change `SAMPLE_INTERVAL_MS` in `shared/metrics.ts` to change the 10-second
sampling interval, then rebuild and restart. `HISTORY_MS` in the same file
controls the rolling 30-minute window. Collection runs with no browser
connected. Samples are held in memory and disappear on restart. Concurrent
page-table walks are limited to eight; sampling rounds never overlap. If a
round takes longer than the interval, the next begins when it completes.

For development, `npm run dev` starts Vite and the API server; Vite proxies
`/api` to `PORT` (default 3000). Reading other users' process mappings still
requires appropriate permissions.

## Nginx at /watch

The production app serves both `/` and `/watch/`. Use this prefix-preserving
proxy configuration (no trailing slash on `proxy_pass`):

```nginx
location /watch {
    proxy_pass http://127.0.0.1:8999;
}
```

The app redirects `/watch` to `/watch/`. Bundled assets and API requests use
relative URLs, so they stay under `/watch/`; no separate Nginx asset or API
locations are needed. After updating the code, run `npm run build` and restart
the Node process with `PORT=8999`.

## Accounting

Each stacked slice totals **MemTotal − MemFree**, including page cache and
excluding swap. All memory quantities in the API and logs are **bytes**, not
KiB. The display uses GiB (2³⁰ bytes).

Layers are listed from the bottom of the stack upward:

| Layer                     | Measurement                                       |
| ------------------------- | ------------------------------------------------- |
| Kernel page tables        | Host `PageTables + SecPageTables`                 |
| Other system              | Host `Slab + KernelStack + Percpu`                |
| File-backed · Lean + Lake | Sum of `Pss_File` for all Lean and Lake processes |
| Watchdogs · non-file      | Sum of `Pss − Pss_File` for `lean --server`       |
| File workers · non-file   | Sum of `Pss − Pss_File` for `lean --worker`       |
| Other parts of Workbench  | Full PSS of recognized web/editor processes       |
| Other RAM + cache         | `MemTotal − MemFree` minus the six layers above   |

Page tables cover the whole host, including secondary page tables where the
kernel reports them. `SecPageTables` and `Percpu` default to zero on kernels
that do not expose them. Process PSS excludes these kernel allocations.

Slab holds kernel objects such as file metadata and socket bookkeeping. It
includes both reclaimable (`SReclaimable`) and unreclaimable (`SUnreclaim`)
allocations; these are shown separately in the detail table but counted only
once. **Other system does not mean unreclaimable memory**, and is not an
exhaustive kernel total. `VmallocUsed` is deliberately excluded because it can
overlap other allocations. Buffers remain in Other RAM + cache.

Other parts of Workbench includes recognized Next.js servers, Workbench shard
and collaboration servers, VS Code server/helpers, extension hosts, file
watchers, auxiliary language servers, and Nginx. Classification uses
executable and script arguments, not ancestry or arbitrary command-string
matches. The VS Code rule targets this deployment's `/app/vscode-server`
installation; other installation paths and unrecognized applications remain in
Other RAM. Shell and bwrap launchers are excluded. Lean/Lake groups take
precedence. The web layer includes its processes' file PSS; that memory is not
also added to the yellow Lean/Lake layer. Per-service count, RSS, PSS and file
PSS are available in the expandable table, API and logs.

Other RAM includes Lake and other Lean non-file memory. Their file-backed
mappings still contribute to the yellow file-backed layer. It also includes
unclassified processes, remaining kernel allocations, and remaining page
cache. Raw measurements for all four Lean/Lake categories remain available.

The second graph shows **average, minimum and maximum non-file memory per
process** across the watchdogs and workers alive at each sample (not a moving
average over time). Blue means watchdogs; orange means file workers. Average
is solid, minimum dotted, maximum dashed. An empty group has null statistics
and appears as a gap.

The third graph, **CPU Utilization**, shows average, minimum and maximum
utilization **across logical CPUs** over the interval since the previous
successful sample. All three lines use the page-table purple: solid average,
dotted minimum, dashed maximum, on a fixed 0–100% scale. Each CPU's
utilization comes from deltas in `/proc/stat`:
`(user + nice + system + irq + softirq) / (user + nice + system + idle + iowait + irq + softirq + steal)`.
Idle, I/O wait and stolen time do not count as executing work. Guest ticks are
already in user/nice and are not counted twice. The average is the arithmetic
mean of per-CPU percentages; min/max compare CPUs, not moments within the
interval. The first sample after restart has no CPU statistic. CPU hotplug,
decreasing counters or zero elapsed ticks establish a new baseline and leave a
CPU gap. Memory and process-count graphs remain available during these
baseline gaps.

The bottom graph shows **Lean LSP processes**: separate watchdog and worker
counts, including zero when none are present. All four graphs use straight
segments between samples, with no smoothing.

`Pss_File` directly measures the proportionally attributed resident pages of
file-backed mappings. It includes `.olean`, other Lean data files, executable
code and shared libraries; it is **not** limited to Lean-specific file
extensions. Anonymous copy-on-write pages belong to the non-file part.
Anonymous and shmem pages are proportionally accounted in the non-file layers.
Unmapped file cache stays in Other RAM. Pages shared with processes outside
Lean/Lake are split proportionally; recognized web processes' shares go to
Other parts of Workbench, and other processes' shares stay in Other RAM.
Explicit hugetlb memory not reported in PSS remains in Other RAM.

This is related to watchapus's USS + (PSS − USS) split, but directly
identifies file-backed memory instead of treating all shared memory as a
proxy. RSS is recorded for every category and shown in the expandable table;
it is never added to the stack because that would double-count shared pages.

Selection uses `/proc/PID/comm` (`lean` or `lake`) and the basename of
argv[0]. Role flags are matched as complete arguments before `--`. All users
and all Lake invocations are included; workers need not have a live watchdog
parent. Processes renamed away from these executable names are not selected.

Procfs is not an atomic snapshot. Processes can start, exit, exec, or change
mappings while scanned. Start times detect PID reuse, disappearing processes
are skipped, and their number is recorded as `vanished`. PSS is rounded by the
kernel to KiB. These introduce small sampling inaccuracies; the stack still
sums exactly to the sampled used-RAM total. An impossible negative residual or
a permission/accounting error produces a gap and an error log, not a
fabricated zero. No new samples for 2.5 sampling intervals triggers a
stale-data message. Long pauses and failed samples break graph lines.

## Capturing logs

The Node process emits newline-delimited JSON to stdout. Every completed round
emits `event: "sample"` with `version: 4`, a Unix-millisecond `timestamp`,
`durationMs`, `measurement`, and `error`. Successful measurements contain
`total`, `free`, `used`, `filePss`, `pageTables`, `otherSystem`, `kernel`,
`webPss`, `webGroups`, `cpu`, `other`, `vanished`, and each Lean/Lake
category's `count`, `rss`, `pss`, `filePss`, `nonFilePss`, and `nonFileStats`
(`average`, `min`, `max` in bytes, or null for an empty group). Failures have
`measurement: null` and a diagnostic `error`; a successful sample has
`error: null`. `kernel` records primary/secondary page tables, total and
reclaimable/unreclaimable slab, kernel stacks, and per-CPU allocations.
`webGroups` records count, RSS, PSS and file PSS for each web/editor category.
`cpu` contains `count` (logical CPUs), `average`, `min` and `max` (percentages
from 0 to 100), or null while establishing a baseline. Version 4 adds CPU
statistics; the memory fields retain their version-3 meanings and API names.
Startup emits `event: "listening"`. Log version 3 subtracts page tables,
web/editor PSS and Other system from `other`. Version 2 folded Lake and other
Lean non-file memory into `other`; version 1 excluded it.

To capture clean NDJSON, invoke Node directly rather than capturing npm's
script banners:

```sh
sudo env PORT=3000 NODE_ENV=production node src/server.ts >> samples.ndjson
```

Under systemd, stdout goes to journald. `deploy/watchapus-dashboard.service`
is an example unit for an installation at `/opt/watchapus-dashboard`:

```sh
sudo cp deploy/watchapus-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now watchapus-dashboard
journalctl -u watchapus-dashboard -o cat --since '30 minutes ago' \
  | jq -Rc 'fromjson? | select(.event == "sample")' > samples.ndjson
```

Edit the unit's `PORT`, paths and Node executable for your installation.
Journald's retention policy controls how long logs survive. The app itself
neither rotates logs nor reads them back into history.

## Verification

```sh
npm run check
npm run lint
npm run prettier
npm run test:server
npm run test:frontend
```

Playwright requires its Chromium browser installed
(`npx playwright install --with-deps chromium`). Browser tests build and
launch the production single-port app on loopback port 3187, then exercise
graphs, hover inspection, mobile layout, collection failures, connection
failures, and the real API. Backend tests cover proportional sharing,
categories, process exits, invalid accounting, history retention,
failures/recovery, and non-overlapping scans.

The implementation was additionally checked against the live Linux kernel
using two synthetic `lean --worker` processes, each with 64 MiB anonymous
memory and the same 32 MiB mapped file: aggregate file PSS was about 32 MiB,
non-file PSS about 128 MiB, and raw RSS about 194 MiB. This validates that the
shared file is not counted twice. This is a kernel accounting test, not a
benchmark of real Lean workloads or of a heavily loaded Ubuntu host.
