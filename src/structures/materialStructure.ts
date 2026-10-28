import { element } from "./elements";
import { fractionalToCartesian, MAX_STRUCTURE_SITES, validateLattice } from "./geometry";
import { MAX_STRUCTURE_BYTES, type CrystalStructure, type Lattice, type Vec3 } from "./types";
import type { Material } from "../types";

export interface MaterialStructureRequest extends Pick<Material, "id" | "formula" | "source" | "structureRef"> { requestId: number; }
export function canViewMaterialStructure(material: Pick<Material, "id" | "source" | "structureRef">): boolean {
  if (material.source === "materials-project") return true;
  return ["MP-DFT", "Catalysis-Hub", "GNoME-Extrapolated", "Lab-Experiment"].includes(material.source ?? "")
    && !!material.structureRef && material.structureRef.id === material.id
    && ["mp-snapshot", "catalysis-hub", "dual-fidelity"].includes(material.structureRef.dataset)
    && /^[a-f0-9]{64}$/.test(material.structureRef.revision);
}
// Current MP datasets also use alphabetic/alphanumeric IDs (e.g. mp-aaafkmdf).
export const isMaterialId = (value: unknown): value is string => typeof value === "string" && /^(?:mp|mvc)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
const vec3 = (value: unknown): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error("无效的结构坐标或晶格向量。");
  return [...value] as Vec3;
};

/** Decode a full pymatgen cell; never expand symmetry or infer coordinates from a formula. */
export function normalizeMaterialStructure(document: any, materialId: string, fetchedAt: string, localHub = false): CrystalStructure {
  const validId = localHub ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(materialId) : isMaterialId(materialId);
  if (!validId || document?.material_id !== materialId) throw new Error("返回的结构与请求材料 ID 不一致。");
  if (typeof document.formula_pretty !== "string" || !document.formula_pretty.trim() || document.formula_pretty.length > 200) throw new Error("材料结构缺少化学式。");
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error("结构获取时间无效。");
  const input = document.structure;
  const raw = JSON.stringify(input);
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_STRUCTURE_BYTES) throw new Error("材料结构缺失或超过 5 MB。");
  if (!Array.isArray(input?.lattice?.matrix) || input.lattice.matrix.length !== 3) throw new Error("材料结构缺少三维晶格。");
  const lattice = validateLattice(input.lattice.matrix.map(vec3) as Lattice);
  if (input.lattice.pbc !== undefined && (!Array.isArray(input.lattice.pbc) || input.lattice.pbc.length !== 3 || input.lattice.pbc.some((v: unknown) => v !== true))) throw new Error("当前仅支持三个方向均周期的晶体结构。");
  if (!Array.isArray(input.sites) || input.sites.length < 1 || input.sites.length > MAX_STRUCTURE_SITES) throw new Error(`材料结构需包含 1–${MAX_STRUCTURE_SITES} 个位点。`);
  let partial = false;
  const sites = input.sites.map((site: any, index: number) => {
    const fractional = vec3(site?.abc);
    if (fractionalToCartesian(fractional, lattice).some(v => !Number.isFinite(v))) throw new Error("原子坐标转换超出有限数值范围。");
    if (!Array.isArray(site.species) || site.species.length === 0) throw new Error("材料位点缺少元素占位。");
    const unique = new Set<string>();
    const species = site.species.map((item: any) => {
      const symbol = typeof item?.element === "string" ? element(item.element) : "";
      if (!symbol || unique.has(symbol) || typeof item.occu !== "number" || !Number.isFinite(item.occu) || item.occu <= 0 || item.occu > 1) throw new Error("材料位点的元素或占位无效。");
      unique.add(symbol);
      return { element: symbol, occupancy: item.occu };
    });
    const total = species.reduce((sum, item) => sum + item.occupancy, 0);
    if (total > 1 + 1e-6) throw new Error("材料位点占位总和超过 1。");
    partial ||= total < 1 - 1e-6 || species.length > 1;
    const label = typeof site.label === "string" && site.label.length <= 200 ? site.label : `${species[0].element}${index + 1}`;
    return { id: `site-${index}`, label, fractional, species, sourceLabels: [label] };
  });
  return { schemaVersion: 1, name: `${document.formula_pretty} · ${materialId}`, lattice, sites,
    source: { filename: materialId, format: localHub ? "data-hub" : "materials-project", materialId, formula: document.formula_pretty, fetchedAt,
      coordinateMode: "direct", symmetry: "listed-sites", spaceGroup: typeof document.symmetry?.symbol === "string" ? document.symmetry.symbol : undefined,
      warnings: partial ? ["包含混占或部分占位；按数据库原始占位保留，3D 以主占位元素着色。"] : [], raw } };
}
