import { MODEL_CATALOG, MODEL_LIMITS, modelConfig, type ModelConfig } from "./models/config";
import { mean, seededRandom } from "./models/math";
import { ensemble, gaussianProcess, gradientBoosting, knn, linearSGD, regressionTree, ridge, type Prediction, type Regressor } from "./models/regressors";

export type TrainingPoint = { features: number[]; trueProperty: number };
export type FeaturePoint = { features: number[] };
export interface ModelDiagnostics {
  kind: ModelConfig["kind"];
  samples: number;
  dimensions: number;
  trainMs: number;
  predictMs: number;
  uncertainty: "gp" | "trees" | "bootstrap";
  lengthScale?: number;
}

/** Numerical core. Browser callers use ModelWorkerClient to keep computation off the UI thread. */
export class SurrogateModel {
  readonly config: ModelConfig;
  private predictStandardized?: (x: number[]) => Prediction;
  private centers: number[] = [];
  private scales: number[] = [];
  private targetCenter = 0;
  private targetScale = 1;
  diagnostics?: ModelDiagnostics;

  constructor(config: Partial<ModelConfig> = {}) { this.config = modelConfig(config); }

  async train(data: TrainingPoint[]): Promise<void> {
    this.predictStandardized = undefined;
    this.diagnostics = undefined;
    const started = performance.now();
    const limit = this.config.kind === "gpr" ? MODEL_LIMITS.gpSamples : MODEL_LIMITS.samples;
    if (data.length === 0 || data.length > limit) throw new RangeError(`Training requires 1–${limit} sampled materials`);
    const dimensions = data[0].features.length;
    if (dimensions < 1 || dimensions > MODEL_LIMITS.features) throw new RangeError(`Features require 1–${MODEL_LIMITS.features} dimensions`);
    data.forEach(point => {
      this.validate(point.features, dimensions);
      if (!Number.isFinite(point.trueProperty) || Math.abs(point.trueProperty) > 1e12) throw new RangeError("Invalid training target");
    });
    this.centers = data[0].features.map((_, j) => mean(data.map(point => point.features[j])));
    this.scales = this.centers.map((center, j) => Math.hypot(...data.map(point => point.features[j] - center)) / Math.sqrt(data.length) || 1);
    this.targetCenter = mean(data.map(point => point.trueProperty));
    this.targetScale = Math.hypot(...data.map(point => point.trueProperty - this.targetCenter)) / Math.sqrt(data.length) || 1;
    const X = data.map(point => this.transform(point.features));
    const y = data.map(point => (point.trueProperty - this.targetCenter) / this.targetScale);
    const random = seededRandom(this.config.seed);
    let lengthScale: number | undefined;
    if (this.config.kind === "gpr") {
      const gp = gaussianProcess(X, y, this.config);
      this.predictStandardized = gp.predict;
      lengthScale = gp.lengthScale;
    } else {
      const models: Regressor[] = [];
      const forest = this.config.kind === "random-forest" || this.config.kind === "extra-trees";
      const count = forest ? this.config.trees : this.config.kind === "linear-ensemble" ? 5 : this.config.ensembleSize;
      for (let i = 0; i < count; i++) {
        const indices = X.map((_, j) => this.config.kind === "extra-trees" ? j : Math.floor(random() * X.length));
        const subX = indices.map(j => X[j]), subY = indices.map(j => y[j]);
        switch (this.config.kind) {
          case "random-forest": case "extra-trees":
            models.push(regressionTree(subX, subY, random, this.config.maxDepth, Math.max(1, Math.floor(Math.sqrt(dimensions))), this.config.kind === "extra-trees")); break;
          case "gradient-boosting": models.push(gradientBoosting(subX, subY, this.config, random)); break;
          case "knn": models.push(knn(subX, subY, this.config.neighbors)); break;
          case "ridge": models.push(ridge(subX, subY, this.config.ridgeAlpha)); break;
          case "linear-ensemble": models.push(linearSGD(subX, subY)); break;
        }
      }
      this.predictStandardized = x => ensemble(models, x);
    }
    this.diagnostics = {
      kind: this.config.kind, samples: data.length, dimensions,
      trainMs: performance.now() - started, predictMs: 0, lengthScale,
      uncertainty: MODEL_CATALOG.find(model => model.id === this.config.kind)!.uncertainty,
    };
  }

  predict(point: FeaturePoint): Prediction {
    if (!this.predictStandardized) throw new Error("Train the surrogate before predicting");
    this.validate(point.features, this.centers.length);
    const prediction = this.predictStandardized(this.transform(point.features));
    const result = { mean: this.targetCenter + this.targetScale * prediction.mean, std: this.targetScale * prediction.std };
    if (!Number.isFinite(result.mean) || !Number.isFinite(result.std) || result.std < 0) throw new Error("Non-finite model prediction");
    return result;
  }

  predictBatch(points: FeaturePoint[]): Prediction[] {
    if (points.length > MODEL_LIMITS.predictions) throw new RangeError(`At most ${MODEL_LIMITS.predictions} predictions per batch`);
    const started = performance.now(), result = points.map(point => this.predict(point));
    if (this.diagnostics) this.diagnostics.predictMs = performance.now() - started;
    return result;
  }
  private validate(features: number[], dimensions: number) {
    if (!Array.isArray(features) || features.length !== dimensions || Array.from(features).some(value => !Number.isFinite(value) || Math.abs(value) > 1e12)) {
      throw new RangeError("Feature dimensions must match training and contain finite numbers");
    }
  }
  private transform(features: number[]) {
    const scaled = features.map((value, j) => (value - this.centers[j]) / this.scales[j]);
    if (scaled.some(value => !Number.isFinite(value))) throw new RangeError("Feature range exceeds the numerical training scale");
    return scaled;
  }
}
