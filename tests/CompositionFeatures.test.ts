import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import {
  ELEMENT_SYMBOLS, FEATURE_DEFINITIONS, PROPERTY_DEFINITIONS, extractCompositionFeatures,
  getElementConstants, normalizeComposition, calculateToleranceFactor,
} from "../src/engine/CompositionFeatures";
import { MaterialsEngine } from "../src/engine/MaterialsEngine";
import { SurrogateModel } from "../src/engine/SurrogateModel";
import { createSeededRandom } from "../src/engine/SeededRandom";

function close(actual: number | null, expected: number, tolerance = 1e-12) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} != ${expected}`);
}

test("offline table has 118 elements, explicit missing data and reference-ion metadata", () => {
  assert.equal(ELEMENT_SYMBOLS.length, 118);
  assert.equal(getElementConstants("Li")?.electronegativityPauling, 0.98);
  assert.equal(getElementConstants("O")?.covalentRadiusAngstrom, 0.66);
  assert.equal(getElementConstants("Li")?.referenceIon?.oxidationState, 1);
  assert.equal(getElementConstants("Li")?.referenceIon?.coordinationNumber, 6);
  assert.equal(getElementConstants("Li")?.referenceIon?.radiusAngstrom, 0.76);
  assert.equal(getElementConstants("Bk")?.covalentRadiusAngstrom, null); // No ASE 2.0 missing placeholder.
  assert.equal(getElementConstants("He")?.electronegativityPauling, null);
  assert.equal(getElementConstants("Xx"), undefined);
  for (const symbol of ELEMENT_SYMBOLS) {
    const row = getElementConstants(symbol)!;
    if (row.firstIonizationEnergyEv !== null && row.electronAffinityEv !== null) {
      close(row.chemicalHardnessEv, (row.firstIonizationEnergyEv - row.electronAffinityEv) / 2);
    }
    if (row.referenceIon) assert.ok(row.ionicRadii.some(ion => JSON.stringify(ion) === JSON.stringify(row.referenceIon)));
  }
});

test("valence counts obey the declared main/d/f-block convention", () => {
  for (const [symbol, count] of Object.entries({ He: 2, O: 6, Al: 3, Fe: 8, Cu: 11, Zn: 12, Ga: 3, La: 3, Er: 14, Lu: 17 })) {
    assert.equal(getElementConstants(symbol)?.valenceElectrons, count, symbol);
  }
});

test("built-in constants cannot be mutated through the lookup API", () => {
  const lithium = getElementConstants("Li")!;
  assert.throws(() => { (lithium as { electronegativityPauling: number }).electronegativityPauling = 5; }, TypeError);
  assert.throws(() => { lithium.ionicRadii.push(lithium.ionicRadii[0]); }, TypeError);
  assert.equal(getElementConstants("Li")!.electronegativityPauling, 0.98);
});

test("Li2O weighted statistics match hand calculations in physical units", () => {
  const { descriptors, features } = extractCompositionFeatures({ Li: 2, O: 1 });
  const en = descriptors.statistics.electronegativityPauling;
  close(en.mean, 1.8);
  close(en.variance, 1.3448);
  close(en.range, 2.46);
  assert.equal(en.coverage, 1);
  close(descriptors.statistics.covalentRadiusAngstrom.mean, (2 * 1.28 + 0.66) / 3);
  close(descriptors.statistics.covalentRadiusAngstrom.variance, 2 / 9 * 0.62 ** 2);
  close(descriptors.statistics.referenceIonicRadiusAngstrom.mean, (2 * 0.76 + 1.4) / 3);
  close(descriptors.statistics.valenceElectrons.mean, 8 / 3);
  close(getElementConstants("Li")!.chemicalHardnessEv, 2.386832888);
  assert.equal(features.length, 22);
  assert.equal(features.length, FEATURE_DEFINITIONS.length);
  close(features[0], 1.8 / 4);
  close(features[1], 1.3448 / 16);
  assert.deepEqual(features.slice(-2), [0, 0]);
});

test("normalization is independent of ordering, formula scale and zero entries", () => {
  const first = extractCompositionFeatures({ Li: 2, O: 1 });
  const second = extractCompositionFeatures({ O: 10, Li: 20, Fe: 0 });
  first.features.forEach((value, i) => close(value, second.features[i]));
  assert.deepEqual(first.descriptors.fractions, second.descriptors.fractions);
  assert.deepEqual(normalizeComposition({ Li: 1e308, O: 1e308 }), { Li: 0.5, O: 0.5 });
});

test("a single element has zero population variance and range", () => {
  const { descriptors } = extractCompositionFeatures({ Fe: 1 });
  for (const property of PROPERTY_DEFINITIONS) {
    assert.equal(descriptors.statistics[property.key].variance, 0);
    assert.equal(descriptors.statistics[property.key].range, 0);
  }
});

test("missing values stay unavailable instead of averaging only the known atoms", () => {
  const { descriptors, features } = extractCompositionFeatures({ Li: 1, He: 1 });
  const stats = descriptors.statistics.electronegativityPauling;
  assert.deepEqual(stats, { mean: null, variance: null, range: null, coverage: 0.5, missingElements: ["He"] });
  assert.deepEqual(features.slice(0, 4), [0, 0, 0, 0.5]);
  assert.ok(features.every(Number.isFinite));
  assert.notEqual(descriptors.statistics.covalentRadiusAngstrom.mean, null);
});

test("Goldschmidt SrTiO3 uses Sr CN12, Ti CN6 and O CN6, with explicit assumptions", () => {
  const { descriptors, features } = extractCompositionFeatures({ Sr: 1, Ti: 1, O: 3 });
  const t = descriptors.toleranceFactor;
  close(t.value, (1.44 + 1.4) / (Math.SQRT2 * (0.605 + 1.4)));
  assert.equal(t.status, "reference-ABO3");
  assert.equal(t.model?.a.coordinationNumber, 12);
  assert.equal(t.model?.a.radiusAngstrom, 1.44);
  assert.equal(t.model?.b.coordinationNumber, 6);
  assert.equal(getElementConstants("Sr")?.referenceIon?.radiusAngstrom, 1.18); // Statistics use the separate CN6 reference.
  close(features[20], t.value! / 2);
  assert.equal(features[21], 1);
});

test("tolerance is invariant to formula scaling and honors an explicit spin model", () => {
  const high = extractCompositionFeatures({ La: 1, Fe: 1, O: 3 }).descriptors.toleranceFactor;
  const scaled = extractCompositionFeatures({ O: 6, Fe: 2, La: 2 }).descriptors.toleranceFactor;
  close(scaled.value, high.value!);
  assert.equal(high.model?.b.spin, "High Spin");
  const low = extractCompositionFeatures({ La: 1, Fe: 1, O: 3 }, { a: "La", b: "Fe", aOxidation: 3, bOxidation: 3, bSpin: "Low Spin" }).descriptors.toleranceFactor;
  assert.equal(low.model?.b.radiusAngstrom, 0.55);
  assert.notEqual(low.value, high.value);
});

test("non-ABO3, missing coordination and unbalanced reference charges never get a fake tolerance", () => {
  for (const composition of [{ Li: 2, O: 1 }, { Sr: 1, Ti: 1, O: 2 }, { Mg: 1, Si: 1, O: 3 }, { Na: 1, Ca: 1, O: 3 }]) {
    const { descriptors, features } = extractCompositionFeatures(composition);
    assert.equal(descriptors.toleranceFactor.value, null);
    assert.deepEqual(features.slice(-2), [0, 0]);
  }
});

test("bad compositions fail explicitly", () => {
  for (const bad of [{}, { Li: 0 }, { Xx: 1 }, { Li: -1 }, { Li: NaN }, { Li: Infinity }, { Li: "2" }, null, []]) {
    assert.throws(() => extractCompositionFeatures(bad as Record<string, number>));
    assert.throws(() => calculateToleranceFactor(bad as Record<string, number>));
  }
});

test("real and Mock paths use identical composition features, without Math randomness", async t => {
  t.mock.method(Math, "random", () => { throw new Error("Uncontrolled randomness is forbidden"); });
  t.mock.method(console, "warn", () => {});
  let realRows: { material_id: string; formula_pretty: string; composition: Record<string, number>; band_gap: number }[] | null = null;
  t.mock.method(axios, "get", async () => {
    if (realRows === null) throw new Error("offline fixture");
    return { data: { data: realRows } };
  });
  const engine = new MaterialsEngine();
  await engine.loadRealData(10);
  const mock = engine.getPool().map(row => structuredClone(row));
  assert.deepEqual(mock[0].features, mock[1].features);
  assert.equal(mock[0].trueProperty, mock[1].trueProperty);
  realRows = mock.map(row => ({ material_id: row.id, formula_pretty: row.formula, composition: row.composition, band_gap: 2.5 }));
  await engine.loadRealData(20);
  engine.getPool().forEach((row, i) => {
    assert.deepEqual(row.features, mock[i].features);
    assert.deepEqual(row.descriptors, mock[i].descriptors);
    assert.equal(row.targetKind, "band-gap");
  });
});

test("Mock data and actual surrogate predictions are reproducible and finite", async t => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(axios, "get", async () => { throw new Error("offline fixture"); });
  const first = new MaterialsEngine(), second = new MaterialsEngine();
  await first.loadRealData(100);
  await second.loadRealData(100);
  assert.deepEqual(first.getPool(), second.getPool());
  const data = first.getPool();
  const model = new SurrogateModel();
  await model.train(data.slice(0, 20));
  const predictions = data.map(row => model.predict(row));
  assert.ok(predictions.every(p => Number.isFinite(p.mean) && Number.isFinite(p.std)));
  await model.train(data.slice(0, 20));
  assert.deepEqual(data.map(row => model.predict(row)), predictions);
});

test("invalid physical input is reported as bad data rather than a network failure", async t => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(axios, "get", async () => ({ data: { data: [{ material_id: "invalid", formula_pretty: "Xx", composition: { Xx: 1 }, band_gap: 2 }] } }));
  const engine = new MaterialsEngine();
  assert.equal(await engine.loadRealData(1), false);
  assert.equal(engine.getLoadIssue(), "BAD_RESPONSE");
  assert.ok(engine.getPool().every(record => record.targetKind === "synthetic-score"));
});

test("explicit seeded generators are repeatable and bounded", () => {
  const first = createSeededRandom(42), second = createSeededRandom(42);
  for (let i = 0; i < 1000; i++) {
    const value = first();
    assert.equal(value, second());
    assert.ok(value >= 0 && value < 1);
  }
});

test("application source contains no calls to the global random generator", () => {
  function inspect(directory: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) inspect(path);
      else if (/\.(tsx?|jsx?)$/.test(item.name)) assert.doesNotMatch(readFileSync(path, "utf8"), /\bMath\s*\.\s*random\s*\(/, path);
    }
  }
  inspect(fileURLToPath(new URL("../src", import.meta.url)));
});
