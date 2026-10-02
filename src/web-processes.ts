import { basename } from "node:path";

import type { WebGroup } from "../shared/metrics.ts";

// Recognize the production commands observed on the Workbench host. Do not classify
// shell/bwrap launchers from embedded command strings or arbitrary Node applications.
export function classifyWeb(comm: string, args: string[]): WebGroup | null {
  if (comm === "nginx") return "nginx";
  if (comm.startsWith("next-server") && /^next-server(?:\s|$)/.test(args[0] ?? "")) return "next";
  const executable = basename(args[0] ?? "");
  if (executable !== "node" && executable !== "nodejs") return null;
  // Production Node switches here use --flag=value. Unrecognized launcher layouts
  // remain in Other instead of guessing based on a later argument's path.
  const script = args.slice(1).find((arg) => !arg.startsWith("-")) ?? "";
  if (/(?:^|\/)shard-manager\/(?:src\/server\.ts|dist\/server\.js)$/.test(script))
    return "shardManager";
  if (/(?:^|\/)collab-server\/(?:src\/server\.ts|dist\/server\.js)$/.test(script))
    return "collaboration";
  if (script.endsWith("/next/dist/bin/next") && (args.includes("start") || args.includes("dev")))
    return "next";
  // This installation root is intentionally specific; it is not a generic match
  // for every process using Node, nor every descendant of an editor.
  if (script !== "/app/vscode-server" && !script.startsWith("/app/vscode-server/")) return null;
  if (script.endsWith("/bootstrap-fork")) {
    if (args.includes("--type=extensionHost")) return "extensions";
    if (args.includes("--type=fileWatcher")) return "watchers";
  }
  if (script.includes("/extensions/") && args.includes("--node-ipc")) return "languageServers";
  return "vscode";
}
