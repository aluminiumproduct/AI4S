import assert from "node:assert/strict";
import test from "node:test";
import { getStopReason, runActiveLearningStep, type StepConfig, type Surrogate } from "../src/engine/ActiveLearningLoop";
import { SurrogateModel } from "../src/engine/SurrogateModel";
import type { Material } from "../src/types";
import { material, state } from "./fixtures";

const config: StepConfig = { totalBudget: 50, batchSize: 2, strategy: "UCB", random: () => 0 };
const fakeModel: Surrogate = {
  train() {},
  predict() { return { mean: 1, std: 0.25 }; },
};
const pool = (size: number) => Array.from({ length: size }, (_, i) => material(i));

for (const size of [0, 1, 2, 3, 4, 5]) {
  test(`initial sampling is bounded for pool size ${size}, even with a constant RNG`, async () => {
    let trainingCalls = 0;
    const result = await runActiveLearningStep(pool(size), state(), config, {
      ...fakeModel, train() { trainingCalls++; },
    });
    const expected = Math.min(size, 5);
    assert.equal(result.state.sampledCount, expected);
    assert.equal(result.pool.filter(m => m.isSampled).length, expected);
    assert.equal(result.state.history.length, size === 0 ? 0 : 1);
    assert.equal(trainingCalls, size === 0 ? 0 : 1);
    assert.equal(result.advanced, size > 0);
    assert.ok(size === 0 || Number.isFinite(result.state.bestValue));
  });
}

for (const totalBudget of [0, 1, 4, 5]) {
  test(`initial samples cannot exceed budget ${totalBudget}`, async () => {
    const result = await runActiveLearningStep(pool(20), state(), { ...config, totalBudget }, fakeModel);
    assert.equal(result.state.sampledCount, totalBudget);
    assert.equal(result.stopReason, "budget-exhausted");
  });
}

test("default budget finishes at exactly 50 with a one-sample final batch", async () => {
  let currentPool = pool(100);
  let currentState = state();
  const changes: number[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await runActiveLearningStep(currentPool, currentState, config, fakeModel);
    if (!result.advanced) break;
    changes.push(result.state.sampledCount - currentState.sampledCount);
    currentPool = result.pool;
    currentState = result.state;
    assert.equal(currentState.sampledCount, currentPool.filter(m => m.isSampled).length);
    assert.ok(currentState.sampledCount <= 50);
  }
  assert.equal(currentState.sampledCount, 50);
  assert.equal(currentState.iteration, 24); // MAX_ITERATIONS is not silently enabled.
  assert.equal(changes[0], 5);
  assert.equal(changes.at(-1), 1);
  assert.equal(new Set(currentPool.filter(m => m.isSampled).map(m => m.id)).size, 50);
  assert.equal(getStopReason(currentPool, 50), "budget-exhausted");
});

test("a batch larger than the remaining budget is truncated", async () => {
  const options = { ...config, totalBudget: 10, batchSize: 20 };
  const first = await runActiveLearningStep(pool(50), state(), options, fakeModel);
  const second = await runActiveLearningStep(first.pool, first.state, options, fakeModel);
  assert.equal(second.state.sampledCount, 10);
  assert.equal(second.stopReason, "budget-exhausted");
});

test("pool exhaustion stops without phantom samples or extra history", async () => {
  const first = await runActiveLearningStep(pool(7), state(), config, fakeModel);
  const second = await runActiveLearningStep(first.pool, first.state, { ...config, batchSize: 20 }, fakeModel);
  assert.equal(second.state.sampledCount, 7);
  assert.equal(second.stopReason, "candidates-exhausted");
  const third = await runActiveLearningStep(second.pool, second.state, config, fakeModel);
  assert.equal(third.advanced, false);
  assert.equal(third.state.sampledCount, 7);
  assert.equal(third.state.history.length, 2);
  assert.equal(third.state.iteration, 2);
});

test("actual sampled records override a stale counter", async () => {
  const candidates = pool(20).map((m, i) => ({ ...m, isSampled: i < 5 }));
  const result = await runActiveLearningStep(candidates, state({ iteration: 1, sampledCount: 999 }),
    { ...config, totalBudget: 8, batchSize: 20 }, fakeModel);
  assert.equal(result.state.sampledCount, 8);
});

test("first step only seeds; a new batch trains on the following step", async () => {
  const sizes: number[] = [];
  const model = { ...fakeModel, train(data: Material[]) { sizes.push(data.length); } };
  const first = await runActiveLearningStep(pool(20), state(), config, model);
  const second = await runActiveLearningStep(first.pool, first.state, config, model);
  await runActiveLearningStep(second.pool, second.state, config, model);
  assert.deepEqual(sizes, [5, 5, 7]);
  assert.ok(first.pool.filter(m => m.isSampled).every(m => m.iteration === 0));
});

test("a pending step never mutates the caller's pool or history", async () => {
  const originalPool = pool(8);
  originalPool.forEach(Object.freeze);
  Object.freeze(originalPool);
  const originalState = state();
  Object.freeze(originalState.history);
  Object.freeze(originalState);
  let finish!: () => void;
  const pending = runActiveLearningStep(originalPool, originalState, config, {
    ...fakeModel, train: () => new Promise<void>(resolve => { finish = resolve; }),
  });
  assert.ok(originalPool.every(m => !m.isSampled));
  assert.equal(originalState.sampledCount, 0);
  finish();
  const result = await pending;
  assert.notEqual(result.pool, originalPool);
  assert.equal(result.state.sampledCount, 5);
  assert.equal(originalState.history.length, 0);
});

test("EI steps with the actual surrogate remain finite and respect the budget", async () => {
  const options = { ...config, totalBudget: 8, strategy: "EI" as const };
  const model = new SurrogateModel();
  let result = await runActiveLearningStep(pool(12), state(), options, model);
  while (result.stopReason === null) result = await runActiveLearningStep(result.pool, result.state, options, model);
  assert.equal(result.state.sampledCount, 8);
  assert.ok(result.pool.filter(m => !m.isSampled).every(m => Number.isFinite(m.acquisitionValue) && m.acquisitionValue! >= 0));
  assert.ok(result.state.history.every(point => Number.isFinite(point.regret)));
});

test("invalid counts and invalid RNG values are rejected rather than looping", async () => {
  for (const options of [{ ...config, totalBudget: -1 }, { ...config, batchSize: 0 }, { ...config, initialSamples: 0 }, { ...config, random: () => 1 }]) {
    await assert.rejects(runActiveLearningStep(pool(10), state(), options, fakeModel), RangeError);
  }
});

test("batch predictions are awaited once, ordered, and never receive hidden candidate labels", async () => {
  let calls = 0;
  const model: Surrogate = {
    train() {},
    async predictBatch(candidates) {
      calls++;
      assert.ok(candidates.every(candidate => Object.keys(candidate).join() === "features"));
      return candidates.map((_, index) => ({ mean: index, std: 0 }));
    },
  };
  const result = await runActiveLearningStep(pool(9), state(), config, model);
  const unsampled = result.pool.filter(m => !m.isSampled);
  assert.equal(calls, 1);
  assert.deepEqual(unsampled.map(m => m.predictedMean), [0, 1, 2, 3]);
});

test("single-point compatibility path also hides candidate labels and metadata", async () => {
  let predictions = 0;
  await runActiveLearningStep(pool(9), state(), config, {
    train() {},
    predict(candidate) {
      assert.deepEqual(Object.keys(candidate), ["features"]);
      predictions++;
      return { mean: 1, std: 1 };
    },
  });
  assert.equal(predictions, 4);
});

test("cancellation after training prevents prediction and leaves caller state untouched", async () => {
  const controller = new AbortController();
  const original = pool(9);
  let calls = 0;
  await assert.rejects(runActiveLearningStep(original, state(), { ...config, signal: controller.signal }, {
    train() { controller.abort(); },
    predictBatch() { calls++; return []; },
  }), { name: "AbortError" });
  assert.equal(calls, 0);
  assert.ok(original.every(m => !m.isSampled));
});

test("cancellation during batch prediction prevents committing stale results", async () => {
  const controller = new AbortController(), original = pool(9);
  await assert.rejects(runActiveLearningStep(original, state(), { ...config, signal: controller.signal }, {
    train() {},
    async predictBatch(candidates) { controller.abort(); return candidates.map(() => ({ mean: 1, std: 1 })); },
  }), { name: "AbortError" });
  assert.ok(original.every(m => !m.isSampled));
});

test("malformed batch outputs cannot change the pool", async () => {
  for (const predictBatch of [() => [], candidates => candidates.map(() => ({ mean: NaN, std: 1 })),
    candidates => candidates.map(() => ({ mean: 1, std: -1 }))]) {
    const original = pool(8);
    await assert.rejects(runActiveLearningStep(original, state(), config, { train() {}, predictBatch }));
    assert.ok(original.every(m => !m.isSampled));
  }
});
