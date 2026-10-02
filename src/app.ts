import * as path from "node:path";

import express from "express";

import type { Monitor } from "./monitor.ts";

export function createApp(monitor: Monitor, production = false) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/api/history", (_req, res) => {
    res.set("Cache-Control", "no-store").json(monitor.snapshot());
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  if (production) {
    app.use(express.static(path.join(import.meta.dirname, "../frontend/dist")));
    app.get("/", (_req, res) =>
      res.sendFile(path.join(import.meta.dirname, "../frontend/dist/index.html")),
    );
  } else {
    app.get("/", (_req, res) =>
      res.send("Watchapus dashboard API. Open the Vite frontend during development."),
    );
  }
  return app;
}
