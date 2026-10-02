import { createApp } from "./app.ts";
import { Monitor } from "./monitor.ts";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer from 1 to 65535");
const monitor = new Monitor();
const app = createApp(monitor, process.env.NODE_ENV === "production");
const server = app.listen(port, process.env.HOST ?? "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ version: 1, event: "listening", port })}\n`);
  monitor.start();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    monitor.stop();
    server.close();
    server.closeIdleConnections();
  });
}
