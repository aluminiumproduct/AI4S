import { AcquisitionFunction } from "../AcquisitionFunction";
import { createSeededRandom } from "../SeededRandom";
import type { FeaturePoint, TrainingPoint } from "../SurrogateModel";
import type { Prediction } from "../models/regressors";
import type { MaterialLineage } from "../../materialContext";
import type { StabilityInput } from "./ParetoData";

export type Objectives = [performance: number, hullEvAtom: number, priceUsdKg: number];
export type Weights = [number, number, number];
export interface ParetoCandidate {
  id: string; formula: string; composition: Record<string, number>; features: number[];
  objectives: Objectives; observed: boolean; observedAt?: number;
  source: "demo" | "materials-project"; stabilitySource: string; priceQuality: "reference" | "scenario";
  lineage?: MaterialLineage;
  objective?: { id: "band-gap"; unit: "eV"; direction: "max" };
  stabilityProvenance?: StabilityInput;
}
export interface ObjectiveScales { performance: number; hull: number; price: number }
export interface ParetoRound {
  round: number; observed: number; hypervolume: number; frontierIds: string[];
  addedIds: string[]; weights: Weights;
}
export interface ParetoState { round: number; history: ParetoRound[] }
export interface ParetoSurrogate {
  train(data: TrainingPoint[]): void | Promise<void>;
  predictBatch(data: FeaturePoint[]): Prediction[] | Promise<Prediction[]>;
}
export const INITIAL_PARETO_STATE = (): ParetoState => ({ round: 0, history: [] });

export function normalizeWeights(weights: Weights): Weights {
  if (weights.length !== 3 || weights.some(w => !Number.isFinite(w) || w < 0)) throw new RangeError("Three nonnegative preference weights required");
  const largest = Math.max(...weights);
  if (largest === 0) return [1 / 3, 1 / 3, 1 / 3];
  const scaled = weights.map(w => w / largest);
  const sum = scaled.reduce((a, b) => a + b, 0);
  return scaled.map(w => w / sum) as Weights;
}
export function validateObjectives(y: Objectives) {
  if (y.length !== 3 || y.some(v => !Number.isFinite(v)) || y[1] < 0 || y[2] < 0) throw new RangeError("Invalid objective vector");
}
export function utilities(y: Objectives, scales: ObjectiveScales): Objectives {
  validateObjectives(y);
  if (Object.values(scales).some(v => !Number.isFinite(v) || v <= 0)) throw new RangeError("Positive fixed objective scales required");
  return [y[0] / scales.performance, 1 - y[1] / scales.hull, 1 - Math.log1p(y[2]) / Math.log1p(scales.price)];
}
export function dominates(a: Objectives, b: Objectives): boolean {
  validateObjectives(a); validateObjectives(b);
  return a[0] >= b[0] && a[1] <= b[1] && a[2] <= b[2]
    && (a[0] > b[0] || a[1] < b[1] || a[2] < b[2]);
}
/** Only acquired observations enter the empirical frontier. */
export function paretoFront(candidates: ParetoCandidate[]): ParetoCandidate[] {
  const observed = candidates.filter(c => c.observed);
  observed.forEach(c => validateObjectives(c.objectives));
  return observed.filter(c => !observed.some(other => other !== c && dominates(other.objectives, c.objectives)));
}
/** Maximize negative augmented Tchebycheff distance to a fixed utility ideal. */
export function scalarize(y: Objectives, weights: Weights, scales: ObjectiveScales): number {
  const w = normalizeWeights(weights), u = utilities(y, scales);
  const distances = u.map((value, i) => w[i] * (1 - value));
  return -Math.max(...distances) - 0.05 * distances.reduce((a, b) => a + b, 0);
}
export function preferredCandidate(candidates: ParetoCandidate[], weights: Weights, scales: ObjectiveScales) {
  return [...paretoFront(candidates)].sort((a, b) => scalarize(b.objectives, weights, scales) - scalarize(a.objectives, weights, scales) || a.id.localeCompare(b.id))[0];
}
/** Exact union of origin-anchored boxes in 3D, with fixed scales and reference (0,0,0). */
export function hypervolume(candidates: ParetoCandidate[], scales: ObjectiveScales): number {
  const points = paretoFront(candidates).map(c => utilities(c.objectives, scales)).filter(p => p.every(v => v > 0));
  const xs = [...new Set([0, ...points.map(p => p[0])])].sort((a, b) => a - b);
  let volume = 0;
  for (let i = 1; i < xs.length; i++) {
    const active = points.filter(p => p[0] >= xs[i]);
    const ys = [...new Set([0, ...active.map(p => p[1])])].sort((a, b) => a - b);
    let area = 0;
    for (let j = 1; j < ys.length; j++) area += (ys[j] - ys[j - 1]) * Math.max(0, ...active.filter(p => p[1] >= ys[j]).map(p => p[2]));
    volume += (xs[i] - xs[i - 1]) * area;
  }
  return volume;
}

export async function runParetoStep(pool: ParetoCandidate[], state: ParetoState,
  config: { budget: number; weights: Weights; scales: ObjectiveScales; seed: number; signal?: AbortSignal; strategy?: "ParEGO" | "Random" },
  model: ParetoSurrogate): Promise<{ pool: ParetoCandidate[]; state: ParetoState; done: boolean }> {
  config.signal?.throwIfAborted();
  if (!Number.isSafeInteger(config.budget) || config.budget < 1 || config.budget > 200 || !Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) throw new RangeError("Invalid budget or seed");
  if (new Set(pool.map(c => c.id)).size !== pool.length) throw new RangeError("Candidate IDs must be unique");
  const preference = normalizeWeights(config.weights);
  const acquired = pool.filter(c => c.observed).length;
  if (acquired >= Math.min(config.budget, pool.length)) return { pool, state, done: true };
  const next = pool.map(c => ({ ...c }));
  const random = createSeededRandom((config.seed + Math.imul(state.round, 2654435761)) >>> 0);
  const draws = preference.map(p => -Math.log(Math.max(random(), 1e-12)) * (0.25 + p)) as Weights;
  const weights = normalizeWeights(draws);
  const added: ParetoCandidate[] = [];
  if (acquired === 0) {
    const remaining = [...next];
    const count = Math.min(6, config.budget, remaining.length);
    const anchors = remaining.filter(c => Object.values(c.composition).filter(n => n > 0).length === 1);
    for (let i = anchors.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1)); [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
    }
    for (let i = 0; i < count; i++) {
      const index = i < anchors.length ? remaining.indexOf(anchors[i]) : Math.floor(random() * remaining.length);
      const [candidate] = remaining.splice(index, 1);
      added.push(candidate);
    }
  } else if (config.strategy === "Random") {
    const candidates = next.filter(c => !c.observed);
    added.push(candidates[Math.floor(random() * candidates.length)]);
  } else {
    const training = next.filter(c => c.observed).map(c => ({ features: c.features, trueProperty: scalarize(c.objectives, weights, config.scales) }));
    await model.train(training);
    config.signal?.throwIfAborted();
    const candidates = next.filter(c => !c.observed);
    const predictions = await model.predictBatch(candidates.map(c => ({ features: c.features })));
    config.signal?.throwIfAborted();
    if (predictions.length !== candidates.length) throw new Error("Prediction count does not match candidates");
    const best = Math.max(...training.map(p => p.trueProperty));
    let winner = 0, highest = -Infinity;
    predictions.forEach((p, i) => {
      if (!Number.isFinite(p.mean) || !Number.isFinite(p.std) || p.std < 0) throw new Error("Invalid ParEGO prediction");
      const value = AcquisitionFunction.computeParEGO(p, best);
      if (value > highest) { highest = value; winner = i; }
    });
    added.push(candidates[winner]);
  }
  config.signal?.throwIfAborted();
  for (const candidate of added) { validateObjectives(candidate.objectives); candidate.observed = true; candidate.observedAt = state.round + 1; }
  const record: ParetoRound = { round: state.round + 1, observed: next.filter(c => c.observed).length,
    hypervolume: hypervolume(next, config.scales), frontierIds: paretoFront(next).map(c => c.id), addedIds: added.map(c => c.id), weights };
  return { pool: next, state: { round: record.round, history: [...state.history, record] }, done: record.observed >= Math.min(config.budget, next.length) };
}
