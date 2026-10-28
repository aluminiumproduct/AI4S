import express, { type NextFunction, type Request, type Response } from "express";
import type { UmlipService } from "./service";

export function umlipRouter(service: UmlipService) {
  const router = express.Router();
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    let sameOrigin = true;
    try { if (origin) sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(req.hostname) || !sameOrigin) return res.status(403).json({ error: "uMLIP 计算接口仅供本机同源访问。", service: "umlip" });
    next();
  });
  router.use(express.json({ limit: "2mb" }));
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/capabilities", (_req, res) => res.json(service.capabilities()));
  router.get("/runs", (_req, res) => res.json(service.list()));
  router.post("/runs", (req, res, next) => { try { res.status(202).json(service.start(req.body?.candidates, req.body?.settings)); } catch (e) { next(e); } });
  router.get("/runs/:id", (req, res, next) => { try { res.json(service.get(req.params.id)); } catch (e) { next(e); } });
  router.post("/runs/:id/cancel", (req, res, next) => { try { res.json(service.cancel(req.params.id)); } catch (e) { next(e); } });
  router.get("/runs/:id/candidates/:candidateId/:artifact", (req, res, next) => {
    try {
      const name = req.params.artifact === "poscar" ? "POSCAR.relaxed" : req.params.artifact === "trajectory" ? "trajectory.jsonl" : null;
      if (!name) return res.sendStatus(404);
      res.download(service.artifact(req.params.id, req.params.candidateId, name), name);
    } catch (e) { next(e); }
  });
  router.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error?.status === 413 ? 413 : error?.status === 409 ? 409 : error?.status === 404 ? 404 : 400)
      .json({ error: error instanceof Error ? error.message.slice(0, 600) : "uMLIP request failed", service: "umlip" });
  });
  return router;
}
