import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionFunction } from "../src/engine/AcquisitionFunction";
import { material } from "./fixtures";

function ei(delta: number, sigma: number, cost = 1, costAware = false) {
  return AcquisitionFunction.compute(
    material(0, { predictedMean: delta, predictedStd: sigma, cost }), "EI", 0, 2, costAware,
  );
}

// Independent Gaussian EI references, calculated at high precision, not by this implementation.
const references = [
  [-8, 7.550262411946499e-17],
  [-3, 0.0003821543170477236],
  [-2, 0.008490702616829638],
  [-1, 0.0833154705876863],
  [0, 0.3989422804014327],
  [1, 1.0833154705876863],
  [2, 2.0084907026168296],
  [3, 3.0003821543170477],
  [8, 8],
];

for (const [delta, expected] of references) {
  test(`EI matches the Gaussian reference at delta=${delta}`, () => {
    const actual = ei(delta, 1);
    assert.ok(actual >= 0 && Number.isFinite(actual));
    assert.ok(Math.abs(actual - expected) <= Math.max(1e-30, expected * 1e-11), `${actual} != ${expected}`);
  });
}

test("zero uncertainty uses deterministic improvement", () => {
  assert.equal(ei(-1, 0), 0);
  assert.equal(ei(0, 0), 0);
  assert.equal(ei(1, 0), 1);
});

test("tiny positive uncertainty preserves scaling and finite limits", () => {
  assert.ok(Math.abs(ei(-2e-12, 1e-12) / 8.490702616829638e-15 - 1) < 1e-11);
  assert.equal(ei(1, Number.MIN_VALUE), 1);
  assert.equal(ei(-1, Number.MIN_VALUE), 0);
});

test("EI applies the existing optional cost normalization", () => {
  assert.ok(Math.abs(ei(-2, 1, 4, true) - 0.0021226756542074094) < 1e-14);
  assert.equal(ei(1, 0, 4, true), 0.25);
  assert.equal(ei(1, 0, 4, false), 1);
  assert.equal(ei(1, 0, 0, true), 1);
});

test("EI rejects invalid uncertainty instead of silently ranking NaN", () => {
  for (const sigma of [-1, NaN, Infinity]) assert.throws(() => ei(0, sigma), RangeError);
});

test("other strategies keep their score and cost behavior", () => {
  const candidate = material(0, { predictedMean: 3, predictedStd: 0.5, cost: 2 });
  assert.equal(AcquisitionFunction.compute(candidate, "UCB", 0), 2);
  assert.equal(AcquisitionFunction.compute(candidate, "Uncertainty", 0), 0.25);
});
