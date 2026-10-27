import type { CompositionDescriptors } from "./engine/CompositionFeatures";

export interface Material {
  id: string;
  formula: string;
  /** Explicit provenance; an unmarked record is never treated as a real structure. */
  source?: "materials-project" | "mock";
  composition: Record<string, number>;
  features: number[];
  descriptors?: CompositionDescriptors;
  targetKind?: "band-gap" | "synthetic-score";
  trueProperty: number; // Only known to the "Oracle"
  cost: number; // Experimental or computational cost
  predictedMean?: number;
  predictedStd?: number;
  acquisitionValue?: number;
  isSampled: boolean;
  iteration?: number;
}

export interface ALState {
  iteration: number;
  budget: number;
  sampledCount: number;
  bestValue: number;
  history: {
    iteration: number;
    bestValue: number;
    avgError: number;
    regret: number;
  }[];
}

export const AL_CONFIG = {
  INITIAL_SAMPLES: 5,
  BATCH_SIZE: 2,
  MAX_ITERATIONS: 20,
  TOTAL_BUDGET: 50,
};
