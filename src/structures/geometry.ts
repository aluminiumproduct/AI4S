import type { CrystalStructure, DisplayAtom, Lattice, Vec3 } from "./types";

export const MAX_STRUCTURE_SITES = 5000;
export const dot = (a: Vec3, b: Vec3) => a.reduce((sum, value, i) => sum + value * b[i], 0);
export const norm = (a: Vec3) => Math.hypot(...a);
export const subtract = (a: Vec3, b: Vec3): Vec3 => a.map((value, i) => value - b[i]) as Vec3;
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const determinant = (cell: Lattice) => dot(cell[0], cross(cell[1], cell[2]));

export function validateLattice(cell: Lattice): Lattice {
  const volume = Math.abs(determinant(cell));
  if (cell.some(v => v.some(x => !Number.isFinite(x))) || cell.some(v => norm(v) < 1e-8)
    || !Number.isFinite(volume) || volume < 1e-8) {
    throw new Error("晶格无效或体积接近零，无法显示周期结构。");
  }
  return cell;
}

export function fractionalToCartesian(frac: Vec3, cell: Lattice): Vec3 {
  return [0, 1, 2].map(i => frac.reduce((sum, x, j) => sum + x * cell[j][i], 0)) as Vec3;
}

export function cartesianToFractional(cart: Vec3, cell: Lattice): Vec3 {
  const det = determinant(validateLattice(cell));
  return [cross(cell[1], cell[2]), cross(cell[2], cell[0]), cross(cell[0], cell[1])]
    .map(reciprocal => dot(cart, reciprocal) / det) as Vec3;
}

export function wrapFractional(frac: Vec3): Vec3 {
  return frac.map(x => {
    if (!Number.isFinite(x)) throw new Error("坐标或对称变换结果不是有限数值。");
    const wrapped = ((x % 1) + 1) % 1;
    return wrapped < 1e-10 || 1 - wrapped < 1e-10 ? 0 : wrapped;
  }) as Vec3;
}

export function latticeFromParameters(a: number, b: number, c: number, alpha: number, beta: number, gamma: number): Lattice {
  if ([a, b, c].some(x => !Number.isFinite(x) || x <= 0)
    || [alpha, beta, gamma].some(x => !Number.isFinite(x) || x <= 0 || x >= 180)) {
    throw new Error("CIF 晶格常数或夹角无效。");
  }
  const rad = Math.PI / 180;
  const ca = Math.cos(alpha * rad), cb = Math.cos(beta * rad), cg = Math.cos(gamma * rad);
  const sg = Math.sin(gamma * rad);
  const cy = c * (ca - cb * cg) / sg;
  const cz2 = c * c - (c * cb) ** 2 - cy ** 2;
  if (cz2 <= 0) throw new Error("CIF 晶格夹角不能构成有效晶胞。");
  return validateLattice([[a, 0, 0], [b * cg, b * sg, 0], [c * cb, cy, Math.sqrt(cz2)]]);
}

export function latticeParameters(cell: Lattice) {
  const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / norm(a) / norm(b)))) * 180 / Math.PI;
  return { a: norm(cell[0]), b: norm(cell[1]), c: norm(cell[2]),
    alpha: angle(cell[1], cell[2]), beta: angle(cell[0], cell[2]), gamma: angle(cell[0], cell[1]),
    volume: Math.abs(determinant(cell)) };
}

/** Exact minimum image search, bounded using reciprocal-vector norms (also works for skew cells). */
export function minimumImageDistance(a: Vec3, b: Vec3, cell: Lattice): number {
  validateLattice(cell);
  const delta = subtract(b, a);
  const initial = delta.map(x => x - Math.round(x)) as Vec3;
  let best = norm(fractionalToCartesian(initial, cell));
  const det = determinant(cell);
  const reciprocal = [cross(cell[1], cell[2]), cross(cell[2], cell[0]), cross(cell[0], cell[1])];
  const bounds = reciprocal.map((vector, i) => {
    const width = best * norm(vector) / Math.abs(det) + 1e-9;
    return [Math.ceil(delta[i] - width), Math.floor(delta[i] + width)];
  });
  const count = bounds.reduce((n, [lo, hi]) => n * (hi - lo + 1), 1);
  if (count > 100000) throw new Error("晶胞过于倾斜，周期最短距离搜索超出当前查看器限制。");
  for (let i = bounds[0][0]; i <= bounds[0][1]; i++)
    for (let j = bounds[1][0]; j <= bounds[1][1]; j++)
      for (let k = bounds[2][0]; k <= bounds[2][1]; k++)
        best = Math.min(best, norm(fractionalToCartesian([delta[0] - i, delta[1] - j, delta[2] - k], cell)));
  return best;
}

export function cellEdges(cell: Lattice, repeats = 1): [Vec3, Vec3][] {
  const edges: [Vec3, Vec3][] = [];
  for (let bits = 0; bits < 8; bits++) {
    const start = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1] as Vec3;
    for (let axis = 0; axis < 3; axis++) if (start[axis] === 0) {
      const end = [...start] as Vec3;
      end[axis] = 1;
      edges.push([fractionalToCartesian(start.map(v => v * repeats) as Vec3, cell),
        fractionalToCartesian(end.map(v => v * repeats) as Vec3, cell)]);
    }
  }
  return edges;
}

export function displayAtoms(structure: CrystalStructure, repeats: number): DisplayAtom[] {
  if (![1, 2].includes(repeats) || structure.sites.length * repeats ** 3 > MAX_STRUCTURE_SITES) {
    throw new Error(`当前显示最多支持 ${MAX_STRUCTURE_SITES} 个位点，请使用较小超胞。`);
  }
  const atoms: DisplayAtom[] = [];
  structure.sites.forEach((site, siteIndex) => {
    const element = [...site.species].sort((a, b) => b.occupancy - a.occupancy)[0].element;
    const wrapped = wrapFractional(site.fractional);
    for (let i = 0; i < repeats; i++) for (let j = 0; j < repeats; j++) for (let k = 0; k < repeats; k++) {
      atoms.push({ siteIndex, element, image: [i, j, k],
        position: fractionalToCartesian([wrapped[0] + i, wrapped[1] + j, wrapped[2] + k], structure.lattice) });
    }
  });
  return atoms;
}

export function structureComposition(structure: CrystalStructure): Record<string, number> {
  const composition: Record<string, number> = {};
  for (const site of structure.sites) for (const species of site.species)
    composition[species.element] = (composition[species.element] ?? 0) + species.occupancy;
  return composition;
}
