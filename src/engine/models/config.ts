export const MODEL_CATALOG = [
  { id: "gpr", zh: "高斯过程 · RBF", en: "Gaussian process · RBF", uncertainty: "gp", descriptionZh: "小样本非线性回归；σ 为潜在函数的 GP 后验标准差。", descriptionEn: "Small-data nonlinear regression; σ is the latent GP posterior standard deviation." },
  { id: "random-forest", zh: "随机森林", en: "Random forest", uncertainty: "trees", descriptionZh: "Bootstrap 样本 + 随机特征的 CART 森林；σ 为树间预测分歧。", descriptionEn: "Bootstrap CART trees with random features; σ measures tree disagreement." },
  { id: "extra-trees", zh: "极端随机树 · Extra Trees", en: "Extra Trees", uncertainty: "trees", descriptionZh: "完整训练集上的随机特征与随机阈值森林；σ 为树间分歧。", descriptionEn: "Random features and thresholds on the full training set; σ measures tree disagreement." },
  { id: "gradient-boosting", zh: "梯度提升回归树 · GBDT", en: "Gradient boosted trees", uncertainty: "bootstrap", descriptionZh: "浅树逐轮拟合残差；多个 Bootstrap 提升模型估计预测分歧。", descriptionEn: "Shallow trees sequentially fit residuals; bootstrapped boosters estimate disagreement." },
  { id: "knn", zh: "k 近邻回归", en: "k-nearest neighbors", uncertainty: "bootstrap", descriptionZh: "标准化空间内按距离加权；σ 来自 Bootstrap 模型分歧。", descriptionEn: "Distance-weighted neighbors in standardized space; σ is bootstrap disagreement." },
  { id: "ridge", zh: "岭回归 · L2", en: "Ridge regression · L2", uncertainty: "bootstrap", descriptionZh: "带 L2 正则的线性基线；σ 来自 Bootstrap 模型分歧。", descriptionEn: "L2-regularized linear baseline; σ is bootstrap disagreement." },
  { id: "linear-ensemble", zh: "Bootstrap 线性回归 · SGD", en: "Bootstrap linear regression · SGD", uncertainty: "bootstrap", descriptionZh: "保留 5 个线性 SGD 回归器作为对照，移除人为 +0.1。", descriptionEn: "Five linear SGD regressors retained as a baseline, without the arbitrary +0.1." },
] as const;

export type ModelKind = typeof MODEL_CATALOG[number]["id"];
export interface ModelConfig {
  kind: ModelKind;
  seed: number;
  lengthScale: number;
  noise: number;
  trees: number;
  maxDepth: number;
  ensembleSize: number;
  boostingRounds: number;
  learningRate: number;
  neighbors: number;
  ridgeAlpha: number;
}
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  kind: "gpr", seed: 42, lengthScale: 1, noise: 0.05,
  trees: 48, maxDepth: 6, ensembleSize: 8,
  boostingRounds: 40, learningRate: 0.08, neighbors: 5, ridgeAlpha: 1,
};
export const MODEL_LIMITS = { gpSamples: 256, samples: 1024, features: 128, predictions: 20_000 } as const;
export function modelConfig(input: Partial<ModelConfig> = {}): ModelConfig {
  const config = { ...DEFAULT_MODEL_CONFIG, ...input };
  if (!MODEL_CATALOG.some(model => model.id === config.kind)) throw new RangeError("Unknown surrogate model");
  const ranges: [keyof ModelConfig, number, number, boolean][] = [
    ["seed", 0, 0xffffffff, true], ["lengthScale", 0.1, 10, false], ["noise", 0.0001, 2, false],
    ["trees", 4, 128, true], ["maxDepth", 1, 10, true], ["ensembleSize", 4, 16, true],
    ["boostingRounds", 5, 100, true], ["learningRate", 0.01, 0.5, false],
    ["neighbors", 1, 32, true], ["ridgeAlpha", 0.000001, 1000, false],
  ];
  for (const [key, min, max, integer] of ranges) {
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new RangeError(`Invalid model setting: ${key} (${min}–${max})`);
    }
  }
  return config;
}
