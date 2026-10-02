import { expect, it } from "vitest";

import { classifyWeb } from "./web-processes.ts";

it("recognizes the observed production services, including Node processes named MainThread", () => {
  expect(classifyWeb("next-server (v1", ["next-server (v16.3.0)"])).toBe("next");
  expect(classifyWeb("node", ["node", "/app/workbench/shard-manager/src/server.ts"])).toBe(
    "shardManager",
  );
  expect(
    classifyWeb("MainThread", [
      "/usr/bin/node",
      "/app/workbench/collab-server/dist/server.js",
      "/workspace/project",
    ]),
  ).toBe("collaboration");
  expect(
    classifyWeb("MainThread", ["/app/vscode-server/lib/node", "/app/vscode-server/out/node/entry"]),
  ).toBe("vscode");
  expect(
    classifyWeb("MainThread", [
      "/app/vscode-server/lib/node",
      "--dns-result-order=ipv4first",
      "/app/vscode-server/lib/vscode/out/bootstrap-fork",
      "--type=extensionHost",
    ]),
  ).toBe("extensions");
  expect(
    classifyWeb("MainThread", [
      "/app/vscode-server/lib/node",
      "/app/vscode-server/lib/vscode/out/bootstrap-fork",
      "--type=fileWatcher",
    ]),
  ).toBe("watchers");
  expect(
    classifyWeb("MainThread", [
      "/app/vscode-server/lib/node",
      "/app/vscode-server/lib/vscode/extensions/json-language-features/server/dist/node/jsonServerMain",
      "--node-ipc",
    ]),
  ).toBe("languageServers");
  expect(classifyWeb("nginx", ["nginx: worker process"])).toBe("nginx");
});
it("leaves wrappers, arbitrary Node programs and Lean descendants out of the service group", () => {
  expect(
    classifyWeb("bwrap", [
      "bwrap",
      "--",
      "/usr/bin/node",
      "/app/workbench/collab-server/dist/server.js",
    ]),
  ).toBeNull();
  expect(
    classifyWeb("bash", ["bash", "-c", "node /app/workbench/shard-manager/src/server.ts"]),
  ).toBeNull();
  expect(
    classifyWeb("node", ["node", "arbitrary.js", "/app/vscode-server/out/node/entry"]),
  ).toBeNull();
  expect(
    classifyWeb("MainThread", ["/app/vscode-server/lib/node", "/workspace/user-script.js"]),
  ).toBeNull();
  expect(classifyWeb("lean", ["lean", "--worker", "file:///workspace/Main.lean"])).toBeNull();
  expect(classifyWeb("node", ["node", "src/server.ts"])).toBeNull();
});
