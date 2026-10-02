import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classify, collect, createCollector, memoryFields, startTime } from "./collector.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "watchapus-proc-"));
  roots.push(root);
  await writeFile(
    join(root, "meminfo"),
    "MemTotal:       10000 kB\nMemFree:         2000 kB\nCached: 4000 kB\nSwapTotal: 9000 kB\nSwapFree: 4000 kB\nPageTables: 100 kB\nSecPageTables: 50 kB\nSlab: 300 kB\nSReclaimable: 200 kB\nSUnreclaim: 100 kB\nKernelStack: 20 kB\nPercpu: 10 kB\n",
  );
  return root;
}
async function processFixture(
  root: string,
  pid: number,
  comm: string,
  args: string[],
  pss: number,
  file: number,
  rss = pss,
) {
  const dir = join(root, String(pid));
  await mkdir(dir);
  await Promise.all([
    writeFile(join(dir, "comm"), `${comm}\n`),
    writeFile(join(dir, "cmdline"), args.join("\0") + "\0"),
    writeFile(join(dir, "stat"), `${pid} (${comm}) S ${Array(18).fill("0").join(" ")} 123456 0`),
    writeFile(
      join(dir, "smaps_rollup"),
      `Rss: ${rss} kB\nPss: ${pss} kB\nPss_File: ${file} kB\nSwap: 5000 kB\n`,
    ),
  ]);
}

describe("Linux memory accounting", () => {
  it("attributes shared file pages proportionally, includes all lake/lean categories and retains cache in total", async () => {
    const root = await fixture();
    // Two workers share 1000 KiB: each gets 500 KiB PSS, but 1000 KiB RSS.
    await processFixture(
      root,
      1,
      "lean",
      ["/opt/lean", "--worker", "file:///a.lean"],
      700,
      500,
      1200,
    );
    await processFixture(root, 2, "lean", ["lean", "--worker", "file:///b.lean"], 800, 500, 1300);
    await processFixture(root, 3, "lean", ["lean", "-Dfoo=true", "--server"], 300, 100, 500);
    await processFixture(root, 4, "lake", ["lake", "build"], 150, 50, 200);
    await processFixture(root, 5, "lean", ["lean", "Main.lean"], 350, 150, 450);
    await processFixture(root, 6, "bash", ["bash", "-c", "lean --worker"], 9999, 9999);
    const sample = await collect(root);
    expect(sample.groups.worker).toEqual({
      count: 2,
      rss: 2500 * 1024,
      pss: 1500 * 1024,
      filePss: 1000 * 1024,
      nonFilePss: 500 * 1024,
      nonFileStats: { average: 250 * 1024, min: 200 * 1024, max: 300 * 1024 },
    });
    expect(sample.filePss).toBe(1300 * 1024);
    expect(sample.other).toBe(5420 * 1024);
    expect(sample.pageTables).toBe(150 * 1024);
    expect(sample.otherSystem).toBe(330 * 1024);
    expect(sample.used).toBe(8000 * 1024);
    expect(sample.swapUsed).toBe(5000 * 1024);
    expect(
      sample.pageTables +
        sample.otherSystem +
        sample.webPss +
        sample.filePss +
        sample.other +
        [sample.groups.watchdog, sample.groups.worker, sample.groups.lake].reduce(
          (n, g) => n + g.nonFilePss,
          0,
        ),
    ).toBe(sample.used);
    expect(sample.groups.lake.count).toBe(1);
    expect(sample.groups.watchdog.count).toBe(1);
    expect(sample.groups.watchdog.nonFileStats).toEqual({
      average: 200 * 1024,
      min: 200 * 1024,
      max: 200 * 1024,
    });
    expect(sample.groups.otherLean.count).toBe(1);
  });
  it("tolerates disappearing processes without losing the host sample", async () => {
    const root = await fixture();
    await mkdir(join(root, "42"));
    const sample = await collect(root);
    expect(sample.vanished).toBe(1);
    expect(sample.other + sample.pageTables + sample.otherSystem).toBe(sample.used);
    expect(sample.groups.worker.nonFileStats).toBeNull();
  });
  it("fails visibly on missing accounting fields rather than inventing zero usage", async () => {
    const root = await fixture();
    await processFixture(root, 1, "lean", ["lean", "--server"], 200, 100);
    await writeFile(join(root, "1", "smaps_rollup"), "Rss: 500 kB\nPss: 200 kB\n");
    await expect(collect(root)).rejects.toThrow("Pss_File");
  });
  it("rejects impossible totals rather than silently clamping the other layer", async () => {
    const root = await fixture();
    await processFixture(root, 1, "lean", ["lean"], 9000, 1000);
    await expect(collect(root)).rejects.toThrow("exceeds used RAM");
  });
  it("uses exact flags and does not classify filename substrings as roles", () => {
    expect(classify("lean", ["lean", "/tmp/--worker.lean"])).toBe("otherLean");
    expect(classify("lean", ["lean", "--", "--server"])).toBe("otherLean");
    expect(classify("bash", ["bash", "lean --server"])).toBeNull();
    expect(startTime(`1 (lean ) test) S ${Array(18).fill("0").join(" ")} 123456 0`)).toBe("123456");
    expect(memoryFields("Pss_File: 123 kB\n").get("Pss_File")).toBe(123 * 1024);
  });
});

it("splits web PSS and kernel allocations out of Other exactly once", async () => {
  const root = await fixture();
  await processFixture(root, 1, "lean", ["lean", "--worker"], 800, 500, 1500);
  await processFixture(
    root,
    2,
    "MainThread",
    [
      "/app/vscode-server/lib/node",
      "/app/vscode-server/lib/vscode/out/bootstrap-fork",
      "--type=extensionHost",
    ],
    300,
    100,
    600,
  );
  await processFixture(root, 3, "next-server (v1", ["next-server (v16.3.0)"], 200, 50, 350);
  await processFixture(root, 4, "nginx", ["nginx: worker process"], 100, 50, 150);
  await processFixture(
    root,
    5,
    "bwrap",
    ["bwrap", "--", "node", "/app/vscode-server/out/node/entry"],
    9999,
    9999,
  );
  await processFixture(root, 6, "node", ["node", "/some/app.js"], 9999, 9999);
  const sample = await collect(root);
  expect(sample.webPss).toBe(600 * 1024);
  expect(sample.webGroups.extensions).toEqual({
    count: 1,
    pss: 300 * 1024,
    filePss: 100 * 1024,
    rss: 600 * 1024,
  });
  expect(sample.filePss).toBe(500 * 1024); // web file pages stay entirely in webPss
  expect(sample.other).toBe((8000 - 800 - 600 - 150 - 330) * 1024);
  expect(
    sample.pageTables +
      sample.filePss +
      sample.groups.watchdog.nonFilePss +
      sample.groups.worker.nonFilePss +
      sample.webPss +
      sample.otherSystem +
      sample.other,
  ).toBe(sample.used);
});
it("supports kernels without the optional secondary-page-table and per-CPU fields", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "meminfo"),
    "MemTotal: 10000 kB\nMemFree: 2000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\nPageTables: 100 kB\nSlab: 300 kB\nSReclaimable: 200 kB\nSUnreclaim: 100 kB\nKernelStack: 20 kB\n",
  );
  const sample = await collect(root);
  expect(sample.pageTables).toBe(100 * 1024);
  expect(sample.otherSystem).toBe(320 * 1024);
  expect(sample.swapUsed).toBe(0);
});
it("does not fabricate an empty kernel layer when required meminfo fields are absent", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "meminfo"),
    "MemTotal: 10000 kB\nMemFree: 2000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
  );
  await expect(collect(root)).rejects.toThrow("PageTables");
});
it("discards samples where kernel plus process accounting exceeds total used RAM", async () => {
  const root = await fixture();
  await processFixture(root, 1, "lean", ["lean", "--worker"], 7900, 1000);
  await expect(collect(root)).rejects.toThrow("exceeds used RAM");
});

it("keeps independent CPU baselines per collector and includes interval statistics", async () => {
  const root = await fixture();
  const collectA = createCollector(root);
  const collectB = createCollector(root);
  await writeFile(join(root, "stat"), "cpu0 10 0 0 90 0 0 0 0\n");
  expect((await collectA()).cpu).toBeNull();
  await writeFile(join(root, "stat"), "cpu0 40 0 0 160 0 0 0 0\n");
  expect((await collectA()).cpu).toEqual({ count: 1, average: 30, min: 30, max: 30 });
  expect((await collectB()).cpu).toBeNull();
});

it("rejects missing or inconsistent swap counters", async () => {
  const root = await fixture();
  const file = join(root, "meminfo");
  const meminfo = await readFile(file, "utf8");
  await writeFile(file, meminfo.replace("SwapFree: 4000 kB", "SwapFree: 10000 kB"));
  await expect(collect(root)).rejects.toThrow("Inconsistent procfs swap fields");
  await writeFile(file, meminfo.replace("SwapFree: 4000 kB\n", ""));
  await expect(collect(root)).rejects.toThrow("SwapFree");
});
