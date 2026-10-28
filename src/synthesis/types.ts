import type { CrystalStructure } from "../structures/types";

export interface XrdPoint { twoTheta: number; intensity: number }
export interface XrdPeak extends XrdPoint { hkl: string; d: number }
export interface XrdPattern {
  name: string; peaks: XrdPeak[]; profile: XrdPoint[];
  wavelength: string; min: number; max: number; fwhm: number;
}
export interface XrdResult { pattern: XrdPattern; references: XrdPattern[]; engine: string }
export interface PreflightResult {
  grade: "A" | "B" | "C"; label: string; score: number;
  energyAboveHull: number; formationEnergy: number | null;
  source: "materials-project" | "demo"; temperature: number; atmosphere: string;
  competitors: { formula: string; role: string }[];
  factors: { name: string; score: number }[];
}
export interface ComparisonResult {
  score: number; mainFraction: number; passed: boolean; shift: number; rmse: number;
  peakCoverage: number; phases: { name: string; percent: number; target: boolean }[];
  experimentalPeaks: XrdPoint[]; unmatchedPeaks: XrdPoint[];
  observed: XrdPoint[]; fitted: XrdPoint[]; residual: XrdPoint[];
}
export interface SynthesisFeedback {
  materialId: string; formula: string; status: "pass" | "impurity";
  score: number; mainFraction: number; prior: number; sampleId: string;
  filename: string; createdAt: string; demo: boolean;
}
export interface ExperimentRecord {
  id: string; materialId: string; formula: string; filename: string;
  createdAt: string; demo: boolean; temperature: number; atmosphere: string;
  points: XrdPoint[]; comparison: ComparisonResult; feedback?: SynthesisFeedback;
  reference: { structure: CrystalStructure; xrd: XrdResult; preflight: PreflightResult | null };
}
export interface LabRequest {
  requestId: number; materialId?: string; formula?: string;
  composition?: Record<string, number>; source?: "materials-project" | "mock";
  structure?: CrystalStructure;
}
