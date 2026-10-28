import { demoCandidates, PARETO_SCALES } from "../src/engine/pareto/ParetoData";
import { hypervolume, INITIAL_PARETO_STATE, runParetoStep } from "../src/engine/pareto/ParetoEngine";
import { SurrogateModel } from "../src/engine/SurrogateModel";

const budget = 30, results = [];
const oracle = hypervolume(demoCandidates().map(c => ({ ...c, observed: true })), PARETO_SCALES.demo);
for (const seed of [11, 22, 33, 44, 55, 66, 77, 88]) {
  for (const strategy of ["ParEGO", "Random"] as const) {
    let pool = demoCandidates(), state = INITIAL_PARETO_STATE(), done = false;
    const model = new SurrogateModel({ kind: "gpr", seed }), started = performance.now();
    while (!done) { const next = await runParetoStep(pool, state, { budget, seed, weights: [50, 25, 25], scales: PARETO_SCALES.demo, strategy }, model); pool = next.pool; state = next.state; done = next.done; }
    const hv = state.history.at(-1)!.hypervolume;
    results.push({ seed, strategy, observed: budget, hypervolume: hv, oracleCoveragePercent: hv / oracle * 100, elapsedMs: performance.now() - started });
  }
}
console.log(JSON.stringify({ dataset: "deterministic six-metal demonstration, not real-material performance validation", budget, oracleHypervolume: oracle, results }, null, 2));
