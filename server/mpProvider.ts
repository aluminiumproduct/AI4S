import { OBJECTIVES, type HubQuery, type HubRecord, type ObjectiveId } from "../src/dataHub";
import { isMaterialId } from "../src/structures/materialStructure";
import { HubInputError, elementList, validateHubRecord } from "./hubStore";
import { NetworkFailure, httpFailure, type NetworkClient } from "./network";

export const MP_FIELDS = "material_id,formula_pretty,elements,composition,structure,symmetry,energy_above_hull,formation_energy_per_atom,band_gap,origins";
export function mpFilterParams(input: any, defaultElements = "") {
  const elements = elementList(input.elements ?? defaultElements), excluded = elementList(input.exclude_elements);
  if (elements.some(el => excluded.includes(el))) throw new HubInputError("包含和排除元素不能重叠。");
  const match = input.match ?? "contains";
  if (!["contains", "exact"].includes(match) || (match === "exact" && !elements.length)) throw new HubInputError("无效的化学体系匹配模式。");
  return { ...(elements.length ? match === "exact" ? { chemsys: elements.join("-") } : { elements: elements.join(",") } : {}),
    ...(excluded.length ? { exclude_elements: excluded.join(",") } : {}) };
}
export async function fetchMPRecords(network: NetworkClient, env: Record<string, string | undefined>, endpoint: string, query: HubQuery, signal: AbortSignal): Promise<HubRecord[]> {
  const key = env.MP_API_KEY?.trim();
  if (!key || /^YOUR_|^你的|[\r\n]/.test(key)) throw new NetworkFailure("MISSING_API_KEY", 503);
  const filters = mpFilterParams({ elements: query.elements, exclude_elements: query.excludeElements, match: query.match });
  const records: HubRecord[] = [];
  const ids = new Set<string>();
  let skip = 0;
  while (records.length < query.limit) {
    signal.throwIfAborted();
    const pageSize = Math.min(100, query.limit - records.length);
    const response = await network.request<{ data: any[]; meta?: { db_version?: string } }>({ url: endpoint, signal,
      headers: { accept: "application/json", "X-API-KEY": key, "User-Agent": "AI4S-DataHub/1.0" },
      params: { ...filters, license: "BY-C", _limit: pageSize, _skip: skip, _fields: MP_FIELDS } });
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300) throw httpFailure(response.status);
    const rows = response.data?.data;
    if (!Array.isArray(rows)) throw new NetworkFailure("BAD_RESPONSE");
    for (const row of rows.slice(0, pageSize)) {
      if (!isMaterialId(row?.material_id) || ids.has(row.material_id)) throw new NetworkFailure("BAD_RESPONSE");
      ids.add(row.material_id);
      const values: HubRecord["values"] = {}, units: HubRecord["units"] = {};
      for (const id of ["band-gap", "formation-energy", "energy-above-hull"] as ObjectiveId[]) {
        const spec = OBJECTIVES[id], value = row[spec.field];
        if (typeof value === "number" && Number.isFinite(value)) { values[id] = value; units[id] = spec.unit; }
      }
      try {
        records.push(validateHubRecord({ id: row.material_id, formula: row.formula_pretty, composition: row.composition, values, units,
          source: "MP-DFT", fidelity: "low-dft", methodMeta: "MP summary; inspect origins task IDs for the actual calculation method", cohort: "MP-summary",
          structure: row.structure, symmetry: row.symmetry,
          provenance: { reference: "Materials Project summary API; Jain et al., APL Materials 1, 011002 (2013), doi:10.1063/1.4812323",
            url: `https://materialsproject.org/materials/${row.material_id}`, datasetVersion: response.data.meta?.db_version ?? "not supplied by API; retrieval time recorded",
            retrievedAt: new Date().toISOString(), license: "MP API license filter BY-C; original Materials Project terms apply",
            taskIds: Array.isArray(row.origins) ? [...new Set(row.origins.map((origin: any) => origin.task_id).filter((id: unknown) => typeof id === "string"))] : [] } }));
      } catch { throw new NetworkFailure("BAD_RESPONSE"); }
    }
    skip += rows.length;
    if (rows.length < pageSize) break;
  }
  return records;
}
