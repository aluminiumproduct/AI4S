import axios from "axios";
import { normalizeMaterialStructure, isMaterialId } from "../structures/materialStructure";
import { StructureCache } from "../structures/StructureCache";
import type { CrystalStructure } from "../structures/types";
import type { Material } from "../types";

type Result = { kind: "ready"; structure: CrystalStructure; cached: boolean } | { kind: "unavailable" };
export class MaterialStructureService {
  private cache = new StructureCache<CrystalStructure>();
  async get(material: Pick<Material, "id" | "source">, signal?: AbortSignal): Promise<Result> {
    // A formula or a realistic-looking ID cannot establish database provenance.
    if (material.source !== "materials-project") return { kind: "unavailable" };
    if (!isMaterialId(material.id)) throw Object.assign(new Error("Invalid material ID"), { code: "INVALID_REQUEST" });
    signal?.throwIfAborted();
    const cached = this.cache.get(material.id);
    if (cached) return { kind: "ready", structure: cached, cached: true };
    const { data } = await axios.get(`/api/materials/${encodeURIComponent(material.id)}/structure`, { signal, timeout: 65_000 });
    signal?.throwIfAborted();
    let structure: CrystalStructure;
    try {
      if (data?.meta?.materialId !== material.id || typeof data.meta.cached !== "boolean") throw new Error("Invalid structure metadata");
      structure = normalizeMaterialStructure(data.data, material.id, data.meta.fetchedAt);
    } catch { throw Object.assign(new Error("Invalid structure response"), { code: "BAD_RESPONSE" }); }
    this.cache.set(material.id, structure);
    return { kind: "ready", structure, cached: data.meta.cached };
  }
}
