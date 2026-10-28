import assert from "node:assert/strict";
import test from "node:test";
import { extractCompositionFeatures } from "../src/engine/CompositionFeatures";
import { DEFAULT_MODEL_CONFIG } from "../src/engine/models/config";
import { buildDistillationSnapshot, compositionGroup, parseSupplements, PHYSICAL_FEATURES } from "../src/engine/distillation/features";
import { dimensionText, evaluateExpression, expressionDimension, formatExpression } from "../src/engine/distillation/expressions";
import { freezePartitions } from "../src/engine/distillation/partitions";
import { fitSparseLinear, lassoCoefficients, searchPhysicalFormulas, splitCompositionGroups } from "../src/engine/distillation/search";
import type { Material } from "../src/types";
import type { DistillationTarget, Expression } from "../src/engine/distillation/types";

const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + " != " + expected);
function fixturePool() {
  const pool: Material[] = Array.from({ length: 44 }, (_, i) => {
    const composition = { Li: 1 + i, O: 2 };
    const extracted = extractCompositionFeatures(composition);
    return { id: "material-" + i, formula: "Li" + (i + 1) + "O2", source: "mock", targetKind: "synthetic-score",
      composition, ...extracted, trueProperty: i < 34 ? 1 + 0.4 * extracted.descriptors.statistics.electronegativityPauling.mean! ** 2 : 192837465,
      cost: 1, isSampled: i < 34 };
  });
  return pool;
}
function fixture(target: DistillationTarget = "observed") {
  return buildDistillationSnapshot(fixturePool(), { runId: 4, iteration: 16, target, objective: "synthetic-score", modelConfig: { ...DEFAULT_MODEL_CONFIG } });
}

test("composition grouping respects scale, ordering and zero entries", () => {
  assert.equal(compositionGroup({ Li: 2, O: 1 }), compositionGroup({ O: 10, Li: 20, Fe: 0 }));
  assert.notEqual(compositionGroup({ Li: 1, O: 1 }), compositionGroup({ Li: 2, O: 1 }));
});
test("snapshot boundary never serializes unsampled oracle labels", () => {
  const snapshot = fixture();
  assert.equal(snapshot.samples.length, 34);
  assert.equal(snapshot.queries.length, 44);
  assert.ok(!JSON.stringify(snapshot).includes("192837465"));
  assert.ok(snapshot.queries.every(row => !Object.hasOwn(row, "label") && !Object.hasOwn(row, "trueProperty")));
  assert.ok(PHYSICAL_FEATURES.every(feature => !/coverage|valid|tolerance/.test(feature.id)));
});
test("raw physical missing values stay null instead of becoming model placeholders", () => {
  const composition = { Li: 1, He: 1 };
  const material: Material = { id: "missing", formula: "LiHe", composition, ...extractCompositionFeatures(composition),
    cost: 1, isSampled: false, trueProperty: 999, targetKind: "synthetic-score" };
  const snapshot = buildDistillationSnapshot([material], { runId: 1, iteration: 0, target: "observed", objective: "synthetic-score", modelConfig: DEFAULT_MODEL_CONFIG });
  assert.equal(snapshot.queries[0].values[0], null);
  assert.equal(snapshot.queries[0].features[0], 0);
});
test("supplemental physics requires fixed units and a source plus reference definition", () => {
  const good = { "material-1": { bond_energy_mo: { value: 4.1, unit: "eV", source: "doi:example", reference: "gas-phase MO to M + O" } } };
  assert.equal(parseSupplements(JSON.stringify(good))["material-1"].bond_energy_mo.value, 4.1);
  assert.throws(() => parseSupplements(JSON.stringify(good), new Set(["other-material"])), /当前数据集/);
  for (const bad of [
    { "material-1": { bond_energy_mo: { ...good["material-1"].bond_energy_mo, unit: "Å" } } },
    { "material-1": { bond_energy_mo: { ...good["material-1"].bond_energy_mo, source: "" } } },
    { "material-1": { bond_energy_mo: { ...good["material-1"].bond_energy_mo, value: -1 } } },
    { "material-1": { unknown: good["material-1"].bond_energy_mo } },
  ]) assert.throws(() => parseSupplements(JSON.stringify(bad)));
  assert.throws(() => parseSupplements('{"__proto__":{}}'));
});
test("AST enforces dimensions, square-root domains and finite guarded division", () => {
  const chi: Expression = { op: "variable", index: 0 }, radius: Expression = { op: "variable", index: 3 };
  assert.equal(expressionDimension({ op: "+", left: chi, right: radius }, PHYSICAL_FEATURES), null);
  assert.equal(expressionDimension({ op: "exp", arg: radius }, PHYSICAL_FEATURES), null);
  assert.deepEqual(expressionDimension({ op: "sqrt", arg: { op: "variable", index: 4 } }, PHYSICAL_FEATURES), [0, 1]);
  assert.equal(dimensionText([0, -2]), "Å^-2");
  assert.equal(evaluateExpression({ op: "/", left: chi, right: radius }, [1, 0, 0, 0]), null);
  assert.equal(evaluateExpression({ op: "sqrt", arg: chi }, [-1]), null);
  assert.equal(evaluateExpression({ op: "exp", arg: chi }, [50]), null);
  assert.equal(evaluateExpression(chi, [null]), null);
  close(evaluateExpression({ op: "abs", arg: chi }, [-2])!, 2);
});
test("L1 coordinate descent matches an independent orthogonal-design solution", () => {
  const x = [-1, 1, -1, 1], z = [-1, -1, 1, 1], y = x.map((value, i) => 3 + 2 * value - 0.5 * z[i]);
  const beta = lassoCoefficients([x, z], y, 0.25);
  close(beta[0], 1.75); close(beta[1], -0.25);
  const fit = fitSparseLinear([x, z], y)!;
  close(fit.intercept, 3); close(fit.coefficients[0], 2); close(fit.coefficients[1], -0.5);
  assert.equal(fitSparseLinear([x, x], y), null);
});
test("group partitions are disjoint and place all scaled replicas together", () => {
  const snapshot = fixture(), rows = [...snapshot.samples, { ...snapshot.samples[0], id: "replica" }];
  const split = splitCompositionGroups(rows, 42);
  assert.equal(new Set([...split.discovery, ...split.tuning, ...split.test]).size, 34);
  assert.ok(split.discovery.every(group => !split.tuning.includes(group) && !split.test.includes(group)));
  assert.deepEqual(splitCompositionGroups([...rows].reverse(), 42), split);
});
test("existing holdout assignments never migrate when new compositions are sampled", () => {
  const snapshot = fixture(), early = splitCompositionGroups(snapshot.samples.slice(0, 10), 42);
  const frozen = freezePartitions(early), later = splitCompositionGroups(snapshot.samples, 42, frozen);
  for (const [group, partition] of Object.entries(frozen)) assert.ok(later[partition].includes(group));
  assert.deepEqual(splitCompositionGroups([...snapshot.samples].reverse(), 42, frozen), later);
});
test("snapshot IDs cover query values, supplemental numbers, options and schema versions", () => {
  const pool = fixturePool(), input = { runId: 1, iteration: 16, target: "teacher" as const, objective: "synthetic-score" as const, modelConfig: DEFAULT_MODEL_CONFIG };
  const before = buildDistillationSnapshot(pool, input);
  const changed = pool.map(row => ({ ...row, features: [...row.features] }));
  changed.at(-1)!.features[0] += 0.01;
  assert.notEqual(buildDistillationSnapshot(changed, input).id, before.id);
  const extra = (value: number) => parseSupplements(JSON.stringify({ "material-43": { bond_energy_mo: { value, unit: "eV", source: "fixed-source", reference: "fixed-definition" } } }));
  assert.notEqual(buildDistillationSnapshot(pool, { ...input, supplements: extra(3) }).id,
    buildDistillationSnapshot(pool, { ...input, supplements: extra(4) }).id);
  assert.ok(before.featureSchemaVersion && before.elementTableVersion);
});
test("LaTeX exports contain a single command backslash after normal JSON parsing", () => {
  const expression: Expression = { op: "sqrt", arg: { op: "variable", index: 0 } };
  const value = JSON.parse(JSON.stringify(formatExpression(expression, PHYSICAL_FEATURES, true)));
  assert.equal(value.slice(0, 6), "\\sqrt{");
  assert.equal(value.charCodeAt(1), "s".charCodeAt(0));
  assert.ok(!value.includes("\\\\"));
});
test("symbolic search learns a held-out nonlinear relation and is deterministic", async () => {
  const snapshot = fixture(), options = { maxCandidates: 1800, l0: 0, l1: 0 };
  const first = await searchPhysicalFormulas(snapshot, options), second = await searchPhysicalFormulas(snapshot, options);
  assert.ok(first.formulas.length >= 1 && first.formulas.length <= 2);
  assert.ok(first.metrics.rmse! < 1e-6, JSON.stringify(first.metrics));
  assert.ok(first.evaluatedCandidates <= 1800);
  assert.deepEqual(first.formulas, second.formulas);
  assert.equal(first.intercept, second.intercept);
  assert.ok(first.points.filter(point => point.partition === "candidate").every(point => point.observed === null));
  assert.deepEqual(first.modelConfig, snapshot.modelConfig);
  assert.equal(first.searchOptions.maxCandidates, 1800);
  assert.equal(first.featureDictionary[0].id, PHYSICAL_FEATURES[0].id);
  assert.equal(first.sourceSnapshot.queries.length, 44);
});
test("poisoning test labels changes metrics but cannot affect formula or fitted coefficients", async () => {
  const snapshot = fixture(), split = splitCompositionGroups(snapshot.samples, 42);
  const poisoned = structuredClone(snapshot);
  poisoned.samples.forEach(row => { if (split.test.includes(row.group)) row.label += 200; });
  const options = { maxCandidates: 1000, l0: 0, l1: 0 };
  const a = await searchPhysicalFormulas(snapshot, options), b = await searchPhysicalFormulas(poisoned, options);
  assert.deepEqual(a.formulas, b.formulas); assert.equal(a.intercept, b.intercept);
  assert.ok(b.metrics.rmse! > 100);
});
test("teacher mode isolates tuning labels and reports fidelity separately", async () => {
  const snapshot = fixture("teacher"), split = splitCompositionGroups(snapshot.samples, 42);
  const poisoned = structuredClone(snapshot);
  poisoned.samples.forEach(row => { if (split.tuning.includes(row.group)) row.label += 300; });
  const options = { maxCandidates: 1000 };
  const a = await searchPhysicalFormulas(snapshot, options), b = await searchPhysicalFormulas(poisoned, options);
  assert.deepEqual(a.formulas, b.formulas); assert.equal(a.intercept, b.intercept);
  assert.equal(a.teacherTrainingRecords, a.splitRecords.discovery);
  assert.ok(a.pseudoRecords >= a.teacherTrainingRecords);
  assert.ok(a.fidelity?.rmse !== null && Number.isFinite(a.fidelity?.rmse));
});
test("all baseline comparisons use the same formula-valid test population", async () => {
  const snapshot = fixture(), split = splitCompositionGroups(snapshot.samples, 42);
  snapshot.samples.forEach(row => { if (split.test.includes(row.group)) row.values.fill(null); });
  const result = await searchPhysicalFormulas(snapshot, { maxCandidates: 1000 });
  assert.equal(result.metrics.count, 0);
  assert.equal(result.metrics.invalid, result.splitRecords.test);
  for (const baseline of [result.teacherMetrics, result.ridgeBaseline, result.meanBaseline]) {
    assert.equal(baseline.count, result.metrics.count);
    assert.equal(baseline.invalid, result.metrics.invalid);
    assert.equal(baseline.rmse, null);
  }
});
test("insufficient data and invalid search budgets produce explicit errors", async () => {
  const snapshot = fixture();
  await assert.rejects(searchPhysicalFormulas({ ...snapshot, samples: snapshot.samples.slice(0, 7) }), /采样/);
  await assert.rejects(searchPhysicalFormulas(snapshot, { maxDepth: 99 }), /搜索限制/);
  await assert.rejects(searchPhysicalFormulas(snapshot, { maxCandidates: 999999 }), /搜索限制/);
  await assert.rejects(searchPhysicalFormulas(snapshot, { l1: NaN }), /正则化/);
  await assert.rejects(searchPhysicalFormulas(snapshot, { seed: NaN }), /种子/);
});
test("constant sampled targets do not produce an invented formula", async () => {
  const snapshot = fixture();
  snapshot.samples.forEach(row => { row.label = 0; });
  await assert.rejects(searchPhysicalFormulas(snapshot), /目标几乎不变/);
});
test("real band gaps and synthetic scores cannot share a formula dataset", () => {
  const pool = fixturePool();
  pool[0].targetKind = "band-gap";
  assert.throws(() => buildDistillationSnapshot(pool, { runId: 1, iteration: 0, target: "observed",
    objective: "synthetic-score", modelConfig: DEFAULT_MODEL_CONFIG }), /不能混用/);
});
