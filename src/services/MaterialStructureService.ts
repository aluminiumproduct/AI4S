import axios from "axios";
import { normalizeMaterialStructure, isMaterialId, canViewMaterialStructure } from "../structures/materialStructure";
import { sourceLabel } from "../dataHub";
import { StructureCache } from "../structures/StructureCache";
import type { CrystalStructure } from "../structures/types";
import type { Material } from "../types";

type Result = { kind: "ready"; structure: CrystalStructure; cached: boolean } | { kind: "unavailable" };
export class MaterialStructureService {
  private cache = new StructureCache<CrystalStructure>();
  async get(material: Pick<Material, "id" | "source" | "structureRef">, signal?: AbortSignal): Promise<Result> {
    // A formula or a realistic-looking ID cannot establish database provenance.
    if (!canViewMaterialStructure(material)) return { kind: "unavailable" };
    const ref = material.structureRef;
    if (!ref && !isMaterialId(material.id)) throw Object.assign(new Error("Invalid material ID"), { code: "INVALID_REQUEST" });
    signal?.throwIfAborted();
    const cacheKey = ref ? `${ref.dataset}|${ref.id}|${ref.revision}` : material.id;
    const cached = this.cache.get(cacheKey);
    if (cached) return { kind: "ready", structure: cached, cached: true };
    const url = ref ? `/api/hub/structure?${new URLSearchParams({ dataset: ref.dataset, id: ref.id, revision: ref.revision })}` : `/api/materials/${encodeURIComponent(material.id)}/structure`;
    const { data } = await axios.get(url, { signal, timeout: 65_000 });
    signal?.throwIfAborted();
    let structure: CrystalStructure;
    try {
      if (data?.meta?.materialId !== material.id || typeof data.meta.cached !== "boolean") throw new Error("Invalid structure metadata");
      if (ref && (data.meta.dataset !== ref.dataset || data.meta.revision !== ref.revision)) throw new Error("Structure revision does not match request");
      structure = normalizeMaterialStructure(data.data, material.id, data.meta.fetchedAt, !!ref);
      if (ref) {
        structure.source.recordRef = { ...ref };
        structure.source.providerLabel = sourceLabel(ref.dataset);
        if (data.meta.provenance) structure.source.provenance = structuredClone(data.meta.provenance);
      }
    } catch { throw Object.assign(new Error("Invalid structure response"), { code: "BAD_RESPONSE" }); }
    this.cache.set(cacheKey, structure);
    return { kind: "ready", structure, cached: data.meta.cached };
  }
}
