import type { Material } from "./types";
import { OBJECTIVES, type ObjectiveId } from "./dataHub";
import { normalizeComposition } from "./engine/CompositionFeatures";

export type MaterialIdentity = Pick<Material, "id" | "composition" | "source" | "datasetSource" | "recordRevision" | "structureRef" | "cohort" | "provenance" | "targetKind">;
export type TargetKind = ObjectiveId | "synthetic-score";

export function targetSpec(id: TargetKind) {
  if (id === "synthetic-score") return { id, zh: "合成演示评分", en: "Synthetic demonstration score", unit: "a.u.", direction: "max" as const };
  if (!Object.hasOwn(OBJECTIVES, id)) throw new RangeError("Unknown objective");
  return { id, ...OBJECTIVES[id] };
}

/** Dataset/revision identity contains no hidden target labels or prediction state. */
export function materialRecordKey(material: MaterialIdentity): string {
  const dataset = material.datasetSource === "mp-live" ? "mp-snapshot"
    : material.datasetSource ?? material.structureRef?.dataset ?? material.source ?? "unmarked";
  const composition = Object.entries(normalizeComposition(material.composition))
    .sort(([a], [b]) => a.localeCompare(b)).map(([symbol, amount]) => [symbol, Number(amount.toPrecision(12))]);
  return JSON.stringify([dataset, material.source ?? null, material.id,
    material.recordRevision ?? material.structureRef?.revision ?? null,
    material.cohort ?? null, material.provenance?.datasetVersion ?? null, composition,
    material.recordRevision ? null : material.targetKind ?? null]);
}

export function materialLineage(material: Material) {
  return {
    recordKey: materialRecordKey(material), revision: material.recordRevision ?? material.structureRef?.revision ?? null,
    source: material.source ?? null, dataset: material.datasetSource ?? null,
    fidelity: material.fidelity ?? null, method: material.methodMeta ?? null,
    cohort: material.cohort ?? null, comparisonBasis: material.comparisonBasis ?? null,
    provenance: material.provenance ? structuredClone(material.provenance) : null,
    structureRef: material.structureRef ? { ...material.structureRef } : null,
    structureHash: material.structureHash ?? null,
  };
}
export type MaterialLineage = ReturnType<typeof materialLineage>;
