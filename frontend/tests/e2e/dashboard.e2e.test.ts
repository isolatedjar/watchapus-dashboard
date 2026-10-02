import { expect, test } from "@playwright/test";

import {
  emptyKernel,
  emptyWebGroups,
  type Measurement,
  type Sample,
} from "../../../shared/metrics.ts";

function history() {
  const now = Date.now();
  const samples: Sample[] = Array.from({ length: 181 }, (_, i) => {
    const worker = 8 + Math.round(4 * Math.sin(i / 16));
    const scale = 2 ** 30;
    const group = (count: number, pss: number, file: number) => ({
      count,
      pss: pss * scale,
      filePss: file * scale,
      nonFilePss: (pss - file) * scale,
      nonFileStats: {
        average: ((pss - file) * scale) / count,
        min: (((pss - file) * scale) / count) * 0.5,
        max: (((pss - file) * scale) / count) * 1.5,
      },
      rss: pss * scale * 1.7,
    });
    const groups = {
      lake: group(3, 0.5, 0.2),
      watchdog: group(4, 2, 0.8),
      worker: group(worker, 8 + 2 * Math.sin(i / 14), 3),
      otherLean: group(2, 1, 0.2),
    };
    const filePss = Object.values(groups).reduce((n, g) => n + g.filePss, 0);
    const used = (23 + Math.sin(i / 20) * 3) * scale;
    const measurement: Measurement = {
      cpu:
        i === 0
          ? null
          : { count: 8, average: 40 + (i % 15), min: 5 + (i % 10), max: 80 + (i % 20) },
      total: 32 * scale,
      free: 32 * scale - used,
      used,
      filePss,
      pageTables: 2 * scale,
      otherSystem: scale,
      kernel: {
        ...emptyKernel(),
        primaryPageTables: 2 * scale,
        slab: scale,
        slabReclaimable: scale * 0.4,
        slabUnreclaimable: scale * 0.6,
      },
      webPss: scale,
      webGroups: {
        ...emptyWebGroups(),
        extensions: { count: 4, rss: scale * 1.5, pss: scale, filePss: scale * 0.1 },
      },
      other:
        used -
        4 * scale -
        Object.values(groups).reduce((n, g) => n + g.pss, 0) +
        groups.otherLean.nonFilePss +
        groups.lake.nonFilePss,
      groups,
      vanished: 0,
    };
    return { timestamp: now - (180 - i) * 10000, durationMs: 35, measurement, error: null };
  });
  return {
    hostname: "lean-host",
    banner: "Lean build server",
    now,
    startedAt: now - 1800000,
    sampleIntervalMs: 10000,
    historyMs: 1800000,
    samples,
  };
}
test("shows stacked memory, process counts and synchronized inspection", async ({ page }) => {
  await page.route("**/api/history", (route) => route.fulfill({ json: history() }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Lean build server" })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const chart = page.getByRole("img", { name: "Stacked RAM usage over the last 30 minutes" });
  await expect(chart.locator("[data-layer]")).toHaveCount(7);
  expect(
    await chart
      .locator("[data-layer]")
      .evaluateAll((paths) => paths.map((p) => p.getAttribute("data-layer"))),
  ).toEqual([
    "File-backed · Lean + Lake",
    "Watchdogs · non-file",
    "File workers · non-file",
    "Kernel page tables",
    "Other system",
    "Other parts of Workbench",
    "Other RAM + cache",
  ]);
  const perProcess = page.getByRole("img", { name: /^Average, minimum and maximum non-file/ });
  await expect(perProcess.locator("[data-series]")).toHaveCount(6);
  await expect(perProcess.locator('[data-series="Watchdogs · Minimum"]')).toHaveAttribute(
    "stroke-dasharray",
    "1 5",
  );
  await expect(perProcess.locator('[data-series="File workers · Maximum"]')).toHaveAttribute(
    "stroke-dasharray",
    "8 5",
  );
  await expect(
    page.getByRole("heading", { name: "Lean LSP processes", exact: true }),
  ).toBeVisible();
  const cpu = page.getByRole("img", { name: /^Average, minimum and maximum utilization/ });
  await expect(cpu.locator("[data-series]")).toHaveCount(3);
  await expect(cpu.locator('[data-series="Average"]')).toHaveAttribute("stroke", "#ac83e8");
  await expect(cpu.locator('[data-series="Minimum"]')).toHaveAttribute("stroke-dasharray", "1 5");
  await expect(cpu.locator('[data-series="Maximum"]')).toHaveAttribute("stroke-dasharray", "8 5");
  await expect(cpu.getByText("100%", { exact: true })).toBeVisible();
  expect(await page.locator("section h2").allTextContents()).toEqual([
    "Physical memory",
    "Memory per LSP process",
    "CPU Utilization",
    "Lean LSP processes",
  ]);
  await chart.hover({ position: { x: 400, y: 100 } });
  await expect(page.getByText(/^Inspecting/)).toBeVisible();
  await expect(page.locator(".crosshair")).toHaveCount(4);
  await page.getByText("Memory accounting & raw process measurements").click();
  await expect(page.getByRole("columnheader", { name: "RSS", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Physical memory" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test("shows failed samples as gaps and reports the collection error", async ({ page }) => {
  const data = history();
  data.samples[80] = { ...data.samples[80]!, measurement: null, error: "Permission denied" };
  data.samples[180] = { ...data.samples[180]!, measurement: null, error: "Permission denied" };
  await page.route("**/api/history", (route) => route.fulfill({ json: data }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Permission denied");
  await expect(page.locator("[data-layer]")).toHaveCount(14);
});
test("surfaces a disconnected server without displaying invented data", async ({ page }) => {
  await page.route("**/api/history", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  await expect(page.locator("[data-layer]")).toHaveCount(0);
});
test("production port serves the SPA and a live procfs sample", async ({ page, request }) => {
  const response = await request.get("/api/history");
  expect(response.ok()).toBe(true);
  const data = await response.json();
  expect(data.sampleIntervalMs).toBe(10000);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Physical memory" })).toBeVisible();
});

test("serves the dashboard under a preserved /watch prefix", async ({ page, request }) => {
  const redirect = await request.get("/watch?from=nginx", { maxRedirects: 0 });
  expect(redirect.status()).toBe(308);
  expect(redirect.headers().location).toBe("/watch/?from=nginx");
  const paths: string[] = [];
  page.on("request", (req) => paths.push(new URL(req.url()).pathname));
  const historyResponse = page.waitForResponse("**/watch/api/history");
  await page.goto("/watch");
  expect((await historyResponse).ok()).toBe(true);
  await expect(page).toHaveURL(/\/watch\/$/);
  await expect(page.getByRole("heading", { name: "127.0.0.1", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Physical memory" })).toBeVisible();
  expect(paths.some((path) => path.startsWith("/watch/assets/"))).toBe(true);
  expect(paths.every((path) => path === "/watch" || path.startsWith("/watch/"))).toBe(true);
  await request.get("/watch/api/missing").then((response) => expect(response.status()).toBe(404));
});

test("leaves gaps in per-process statistics when a population is empty", async ({ page }) => {
  const data = history();
  const m = data.samples[80]!.measurement!;
  m.other += m.groups.worker.pss;
  m.filePss -= m.groups.worker.filePss;
  m.groups.worker = { count: 0, rss: 0, pss: 0, filePss: 0, nonFilePss: 0, nonFileStats: null };
  await page.route("**/api/history", (route) => route.fulfill({ json: data }));
  await page.goto("/");
  const chart = page.getByRole("img", { name: /^Average, minimum and maximum non-file/ });
  await expect(chart.locator('[data-series="File workers · Average"]')).toHaveCount(2);
  await expect(chart.locator('[data-series="Watchdogs · Average"]')).toHaveCount(1);
  await expect(
    page
      .getByRole("img", { name: /^Watchdog and file worker process counts/ })
      .locator('[data-series="File workers"]'),
  ).toHaveCount(1);
});

test("leaves a CPU gap when a counter baseline is unavailable", async ({ page }) => {
  const data = history();
  data.samples[80]!.measurement!.cpu = null;
  data.samples[180]!.measurement!.cpu = null;
  await page.route("**/api/history", (route) => route.fulfill({ json: data }));
  await page.goto("/");
  const cpu = page.getByRole("img", { name: /^Average, minimum and maximum utilization/ });
  await expect(cpu.locator('[data-series="Average"]')).toHaveCount(2);
  await expect(page.locator(".cpu-legend b")).toHaveText(["—", "—", "—"]);
  await expect(page.locator("[data-layer]")).toHaveCount(7);
});
