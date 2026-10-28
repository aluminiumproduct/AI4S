import type { DistillationOptions, DistillationResult, DistillationSnapshot } from "./types";

export interface DistillationWorker {
  onmessage: ((event: { data: { id: number; result?: DistillationResult; error?: string } }) => void) | null;
  onerror: ((event: { preventDefault?: () => void }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: { id: number; snapshot: DistillationSnapshot; options: DistillationOptions }): void;
  terminate(): void;
}
export class DistillationWorkerClient {
  private worker?: DistillationWorker;
  private pending?: { reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private sequence = 0;
  constructor(private factory: () => DistillationWorker = () => new Worker(new URL("../../workers/distillation.worker.ts", import.meta.url), { type: "module" }),
    private timeoutMs = 40_000) {}

  run(snapshot: DistillationSnapshot, options: DistillationOptions): Promise<DistillationResult> {
    this.cancel();
    let worker: DistillationWorker;
    try { worker = this.factory(); }
    catch { return Promise.reject(new Error("无法启动公式 Worker，请使用 localhost 或 HTTPS 浏览器")); }
    this.worker = worker;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(new Error("公式搜索超过 40 秒，请降低搜索规模")), this.timeoutMs);
      this.pending = { reject, timer };
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker || data.id !== id) return;
        if (data.result && data.result.snapshotId !== snapshot.id) return;
        clearTimeout(timer); this.pending = undefined;
        worker.terminate(); this.worker = undefined;
        if (data.error) reject(new Error(data.error));
        else if (data.result) resolve(data.result);
        else reject(new Error("公式 Worker 返回无效结果"));
      };
      worker.onerror = event => { if (this.worker === worker) { event.preventDefault?.(); this.cancel(new Error("公式 Worker 计算失败")); } };
      worker.onmessageerror = () => { if (this.worker === worker) this.cancel(new Error("无法读取公式 Worker 响应")); };
      try { worker.postMessage({ id, snapshot, options }); }
      catch { this.cancel(new Error("无法发送公式计算快照")); }
    });
  }
  cancel(error: Error = new DOMException("公式计算已取消", "AbortError")) {
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = undefined;
    }
    if (this.pending) {
      clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined;
    }
  }
  dispose() { this.cancel(); }
}
