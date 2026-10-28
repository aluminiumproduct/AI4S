import express from "express";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { createApiApp } from "./server/api";
import { createNetworkClient } from "./server/network";
import { UmlipService } from "./server/umlip/service";

dotenv.config();
dotenv.config({ path: ".env.umlip.local" });

async function startServer() {
  const network = createNetworkClient();
  const umlip = new UmlipService({ root: process.cwd(), env: process.env });
  const app = createApiApp({ network, umlip });
  const port = Number(process.env.PORT || 3000);
  const vite = process.env.NODE_ENV !== "production"
    ? await createViteServer({ server: {
      middlewareMode: true,
      hmr: process.env.DISABLE_HMR === "true" ? false : { host: "127.0.0.1" },
    }, appType: "spa" }) : null;
  if (vite) app.use(vite.middlewares);
  else app.use(express.static("dist"));

  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Server running on http://127.0.0.1:${port}`);
  });
  server.once("error", () => {
    console.error("Cannot start the local server. Check that port 3000 is available.");
    network.close();
    umlip.close();
    void vite?.close();
    process.exitCode = 1;
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    network.close();
    umlip.close();
    server.close();
    server.closeIdleConnections();
    void vite?.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

startServer().catch(() => {
  console.error("Server startup failed. Check that port 3000 is available and dependencies are installed.");
  process.exitCode = 1;
});
