import assert from "node:assert/strict";
import test from "node:test";
import { SurrogateModel } from "../src/engine/SurrogateModel";
import { DEFAULT_MODEL_CONFIG, MODEL_CATALOG, modelConfig } from "../src/engine/models/config";
import { gaussianProcess } from "../src/engine/models/regressors";
import { seededRandom } from "../src/engine/models/math";

const point = (x: number, y: number) => ({ features: [x, 7], trueProperty: y });
const training = Array.from({ length: 41 }, (_, i) => { const x = -2 + i / 10; return point(x, x * x); });
const queries = Array.from({ length: 40 }, (_, i) => { const x = -1.95 + i / 10; return point(x, x * x); });
const rmse = (predictions: { mean: number }[], data = queries) => Math.sqrt(predictions.reduce((sum, p, i) => sum + (p.mean - data[i].trueProperty) ** 2, 0) / data.length);

for (const { id } of MODEL_CATALOG) {
  test(`${id}: deterministic, finite, immutable and learns from changed labels`, async () => {
    const data = structuredClone(training);
    const snapshot = structuredClone(data);
    const first = new SurrogateModel({ kind: id });
    await first.train(data);
    const prediction = first.predictBatch(queries);
    assert.equal(prediction.length, queries.length);
    prediction.forEach(p => assert.ok(Number.isFinite(p.mean) && Number.isFinite(p.std) && p.std >= 0));
    assert.deepEqual(data, snapshot);
    const second = new SurrogateModel({ kind: id });
    await second.train(data);
    assert.deepEqual(second.predictBatch(queries), prediction);
    await first.train(data.map(p => ({ ...p, trueProperty: p.trueProperty + 12 })));
    const shifted = first.predictBatch(queries);
    shifted.forEach((p, i) => assert.ok(Math.abs(p.mean - prediction[i].mean - 12) < 1e-8));
    assert.equal(first.diagnostics!.samples, 41);
  });
  test(`${id}: single point, constant targets and duplicate features remain finite`, async () => {
    const model = new SurrogateModel({ kind: id });
    for (const data of [[point(0, 3)], [point(0, 3), point(0, 3), point(0, 3)], [point(0, 2), point(0, 4)]]) {
      await model.train(data);
      const result = model.predict(point(5, 999));
      assert.ok(Number.isFinite(result.mean) && Number.isFinite(result.std));
      assert.ok(result.std >= 0);
    }
    await assert.rejects(model.train([]), RangeError);
    assert.throws(() => model.predict(point(0, 0)), /Train/);
  });
}

test("GP posterior agrees with closed-form one-observation reference and uncertainty grows away", () => {
  const gp = gaussianProcess([[0]], [2], modelConfig({ noise: 0.1 }));
  for (const x of [0, 0.5, 2, 8]) {
    const k = Math.exp(-x * x / 2), variance = 1 + 0.01 + 1e-10;
    const p = gp.predict([x]);
    assert.ok(Math.abs(p.mean - 2 * k / variance) < 1e-12);
    assert.ok(Math.abs(p.std ** 2 - (1 - k * k / variance)) < 1e-12);
  }
  assert.ok(gp.predict([0]).std < gp.predict([0.5]).std);
  assert.ok(gp.predict([0.5]).std < gp.predict([8]).std);
  // Observation variance would add 0.01; this API deliberately returns latent variance.
  assert.ok(gp.predict([0]).std ** 2 < 0.01);
});

test("GP two-observation posterior matches an independent 2x2 inverse", () => {
  const config = modelConfig({ noise: 0.2 });
  const gp = gaussianProcess([[-1], [1]], [-1, 2], config);
  const diagonal = 1.04 + 1e-10, offDiagonal = Math.exp(-0.5);
  const determinant = diagonal ** 2 - offDiagonal ** 2;
  const k0 = Math.exp(-(1.5 ** 2) / 8), k1 = Math.exp(-(0.5 ** 2) / 8);
  const expectedMean = (k0 * (-diagonal - 2 * offDiagonal) + k1 * (offDiagonal + 2 * diagonal)) / determinant;
  const expectedVariance = 1 - (diagonal * (k0 * k0 + k1 * k1) - 2 * offDiagonal * k0 * k1) / determinant;
  const actual = gp.predict([0.5]);
  assert.ok(Math.abs(actual.mean - expectedMean) < 1e-12);
  assert.ok(Math.abs(actual.std ** 2 - expectedVariance) < 1e-12);
});

test("nonlinear regressors fit an unseen quadratic better than the linear baseline", async () => {
  const errors: Record<string, number> = {};
  for (const { id } of MODEL_CATALOG) {
    const model = new SurrogateModel({ kind: id });
    await model.train(training);
    errors[id] = rmse(model.predictBatch(queries));
  }
  assert.ok(errors.gpr < 0.15, JSON.stringify(errors));
  for (const kind of ["random-forest", "extra-trees", "gradient-boosting", "knn"]) {
    assert.ok(errors[kind] < errors["linear-ensemble"] * 0.65, JSON.stringify(errors));
  }
});

test("feature units and target units are handled using training-only standardization", async () => {
  for (const kind of ["gpr", "ridge", "knn"] as const) {
    const first = new SurrogateModel({ kind }), second = new SurrogateModel({ kind });
    await first.train(training);
    await second.train(training.map(p => ({ features: [p.features[0] * 1000 + 500, 7], trueProperty: 3 * p.trueProperty - 5 })));
    const a = first.predict(point(0.75, -1));
    const b = second.predict({ features: [1250, 7] });
    assert.ok(Math.abs(b.mean - (3 * a.mean - 5)) < 1e-8);
    assert.ok(Math.abs(b.std - 3 * a.std) < 1e-8);
  }
});

test("constant ensemble predictions have zero spread without an arbitrary floor", async () => {
  const model = new SurrogateModel({ kind: "ridge" });
  await model.train(Array.from({ length: 12 }, (_, i) => point(i, 5)));
  assert.deepEqual(model.predict(point(8, 999)), { mean: 5, std: 0 });
});

test("invalid dimensions, numbers, configurations and resource overflow are rejected", async () => {
  for (const config of [{ kind: "fake" }, { trees: 10000 }, { seed: -1 }, { noise: 0 }, { lengthScale: NaN }]) {
    assert.throws(() => new SurrogateModel(config as never), RangeError);
  }
  const model = new SurrogateModel();
  await assert.rejects(model.train([{ features: [], trueProperty: 0 }]), RangeError);
  await assert.rejects(model.train([point(0, 1), { features: [1], trueProperty: 2 }]), RangeError);
  await assert.rejects(model.train([point(NaN, 1)]), RangeError);
  await assert.rejects(model.train([point(0, Infinity)]), RangeError);
  await assert.rejects(model.train(Array.from({ length: 257 }, (_, i) => point(i, 0))), RangeError);
  await model.train(training);
  assert.throws(() => model.predict({ features: [1] }), RangeError);
  assert.throws(() => model.predict({ features: [Infinity, 7] }), RangeError);
  assert.throws(() => model.predictBatch(new Array(20001).fill(point(0, 1))), RangeError);
});

test("seeded sampling is reproducible and seed-sensitive", () => {
  const a = seededRandom(42), b = seededRandom(42), c = seededRandom(43);
  const draws = Array.from({ length: 100 }, a);
  assert.deepEqual(draws, Array.from({ length: 100 }, b));
  assert.notDeepEqual(draws, Array.from({ length: 100 }, c));
  assert.ok(draws.every(x => x >= 0 && x < 1));
  assert.equal(DEFAULT_MODEL_CONFIG.kind, "gpr");
});

test("SGD remains bounded on sparse high-leverage features at supported sample limits", async () => {
  for (const size of [256, 1024]) {
    const model = new SurrogateModel({ kind: "linear-ensemble" });
    await model.train(Array.from({ length: size }, (_, i) => ({ features: [i === size - 1 ? 1 : 0], trueProperty: i === size - 1 ? 1 : 0 })));
    const result = model.predict({ features: [1] });
    assert.ok(Number.isFinite(result.mean) && Math.abs(result.mean) < 2, JSON.stringify(result));
    assert.ok(Number.isFinite(result.std) && result.std < 2);
  }
});

test("adjacent floating-point descriptors cannot create empty CART leaves", async () => {
  const data = [-10, 1, 1 + Number.EPSILON].flatMap((value, i) => Array.from({ length: 4 }, () => ({ features: [value], trueProperty: [-10, 0, 1][i] })));
  for (const kind of ["random-forest", "extra-trees", "gradient-boosting"] as const) {
    const model = new SurrogateModel({ kind });
    await model.train(data);
    const p = model.predict({ features: [2] });
    assert.ok(Number.isFinite(p.mean) && Number.isFinite(p.std));
  }
});

test("kNN handles extreme but finite training scales without squared-distance overflow", async () => {
  const model = new SurrogateModel({ kind: "knn" });
  await model.train([{ features: [0], trueProperty: 0 }, { features: [1e-160], trueProperty: 1 }]);
  const p = model.predict({ features: [1] });
  assert.ok(Number.isFinite(p.mean) && Number.isFinite(p.std));
  assert.ok(p.mean >= 0 && p.mean <= 1);
});

test("sparse feature arrays are rejected", async () => {
  await assert.rejects(new SurrogateModel().train([{ features: new Array(2), trueProperty: 1 }]), RangeError);
});
