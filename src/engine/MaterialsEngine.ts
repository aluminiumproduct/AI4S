import axios from "axios";
import { Material } from "../types";
import type { MPData } from "../services/MaterialsProjectService";
import { extractCompositionFeatures } from "./CompositionFeatures";
import { createSeededRandom } from "./SeededRandom";

function formulaCost(composition: Record<string, number>) {
  const count = Object.values(composition).reduce((sum, amount) => sum + amount, 0);
  if (!Number.isFinite(count)) throw new RangeError("Invalid formula size");
  return 1 + count * 0.2; // Formula-size proxy, not measured DFT hours.
}

/**
 * Real Materials Engine interfacing with Materials Project.
 */
export class MaterialsEngine {
  private pool: Material[] = [];
  private globalMax: number = 0;
  private loadVersion = 0;
  private isRealData = false;

  private replacePool(pool: Material[], isRealData: boolean) {
    this.pool = pool;
    this.globalMax = pool.reduce((max, material) => Math.max(max, material.trueProperty), -Infinity);
    if (pool.length === 0) this.globalMax = 0;
    this.isRealData = isRealData;
  }

  async loadRealData(limit: number = 150): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("Material count must be a non-negative integer");
    }
    const version = ++this.loadVersion;
    try {
      const response = await axios.get(`/api/materials?limit=${limit}`);
      const data: MPData[] = response.data.data;
      
      const pool = data.map(m => {
        const { features, descriptors } = extractCompositionFeatures(m.composition);
        if (!Number.isFinite(m.band_gap)) throw new RangeError("Invalid band gap");

        return {
          id: m.material_id,
          formula: m.formula_pretty,
          composition: m.composition,
          features,
          descriptors,
          targetKind: "band-gap" as const,
          trueProperty: m.band_gap, 
          cost: formulaCost(m.composition),
          isSampled: false,
        };
      });

      // Only the latest request owns the dataset, including its global maximum.
      if (version !== this.loadVersion) return this.isRealData;
      this.replacePool(pool, true);
      return true;
    } catch (e) {
      if (version !== this.loadVersion) return this.isRealData;
      console.warn("Failed to load real data from API, falling back to mock.");
      this.replacePool(this.generateMockPool(limit), false);
      return false;
    }
  }

  private generateMockPool(size: number): Material[] {
    const pool: Material[] = [];
    const random = createSeededRandom(0x4d4f434b);
    const elements = ["Li", "La", "Zr", "O", "P", "S", "Ge", "Sn"];
    const examples: Record<string, number>[] = [
      { Li: 2, O: 1 }, { Sr: 1, Ti: 1, O: 3 }, { Ba: 1, Zr: 1, O: 3 },
      { Li: 3, P: 1, O: 4 }, { Li: 7, La: 3, Zr: 2, O: 12 },
    ];
    for (let i = 0; i < size; i++) {
      const composition: Record<string, number> = { ...examples[i] };
      if (i >= examples.length) {
        const selected = [...elements];
        for (let j = selected.length - 1; j > 0; j--) {
          const k = Math.floor(random() * (j + 1));
          [selected[j], selected[k]] = [selected[k], selected[j]];
        }
        const count = 2 + Math.floor(random() * 3);
        selected.slice(0, count).forEach(symbol => { composition[symbol] = 1 + Math.floor(random() * 5); });
      }
      const formula = Object.entries(composition).map(([el, count]) => `${el}${count > 1 ? count : ""}`).join("");
      const { features, descriptors } = extractCompositionFeatures(composition);
      // Synthetic, deterministic demonstration score, not a physical band gap.
      const stats = descriptors.statistics;
      const syntheticScore = (stats.electronegativityPauling.variance ?? 0)
        + 0.05 * (stats.chemicalHardnessEv.mean ?? 0) + 0.02 * (stats.valenceElectrons.mean ?? 0);
      // Keep two records per composition, labelled replicas rather than invented polymorphs.
      for (let p = 0; p < 2; p++) {
        pool.push({
          id: `mock-${i}-${p}`, 
          formula: p === 1 ? `${formula} (replica)` : formula,
          composition, 
          features: [...features],
          descriptors,
          targetKind: "synthetic-score",
          trueProperty: syntheticScore,
          cost: formulaCost(composition),
          isSampled: false 
        });
      }
    }
    return pool;
  }

  getPool() { return this.pool; }
  getGlobalMax() { return this.globalMax; }
}
