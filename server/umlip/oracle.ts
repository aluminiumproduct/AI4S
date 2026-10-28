import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ConfigurationInput, RelaxationProgress, RelaxationResult, UmlipModel, UmlipSettings, UmlipCapabilities } from "../../src/umlip/types";
import { UMLIP_LIMITS } from "../../src/umlip/configurations";

export interface RelaxationOracle {
  ready(): Promise<{ model: UmlipModel; loadSeconds: number }>;
  relax(candidate: ConfigurationInput, settings: UmlipSettings, progress: (p: RelaxationProgress) => void, signal: AbortSignal): Promise<RelaxationResult>;
  close(): void;
}
export interface OracleOptions {
  python: string;
  modelPath: string;
  scriptPath: string;
  outputRoot: string;
  threads: number;
  startupTimeoutMs?: number;
  calculationTimeoutMs?: number;
}
export function runtimeOptions(root: string, env = process.env) {
  const localPython = path.join(root, ".venv-umlip/bin/python");
  return { python: env.UMLIP_PYTHON || (existsSync(localPython) ? localPython : "python3"),
    modelPath: env.UMLIP_MODEL_PATH || path.join(homedir(), ".cache/mace/macempa0mediummodel"),
    scriptPath: path.join(root, "scripts/umlip_worker.py"),
    threads: Math.max(1, Math.min(8, Number(env.UMLIP_THREADS) || 2)) };
}
export function runtimeCapabilities(root: string, env = process.env): UmlipCapabilities {
  const options = runtimeOptions(root, env), configured = existsSync(options.modelPath) && existsSync(options.scriptPath);
  return { configured, modelLabel: path.basename(options.modelPath) === "macempa0mediummodel" ? "MACE-MPA-0 medium · CPU/float64" : "MACE local checkpoint · CPU/float64",
    message: configured ? "检测到本地权重；启动时验证 Python 依赖及模型元素支持。" : "未找到本地 MACE 权重。请配置 UMLIP_MODEL_PATH 与 UMLIP_PYTHON；不会回退为模拟计算。",
    limits: UMLIP_LIMITS };
}
const aborted = () => Object.assign(new Error("Calculation cancelled"), { name: "AbortError" });

/** One process/model per run; all candidates reuse it. No shell, client-supplied paths or downloads. */
export class PythonMaceOracle implements RelaxationOracle {
  private child: ChildProcessWithoutNullStreams;
  private readiness: Promise<{ model: UmlipModel; loadSeconds: number }>;
  private pending?: { id: string; progress(p: RelaxationProgress): void; resolve(r: RelaxationResult): void; reject(e: Error): void; cleanup(): void };
  private closed = false;
  constructor(private options: OracleOptions) {
    if (!existsSync(options.modelPath)) throw new Error("MACE checkpoint missing; configure UMLIP_MODEL_PATH.");
    this.child = spawn(options.python, [options.scriptPath, "--model-path", options.modelPath, "--output-root", options.outputRoot, "--threads", String(options.threads)], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1", OMP_NUM_THREADS: String(options.threads), MKL_NUM_THREADS: String(options.threads) },
    });
    // Third-party logging never shares the JSON protocol or becomes a fabricated model result.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", error => this.finish(error));
    this.readiness = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Model loading exceeded its 120-second limit.")); this.close(); }, options.startupTimeoutMs ?? 120_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); this.finish(error); this.close(); };
      this.child.once("error", error => fail(new Error(`Python runtime could not start: ${error.message}`)));
      this.child.once("exit", (code, signal) => fail(new Error(`MACE worker exited (${signal ?? code}); check Python dependencies and checkpoint compatibility.`)));
      const lines = createInterface({ input: this.child.stdout });
      lines.on("line", line => {
        if (this.closed) return;
        let message: any;
        try { if (line.length > 256_000) throw new Error("Oversized worker message"); message = JSON.parse(line); }
        catch { return; }
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve({ model: message.model, loadSeconds: message.loadSeconds });
        } else if (message.type === "fatal") {
          fail(new Error(String(message.error).slice(0, 600))); this.close();
        } else if (this.pending && message.id === this.pending.id) {
          if (message.type === "progress") this.pending.progress(message.progress);
          else if (message.type === "result") {
            const current = this.pending; this.pending = undefined; current.cleanup(); current.resolve(message.result);
          } else if (message.type === "error") this.finish(new Error(String(message.error).slice(0, 600)));
        }
      });
    });
  }
  ready() { return this.readiness; }
  async relax(candidate: ConfigurationInput, settings: UmlipSettings, progress: (p: RelaxationProgress) => void, signal: AbortSignal) {
    await this.ready();
    signal.throwIfAborted();
    if (this.closed || this.pending) throw new Error("MACE worker unavailable or busy");
    return new Promise<RelaxationResult>((resolve, reject) => {
      const abort = () => { this.finish(aborted()); this.close(); };
      const timer = setTimeout(() => { this.finish(new Error("Relaxation exceeded its 180-second limit.")); this.close(); }, this.options.calculationTimeoutMs ?? 180_000);
      this.pending = { id: candidate.id, progress, resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } };
      signal.addEventListener("abort", abort, { once: true });
      const { id, name, source, structure } = candidate;
      this.child.stdin.write(JSON.stringify({ candidate: { id, name, source, structure }, settings }) + "\n", error => { if (error) this.finish(error); });
    });
  }
  private finish(error: Error) {
    const current = this.pending;
    this.pending = undefined;
    if (current) { current.cleanup(); current.reject(error); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.finish(aborted());
    this.child.stdin.end(); this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 1000);
    timer.unref();
  }
}
