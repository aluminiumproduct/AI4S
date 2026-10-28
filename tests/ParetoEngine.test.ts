import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { AcquisitionFunction } from "../src/engine/AcquisitionFunction";
import { SurrogateModel } from "../src/engine/SurrogateModel";
import { MaterialsEngine } from "../src/engine/MaterialsEngine";
import { demoCandidates, materialCandidates, PARETO_SCALES, parseStabilityInputs } from "../src/engine/pareto/ParetoData";
import { PRICE_BOOK, materialPrice, parsePriceOverrides } from "../src/engine/pareto/priceBook";
import { dominates, hypervolume, INITIAL_PARETO_STATE, normalizeWeights, paretoFront, preferredCandidate, runParetoStep, scalarize, type Objectives, type ParetoCandidate, type ParetoSurrogate } from "../src/engine/pareto/ParetoEngine";

function candidate(id: string, objectives: Objectives, observed = true): ParetoCandidate {
  return { id, formula: id, composition: { Al: 1, Co: 1 }, features: [id.length, objectives[0] / 100], objectives,
    source: "demo", stabilitySource: "fixture", priceQuality: "reference", observed };
}
const config = { budget: 10, weights: [50, 25, 25] as [number, number, number], scales: PARETO_SCALES.demo, seed: 42 };
const fake: ParetoSurrogate = { train() {}, predictBatch(points) { return points.map((_, i) => ({ mean: i / 100, std: 0.1 })); } };

test("Pareto dominance uses max performance and min hull/price, retaining equal non-dominating points", () => {
  assert.equal(dominates([80, 0.02, 10], [70, 0.03, 12]), true);
  assert.equal(dominates([80, 0.02, 10], [80, 0.02, 10]), false);
  assert.equal(dominates([80, 0.02, 10], [90, 0.03, 12]), false);
  const a = candidate("a", [80, 0.02, 10]), b = candidate("b", [70, 0.03, 12]), twin = candidate("c", a.objectives);
  const hidden = candidate("secret", [100, 0, 0], false);
  assert.deepEqual(paretoFront([a, b, twin, hidden]).map(c => c.id), ["a", "c"]);
  assert.deepEqual(paretoFront([]), []);
});

test("exact 3D hypervolume matches independent box-union arithmetic and excludes hidden labels", () => {
  const scales = { performance: 1, hull: 1, price: Math.E - 1 };
  const a = candidate("a", [0.5, 0.5, Math.expm1(0.5)]);
  const b = candidate("b", [0.75, 0.75, Math.expm1(0.5)]);
  assert.ok(Math.abs(hypervolume([a], scales) - 0.125) < 1e-12);
  assert.ok(Math.abs(hypervolume([a, b], scales) - 0.15625) < 1e-12);
  assert.equal(hypervolume([a, candidate("hidden", [1, 0, 0], false)], scales), hypervolume([a], scales));
  assert.equal(hypervolume([], scales), 0);
});

test("preference changes select distinct observed compromises without changing history or hypervolume", () => {
  const pool = demoCandidates().map(c => ({ ...c, observed: true }));
  const before = JSON.stringify(pool), hv = hypervolume(pool, config.scales);
  const flagship = preferredCandidate(pool, [90, 7, 3], config.scales)!;
  const value = preferredCandidate(pool, [35, 15, 50], config.scales)!;
  assert.notEqual(flagship.id, value.id);
  assert.ok(flagship.objectives[0] > value.objectives[0]);
  assert.ok(flagship.objectives[2] > value.objectives[2]);
  assert.equal(JSON.stringify(pool), before);
  assert.equal(hypervolume(pool, config.scales), hv);
});

test("price is mass-weighted, formula-scale invariant and preserves missing-price semantics", () => {
  const expected = (PRICE_BOOK.Al.mass * PRICE_BOOK.Al.usdKg + 2 * PRICE_BOOK.Co.mass * PRICE_BOOK.Co.usdKg) / (PRICE_BOOK.Al.mass + 2 * PRICE_BOOK.Co.mass);
  assert.ok(Math.abs(materialPrice({ Al: 1, Co: 2 }).usdKg! - expected) < 1e-12);
  assert.equal(materialPrice({ Al: 1, Co: 2 }).usdKg, materialPrice({ Al: 10, Co: 20 }).usdKg);
  assert.equal(materialPrice({ Al: 1 }).quality, "reference");
  assert.equal(materialPrice({ Al: 1 }, { Al: 2 }).quality, "scenario");
  assert.equal(materialPrice({ Al: 1 }, { Al: 0 }).usdKg, 0);
  assert.equal(materialPrice({ Al: 1, Xe: 1 }).usdKg, null);
  assert.deepEqual(materialPrice({ Al: 1, Xe: 1 }).missing, ["Xe"]);
  assert.throws(() => materialPrice({ Al: -1 }));
  assert.throws(() => materialPrice({ Al: 1 }, { Al: NaN }));
  const custom = parsePriceOverrides('{"Si":3,"Xe":7}');
  assert.equal(materialPrice({ Si: 1 }, custom).usdKg, 3);
  assert.notEqual(materialPrice({ Al: 1, Xe: 1 }, custom).usdKg, null);
  assert.throws(() => parsePriceOverrides('{"Xx":3}'));
});

test("preference weights and augmented Tchebycheff scalarization are finite and directional", () => {
  assert.deepEqual(normalizeWeights([0, 0, 0]), [1 / 3, 1 / 3, 1 / 3]);
  assert.deepEqual(normalizeWeights([1e308, 1e308, 0]), [0.5, 0.5, 0]);
  assert.throws(() => normalizeWeights([-1, 1, 1]));
  assert.throws(() => normalizeWeights([1, Infinity, 1]));
  assert.ok(scalarize([100, 0, 0], [1, 1, 1], config.scales) > scalarize([50, 0.1, 10], [1, 1, 1], config.scales));
  assert.throws(() => scalarize([1, -1, 2], [1, 1, 1], config.scales));
  assert.throws(() => scalarize([NaN, 1, 2], [1, 1, 1], config.scales));
  assert.equal(AcquisitionFunction.computeParEGO({ mean: 2, std: 0 }, 1), 1);
});

test("ParEGO initializes and then adds one observation per round, reproducibly without mutation", async () => {
  const execute = async () => {
    let pool = demoCandidates(), state = INITIAL_PARETO_STATE();
    const original = JSON.stringify(pool);
    const first = await runParetoStep(pool, state, config, fake);
    assert.equal(JSON.stringify(pool), original);
    assert.equal(first.state.history[0].observed, 6);
    assert.equal(first.pool.filter(c => c.observed && Object.keys(c.composition).length === 1).length, 6);
    pool = first.pool; state = first.state;
    while (pool.filter(c => c.observed).length < config.budget) {
      const result = await runParetoStep(pool, state, config, fake);
      assert.equal(result.state.history.at(-1)!.observed, state.history.at(-1)!.observed + 1);
      assert.ok(result.state.history.at(-1)!.hypervolume + 1e-14 >= state.history.at(-1)!.hypervolume);
      pool = result.pool; state = result.state;
    }
    const done = await runParetoStep(pool, state, config, fake);
    assert.equal(done.done, true); assert.equal(done.state, state);
    return { pool, state };
  };
  assert.deepEqual(await execute(), await execute());
});

test("ParEGO fits only scalarized acquired labels and predicts with features only", async () => {
  const pool = demoCandidates().map((c, i) => ({ ...c, observed: i < 6 }));
  let calls = 0;
  await runParetoStep(pool, INITIAL_PARETO_STATE(), config, {
    train(data) { calls++; assert.equal(data.length, 6); for (const p of data) { assert.deepEqual(Object.keys(p).sort(), ["features", "trueProperty"]); assert.ok(Number.isFinite(p.trueProperty)); } },
    predictBatch(data) { for (const p of data) assert.deepEqual(Object.keys(p), ["features"]); return data.map(() => ({ mean: 0, std: 0.1 })); },
  });
  assert.equal(calls, 1);
});

test("cancellation and malformed predictions cannot commit partial observations", async () => {
  const pool = demoCandidates().map((c, i) => ({ ...c, observed: i < 6 })), before = JSON.stringify(pool);
  const controller = new AbortController();
  await assert.rejects(runParetoStep(pool, INITIAL_PARETO_STATE(), { ...config, signal: controller.signal }, {
    train() { controller.abort(); }, predictBatch() { throw new Error("must not predict"); },
  }), { name: "AbortError" });
  for (const output of [[], [{ mean: NaN, std: 0 }]]) {
    await assert.rejects(runParetoStep(pool, INITIAL_PARETO_STATE(), config, { train() {}, predictBatch() { return output; } }));
  }
  await assert.rejects(runParetoStep(pool, INITIAL_PARETO_STATE(), config, { train() {}, predictBatch(points) { return points.map(() => ({ mean: 0, std: -1 })); } }));
  assert.equal(JSON.stringify(pool), before);
});

test("new weights re-scalarize all history and exact GPR handles the 22D demo pipeline", async () => {
  let pool = demoCandidates(), state = INITIAL_PARETO_STATE();
  const model = new SurrogateModel({ kind: "gpr" });
  const labels: number[][] = [];
  const wrapped: ParetoSurrogate = { train(data) { labels.push(data.map(p => p.trueProperty)); return model.train(data); }, predictBatch(data) { return model.predictBatch(data); } };
  for (let i = 0; i < 4; i++) { const next = await runParetoStep(pool, state, config, wrapped); pool = next.pool; state = next.state; }
  assert.equal(pool.filter(c => c.observed).length, 9);
  assert.equal(model.diagnostics?.dimensions, 22);
  assert.notDeepEqual(labels[0], labels[1].slice(0, labels[0].length));
});

test("MP hull zero is preserved; optional missing hull does not force the original engine to Mock", async t => {
  t.mock.method(axios, "get", async () => ({ data: { data: [0, null, undefined].map((hull, i) => ({ material_id: `mp-${i}`, formula_pretty: "Li2O", composition: { Li: 2, O: 1 }, band_gap: 2 + i, formation_energy_per_atom: -1, energy_above_hull: hull })) } }));
  const engine = new MaterialsEngine();
  assert.equal(await engine.loadRealData(3), true);
  const pool = engine.getPool();
  assert.equal(pool[0].energyAboveHull, 0);
  assert.equal(pool[0].formationEnergyPerAtom, -1);
  assert.equal(pool[1].energyAboveHull, null);
  assert.equal(pool[2].energyAboveHull, null);
  assert.equal(materialCandidates(pool).candidates.length, 1);
  assert.equal(materialCandidates(pool).missingStability, 2);
  const imported = parseStabilityInputs('[{"materialId":"mp-1","energyAboveHull":0.03,"source":"MLIP evaluation","method":"same-model phase diagram","referenceSet":"fixture-v1"}]');
  assert.equal(materialCandidates(pool, {}, imported).candidates.length, 2);
  assert.match(materialCandidates(pool, {}, imported).candidates[1].stabilitySource, /fixture-v1/);
  assert.throws(() => parseStabilityInputs('[{"materialId":"mp-1","energyAboveHull":-1}]'));
  assert.throws(() => parseStabilityInputs('{}'));
});

test("budget and duplicate-ID validation and a small pool terminate without phantom rounds", async () => {
  await assert.rejects(runParetoStep(demoCandidates(), INITIAL_PARETO_STATE(), { ...config, budget: 0 }, fake));
  const row = demoCandidates()[0];
  await assert.rejects(runParetoStep([row, row], INITIAL_PARETO_STATE(), config, fake));
  const small = await runParetoStep(demoCandidates().slice(0, 3), INITIAL_PARETO_STATE(), config, fake);
  assert.equal(small.done, true); assert.equal(small.state.history[0].observed, 3);
  const empty = await runParetoStep([], INITIAL_PARETO_STATE(), config, fake);
  assert.equal(empty.done, true); assert.equal(empty.state.history.length, 0);
});
