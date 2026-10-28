import { parseCif, type CifItem } from "crystcif-parse/lib/parse.js";
import { cartesianToFractional, determinant, dot, latticeFromParameters, MAX_STRUCTURE_SITES, subtract, validateLattice, wrapFractional } from "./geometry";
import { MAX_STRUCTURE_BYTES, type CrystalStructure, type Lattice, type StructureSite, type Vec3 } from "./types";
import { element } from "./elements";

export { MAX_STRUCTURE_BYTES } from "./types";

function number(value: unknown, description: string): number {
  const match = String(value ?? "").trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:\(\d+\))?([eEdD][+-]?\d+)?$/);
  if (!match) throw new Error(`${description} 缺失或不是有效数值。`);
  const result = Number(match[1] + (match[2] ?? "").replace(/[dD]/, "e"));
  if (!Number.isFinite(result)) throw new Error(`${description} 必须是有限数值。`);
  return result;
}

function vector(line: string, description: string): Vec3 {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) throw new Error(`${description} 必须包含三个分量。`);
  return parts.slice(0, 3).map(v => number(v, description)) as Vec3;
}

function parsePoscar(raw: string, filename: string): CrystalStructure {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim());
  if (lines.length < 8) throw new Error("POSCAR 内容不完整。需要晶格、元素、数量和坐标。");
  const scaleTokens = lines[1].split(/\s+/);
  if (![1, 3].includes(scaleTokens.length)) throw new Error("POSCAR 缩放行须为一个标量或三个正数。");
  const scale = scaleTokens.map(value => number(value, "缩放因子"));
  const unscaled = [2, 3, 4].map(i => vector(lines[i], "晶格向量")) as Lattice;
  // These vectors have arbitrary units until the scale is applied. Only the
  // final cell in angstroms should be subject to an absolute volume threshold.
  const unscaledVolume = Math.abs(determinant(unscaled));
  if (!Number.isFinite(unscaledVolume) || unscaledVolume === 0) throw new Error("POSCAR 原始晶格必须有限且非奇异。");
  let factors: Vec3;
  if (scale.length === 3) {
    if (scale.some(value => value <= 0)) throw new Error("三个 Cartesian 缩放因子必须全部为正。");
    factors = scale as Vec3;
  } else {
    if (scale[0] === 0) throw new Error("POSCAR 缩放因子不能为零。");
    const factor = scale[0] > 0 ? scale[0] : Math.cbrt(-scale[0] / Math.abs(determinant(unscaled)));
    factors = [factor, factor, factor];
  }
  const lattice = validateLattice(unscaled.map(row => row.map((v, i) => v * factors[i]) as Vec3) as Lattice);
  const symbols = lines[5].split(/\s+/);
  if (symbols.every(value => /^\d+$/.test(value))) {
    throw new Error("这是未列出元素的 VASP 4 格式；请先转换为带元素行的 VASP 5 POSCAR，查看器不会从标题猜测元素。");
  }
  const species = symbols.map(value => element(value));
  const countTokens = lines[6].split(/[!#]/)[0].trim().split(/\s+/);
  if (countTokens.length !== species.length || countTokens.some(value => !/^\d+$/.test(value))) throw new Error("POSCAR 元素和原子数量不匹配。");
  const counts = countTokens.map(Number);
  const count = counts.reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STRUCTURE_SITES) throw new Error(`结构需包含 1–${MAX_STRUCTURE_SITES} 个位点。`);
  let cursor = 7;
  const selective = /^s/i.test(lines[cursor]);
  if (selective) cursor++;
  const mode = lines[cursor++]?.[0]?.toLowerCase();
  if (!["d", "c", "k"].includes(mode)) throw new Error("POSCAR 坐标模式须为 Direct 或 Cartesian / K。");
  const sites: StructureSite[] = [];
  species.forEach((symbol, group) => {
    for (let index = 0; index < counts[group]; index++) {
      const line = lines[cursor++];
      if (!line) throw new Error("POSCAR 原子坐标不足。");
      const coords = vector(line, `原子 ${sites.length + 1} 坐标`);
      const fractional = mode === "d" ? coords : cartesianToFractional(coords.map((v, i) => v * factors[i]) as Vec3, lattice);
      if (fractional.some(value => !Number.isFinite(value))) throw new Error("POSCAR 坐标缩放或转换超出有限数值范围。");
      let constraints: [boolean, boolean, boolean] | undefined;
      if (selective) {
        const flags = line.split(/\s+/).slice(3, 6);
        if (flags.length !== 3 || flags.some(flag => !/^[tf]$/i.test(flag))) throw new Error("Selective dynamics 需要三个 T/F 标记。");
        constraints = flags.map(flag => /^t$/i.test(flag)) as [boolean, boolean, boolean];
      }
      sites.push({ id: `site-${sites.length}`, label: `${symbol}${index + 1}`, fractional,
        species: [{ element: symbol, occupancy: 1 }], sourceLabels: [`${sites.length + 1}`], selective: constraints });
    }
  });
  const warnings: string[] = [];
  if (selective) warnings.push("保留了 Selective dynamics 标记；其约束方向遵循 VASP 的 Direct 基矢约定。");
  if (lines.slice(cursor).some(line => line.length > 0)) warnings.push("当前仅读取结构；已忽略坐标后的速度、预测校正或其他附加段。");
  return { schemaVersion: 1, name: lines[0] || filename, lattice, sites,
    source: { filename, format: "poscar", coordinateMode: mode === "d" ? "direct" : "cartesian", symmetry: "listed-sites", warnings, raw } };
}

type Symmetry = { rotation: Lattice; shift: Vec3 };
function fraction(text: string): number {
  const parts = text.split("/");
  if (parts.length > 2) throw new Error("无效的对称平移分数。");
  const numerator = number(parts[0], "对称平移");
  const denominator = parts.length === 2 ? number(parts[1], "对称平移分母") : 1;
  if (denominator === 0) throw new Error("对称操作的分母不能为零。");
  return numerator / denominator;
}

/** Parse affine crystallographic expressions; never evaluate CIF text as JavaScript. */
function symmetry(operation: string): Symmetry {
  const components = operation.toLowerCase().replace(/\s/g, "").split(",");
  if (components.length !== 3) throw new Error(`对称操作需有三个分量：${operation}`);
  const rotation: Lattice = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const shift: Vec3 = [0, 0, 0];
  components.forEach((expr, i) => {
    const terms = expr.match(/[+-]?[^+-]+/g) ?? [];
    if (terms.length === 0 || terms.join("") !== expr) throw new Error(`无法解析对称操作：${operation}`);
    for (const term of terms) {
      const sign = term.startsWith("-") ? -1 : 1;
      const value = term.replace(/^[+-]/, "");
      const variable = value.match(/^(\d+)?\*?([xyz])$/);
      if (variable) rotation[i]["xyz".indexOf(variable[2])] += sign * Number(variable[1] ?? 1);
      else if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:\/\d+)?$/.test(value)) shift[i] += sign * fraction(value);
      else throw new Error(`不支持的对称表达式：${operation}`);
    }
  });
  const det = determinant(rotation);
  if (rotation.some(row => row.some(value => !Number.isSafeInteger(value))) || !Number.isFinite(det)
    || Math.abs(Math.abs(det) - 1) > 1e-8) throw new Error("对称操作的旋转矩阵必须为有效整数矩阵，且行列式为 ±1。");
  return { rotation, shift };
}

function cifValues(item?: CifItem): (string | number | undefined)[] {
  return item ? (Array.isArray(item.value) ? item.value : [item.value]).map(value => value.get_value()) : [];
}

function sameMetric(a: Lattice, b: Lattice): boolean {
  return a.every((row, i) => a.every((other, j) => {
    const expected = dot(row, other);
    const tolerance = 1e-4 * Math.max(1, Math.sqrt(dot(row, row) * dot(other, other)));
    return Math.abs(dot(b[i], b[j]) - expected) <= tolerance;
  }));
}

function validateSymmetryMetric(op: Symmetry, lattice: Lattice) {
  // x' = R x, with fractional column coordinates. Columns of R are the
  // transformed basis vectors; they must preserve R^T G R = G.
  const transformed = [0, 1, 2].map(i => [0, 1, 2].map(axis =>
    lattice.reduce((sum, row, j) => sum + op.rotation[j][i] * row[axis], 0)) as Vec3) as Lattice;
  if (!sameMetric(lattice, transformed)) throw new Error("CIF 对称操作不保持晶格度量，请检查晶胞参数与操作列表是否匹配。");
}

function parseCifStructures(raw: string, filename: string): CrystalStructure[] {
  if (raw.includes("#\\#CIF_2.0") || /^\s*save_/im.test(raw)) throw new Error("当前支持 CIF 1.1 结构文件；尚不支持 CIF 2.0 或 save frames。");
  const parsed = parseCif(raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  const structures: CrystalStructure[] = [];
  for (const [blockName, original] of Object.entries(parsed)) {
    const block = Object.fromEntries(Object.entries(original).map(([key, value]) => [key.toLowerCase().replace(/\./g, "_"), value]));
    const values = (...names: string[]) => cifValues(names.map(name => block[name]).find(Boolean));
    const scalar = (...names: string[]) => values(...names)[0];
    const labels = values("_atom_site_label", "_atom_site_id");
    const types = values("_atom_site_type_symbol");
    const xs = values("_atom_site_fract_x"), ys = values("_atom_site_fract_y"), zs = values("_atom_site_fract_z");
    const cx = values("_atom_site_cartn_x"), cy = values("_atom_site_cartn_y"), cz = values("_atom_site_cartn_z");
    const count = Math.max(labels.length, types.length, xs.length, cx.length);
    if (count === 0) continue; // CIFs may contain non-structural metadata blocks.
    if (count > MAX_STRUCTURE_SITES) throw new Error(`CIF 位点超过 ${MAX_STRUCTURE_SITES}，请导入较小结构。`);
    const lattice = latticeFromParameters(...["a", "b", "c", "alpha", "beta", "gamma"].map(name =>
      number(scalar(`_cell_${name.length === 1 ? "length" : "angle"}_${name}`), `晶格 ${name}`)) as [number, number, number, number, number, number]);
    const fractionalMode = xs.length > 0;
    // coreCIF defines Cartn = M * fract + v. Our Lattice stores row
    // vectors, so transpose the explicit M before using the inverse below.
    // https://www.iucr.org/__data/iucr/cifdic_html/1/cif_core.dic/Iatom_sites_Cartn_tran_matrix_.html
    let cartesianCell = lattice;
    let cartesianOrigin: Vec3 = [0, 0, 0];
    const coordinateWarnings: string[] = [];
    if (!fractionalMode) {
      const matrixValues = [1, 2, 3].flatMap(i => [1, 2, 3].map(j => scalar(`_atom_sites_cartn_tran_matrix_${i}${j}`)));
      const originValues = [1, 2, 3].map(i => scalar(`_atom_sites_cartn_tran_vector_${i}`));
      if (matrixValues.some(v => v !== undefined)) {
        if (matrixValues.some(v => v === undefined)) throw new Error("CIF Cartesian 变换矩阵不完整，需要全部九个分量。");
        const matrix = matrixValues.map(v => number(v, "Cartesian 变换矩阵"));
        cartesianCell = validateLattice([0, 1, 2].map(j => [0, 1, 2].map(i => matrix[i * 3 + j]) as Vec3) as Lattice);
        if (!sameMetric(lattice, cartesianCell)) throw new Error("CIF Cartesian 变换矩阵与声明的晶格参数不一致。");
      } else if (scalar("_atom_sites_cartn_transform_axes") !== undefined) {
        throw new Error("CIF 指定了 Cartesian 轴约定但未给出变换矩阵；请提供完整矩阵或分数坐标。");
      } else {
        coordinateWarnings.push("Cartesian 坐标未附变换矩阵，采用标准 a 沿 x、b 位于 xy 平面的晶胞约定；如原文件使用其他轴向，请先转换为分数坐标。");
      }
      if (originValues.some(v => v !== undefined)) {
        if (originValues.some(v => v === undefined)) throw new Error("CIF Cartesian 平移向量不完整。");
        cartesianOrigin = originValues.map(v => number(v, "Cartesian 平移向量")) as Vec3;
      }
    }
    const coords = fractionalMode ? [xs, ys, zs] : [cx, cy, cz];
    if (coords.some(column => column.length !== count) || (types.length && types.length !== count) || (labels.length && labels.length !== count)) throw new Error(`CIF 数据块 ${blockName} 的原子列长度不一致。`);
    const occupancy = values("_atom_site_occupancy");
    if (occupancy.length && occupancy.length !== count) throw new Error("CIF 占位列长度不一致。");
    const operations = values("_space_group_symop_operation_xyz", "_symmetry_equiv_pos_as_xyz");
    if (operations.length > 384) throw new Error("CIF 对称操作过多，超出查看器限制。");
    const symmetries = operations.length ? operations.map(value => symmetry(String(value))) : [symmetry("x,y,z")];
    symmetries.forEach(op => validateSymmetryMetric(op, lattice));
    if (!symmetries.some(op => op.rotation.every((row, i) => row.every((v, j) => v === (i === j ? 1 : 0)))
      && wrapFractional(op.shift).every(v => v === 0))) throw new Error("CIF 对称操作缺少恒等变换，请检查文件。");
    const spaceGroup = scalar("_space_group_name_h-m_alt", "_symmetry_space_group_name_h-m");
    const groupNumber = scalar("_space_group_it_number", "_symmetry_int_tables_number");
    const isP1 = String(spaceGroup ?? "").replace(/\s/g, "").toLowerCase() === "p1" || Number(groupNumber) === 1;
    const warnings: string[] = [...coordinateWarnings];
    if (!operations.length && !isP1) warnings.push("文件未提供对称操作：仅显示文件列出的位点，未依据空间群名称补全晶胞。请用 P1 完整晶胞或包含操作列表的 CIF 核对。");
    const sites: StructureSite[] = [];
    const byPosition = new Map<string, StructureSite>();
    let duplicates = false;
    for (let i = 0; i < count; i++) {
      const symbol = types.length ? element(String(types[i])) : element(String(labels[i]), true);
      const label = String(labels[i] ?? `${symbol}${i + 1}`);
      const occ = occupancy.length ? number(occupancy[i], `位点 ${label} 占位`) : 1;
      if (occ < 0 || occ > 1 + 1e-6) throw new Error(`位点 ${label} 占位须在 0 到 1 之间。`);
      if (occ === 0) continue;
      const input = coords.map((column, axis) => number(column[i], `位点 ${label} 坐标 ${axis + 1}`)) as Vec3;
      const frac = fractionalMode ? input : cartesianToFractional(subtract(input, cartesianOrigin), cartesianCell);
      const generated = new Set<string>();
      for (const op of symmetries) {
        const position = wrapFractional(op.rotation.map((row, axis) => row.reduce((sum, value, j) => sum + value * frac[j], op.shift[axis])) as Vec3);
        const key = position.map(v => Math.round(v * 1e7) % 1e7).join(":");
        if (generated.has(key)) continue; // Special positions must not multiply occupancy.
        generated.add(key);
        const existing = byPosition.get(key);
        if (existing) {
          const same = existing.species.find(species => species.element === symbol);
          if (same?.occupancy === 1 && occ === 1 && existing.species.length === 1) duplicates = true;
          else {
            if (same) throw new Error(`位点 ${label} 与已有同元素部分占位记录对称等价；请先消除冗余或转换为明确的 P1 结构，避免错误累加占位。`);
            if (existing.species.reduce((sum, item) => sum + item.occupancy, 0) + occ > 1 + 1e-6) throw new Error(`位点 ${label} 的重叠占位总和超过 1，无法可靠合并。`);
            existing.species.push({ element: symbol, occupancy: occ });
          }
          if (!existing.sourceLabels.includes(label)) existing.sourceLabels.push(label);
        } else {
          const site: StructureSite = { id: `site-${sites.length}`, label, fractional: position,
            species: [{ element: symbol, occupancy: occ }], sourceLabels: [label] };
          sites.push(site); byPosition.set(key, site);
          if (sites.length > MAX_STRUCTURE_SITES) throw new Error(`对称展开后超过 ${MAX_STRUCTURE_SITES} 个位点。`);
        }
      }
    }
    if (sites.length === 0) throw new Error(`数据块 ${blockName} 没有可显示的非零占位。`);
    if (duplicates) warnings.push("已去重重叠的满占位同元素记录；原始标签保留在位点信息中。");
    if (sites.some(site => site.species.length > 1 || site.species.reduce((sum, item) => sum + item.occupancy, 0) < 1 - 1e-6)) warnings.push("包含混占或部分占位；保留原始占位，3D 以主占位元素着色，不代表已生成有序结构。");
    structures.push({ schemaVersion: 1, name: blockName || filename, lattice, sites,
      source: { filename, format: "cif", blockName, spaceGroup: spaceGroup === undefined ? undefined : String(spaceGroup),
        symmetry: operations.length ? "expanded" : isP1 ? "p1" : "listed-sites", coordinateMode: fractionalMode ? "direct" : "cartesian", warnings, raw } });
  }
  if (structures.length === 0) throw new Error("CIF 中没有找到包含原子坐标的结构数据块。");
  return structures;
}

export function importStructures(text: string, filename: string, format: "auto" | "cif" | "poscar" = "auto"): CrystalStructure[] {
  if (!text.trim()) throw new Error("文件为空，请选择 CIF 或 POSCAR 文件。");
  if (text.length > MAX_STRUCTURE_BYTES || new TextEncoder().encode(text).byteLength > MAX_STRUCTURE_BYTES) throw new Error("文件超过 5 MB，请使用较小结构文件。");
  if (text.includes("\0")) throw new Error("文件包含二进制内容；请使用文本 CIF 或 POSCAR。");
  const cif = format === "cif" || (format === "auto" && (/\.cif$/i.test(filename) || /^\s*data_/im.test(text)));
  return cif ? parseCifStructures(text, filename) : [parsePoscar(text, filename)];
}
