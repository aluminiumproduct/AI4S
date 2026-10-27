import type { ModelConfig } from "./config";
import { cholesky, dot, forwardSolve, mean, solveCholesky, squaredDistance } from "./math";
export interface Prediction { mean: number; std: number }
export type Regressor = (features: number[]) => number;

/** GPML algorithm 2.1; unit-amplitude RBF, LATENT rather than observation variance. */
export function gaussianProcess(X: number[][], y: number[], config: ModelConfig) {
  const distances: number[] = [];
  for (let i = 0; i < X.length; i++) for (let j = 0; j < i; j++) {
    const distance = Math.sqrt(squaredDistance(X[i], X[j]));
    if (distance > 1e-12) distances.push(distance);
  }
  distances.sort((a, b) => a - b);
  const lengthScale = (distances.length ? distances[Math.floor(distances.length / 2)] : 1) * config.lengthScale;
  const kernel = (a: number[], b: number[]) => Math.exp(-squaredDistance(a, b) / (2 * lengthScale ** 2));
  const covariance = X.map((a, i) => X.map((b, j) => kernel(a, b) + (i === j ? config.noise ** 2 + 1e-10 : 0)));
  const lower = cholesky(covariance), alpha = solveCholesky(lower, y);
  return { lengthScale, predict(x: number[]): Prediction {
    const k = X.map(row => kernel(row, x)), v = forwardSolve(lower, k);
    return { mean: dot(k, alpha), std: Math.sqrt(Math.max(0, 1 - dot(v, v))) };
  } };
}

type Tree = { value: number; feature?: number; threshold?: number; left?: Tree; right?: Tree };
/** Squared-error CART with at least two observations per leaf. */
export function regressionTree(X: number[][], y: number[], random: () => number, depth: number, featureCount: number, randomThreshold = false): Regressor {
  function build(indices: number[], remainingDepth: number): Tree {
    const value = mean(indices.map(i => y[i]));
    if (remainingDepth === 0 || indices.length < 4) return { value };
    const parentError = indices.reduce((sum, i) => sum + (y[i] - value) ** 2, 0);
    if (parentError < 1e-14) return { value };
    // Constant descriptor columns cannot split this node; do not let them produce
    // accidental stumps when drawing the random feature subset.
    const features = X[0].map((_, i) => i).filter(f => indices.some(i => X[i][f] !== X[indices[0]][f]));
    const selectedCount = Math.min(featureCount, features.length);
    for (let i = 0; i < selectedCount; i++) {
      const j = i + Math.floor(random() * (features.length - i));
      [features[i], features[j]] = [features[j], features[i]];
    }
    let bestError = parentError - 1e-12, feature = -1, threshold = 0;
    for (const f of features.slice(0, selectedCount)) {
      const sorted = indices.slice().sort((a, b) => X[a][f] - X[b][f]);
      const low = X[sorted[0]][f], high = X[sorted[sorted.length - 1]][f];
      if (low === high) continue;
      const cut = randomThreshold ? low + random() * (high - low) : null;
      const total = sorted.reduce((sum, i) => sum + y[i], 0);
      const totalSquares = sorted.reduce((sum, i) => sum + y[i] ** 2, 0);
      let leftSum = 0, leftSquares = 0;
      for (let pos = 1; pos < sorted.length; pos++) {
        const target = y[sorted[pos - 1]];
        leftSum += target; leftSquares += target ** 2;
        const a = X[sorted[pos - 1]][f], b = X[sorted[pos]][f];
        if (pos < 2 || sorted.length - pos < 2 || a === b) continue;
        if (cut !== null && !(a <= cut && cut < b)) continue;
        const error = leftSquares - leftSum ** 2 / pos + totalSquares - leftSquares - (total - leftSum) ** 2 / (sorted.length - pos);
        if (error < bestError) {
          bestError = error; feature = f;
          const midpoint = a + (b - a) / 2;
          threshold = cut ?? (midpoint < b ? midpoint : a);
        }
      }
    }
    if (feature < 0) return { value };
    const left = indices.filter(i => X[i][feature] <= threshold), right = indices.filter(i => X[i][feature] > threshold);
    if (left.length < 2 || right.length < 2) return { value };
    return { value, feature, threshold, left: build(left, remainingDepth - 1), right: build(right, remainingDepth - 1) };
  }
  const root = build(X.map((_, i) => i), depth);
  return x => {
    let node = root;
    while (node.feature !== undefined) node = x[node.feature] <= node.threshold! ? node.left! : node.right!;
    return node.value;
  };
}

export function ridge(X: number[][], y: number[], alpha: number): Regressor {
  const centerX = X[0].map((_, j) => mean(X.map(x => x[j]))), centerY = mean(y);
  const centered = X.map(x => x.map((value, j) => value - centerX[j]));
  const covariance = centerX.map((_, i) => centerX.map((__, j) => centered.reduce((sum, x) => sum + x[i] * x[j], 0) + (i === j ? alpha : 0)));
  const rhs = centerX.map((_, j) => centered.reduce((sum, x, i) => sum + x[j] * (y[i] - centerY), 0));
  const weights = solveCholesky(cholesky(covariance), rhs);
  return x => centerY + dot(x.map((value, j) => value - centerX[j]), weights);
}
export function knn(X: number[][], y: number[], neighbors: number): Regressor {
  return x => {
    const nearest = X.map((row, i) => ({ distance: Math.hypot(...row.map((value, j) => value - x[j])), y: y[i] }))
      .sort((a, b) => a.distance - b.distance).slice(0, Math.min(neighbors, X.length));
    const exact = nearest.filter(point => point.distance === 0);
    if (exact.length) return mean(exact.map(point => point.y));
    // Relative inverse distances avoid both squared-distance overflow and tiny
    // reciprocal weights whose sum could underflow to zero.
    const weights = nearest.map(point => nearest[0].distance / point.distance);
    return dot(weights, nearest.map(point => point.y)) / weights.reduce((sum, weight) => sum + weight, 0);
  };
}
export function gradientBoosting(X: number[][], y: number[], config: ModelConfig, random: () => number): Regressor {
  const base = mean(y), fitted = y.map(() => base), trees: Regressor[] = [];
  for (let round = 0; round < config.boostingRounds; round++) {
    const tree = regressionTree(X, y.map((value, i) => value - fitted[i]), random, Math.min(config.maxDepth, 3), X[0].length);
    for (let i = 0; i < fitted.length; i++) fitted[i] += config.learningRate * tree(X[i]);
    trees.push(tree);
  }
  return x => base + config.learningRate * trees.reduce((sum, tree) => sum + tree(x), 0);
}
export function linearSGD(X: number[][], y: number[]): Regressor {
  let weights = X[0].map(() => 0), bias = 0;
  const maxNormSquared = Math.max(...X.map(x => 1 + dot(x, x)));
  const rate = Math.min(0.01 / X[0].length, 1 / maxNormSquared);
  for (let epoch = 0; epoch < 100; epoch++) for (let i = 0; i < X.length; i++) {
    const error = dot(X[i], weights) + bias - y[i];
    weights = weights.map((value, j) => value - rate * error * X[i][j]);
    bias -= rate * error;
  }
  return x => dot(x, weights) + bias;
}
export function ensemble(models: Regressor[], x: number[]): Prediction {
  const predictions = models.map(model => model(x)), average = mean(predictions);
  const std = Math.hypot(...predictions.map(value => value - average)) / Math.sqrt(predictions.length - 1);
  return { mean: average, std };
}
