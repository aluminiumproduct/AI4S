import type { Material } from "../types";
import type { SynthesisFeedback } from "./types";

export function feasibilityPrior(feedback?: SynthesisFeedback): number {
  return feedback ? Math.max(.05, Math.min(1, feedback.prior)) : 1;
}

export function constrainAcquisition(score: number, prior: number): number {
  const factor = Math.max(.05, Math.min(1, prior));
  return score >= 0 ? score*factor : score/factor;
}

export function applySynthesisFeedback(pool: Material[], feedback: SynthesisFeedback): Material[] {
  return pool.map(material => {
    if (material.id !== feedback.materialId) return material;
    const oldPrior = feasibilityPrior(material.synthesisFeedback);
    const value = material.acquisitionValue;
    const base = value === undefined ? undefined : value >= 0 ? value/oldPrior : value*oldPrior;
    return { ...material, synthesisFeedback: { ...feedback },
      acquisitionValue: base === undefined ? undefined : constrainAcquisition(base, feasibilityPrior(feedback)) };
  });
}

const KEY = "ai4s-synthesis-feedback-v1";
export function loadFeedbackRegistry(): Record<string, SynthesisFeedback> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
export function saveFeedbackRegistry(registry: Record<string, SynthesisFeedback>) {
  try { localStorage.setItem(KEY, JSON.stringify(registry)); } catch { /* Session feedback still works. */ }
}

export function restoreFeedback(pool: Material[], registry: Record<string, SynthesisFeedback>): Material[] {
  return Object.values(registry).reduce((current, feedback) => applySynthesisFeedback(current, feedback), pool);
}
