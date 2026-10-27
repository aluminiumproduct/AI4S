import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { MaterialsEngine } from "../src/engine/MaterialsEngine";
import { SurrogateModel } from "../src/engine/SurrogateModel";
import { runActiveLearningStep } from "../src/engine/ActiveLearningLoop";
import { DEFAULT_MODEL_CONFIG, MODEL_CATALOG } from "../src/engine/models/config";
import { buildAdvisorContext } from "../src/services/AdvisorContext";
import { state } from "./fixtures";

test("all seven models integrate deterministic 22D data, sampling and advisor snapshots", async t => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(axios, "get", async () => { throw new Error("offline fixture"); });
  const engine = new MaterialsEngine();
  await engine.loadRealData(20);
  const original = engine.getPool();
  assert.ok(original.every(m => m.source === "mock" && m.targetKind === "synthetic-score" && m.features.length === 22));
  for (const { id } of MODEL_CATALOG) {
    const config = { ...DEFAULT_MODEL_CONFIG, kind: id };
    const execute = async () => {
      const model = new SurrogateModel(config);
      const options = { totalBudget: 10, batchSize: 2, strategy: "Random" as const };
      const initial = await runActiveLearningStep(original, state(), options, model);
      const selected = await runActiveLearningStep(initial.pool, initial.state, options, model);
      assert.equal(selected.state.sampledCount - initial.state.sampledCount, 2, id);
      return selected;
    };
    const first = await execute(), repeated = await execute();
    assert.deepEqual(first.pool, repeated.pool, id);
    assert.equal(first.state.sampledCount, 7);
    const candidates = first.pool.filter(m => !m.isSampled);
    assert.ok(candidates.every(m => Number.isFinite(m.predictedMean) && Number.isFinite(m.predictedStd)));
    const context = buildAdvisorContext({ pool: first.pool, state: first.state, strategy: "Random",
      batchSize: 2, totalBudget: 10, isRealData: false, runId: 1, modelConfig: config }, candidates[0].id);
    assert.equal(context.learning.model_config.kind, id);
    assert.equal(context.selected_material?.features.length, 22);
    assert.ok(!Object.hasOwn(context.selected_material!, "observed_value"));
  }
  assert.ok(original.every(m => !m.isSampled && m.predictedMean === undefined));
});
