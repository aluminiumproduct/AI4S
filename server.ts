import express from "express";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { createApiApp } from "./server/api";
import { createNetworkClient } from "./server/network";

dotenv.config();

async function startServer() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Invalid PORT");
  const network = createNetworkClient();
  const app = createApiApp({ network });
  const vite = process.env.NODE_ENV !== "production"
    ? await createViteServer({ server: {
      middlewareMode: true,
      hmr: process.env.DISABLE_HMR === "true" ? false : { host: "127.0.0.1" },
    }, appType: "spa" }) : null;
  if (vite) app.use(vite.middlewares);
  else app.use(express.static("dist"));

  const server = app.listen(port, "127.0.0.1", () => {
    console.log("Server running on http://127.0.0.1:" + port);
  });
  server.once("error", () => {
    console.error("Cannot start the local server. Check that the configured port is available.");
    network.close();
    void vite?.close();
    process.exitCode = 1;
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    network.close();
    server.close();
    server.closeIdleConnections();
    void vite?.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

startServer().catch(() => {
  console.error("Server startup failed. Check the configured port and installed dependencies.");
  process.exitCode = 1;
});
