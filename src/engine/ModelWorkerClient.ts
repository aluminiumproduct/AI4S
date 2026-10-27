import type { FeaturePoint, ModelDiagnostics, TrainingPoint } from "./SurrogateModel";
import { modelConfig, type ModelConfig } from "./models/config";
import type { Prediction } from "./models/regressors";

export type ModelRequest = { id: number; operation: "train"; config: ModelConfig; data: TrainingPoint[] }
  | { id: number; operation: "predict"; data: FeaturePoint[] };
export type ModelResponse = { id: number; error: string } | { id: number; result: { predictions?: Prediction[]; diagnostics: ModelDiagnostics } };
export interface ModelWorker {
  onmessage: ((event: { data: ModelResponse }) => void) | null;
  onerror: ((event: { preventDefault?: () => void }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: ModelRequest): void;
  terminate(): void;
}
type Pending = { resolve(value: Extract<ModelResponse, { result: unknown }>["result"]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class ModelWorkerClient {
  private worker?: ModelWorker;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  diagnostics?: ModelDiagnostics;
  readonly config: ModelConfig;

  constructor(config: Partial<ModelConfig> = {},
    private factory: () => ModelWorker = () => new Worker(new URL("../workers/surrogate.worker.ts", import.meta.url), { type: "module" }),
    private timeoutMs = 30_000) { this.config = modelConfig(config); }

  async train(data: TrainingPoint[]): Promise<void> {
    const result = await this.request({ operation: "train", config: this.config,
      data: data.map(point => ({ features: point.features, trueProperty: point.trueProperty })) });
    this.diagnostics = result.diagnostics;
  }
  async predictBatch(data: FeaturePoint[]): Promise<Prediction[]> {
    // Candidate labels, costs and metadata never cross the model's prediction boundary.
    const result = await this.request({ operation: "predict", data: data.map(point => ({ features: point.features })) });
    if (!Array.isArray(result.predictions)) throw new Error("Invalid prediction response");
    this.diagnostics = result.diagnostics;
    return result.predictions;
  }
  cancel(error: Error = new DOMException("Model computation cancelled", "AbortError")) {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = undefined;
    this.diagnostics = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  dispose() { this.cancel(); }

  private request(message: Omit<Extract<ModelRequest, { operation: "train" }>, "id"> | Omit<Extract<ModelRequest, { operation: "predict" }>, "id">) {
    if (!this.worker) {
      try { this.worker = this.factory(); }
      catch { return Promise.reject(new Error("Model Worker unavailable; use a modern browser over localhost or HTTPS")); }
      const activeWorker = this.worker;
      activeWorker.onmessage = ({ data }) => {
        if (this.worker !== activeWorker) return;
        const request = this.pending.get(data.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(data.id);
        if ("error" in data) request.reject(new Error(data.error)); else request.resolve(data.result);
      };
      activeWorker.onerror = event => {
        if (this.worker !== activeWorker) return;
        event.preventDefault?.(); this.cancel(new Error("Model Worker failed"));
      };
      activeWorker.onmessageerror = () => {
        if (this.worker === activeWorker) this.cancel(new Error("Model Worker response could not be read"));
      };
    }
    const id = ++this.sequence;
    return new Promise<Extract<ModelResponse, { result: unknown }>["result"]>((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(new Error("Model computation exceeded 30 seconds; reduce the workload")), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker!.postMessage({ ...message, id } as ModelRequest); }
      catch { this.cancel(new Error("Could not send data to Model Worker")); }
    });
  }
}
