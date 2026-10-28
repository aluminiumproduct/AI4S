import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SurrogateModel } from "../../src/engine/SurrogateModel";
import { createSeededRandom } from "../../src/engine/SeededRandom";
import { compositionOf, configurationFeatures, validateConfiguration, validatePool, validateSettings } from "../../src/umlip/configurations";
import type { ConfigurationRecord, RelaxationResult, UmlipCapabilities, UmlipRun, UmlipSettings } from "../../src/umlip/types";
import { PythonMaceOracle, runtimeCapabilities, runtimeOptions, type RelaxationOracle } from "./oracle";

export interface UmlipServiceOptions {
  root: string;
  outputRoot?: string;
  env?: NodeJS.ProcessEnv;
  oracleFactory?: (outputRoot: string) => RelaxationOracle;
  surrogateFactory?: () => Pick<SurrogateModel, "train" | "predict">;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set(["converged", "unconverged", "failed", "cancelled"]);

/** Separate online minimization workflow. No uncomputed candidate has a target label. */
export class UmlipService {
  readonly outputRoot: string;
  private runs = new Map<string, UmlipRun>();
  private active?: { run: UmlipRun; controller: AbortController; oracle?: RelaxationOracle };
  private closed = false;
  constructor(private options: UmlipServiceOptions) {
    this.outputRoot = path.resolve(options.outputRoot ?? options.env?.UMLIP_OUTPUT_DIR ?? path.join(options.root, "umlip-results"));
    if (existsSync(this.outputRoot)) for (const id of readdirSync(this.outputRoot).slice(-100)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const run = JSON.parse(readFileSync(path.join(this.outputRoot, id, "run.json"), "utf8")) as UmlipRun;
        if (run.id !== id) continue;
        const interrupted = run.status === "running";
        if (interrupted) {
          run.status = "failed"; run.error = "服务已重启，先前计算已中断。请检查保留的轨迹后建立新运行。";
          run.finishedAt = new Date().toISOString();
          for (const c of run.candidates) if (c.status === "running") { c.status = "failed"; c.error = "Server restart interrupted calculation"; }
        }
        this.runs.set(id, run);
        if (interrupted) this.persist(run);
      } catch { /* incomplete/unrelated result directories are never treated as observations */ }
    }
  }
  capabilities(): UmlipCapabilities { return runtimeCapabilities(this.options.root, this.options.env); }
  list() { return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt, atomCount: r.atomCount, candidates: r.candidates.length, converged: r.candidates.filter(c => c.status === "converged").length })); }
  get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw Object.assign(new Error("找不到计算运行。"), { status: 404 });
    return structuredClone(run);
  }
  artifact(id: string, candidateId: string, filename: "POSCAR.relaxed" | "trajectory.jsonl") {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(candidateId)) throw Object.assign(new Error("Invalid candidate ID"), { status: 404 });
    const run = this.get(id);
    if (!run.candidates.some(c => c.id === candidateId)) throw Object.assign(new Error("Unknown candidate"), { status: 404 });
    const target = path.join(this.outputRoot, id, candidateId, filename);
    if (!existsSync(target)) throw Object.assign(new Error("尚无该输出文件。"), { status: 404 });
    return target;
  }
  start(inputs: unknown, settings: Partial<UmlipSettings> = {}) {
    if (this.closed || this.active) throw Object.assign(new Error("已有运行正在计算；请先取消或等待完成。"), { status: 409 });
    const pool = validatePool(inputs), config = validateSettings(settings, pool.length);
    const run: UmlipRun = { id: randomUUID(), status: "running", createdAt: new Date().toISOString(), wallSeconds: 0, surrogateSeconds: 0,
      atomCount: pool[0].structure.elements.length, composition: compositionOf(pool[0].structure), settings: config,
      descriptorVersion: "periodic-pair-rbf-v1", rounds: [], candidates: pool.map(c => ({ ...c, inputSha256: hash(c.structure), features: configurationFeatures(c.structure), status: "pending" })) };
    mkdirSync(this.outputRoot, { recursive: true });
    mkdirSync(path.join(this.outputRoot, run.id));
    this.runs.set(run.id, run); this.persist(run);
    const active = { run, controller: new AbortController(), oracle: undefined as RelaxationOracle | undefined };
    this.active = active;
    void this.execute(active);
    return this.get(run.id);
  }
  cancel(id: string) {
    const active = this.active;
    if (active?.run.id === id) {
      active.run.status = "cancelled"; active.run.finishedAt = new Date().toISOString();
      active.run.wallSeconds = Math.max(0, (Date.now() - Date.parse(active.run.createdAt)) / 1000);
      active.controller.abort(); active.oracle?.close();
      for (const c of active.run.candidates) if (c.status === "running") c.status = "cancelled";
      this.persist(active.run);
      this.active = undefined;
    }
    return this.get(id);
  }
  close() { this.closed = true; if (this.active) this.cancel(this.active.run.id); }
  private persist(run: UmlipRun) {
    if (run.status === "running") run.wallSeconds = Math.max(0, (Date.now() - Date.parse(run.createdAt)) / 1000);
    const target = path.join(this.outputRoot, run.id, "run.json");
    writeFileSync(target + ".tmp", JSON.stringify(run, null, 2)); renameSync(target + ".tmp", target);
  }
  private async chooseBatch(run: UmlipRun, random: () => number, count: number) {
    const pending = run.candidates.filter(c => c.status === "pending");
    const sampled = run.candidates.filter(c => c.status === "converged" && c.result);
    if (sampled.length < run.settings.initialSamples) {
      // Reference candidate first, then seeded coverage while there are too few observations.
      const available = pending.slice(), selected: ConfigurationRecord[] = [];
      if (!run.candidates.some(c => terminal.has(c.status))) selected.push(available.shift()!);
      while (selected.length < count && available.length) selected.push(...available.splice(Math.floor(random() * available.length), 1));
      return selected;
    }
    const start = performance.now();
    const surrogate = this.options.surrogateFactory?.() ?? new SurrogateModel({ kind: "gpr", seed: run.settings.seed });
    await surrogate.train(sampled.map(c => ({ features: c.features, trueProperty: -c.result!.energyPerAtomEv })));
      for (const c of pending) {
        const p = surrogate.predict({ features: c.features });
        const mean = -p.mean - run.reference!.energyPerAtomEv;
        c.prediction = { meanRelativeEvPerAtom: mean, sigmaEvPerAtom: p.std, lcbEvPerAtom: mean - 2 * p.std };
      }
      run.surrogateSeconds += (performance.now() - start) / 1000;
      return pending.sort((a, b) => a.prediction!.lcbEvPerAtom - b.prediction!.lcbEvPerAtom || a.id.localeCompare(b.id)).slice(0, count);
  }
  private accept(candidate: ConfigurationRecord, result: RelaxationResult, run: UmlipRun) {
    const s = validateConfiguration(result.structure), original = candidate.structure;
    if (JSON.stringify(s.elements) !== JSON.stringify(original.elements) || JSON.stringify(s.movable) !== JSON.stringify(original.movable)
      || s.cell.some((row, i) => row.some((x, j) => Math.abs(x - original.cell[i][j]) > 1e-9))) throw new Error("计算输出改变了元素、约束或固定晶胞。");
    for (const value of [result.energyEv, result.energyPerAtomEv, result.maxForceEvAngstrom, result.rawMaxForceEvAngstrom, result.elapsedSeconds]) {
      if (!Number.isFinite(value)) throw new Error("计算输出含非有限数值。");
    }
    if (Math.abs(result.energyEv / run.atomCount - result.energyPerAtomEv) > 1e-8 || result.elapsedSeconds < 0
      || result.maxForceEvAngstrom < 0 || result.rawMaxForceEvAngstrom < 0 || !Number.isInteger(result.steps) || result.steps < 0 || result.steps > run.settings.maxSteps) throw new Error("计算输出的单位、步数或耗时无效。");
    if (typeof result.converged !== "boolean" || !Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.finishedAt))) throw new Error("计算输出缺少明确的收敛状态或时间戳。");
    candidate.result = { ...result, structure: s };
    candidate.status = result.converged && result.maxForceEvAngstrom <= run.settings.fmax ? "converged" : "unconverged";
    if (candidate.status === "converged") {
      run.reference ??= { id: candidate.id, energyEv: result.energyEv, energyPerAtomEv: result.energyPerAtomEv };
      candidate.relativeEnergyEv = result.energyEv - run.reference.energyEv;
      candidate.relativeEnergyPerAtomEv = result.energyPerAtomEv - run.reference.energyPerAtomEv;
      run.bestRelativeEvPerAtom = Math.min(...run.candidates.filter(c => c.status === "converged").map(c => c.relativeEnergyPerAtomEv!));
    }
  }
  private async execute(active: NonNullable<UmlipService["active"]>) {
    const { run, controller } = active;
    const started = performance.now(), random = createSeededRandom(run.settings.seed);
    try {
      active.oracle = this.options.oracleFactory?.(path.join(this.outputRoot, run.id))
        ?? new PythonMaceOracle({ ...runtimeOptions(this.options.root, this.options.env), outputRoot: path.join(this.outputRoot, run.id) });
      const ready = await active.oracle.ready(); controller.signal.throwIfAborted();
      if (!/^[a-f0-9]{64}$/.test(ready.model.sha256) || !/^[a-f0-9]{64}$/.test(ready.model.runnerSha256)) throw new Error("模型或运行器缺少可验证的 SHA256。");
      run.model = ready.model; run.modelLoadSeconds = ready.loadSeconds; this.persist(run);
      let attempted = 0, round = 0;
      while (attempted < run.settings.budget && run.candidates.some(c => c.status === "pending")) {
        controller.signal.throwIfAborted(); round++;
        const count = Math.min(round === 1 ? run.settings.initialSamples : run.settings.batchSize, run.settings.budget - attempted);
        const batch = await this.chooseBatch(run, random, count); controller.signal.throwIfAborted();
        for (const candidate of batch) {
          controller.signal.throwIfAborted();
          candidate.status = "running"; candidate.round = round;
          candidate.selectionReason = candidate.prediction ? "minimum predicted energy − 2σ (LCB), converged observations only" : "reference / seeded initial sampling; no energy label available";
          this.persist(run); attempted++;
          try {
            let lastWrite = 0;
            const result = await active.oracle.relax(candidate, run.settings, progress => {
              if (controller.signal.aborted || run.status !== "running" || candidate.status !== "running") return;
              if (![progress.energyEv, progress.maxForceEvAngstrom, progress.elapsedSeconds, progress.step].every(Number.isFinite)
                || progress.maxForceEvAngstrom < 0 || progress.elapsedSeconds < 0 || !Number.isInteger(progress.step) || progress.step < 0 || progress.step > run.settings.maxSteps
                || !Array.isArray(progress.fractional) || progress.fractional.length !== run.atomCount
                || progress.fractional.some(row => !Array.isArray(row) || row.length !== 3 || row.some(x => !Number.isFinite(x)))) return;
              candidate.progress = progress;
              if (Date.now() - lastWrite > 200) { lastWrite = Date.now(); this.persist(run); }
            }, controller.signal);
            controller.signal.throwIfAborted(); this.accept(candidate, result, run);
          } catch (error) {
            if (controller.signal.aborted) { candidate.status = "cancelled"; throw error; }
            candidate.status = "failed"; candidate.error = error instanceof Error ? error.message : "Calculation failed";
          }
          this.persist(run);
        }
        run.rounds.push({ round, evaluated: attempted, converged: run.candidates.filter(c => c.status === "converged").length, bestRelativeEvPerAtom: run.bestRelativeEvPerAtom ?? null });
        this.persist(run);
      }
      controller.signal.throwIfAborted();
      run.status = run.reference ? "completed" : "failed";
      if (!run.reference) run.error = "所有已尝试构型均未通过收敛验收；未生成相对能标签或有效训练集。";
    } catch (error) {
      if (!controller.signal.aborted) { run.status = "failed"; run.error = error instanceof Error ? error.message : "MACE run failed"; }
    } finally {
      active.oracle?.close();
      run.finishedAt ??= new Date().toISOString(); run.wallSeconds = (performance.now() - started) / 1000;
      this.persist(run); if (this.active === active) this.active = undefined;
    }
  }
}
