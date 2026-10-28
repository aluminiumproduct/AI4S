import express from "express";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { NetworkClient } from "./network";
import { isMaterialId } from "../src/structures/materialStructure";
import type { PreflightResult } from "../src/synthesis/types";

interface Dependencies { network: NetworkClient; env: Record<string, string | undefined>; materialsEndpoint: string }

interface Job { complete(error?: Error, result?: unknown): void }
let engine: ChildProcessWithoutNullStreams | null = null;
let queue: Job[] = [];
export function closeSynthesisEngine() {
  const child = engine; engine = null;
  for (const job of queue.splice(0)) job.complete(new Error("计算引擎已停止"));
  child?.kill();
}
process.once("exit", () => engine?.kill());

function scientificEngine() {
  if (engine) return engine;
  const local = path.resolve(".venv/bin/python");
  const python = process.env.AI4S_PYTHON || (existsSync(local) ? local : "python3");
  const child = spawn(python, ["-u", path.resolve("scripts/synthesis_engine.py")], { stdio: ["pipe", "pipe", "pipe"] });
  engine = child;
  let buffer = "", stderr = "";
  child.stdout.on("data", chunk => {
    if (engine !== child) return;
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline+1);
      const job = queue.shift();
      try { const result = JSON.parse(line); job?.complete(result.error ? new Error(result.error) : undefined, result); }
      catch { job?.complete(new Error("计算结果无法读取")); }
    }
  });
  child.stderr.on("data", chunk => { stderr = (stderr+chunk).slice(-2000); });
  const failed = () => {
    if (engine !== child) return;
    engine = null;
    const message = stderr.includes("ModuleNotFoundError") ? "请先运行 npm run setup:synthesis 安装计算依赖" : "计算引擎已退出，请重试";
    for (const job of queue.splice(0)) job.complete(new Error(message));
  };
  child.on("error", failed); child.on("close", failed); child.stdin.on("error", () => {});
  return child;
}

export function runSynthesis(operation: string, payload: object, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = scientificEngine();
    let finished = false;
    const job: Job = { complete(error, result) {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    } };
    const abort = () => job.complete(new Error("计算已取消"));
    const timer = setTimeout(() => { job.complete(new Error("计算超时，请使用较小的晶胞")); closeSynthesisEngine(); }, 45_000);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    queue.push(job); child.stdin.write(JSON.stringify({ ...payload, operation })+"\n");
  });
}

export function demoPreflight(composition: Record<string, number>, temperature = 900, atmosphere = "air", hull?: number): PreflightResult {
  const elements = Object.keys(composition).filter(el => composition[el] > 0);
  const seed = elements.sort().join("").split("").reduce((n, ch) => n + ch.charCodeAt(0), 0);
  const estimated = hull ?? (elements.includes("Sr") && elements.includes("Ti") ? .008 : .008 + (seed % 110) / 1000);
  const atmospherePenalty = atmosphere === "reducing" && elements.includes("O") ? 16 : 0;
  const temperaturePenalty = temperature < 600 ? 12 : temperature > 1300 ? 9 : 0;
  const score = Math.max(8, Math.min(98, Math.round(98-estimated*330-atmospherePenalty-temperaturePenalty)));
  const grade = score >= 80 ? "A" : score >= 55 ? "B" : "C";
  const oxides: Record<string, string> = { Sr: "SrO", Ti: "TiO₂", Ba: "BaO", Zr: "ZrO₂", La: "La₂O₃", Fe: "Fe₂O₃", Co: "CoO", Li: "Li₂O", Zn: "ZnO", Cu: "CuO", Al: "Al₂O₃", Mg: "MgO", Ca: "CaO" };
  return { grade, label: { A: "易合成 · 优先验证", B: "亚稳态 · 工艺可调", C: "高分相风险" }[grade], score,
    energyAboveHull: estimated, formationEnergy: null, source: hull === undefined ? "demo" : "materials-project", temperature, atmosphere,
    competitors: elements.filter(el => oxides[el]).map(el => ({ formula: oxides[el], role: "候选竞争相" })),
    factors: [{ name: "热力学稳定性", score: Math.max(5, Math.round(100-estimated*500)) },
      { name: "烧结窗口", score: 94-temperaturePenalty*2 }, { name: "气氛适配", score: 96-atmospherePenalty*3 }] };
}

export function createSynthesisRouter({ network, env, materialsEndpoint }: Dependencies) {
  const router = express.Router();
  router.use(express.json({ limit: "8mb" }));
  const cache = new Map<string, Promise<unknown>>();
  router.post("/preflight", async (req, res) => {
    try {
      const { composition, temperature = 900, atmosphere = "air", materialId } = req.body;
      if (!composition || !Object.keys(composition).length) return res.status(400).json({ error: "请选择材料组成" });
      let hull: number | undefined, formation: number | null = null;
      const key = env.MP_API_KEY?.trim();
      if (key && !/^YOUR_|^你的/.test(key) && isMaterialId(materialId)) {
        try {
          const response = await network.request<{ data: any[] }>({ url: materialsEndpoint, signal: AbortSignal.timeout(8000),
            headers: { accept: "application/json", "X-API-KEY": key },
            params: { material_ids: materialId, _limit: 1, _fields: "material_id,energy_above_hull,formation_energy_per_atom" } });
          const row = response.data?.data?.[0];
          if (response.status === 200 && row?.material_id === materialId && Number.isFinite(row.energy_above_hull)) {
            hull = row.energy_above_hull; formation = Number.isFinite(row.formation_energy_per_atom) ? row.formation_energy_per_atom : null;
          }
        } catch { /* The interactive demo remains available without a database connection. */ }
      }
      res.json({ ...demoPreflight(composition, Number(temperature), atmosphere, hull), formationEnergy: formation });
    } catch { res.status(400).json({ error: "预审参数无效" }); }
  });
  for (const operation of ["xrd", "compare", "demo"]) router.post(`/${operation}`, async (req, res) => {
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", closed);
    try {
      if (operation === "xrd" && !req.body?.structure?.sites?.length) return res.status(400).json({ error: "需要晶体结构" });
      const key = createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
      let result: unknown;
      if (operation === "xrd") {
        let pending = cache.get(key);
        if (!pending) {
          pending = runSynthesis(operation, req.body);
          cache.set(key, pending);
          pending.catch(() => cache.delete(key));
          if (cache.size > 24) cache.delete(cache.keys().next().value!);
        }
        result = await pending;
      } else result = await runSynthesis(operation, req.body, controller.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) { if (!res.destroyed) res.status(422).json({ error: error instanceof Error ? error.message : "分析失败" }); }
    finally { res.off("close", closed); }
  });
  router.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error?.status === 413 ? 413 : 400).json({ error: "谱图或结构文件过大，或数据格式有误" });
  });
  return router;
}
