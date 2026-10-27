import assert from "node:assert/strict";
import test from "node:test";
import { advisorCandidates, advisorMessages, buildAdvisorContext, type AdvisorInput } from "../src/services/AdvisorContext";
import { material, state } from "./fixtures";

function input(overrides: Partial<AdvisorInput> = {}): AdvisorInput {
  return { pool: [], state: state(), strategy: "UCB", batchSize: 2, totalBudget: 50, isRealData: true, runId: 1, ...overrides };
}

test("advisor serializes the best observed material but no unsampled oracle labels or oracle regret", () => {
  const observed = material(1, { id: "mp-observed", source: "materials-project", isSampled: true, trueProperty: 5.5, iteration: 0 });
  const hidden = material(2, { id: "mp-candidate", source: "materials-project", trueProperty: 98765, predictedMean: 4, predictedStd: 0.7, acquisitionValue: 3 });
  const context = buildAdvisorContext(input({ pool: [observed, hidden], state: state({ iteration: 1, history: [{ iteration: 1, bestValue: 5.5, avgError: 999, regret: 98759.5 }] }) }), hidden.id);
  assert.equal(context.best_observed_material?.id, observed.id);
  assert.equal(context.best_observed_material?.observed_value, 5.5);
  assert.equal(context.selected_material?.id, hidden.id);
  assert.ok(!Object.hasOwn(context.selected_material!, "observed_value"));
  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes("98765"));
  assert.ok(!serialized.includes("98759.5"));
  assert.ok(!serialized.includes('"trueProperty"'));
  assert.deepEqual(context.convergence, [{ iteration: 1, best_observed_value: 5.5 }]);
});

test("Top-3 uses existing cost-aware scores, including zero and negative values, without mutation or rerandomization", () => {
  const pool = [material(1, { acquisitionValue: -1 }), material(2, { acquisitionValue: 0 }), material(3, { acquisitionValue: 4 }), material(4, { acquisitionValue: 6, isSampled: true }), material(5)];
  for (const m of pool.slice(0, 4)) { m.predictedMean = 1; m.predictedStd = 0.2; }
  const before = JSON.stringify(pool);
  assert.deepEqual(advisorCandidates(pool).map(m => m.id), ["test-3", "test-2", "test-1"]);
  assert.deepEqual(advisorCandidates(pool).map(m => m.id), ["test-3", "test-2", "test-1"]);
  assert.equal(JSON.stringify(pool), before);
});

test("real and Mock feature orders, normalization and simulated provenance are explicit", () => {
  const real = buildAdvisorContext(input({ pool: [material(1, { isSampled: true })] })).best_observed_material!;
  const mockContext = buildAdvisorContext(input({ isRealData: false, pool: [material(1, { isSampled: true, source: "mock" })] }));
  const mock = mockContext.best_observed_material!;
  assert.equal(real.features[1].name, "O_atomic_fraction");
  assert.equal(mock.features[1].name, "La_count_divided_by_10");
  assert.match(mock.features[1].provenance, /not normalized/);
  for (const descriptor of [...real.features.slice(8), ...mock.features.slice(8)]) assert.match(descriptor.provenance, /SIMULATED/);
  assert.match(real.cost.provenance, /not measured/);
  assert.match(mockContext.objective.unit, /^arbitrary/);
  assert.match(mockContext.learning.uncertainty, /not a calibrated confidence/);
});

test("context is a detached snapshot and ignores missing or nonfinite predictions", () => {
  const row = material(1, { isSampled: true, predictedMean: NaN, predictedStd: Infinity });
  const source = input({ pool: [row], state: state({ iteration: 3 }) });
  const context = buildAdvisorContext(source, row.id);
  const captured = JSON.stringify(context);
  row.features[0] = 100; row.composition.Li = 400; row.trueProperty = 200;
  source.state.iteration = 8;
  assert.equal(JSON.stringify(context), captured);
  assert.equal(context.selected_material?.prediction_mean_mu, null);
  assert.equal(context.selected_material?.uncertainty_sigma, null);
  assert.equal(context.learning.iteration, 3);
});

test("empty and untrained pools do not invent a winner or a recommendation", () => {
  const empty = buildAdvisorContext(input());
  assert.equal(empty.best_observed_material, null);
  assert.deepEqual(empty.top_candidates, []);
  assert.equal(empty.selected_material, null);
  assert.deepEqual(buildAdvisorContext(input({ pool: [material()] })).top_candidates, []);
});

test("advisor exposes the actual scoring rule and identifies composition lost by the limited feature vector", () => {
  const row = material(1, { composition: { Li: 2, O: 1, Br: 1 }, source: "materials-project" });
  const context = buildAdvisorContext(input({ pool: [row] }), row.id);
  assert.equal(context.learning.score_formula, "(mu + 2 * sigma) / estimated_cost");
  assert.deepEqual(context.selected_material?.composition_elements_missing_from_feature_vector, ["Br"]);
  assert.match(buildAdvisorContext(input({ strategy: "Random" })).learning.score_formula, /not a performance ranking/);
});

test("multibyte history is bounded while retaining the current snapshot and scientific evidence policy", () => {
  const context = buildAdvisorContext(input({ pool: [material(1)] }));
  const history = Array.from({ length: 30 }, (_, i) => ({ question: `question-${i}`, answer: "研究建议".repeat(3000), iteration: i }));
  const messages = advisorMessages("比较当前候选", context, history, "zh");
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /random descriptors are not physical evidence/);
  assert.match(messages[0].content, /Do not invent citations/);
  assert.match(messages.at(-1)!.content, /比较当前候选/);
  assert.match(messages.at(-1)!.content, /"run_id":1/);
  assert.ok(new TextEncoder().encode(JSON.stringify({ messages })).length <= 85_000);
  assert.ok(messages.length <= 14);
});
