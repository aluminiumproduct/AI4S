import { AL_CONFIG, type ALState, type Material } from "../types";
import { AcquisitionFunction, type AcquisitionStrategy } from "./AcquisitionFunction";

export type StopReason = "empty-pool" | "budget-exhausted" | "candidates-exhausted";

export interface Surrogate {
  train(data: Material[]): void | Promise<void>;
  predict(material: Material): { mean: number; std: number };
}

export interface StepConfig {
  totalBudget: number;
  batchSize: number;
  strategy: AcquisitionStrategy;
  initialSamples?: number;
  random?: () => number;
}

export function getStopReason(pool: Material[], totalBudget: number): StopReason | null {
  if (pool.length === 0) return "empty-pool";
  const sampledCount = pool.filter(material => material.isSampled).length;
  if (sampledCount >= totalBudget) return "budget-exhausted";
  if (sampledCount === pool.length) return "candidates-exhausted";
  return null;
}

/** One immutable, bounded step. React scheduling and cancellation belong to the caller. */
export async function runActiveLearningStep(
  pool: Material[],
  state: ALState,
  config: StepConfig,
  model: Surrogate,
): Promise<{ pool: Material[]; state: ALState; advanced: boolean; stopReason: StopReason | null }> {
  const { totalBudget, batchSize, initialSamples = AL_CONFIG.INITIAL_SAMPLES, random = Math.random } = config;
  if (!Number.isSafeInteger(totalBudget) || totalBudget < 0
    || !Number.isSafeInteger(batchSize) || batchSize < 1
    || !Number.isSafeInteger(initialSamples) || initialSamples < 1) {
    throw new RangeError("Sampling counts must be valid integers");
  }

  // The actual sampled records are authoritative, rather than a separately incremented counter.
  const sampledCount = pool.filter(material => material.isSampled).length;
  const stopReason = getStopReason(pool, totalBudget);
  if (stopReason) {
    return {
      pool,
      state: { ...state, budget: totalBudget, sampledCount },
      advanced: false,
      stopReason,
    };
  }

  const nextPool = pool.map(material => ({ ...material }));
  const initializing = sampledCount === 0;
  if (initializing) {
    const indices = nextPool.map((_, index) => index);
    const count = Math.min(initialSamples, totalBudget, nextPool.length);
    // Partial Fisher-Yates: fixed work even if the RNG always returns the same value.
    for (let i = 0; i < count; i++) {
      const draw = random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new RangeError("RNG must return a value in [0, 1)");
      const j = i + Math.floor(draw * (indices.length - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
      nextPool[indices[i]].isSampled = true;
      nextPool[indices[i]].iteration = 0;
    }
  }

  const sampled = nextPool.filter(material => material.isSampled);
  await model.train(sampled);
  const bestObserved = Math.max(...sampled.map(material => material.trueProperty));
  for (const material of nextPool) {
    if (!material.isSampled) {
      const { mean, std } = model.predict(material);
      material.predictedMean = mean;
      material.predictedStd = std;
      material.acquisitionValue = AcquisitionFunction.compute(material, config.strategy, bestObserved, 2, true);
    }
  }

  if (!initializing) {
    const count = Math.min(batchSize, totalBudget - sampledCount);
    const candidates = nextPool.filter(material => !material.isSampled)
      .sort((a, b) => (b.acquisitionValue ?? 0) - (a.acquisitionValue ?? 0))
      .slice(0, count);
    for (const material of candidates) {
      material.isSampled = true;
      material.iteration = state.iteration;
    }
  }

  const updated = nextPool.filter(material => material.isSampled);
  const bestValue = Math.max(...updated.map(material => material.trueProperty));
  const globalMax = Math.max(...nextPool.map(material => material.trueProperty));
  const regret = globalMax - bestValue;
  const nextState: ALState = {
    ...state,
    iteration: state.iteration + 1,
    budget: totalBudget,
    sampledCount: updated.length,
    bestValue,
    history: [...state.history, {
      iteration: state.iteration + 1,
      bestValue,
      avgError: 0,
      regret: regret > 1e-6 ? regret : 0,
    }],
  };
  return { pool: nextPool, state: nextState, advanced: true, stopReason: getStopReason(nextPool, totalBudget) };
}
