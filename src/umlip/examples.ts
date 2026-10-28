import { importStructures } from "../structures/importStructure";
import { examplePoscar } from "../structures/examples";
import { fromCrystalStructure } from "./configurations";
import type { ConfigurationInput } from "./types";

/** Explicitly generated ideal/perturbed coordinates; no energy or DFT truth is supplied. */
export function demoConfigurations(): ConfigurationInput[] {
  const base = fromCrystalStructure(importStructures(examplePoscar, "SrTiO3_ideal_demo.POSCAR")[0]);
  const offsets = [[], [[2, 0, 0.02]], [[2, 0, -0.02]], [[1, 0, 0.025]], [[2, 1, 0.03], [3, 0, -0.02]], [[1, 2, -0.02], [4, 1, 0.025]]];
  return offsets.map((changes, index) => {
    const structure = structuredClone(base);
    for (const [atom, axis, delta] of changes) structure.fractional[atom][axis] += delta;
    return { id: `demo-${index}`, name: index === 0 ? "SrTiO₃ · 理想坐标" : `SrTiO₃ · 位移扰动 ${index}`,
      source: "Generated ideal/perturbed SrTiO3 coordinates; not DFT or experimentally validated polymorphs", structure };
  });
}
