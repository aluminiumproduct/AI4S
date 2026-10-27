import type { ALState, Material } from "../src/types";

export function material(index = 0, overrides: Partial<Material> = {}): Material {
  return {
    id: `test-${index}`,
    formula: "Li2O",
    composition: { Li: 2, O: 1 },
    features: [2 / 3, 1 / 3, 0, 0, 0, 0, 0, 0, 0.2, 0.3, 4],
    trueProperty: index + 1,
    cost: 1,
    isSampled: false,
    ...overrides,
  };
}

export function state(overrides: Partial<ALState> = {}): ALState {
  return { iteration: 0, budget: 50, sampledCount: 0, bestValue: -Infinity, history: [], ...overrides };
}

export function realResponse(ids: string[]) {
  return {
    data: {
      data: ids.map((id, i) => ({
        material_id: id,
        formula_pretty: "Li2O",
        elements: ["Li", "O"],
        composition: { Li: 2, O: 1 },
        band_gap: i + 1,
        formation_energy_per_atom: -1,
      })),
    },
  };
}
