import { Material } from "../types";
import { createSeededRandom, hashString } from "./SeededRandom";
import type { ObjectiveDirection } from "../dataHub";
import { constrainAcquisition, feasibilityPrior } from "../synthesis/feedback";

export type AcquisitionStrategy = "Random" | "Uncertainty" | "EI" | "UCB";

export class AcquisitionFunction {
  /** EI of the augmented-Tchebycheff GP. Material price is already an objective. */
  static computeParEGO(prediction: { mean: number; std: number }, bestScalar: number): number {
    return this.expectedImprovement(prediction.mean, prediction.std, bestScalar);
  }

  static compute(
    material: Material, 
    strategy: AcquisitionStrategy, 
    bestObserved: number,
    kappa: number = 2.0,
    isCostAware: boolean = true,
    random: () => number = createSeededRandom(hashString(`${material.id}|${bestObserved}`)),
    direction: ObjectiveDirection = "max",
  ): number {
    const { mean, std } = { 
      mean: material.predictedMean ?? 0,
      std: material.predictedStd ?? 1e-6
    };

    let value = 0;
    switch (strategy) {
      case "Random":
        value = random();
        break;
      
      case "Uncertainty":
        value = std;
        break;

      case "UCB":
        value = (direction === "min" ? -mean : mean) + kappa * std;
        break;

      case "EI":
        value = direction === "min" ? this.expectedImprovement(-mean, std, -bestObserved) : this.expectedImprovement(mean, std, bestObserved);
        break;

      default:
        value = 0;
    }

    // Cost-aware BO: Acquisition per unit cost
    if (isCostAware && material.cost > 0) {
      value /= material.cost;
    }
    return constrainAcquisition(value, feasibilityPrior(material.synthesisFeedback));
  }

  private static expectedImprovement(mean: number, std: number, best: number): number {
    const delta = mean - best;
    if (!Number.isFinite(delta) || !Number.isFinite(std) || std < 0) {
      throw new RangeError("EI requires finite predictions and non-negative uncertainty");
    }
    if (std === 0) return Math.max(delta, 0);

    // EI(delta, sigma) = max(delta, 0) + sigma * [pdf(a) - a * Q(a)],
    // a = abs(delta / sigma), Q = standard normal upper-tail probability.
    const a = Math.abs(delta / std);
    if (!Number.isFinite(a)) return Math.max(delta, 0);
    let tailImprovement: number;
    if (a < 4) {
      tailImprovement = std * (this.pdf(a) - a * this.normalUpperTail(a));
    } else {
      // Mills-ratio continued fraction (NIST DLMF 7.9.1 after rescaling).
      // Evaluate the positive remainder directly to avoid subtracting nearly equal tails.
      let remainder = 0;
      for (let k = 64; k >= 1; k--) remainder = k / (a + remainder);
      tailImprovement = Math.exp(
        Math.log(std) - 0.5 * a * a - 0.5 * Math.log(2 * Math.PI)
        + Math.log(remainder) - Math.log(a + remainder),
      );
    }
    // Guard floating-point roundoff after using a consistent normal CDF and PDF.
    return Math.max(delta, 0) + Math.max(0, tailImprovement);
  }

  private static normalUpperTail(a: number): number {
    // West (2009), Figure 2: rational normal-tail approximation.
    // Used only for a < 4; larger tails use the continued fraction above.
    const numerator = [
      0.0352624965998911, 0.700383064443688, 6.37396220353165,
      33.912866078383, 112.079291497871, 221.213596169931, 220.206867912376,
    ].reduce((value, coefficient) => value * a + coefficient, 0);
    const denominator = [
      0.0883883476483184, 1.75566716318264, 16.064177579207,
      86.7807322029461, 296.564248779674, 637.333633378831,
      793.826512519948, 440.413735824752,
    ].reduce((value, coefficient) => value * a + coefficient, 0);
    return Math.exp(-0.5 * a * a) * numerator / denominator;
  }

  private static pdf(x: number): number {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }
}
