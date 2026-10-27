import axios from "axios";
import { Material } from "../types";
import type { MPData } from "../services/MaterialsProjectService";
import { networkIssueCode, type NetworkIssueCode } from "../services/NetworkStatus";

/**
 * Real Materials Engine interfacing with Materials Project.
 */
export class MaterialsEngine {
  private pool: Material[] = [];
  private globalMax: number = 0;
  private loadVersion = 0;
  private isRealData = false;
  private activeRequest: AbortController | undefined;
  private loadIssue: NetworkIssueCode | null = null;

  private replacePool(pool: Material[], isRealData: boolean) {
    this.pool = pool;
    this.globalMax = pool.reduce((max, material) => Math.max(max, material.trueProperty), -Infinity);
    if (pool.length === 0) this.globalMax = 0;
    this.isRealData = isRealData;
  }

  /**
   * Enhanced featurizer including structural descriptors.
   * 1-8: Atomic fractions
   * 9: Electronegativity Difference (Simulated)
   * 10: Lattice Distortion (Simulated)
   * 11: Coordination Number (Simulated)
   */
  private featurize(mpData: MPData): number[] {
    const elements = ["Li", "O", "P", "S", "Ge", "Sn", "La", "Zr"];
    const features = new Array(elements.length + 3).fill(0);
    
    const totalAtoms = Object.values(mpData.composition).reduce((a: number, b: number) => a + b, 0);
    elements.forEach((el, i) => {
      features[i] = (mpData.composition[el] || 0) / totalAtoms;
    });

    // Simulated Structural Descriptors (in real life, these would come from MP or matminer)
    features[elements.length] = Math.random(); // Electronegativity Difference
    features[elements.length + 1] = Math.random(); // Lattice Distortion
    features[elements.length + 2] = Math.floor(Math.random() * 6) + 4; // Coordination Number

    return features;
  }

  async loadRealData(limit: number = 150): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("Material count must be a non-negative integer");
    }
    const version = ++this.loadVersion;
    this.activeRequest?.abort();
    const controller = new AbortController();
    this.activeRequest = controller;
    this.loadIssue = null;
    try {
      const response = await axios.get(`/api/materials?limit=${limit}`, { signal: controller.signal, timeout: 65_000 });
      const data: MPData[] = response.data.data;
      if (!Array.isArray(data)) throw Object.assign(new Error("Invalid materials response"), { code: "BAD_RESPONSE" });
      
      const pool = data.map(m => {
        const features = this.featurize(m);
        // Cost is proportional to the number of atoms (simulating DFT complexity)
        const totalAtoms = Object.values(m.composition).reduce((a, b) => a + b, 0);
        const cost = 1 + (totalAtoms * 0.2) + (features[features.length - 1] * 0.1); 

        return {
          id: m.material_id,
          formula: m.formula_pretty,
          composition: m.composition,
          features,
          trueProperty: m.band_gap, 
          cost,
          isSampled: false,
        };
      });

      // Only the latest request owns the dataset, including its global maximum.
      if (version !== this.loadVersion) return this.isRealData;
      this.replacePool(pool, true);
      return true;
    } catch (e) {
      if (version !== this.loadVersion) return this.isRealData;
      if (controller.signal.aborted || axios.isCancel(e)) return this.isRealData;
      const error = e as { code?: string; response?: { data?: { code?: string } } };
      this.loadIssue = networkIssueCode(error.response?.data?.code
        ?? (error.code === "ECONNABORTED" ? "TIMEOUT" : error.code));
      console.warn(`Materials unavailable (${this.loadIssue}); using mock data.`);
      this.replacePool(this.generateMockPool(limit), false);
      return false;
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }

  private generateMockPool(size: number): Material[] {
    const pool: Material[] = [];
    const elements = ["Li", "La", "Zr", "O", "P", "S", "Ge", "Sn"];
    for (let i = 0; i < size; i++) {
      const composition: Record<string, number> = {};
      const numElements = 2 + Math.floor(Math.random() * 3);
      const selected = [...elements].sort(() => 0.5 - Math.random()).slice(0, numElements);
      selected.forEach(el => { composition[el] = Math.floor(Math.random() * 5) + 1; });
      const formula = Object.entries(composition).map(([el, count]) => `${el}${count > 1 ? count : ""}`).join("");
      
      // Generate 2 polymorphs for each composition to demonstrate structural sensitivity
      for (let p = 0; p < 2; p++) {
        const structuralFeatures = [
          Math.random(), // Electronegativity Diff
          Math.random(), // Lattice Distortion
          Math.floor(Math.random() * 6) + 4 // Coordination Number
        ];
        
        const compositionFeatures = elements.map(el => (composition[el] || 0) / 10);
        const features = [...compositionFeatures, ...structuralFeatures];
        
        const liContent = composition["Li"] || 0;
        // Performance depends on both Li content AND structural features
        // e.g. Lattice distortion (features[9]) and Coordination (features[10])
        const trueProperty = (liContent * 0.5) + (features[9] * 2) + (features[10] * 0.1) + Math.random();
        
        const totalAtoms = Object.values(composition).reduce((a, b) => a + b, 0);
        const cost = 1 + (totalAtoms * 0.3) + (p * 0.5); // Polymorph 2 might be more complex

        pool.push({
          id: `mock-${i}-${p}`, 
          formula: p === 1 ? `${formula} (β)` : formula, 
          composition, 
          features, 
          trueProperty, 
          cost,
          isSampled: false 
        });
      }
    }
    return pool;
  }

  getPool() { return this.pool; }
  getGlobalMax() { return this.globalMax; }
  getLoadIssue() { return this.loadIssue; }
  cancelLoad() {
    this.loadVersion++;
    this.activeRequest?.abort();
    this.activeRequest = undefined;
  }
}
