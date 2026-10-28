import type { Material } from "../../types";
import { extractCompositionFeatures } from "../CompositionFeatures";
import { materialPrice, type PriceOverrides } from "./priceBook";
import type { ObjectiveScales, ParetoCandidate } from "./ParetoEngine";

export interface StabilityInput { materialId: string; energyAboveHull: number; source: string; method: string; referenceSet: string }
export function parseStabilityInputs(text: string): StabilityInput[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("需要稳定性记录数组");
  const seen = new Set<string>();
  return rows.map(row => {
    if (!row || typeof row.materialId !== "string" || !row.materialId || seen.has(row.materialId)
      || typeof row.energyAboveHull !== "number" || !Number.isFinite(row.energyAboveHull) || row.energyAboveHull < 0
      || ![row.source, row.method, row.referenceSet].every(v => typeof v === "string" && v.trim().length > 0)) throw new Error("每条记录需要唯一材料ID、非负Ehull、来源、方法及参考相集合");
    seen.add(row.materialId);
    return { materialId: row.materialId, energyAboveHull: row.energyAboveHull, source: row.source, method: row.method, referenceSet: row.referenceSet };
  });
}
export function demoCandidates(overrides: PriceOverrides = {}): ParetoCandidate[] {
  const symbols = ["Al", "Co", "Ni", "Cu", "Ge", "Sc"];
  const strength = [35, 77, 72, 48, 91, 97];
  const instability = [0.01, 0.035, 0.02, 0.012, 0.15, 0.19];
  const rows: ParetoCandidate[] = [];
  const add = (i: number, j: number, a: number, b: number) => {
    const composition = i === j ? { [symbols[i]]: 1 } : { [symbols[i]]: a, [symbols[j]]: b };
    const x = a / (a + b), mix = i === j ? 0 : 4 * x * (1 - x);
    const performance = i === j ? strength[i] : Math.min(100, x * strength[i] + (1 - x) * strength[j] + 10 * mix * Math.cos((i + j) * 0.7));
    const hull = i === j ? instability[i] : Math.max(0, x * instability[i] + (1 - x) * instability[j] + 0.035 * mix * Math.sin(i + j));
    const price = materialPrice(composition, overrides);
    rows.push({ id: `alloy-${i}-${j}-${a}`, formula: Object.entries(composition).map(([s, n]) => `${s}${n === 1 ? "" : n}`).join(""),
      composition, features: extractCompositionFeatures(composition).features, objectives: [performance, hull, price.usdKg!],
      source: "demo", stabilitySource: "deterministic-demo-v1", priceQuality: price.quality, observed: false });
  };
  for (let i = 0; i < symbols.length; i++) {
    add(i, i, 1, 0);
    for (let j = i + 1; j < symbols.length; j++) for (let a = 1; a <= 6; a++) add(i, j, a, 7 - a);
  }
  return rows;
}
export function materialCandidates(materials: Material[], overrides: PriceOverrides = {}, stability: StabilityInput[] = []) {
  const external = new Map(stability.map(row => [row.materialId, row]));
  const candidates: ParetoCandidate[] = [];
  let missingStability = 0, missingPrice = 0;
  for (const material of materials) {
    if (material.source !== "materials-project") continue;
    const imported = external.get(material.id);
    const hull = imported?.energyAboveHull ?? material.energyAboveHull;
    if (typeof hull !== "number" || !Number.isFinite(hull) || hull < 0) { missingStability++; continue; }
    const price = materialPrice(material.composition, overrides);
    if (price.usdKg === null) { missingPrice++; continue; }
    candidates.push({ id: material.id, formula: material.formula, composition: material.composition, features: material.features,
      objectives: [material.trueProperty, hull, price.usdKg], observed: false, source: "materials-project",
      stabilitySource: imported ? `${imported.source} · ${imported.method} · ${imported.referenceSet}` : "Materials Project energy_above_hull", priceQuality: price.quality });
  }
  return { candidates, missingStability, missingPrice };
}
/** Declared scales, not a min/max peek at the hidden candidate target labels. */
export const PARETO_SCALES: Record<"demo" | "materials-project", ObjectiveScales> = {
  demo: { performance: 100, hull: 0.5, price: 6000 },
  "materials-project": { performance: 12, hull: 0.5, price: 6000 },
};
