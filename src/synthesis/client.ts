import type { CrystalStructure } from "../structures/types";
import type { ComparisonResult, XrdPoint, XrdResult } from "./types";

export async function synthesisRequest<T>(operation: string, payload: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/synthesis/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "分析暂时不可用");
  return result;
}

export function xrdPayload(structure: CrystalStructure, options = {}) {
  return { structure: { name: structure.name, lattice: structure.lattice, sites: structure.sites }, options };
}

export function parseExperimentalSpectrum(text: string): XrdPoint[] {
  const rows = new Map<number, number[]>();
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!;]/.test(line)) continue;
    const fields = line.trim().split(/[,;\t\s]+/);
    const x = Number(fields[0]), y = Number(fields[1]);
    if (fields.length < 2 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > 180) continue;
    const values = rows.get(x) ?? []; values.push(y); rows.set(x, values);
  }
  const points = [...rows].sort(([a], [b]) => a-b).map(([twoTheta, values]) => ({ twoTheta, intensity: values.reduce((a, b) => a+b, 0)/values.length }));
  if (points.length < 8) throw new Error("需要至少 8 个有效数据点；文件应包含 2θ 和强度两列。");
  if (points.length > 100_000) throw new Error("请使用不超过 100000 点的谱图。");
  return points;
}

export function spectrumText(points: XrdPoint[]): string {
  return "# 2theta(deg) intensity\n" + points.map(p => `${p.twoTheta.toFixed(4)}\t${p.intensity.toFixed(5)}`).join("\n");
}

export function compareSpectrum(result: XrdResult, points: XrdPoint[], signal?: AbortSignal) {
  return synthesisRequest<ComparisonResult>("compare", { pattern: result.pattern, references: result.references, points }, signal);
}

export function sameComposition(a: Record<string, number>, b: Record<string, number>): boolean {
  const entries = (composition: Record<string, number>) => Object.entries(composition).filter(([, amount]) => amount > 0);
  const aa = entries(a), bb = entries(b);
  const totalA = aa.reduce((sum, [, n]) => sum+n, 0), totalB = bb.reduce((sum, [, n]) => sum+n, 0);
  return aa.length === bb.length && totalA > 0 && totalB > 0 && aa.every(([el, n]) => Math.abs(n/totalA-(b[el] || 0)/totalB) < 1e-8);
}
export function isStrontiumTitanate(composition: Record<string, number>): boolean {
  return sameComposition(composition, { Sr: 1, Ti: 1, O: 3 });
}
export function demoCrystal(composition: Record<string, number> = { Sr: 1, Ti: 1, O: 3 }): CrystalStructure {
  const strontium = isStrontiumTitanate(composition);
  const rows = strontium
    ? [{ element: "Sr", fractional: [0, 0, 0] }, { element: "Ti", fractional: [.5, .5, .5] },
      { element: "O", fractional: [.5, .5, 0] }, { element: "O", fractional: [.5, 0, .5] }, { element: "O", fractional: [0, .5, .5] }]
    : Object.entries(composition).flatMap(([element, amount]) => Array.from({ length: Math.max(1, Math.min(16, Math.round(amount))) }, () => ({ element, fractional: [0, 0, 0] })));
  const side = strontium ? 3.905 : Math.max(4, Math.cbrt(rows.length*23));
  const n = Math.ceil(Math.cbrt(rows.length));
  const sites = rows.map((row, i) => ({ id: `demo-${i}`, label: `${row.element}${i+1}`, sourceLabels: [`${row.element}${i+1}`],
    fractional: (strontium ? row.fractional : [(i%n+.2)/n, (Math.floor(i/n)%n+.2)/n, (Math.floor(i/n/n)+.2)/n]) as [number, number, number],
    species: [{ element: row.element, occupancy: 1 }] }));
  return { schemaVersion: 1, name: strontium ? "SrTiO₃ · 演示晶胞" : "候选组成 · 演示构型", lattice: [[side, 0, 0], [0, side, 0], [0, 0, side]], sites,
    source: { filename: "demo.POSCAR", format: "poscar", symmetry: "p1", warnings: ["演示构型"], raw: "" } };
}
