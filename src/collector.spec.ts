import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classify, collect, memoryFields, startTime } from "./collector.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "watchapus-proc-"));
  roots.push(root);
  await writeFile(
    join(root, "meminfo"),
    "MemTotal:       10000 kB\nMemFree:         2000 kB\nCached: 4000 kB\nSwapTotal: 9000 kB\n",
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
    expect(sample.other).toBe(6000 * 1024);
    expect(sample.used).toBe(8000 * 1024);
    expect(
      sample.filePss +
        sample.other +
        [sample.groups.watchdog, sample.groups.worker].reduce((n, g) => n + g.nonFilePss, 0),
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
    expect(sample.other).toBe(sample.used);
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
