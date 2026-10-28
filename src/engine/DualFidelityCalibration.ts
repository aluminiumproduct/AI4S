import type { CalibrationResult, FidelityPair, ObjectiveId } from "../dataHub";
import { OBJECTIVES } from "../dataHub";
import { normalizeComposition } from "./CompositionFeatures";
import { createSeededRandom } from "./SeededRandom";

/** Transparent constant residual correction; not a multi-fidelity surrogate or a causal model. */
export function calibratePairs(pairs: FidelityPair[], objective: ObjectiveId, cohort: string): CalibrationResult {
  const groups = new Map<string, FidelityPair[]>();
  for (const pair of pairs.filter(p => p.objective === objective && p.cohort === cohort)) {
    const key = JSON.stringify(Object.entries(normalizeComposition(pair.composition)).map(([el, n]) => [el, Number(n.toPrecision(12))]));
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }
  // One representative per composition; no replica/polymorph composition leaks between splits.
  const representatives = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, rows]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))[0]);
  if (representatives.length < 10) throw new RangeError("至少需要10个不同组成的可信配对记录；重复组成不计为独立校准样本。");
  const random = createSeededRandom(42);
  for (let i = representatives.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [representatives[i], representatives[j]] = [representatives[j], representatives[i]];
  }
  const calibration = representatives.slice(0, 10), validation = representatives.slice(10);
  const correction = calibration.reduce((sum, p) => sum + p.experiment.value - p.dft.value, 0) / calibration.length;
  const mae = (offset: number) => validation.reduce((sum, p) => sum + Math.abs(p.dft.value + offset - p.experiment.value), 0) / validation.length;
  return { objective, unit: OBJECTIVES[objective].unit, cohort, model: "constant-bias", correction,
    calibrationIds: calibration.map(p => p.id), validationIds: validation.map(p => p.id),
    calibrationGroups: calibration.length, validationGroups: validation.length,
    validation: validation.length >= 2 ? { baselineMAE: mae(0), correctedMAE: mae(correction) } : null,
    note: "固定种子42、按组成隔离；每组仅取ID排序首条。修正=mean(实验−DFT)，仅使用10组校准值；至少2组独立留出时才报告MAE。配对可比性由导入依据决定，不保证误差改善。" };
}
