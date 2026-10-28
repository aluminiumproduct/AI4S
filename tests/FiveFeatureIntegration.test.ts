import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { HubStore } from "../server/hubStore";
import { createApiApp } from "../server/api";
import { createNetworkClient } from "../server/network";
import { UmlipService } from "../server/umlip/service";
import { DEFAULT_HUB_QUERY, OBJECTIVES, type HubRecord, type ObjectiveId } from "../src/dataHub";
import type { Material } from "../src/types";
import { MaterialsEngine } from "../src/engine/MaterialsEngine";
import { SurrogateModel } from "../src/engine/SurrogateModel";
import { DEFAULT_MODEL_CONFIG } from "../src/engine/models/config";
import { materialRecordKey, targetSpec } from "../src/materialContext";
import { materialCandidates, bindStabilityInputs, PARETO_SCALES } from "../src/engine/pareto/ParetoData";
import { INITIAL_PARETO_STATE, runParetoStep } from "../src/engine/pareto/ParetoEngine";
import { buildDistillationSnapshot } from "../src/engine/distillation/features";
import { searchPhysicalFormulas } from "../src/engine/distillation/search";
import { extractCompositionFeatures } from "../src/engine/CompositionFeatures";
import { runActiveLearningStep } from "../src/engine/ActiveLearningLoop";
import { AcquisitionFunction } from "../src/engine/AcquisitionFunction";
import { MaterialStructureService } from "../src/services/MaterialStructureService";
import { buildAdvisorContext } from "../src/services/AdvisorContext";
import { materialForStructure, resolveSynthesisReference, structureFingerprint } from "../src/synthesis/reference";
import { applySynthesisFeedback, canApplySynthesisFeedback, feedbackLabel, feedbackRejectionReason,
  loadFeedbackRegistry, restoreFeedback, saveFeedbackRegistry } from "../src/synthesis/feedback";
import type { ReferenceBinding, SynthesisFeedback } from "../src/synthesis/types";
import { parseExperimentalSpectrum, spectrumIsDemonstration, spectrumText } from "../src/synthesis/client";
import { listen } from "./httpFixtures";
import { state } from "./fixtures";

// Synthetic contract fixtures only: these records are not materials/experimental evidence.
const provenance = { reference: "Synthetic integration fixture, not physical evidence", url: "https://fixtures.invalid/integration",
  datasetVersion: "integration-1", retrievedAt: "2026-10-28T00:00:00Z", license: "test-only" };
const rawStructure = { lattice: { matrix: [[4, 0, 0], [0, 4, 0], [0, 0, 4]], pbc: [true, true, true] },
  sites: [{ species: [{ element: "Al", occu: 1 }], abc: [0, 0, 0] }] };
function record(index = 0): HubRecord {
  return { id: `integration-${index}`, formula: "Al", composition: { Al: 1 },
    source: "MP-DFT", fidelity: "low-dft", cohort: "contract", methodMeta: "Synthetic fixture calculation",
    provenance: { ...provenance }, values: { "band-gap": index + 1, "formation-energy": -2 - index / 10, "energy-above-hull": index / 100 },
    units: { "band-gap": "eV", "formation-energy": "eV/atom", "energy-above-hull": "eV/atom" }, structure: rawStructure };
}
async function context(t: TestContext, records = [record()]) {
  const hub = new HubStore(":memory:"); hub.import("mp-snapshot", records, true);
  const directory = mkdtempSync(join(tmpdir(), "ai4s-five-features-"));
  const umlip = new UmlipService({ root: process.cwd(), outputRoot: directory, env: {} });
  const network = createNetworkClient();
  t.after(() => { umlip.close(); network.close(); hub.close(); rmSync(directory, { recursive: true, force: true }); });
  const url = await listen(t, http.createServer(createApiApp({ hub, umlip, network, env: {} })));
  const get = axios.get.bind(axios);
  t.mock.method(axios, "get", (path, config) => get(new URL(path, url).href, { ...config, proxy: false }));
  const engine = new MaterialsEngine();
  await engine.loadHubData({ ...DEFAULT_HUB_QUERY });
  return { hub, engine, url };
}
function request(row: Material) {
  return { requestId: 1, materialId: row.id, recordKey: materialRecordKey(row), source: row.source, structureRef: row.structureRef };
}
function feedback(row: Material, reference: ReferenceBinding, overrides: Partial<SynthesisFeedback> = {}): SynthesisFeedback {
  return { schemaVersion: 2, materialId: row.id, recordKey: materialRecordKey(row), formula: row.formula,
    reference, status: "pass", score: 90, mainFraction: 80, prior: .4, sampleId: "CONTRACT-ONLY",
    filename: "contract-upload.xy", createdAt: "2026-10-28T00:00:00Z", demo: false, ...overrides };
}
function symbolicPool(objective: ObjectiveId): Material[] {
  return Array.from({ length: 44 }, (_, index) => {
    const composition = { Li: index + 1, O: 2 }, features = extractCompositionFeatures(composition);
    return { id: `symbolic-${index}`, formula: `Li${index + 1}O2`, composition, ...features,
      source: "Lab-Experiment", datasetSource: "catalysis-hub", fidelity: "high-exp", cohort: "one-condition",
      provenance: { ...provenance }, methodMeta: "Synthetic fixture measurement", recordRevision: index.toString(16).padStart(64, "0"),
      targetKind: objective, trueProperty: index < 34 ? -1 - .4 * features.descriptors.statistics.electronegativityPauling.mean! ** 2 : 192837465,
      cost: 1, isSampled: index < 34 };
  });
}

test("Hub SQLite -> HTTP -> Engine -> real Pareto retains zero hull, auxiliaries, lineage and separate sampling", async t => {
  const { engine } = await context(t, Array.from({ length: 8 }, (_, index) => record(index)));
  const rows = engine.getPool(), before = JSON.stringify(rows);
  assert.equal(rows[0].source, "MP-DFT"); assert.equal(rows[0].energyAboveHull, 0);
  assert.equal(rows[0].formationEnergyPerAtom, -2); assert.equal(rows[0].objectiveValues?.["energy-above-hull"], 0);
  const data = materialCandidates(rows);
  assert.equal(data.candidates.length, 8);
  assert.equal(data.candidates[0].lineage?.revision, rows[0].recordRevision);
  const config = { budget: 8, weights: [50, 25, 25] as [number, number, number], scales: PARETO_SCALES["materials-project"], seed: 42 };
  const model = new SurrogateModel();
  const first = await runParetoStep(data.candidates, INITIAL_PARETO_STATE(), config, model);
  const second = await runParetoStep(first.pool, first.state, config, model);
  assert.equal(first.pool.filter(row => row.observed).length, 6);
  assert.equal(second.pool.filter(row => row.observed).length, 7);
  assert.equal(JSON.stringify(rows), before);
  const imported = bindStabilityInputs([{ materialId: rows[0].id, energyAboveHull: .02, source: "fixture", method: "fixture", referenceSet: "fixture" }], rows);
  assert.equal(materialCandidates(rows, {}, imported).candidates[0].objectives[1], .02);
  assert.equal(materialCandidates([{ ...rows[0], recordRevision: "f".repeat(64) }], {}, imported).candidates[0].objectives[1], 0);
});

test("Hub minimization drives AL and advisor while unsupported real Pareto targets are explicitly excluded", async t => {
  const { engine } = await context(t, Array.from({ length: 8 }, (_, index) => record(index)));
  const query = { ...DEFAULT_HUB_QUERY, objective: "formation-energy" as const };
  const metadata = await engine.loadHubData(query);
  const rows = engine.getPool(); assert.equal(materialCandidates(rows).candidates.length, 0);
  const result = await runActiveLearningStep(rows, state(), { totalBudget: 6, batchSize: 1, strategy: "UCB", direction: "min" }, new SurrogateModel());
  const sampled = result.pool.filter(row => row.isSampled);
  assert.equal(result.state.bestValue, Math.min(...sampled.map(row => row.trueProperty)));
  const snapshot = buildAdvisorContext({ pool: result.pool, state: result.state, strategy: "UCB", batchSize: 1,
    totalBudget: 6, isRealData: true, runId: 1, modelConfig: DEFAULT_MODEL_CONFIG, hubQuery: query, hubMetadata: metadata });
  assert.equal(snapshot.objective.unit, "eV/atom"); assert.equal(snapshot.objective.direction, "min");
  assert.match(snapshot.learning.score_formula, /-mu/);
});

test("all seven Hub objectives serialize correct units, directions and detached lineage without hidden labels", () => {
  for (const objective of Object.keys(OBJECTIVES) as ObjectiveId[]) {
    const rows = symbolicPool(objective);
    const snapshot = buildDistillationSnapshot(rows, { runId: 1, iteration: 1, target: "observed", objective, modelConfig: DEFAULT_MODEL_CONFIG });
    assert.equal(snapshot.objectiveMeta?.unit, OBJECTIVES[objective].unit);
    assert.equal(snapshot.objectiveMeta?.direction, OBJECTIVES[objective].direction);
    assert.equal(snapshot.queries[0].lineage?.source, "Lab-Experiment");
    assert.ok(!JSON.stringify(snapshot).includes("192837465"));
    assert.ok(snapshot.queries.every(row => !Object.hasOwn(row, "label") && !Object.hasOwn(row, "trueProperty")));
    const captured = JSON.stringify(snapshot);
    rows[0].provenance!.datasetVersion = "mutated";
    assert.equal(JSON.stringify(snapshot), captured);
  }
});

test("grouped formula fitting supports a minimizing non-gap objective and marks its lower-value preferred region", async () => {
  const rows = symbolicPool("formation-energy");
  const snapshot = buildDistillationSnapshot(rows, { runId: 1, iteration: 1, target: "observed", objective: "formation-energy", modelConfig: DEFAULT_MODEL_CONFIG });
  const result = await searchPhysicalFormulas(snapshot, { maxCandidates: 600 });
  assert.equal(result.objective, "formation-energy"); assert.equal(result.sourceSnapshot.objectiveMeta?.unit, "eV/atom");
  const ordered = rows.filter(row => row.isSampled).map(row => row.trueProperty).sort((a, b) => a - b);
  assert.equal(result.highThreshold, ordered[Math.floor((ordered.length - 1) * .2)]);
  assert.ok(result.metrics.rmse !== null && Number.isFinite(result.metrics.rmse));
  assert.equal(result.sourceSnapshot.samples[0].lineage?.fidelity, "high-exp");
  assert.throws(() => buildDistillationSnapshot([{ ...rows[0], targetKind: "band-gap" }], {
    runId: 1, iteration: 1, target: "observed", objective: "formation-energy", modelConfig: DEFAULT_MODEL_CONFIG }), /混用/);
  assert.throws(() => buildDistillationSnapshot([rows[0], { ...rows[1], cohort: "other-condition" }], {
    runId: 1, iteration: 1, target: "observed", objective: "formation-energy", modelConfig: DEFAULT_MODEL_CONFIG }), /条件组/);
});

test("database XRD references carry exact revision and geometry SHA; failed lookups never turn into demonstrations", async t => {
  const { engine } = await context(t); const row = engine.getPool()[0];
  const resolved = await resolveSynthesisReference(request(row), row);
  assert.equal(resolved.binding.kind, "record"); assert.match(resolved.binding.structureHash, /^[a-f0-9]{64}$/);
  assert.equal(resolved.binding.structureHash, row.structureHash);
  assert.deepEqual(resolved.structure.source.recordRef, row.structureRef);
  assert.equal(materialForStructure([row], resolved.structure)?.id, row.id);
  const altered = structuredClone(resolved.structure); altered.sites[0].fractional[0] += .1;
  assert.notEqual(await structureFingerprint(altered), resolved.binding.structureHash);
  assert.equal(materialForStructure([{ ...row, structureRef: { ...row.structureRef!, dataset: "catalysis-hub" } }], resolved.structure), undefined);
  await assert.rejects(resolveSynthesisReference(request(row), row, undefined, async () => ({ kind: "unavailable" })), /没有可用/);
  await assert.rejects(resolveSynthesisReference(request(row), row, undefined, async () => { throw new Error("database unavailable"); }), /database unavailable/);
});

test("uploaded feedback binds a real record; demonstrations and arbitrary imported same-composition geometry cannot affect it", async t => {
  const { engine } = await context(t); const row = engine.getPool()[0];
  const resolved = await resolveSynthesisReference(request(row), row);
  const valid = feedback(row, resolved.binding);
  assert.equal(canApplySynthesisFeedback(row, valid), true);
  for (const invalid of [feedback(row, resolved.binding, { demo: true }), feedback(row, { ...resolved.binding, kind: "demo" }),
    feedback(row, { ...resolved.binding, kind: "imported" }), { ...valid, schemaVersion: undefined }]) {
    assert.equal(canApplySynthesisFeedback(row, invalid), false);
    assert.equal(applySynthesisFeedback([row], invalid)[0], row);
  }
  const imported = structuredClone(resolved.structure); imported.source = { ...imported.source, format: "poscar", recordRef: undefined };
  const local = await resolveSynthesisReference({ ...request(row), structure: imported }, row);
  assert.equal(local.binding.kind, "imported"); assert.match(feedbackRejectionReason(row, local.binding, false)!, /仅供谱图分析/);
  assert.equal(feedbackLabel(valid), "上传谱匹配通过");
  assert.ok(!feedbackLabel(valid).includes("验证"));
});

test("persistent feedback rejects same IDs from another dataset, changed revisions, malformed dates and mismatched reference hashes", async t => {
  const { engine } = await context(t); const row = engine.getPool()[0];
  const resolved = await resolveSynthesisReference(request(row), row);
  const valid = feedback(row, resolved.binding);
  const other = { ...row, datasetSource: "catalysis-hub" as const, source: "Lab-Experiment" as const };
  assert.equal(applySynthesisFeedback([other], valid)[0], other);
  assert.equal(applySynthesisFeedback([{ ...row, recordRevision: "f".repeat(64) }], valid)[0].synthesisFeedback, undefined);
  assert.equal(canApplySynthesisFeedback(row, { ...valid, reference: { ...resolved.binding, structureRef: { ...row.structureRef!, revision: "f".repeat(64) } } }), false);
  assert.equal(canApplySynthesisFeedback(row, { ...valid, createdAt: { toString: "bad" } as unknown as string }), false);
  assert.equal(canApplySynthesisFeedback(row, { ...valid, reference: { ...resolved.binding, structureHash: "invalid" } }), false);
  assert.equal(canApplySynthesisFeedback(row, { ...valid, reference: { ...resolved.binding, structureHash: "f".repeat(64) } }), false);
  assert.equal(canApplySynthesisFeedback({ ...row, structureHash: undefined }, valid), false);
  const map = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value) } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage"); });
  map.set("ai4s-synthesis-feedback-v1", JSON.stringify({ [row.id]: valid }));
  assert.deepEqual(loadFeedbackRegistry(), {});
  saveFeedbackRegistry({ [valid.recordKey!]: valid });
  assert.equal(restoreFeedback([row], loadFeedbackRegistry())[0].synthesisFeedback?.recordKey, valid.recordKey);
  assert.equal(restoreFeedback([other], loadFeedbackRegistry())[0].synthesisFeedback, undefined);
});

test("valid spectrum priors remain idempotent, preserve labels and respect negative scores; invalid attached feedback has no scoring effect", async t => {
  const { engine } = await context(t); const original = engine.getPool()[0];
  const resolved = await resolveSynthesisReference(request(original), original), valid = feedback(original, resolved.binding);
  for (const score of [10, -2]) {
    const row = { ...original, acquisitionValue: score }, before = JSON.stringify(row);
    const updated = applySynthesisFeedback([row], valid);
    assert.equal(updated[0].acquisitionValue, score > 0 ? 4 : -5);
    assert.deepEqual(applySynthesisFeedback(updated, valid), updated);
    assert.equal(updated[0].trueProperty, row.trueProperty); assert.equal(updated[0].isSampled, false);
    assert.equal(JSON.stringify(row), before);
  }
  const row = { ...original, predictedMean: 10, predictedStd: 0, cost: 1 };
  assert.equal(AcquisitionFunction.compute({ ...row, synthesisFeedback: { ...valid, demo: true } }, "UCB", 1), 10);
  assert.equal(AcquisitionFunction.compute({ ...row, synthesisFeedback: valid }, "UCB", 1), 4);
  assert.equal(AcquisitionFunction.compute({ ...row, synthesisFeedback: { ...valid, reference: { ...resolved.binding, structureHash: "f".repeat(64) } } }, "UCB", 1), 10);
});

test("Hub, uMLIP and synthesis routers coexist, keeping large route-specific payload parsers before the global parser", async t => {
  const { url } = await context(t);
  const capabilities = await axios.get(url + "/api/umlip/capabilities", { proxy: false });
  assert.equal(capabilities.status, 200);
  const screening = await axios.post(url + "/api/synthesis/preflight", { composition: { Al: 1 }, padding: "x".repeat(120_000) }, { proxy: false });
  assert.equal(screening.status, 200); assert.equal(screening.data.source, "demo");
  const row = { ...record(), id: "imported-large", source: "Catalysis-Hub", structure: undefined };
  const imported = await axios.post(url + "/api/hub/import", { dataset: "catalysis-hub", records: [row], padding: "x".repeat(120_000) }, { proxy: false });
  assert.equal(imported.status, 200); assert.equal(imported.data.imported, 1);
  assert.equal(targetSpec("overpotential").unit, "mV");
});

test("downloaded demonstration spectra retain their evidence marker when renamed and imported again", () => {
  const points = Array.from({ length: 10 }, (_, index) => ({ twoTheta: 20 + index, intensity: index * 10 }));
  const downloaded = spectrumText(points, true);
  assert.equal(spectrumIsDemonstration(downloaded, "renamed.xy"), true);
  assert.deepEqual(parseExperimentalSpectrum(downloaded), points);
  assert.equal(spectrumIsDemonstration(spectrumText(points), "old-demo-spectrum.xy"), true);
  assert.equal(spectrumIsDemonstration(spectrumText(points), "instrument-upload.xy"), false);
});

test("preflight uses the exact offline Hub dataset and revision, never a colliding bare MP ID or seeded missing hull", async t => {
  const original = { ...record(), id: "mp-collision" };
  const { engine, hub, url } = await context(t, [original]);
  const first = engine.getPool()[0];
  const post = (payload: object) => axios.post(url + "/api/synthesis/preflight", payload, { proxy: false, validateStatus: () => true });
  hub.import("mp-snapshot", [{ ...original, values: { ...original.values, "energy-above-hull": .6 } }], true);
  const historical = await post({ materialId: first.id, structureRef: first.structureRef, composition: first.composition });
  assert.equal(historical.status, 200); assert.equal(historical.data.source, "data-hub");
  assert.equal(historical.data.energyAboveHull, 0);
  assert.equal(historical.data.reference.revision, first.recordRevision);
  const imported = { ...original, composition: { Si: 1 }, formula: "Si", source: "Catalysis-Hub" as const,
    values: { ...original.values, "energy-above-hull": .25 },
    structure: { ...rawStructure, sites: [{ species: [{ element: "Si", occu: 1 }], abc: [0, 0, 0] }] } };
  hub.import("catalysis-hub", [imported]);
  const selected = hub.select("catalysis-hub", { ...DEFAULT_HUB_QUERY, source: "catalysis-hub", cohort: "contract" });
  const ref = { dataset: "catalysis-hub", id: original.id, revision: selected.revisions[0] };
  const local = await post({ materialId: original.id, structureRef: ref, composition: { Si: 1 }, source: "Catalysis-Hub" });
  assert.equal(local.status, 200); assert.equal(local.data.energyAboveHull, .25);
  assert.equal(local.data.reference.source, "Catalysis-Hub");
  assert.equal(local.data.reference.dataset, "catalysis-hub");
  assert.equal((await post({ materialId: original.id, structureRef: ref, composition: { Al: 1 } })).status, 400);
  assert.equal((await post({ materialId: original.id, structureRef: { ...ref, revision: "f".repeat(64) }, composition: { Si: 1 } })).status, 404);
  const unbound = await post({ materialId: original.id, source: "Catalysis-Hub", composition: { Si: 1 } });
  assert.equal(unbound.data.source, "unavailable"); assert.equal(unbound.data.energyAboveHull, null);
  hub.import("mp-snapshot", [{ ...original, id: "no-hull", values: { "band-gap": 2 }, units: { "band-gap": "eV" } }], true);
  const missing = hub.select("mp-snapshot", DEFAULT_HUB_QUERY);
  const index = missing.data.findIndex(row => row.id === "no-hull");
  const unknown = await post({ materialId: "no-hull", structureRef: { dataset: "mp-snapshot", id: "no-hull", revision: missing.revisions[index] }, composition: { Al: 1 } });
  assert.equal(unknown.data.source, "unavailable"); assert.equal(unknown.data.energyAboveHull, null);
  assert.equal(unknown.data.grade, "unknown"); assert.equal(unknown.data.score, null);
});
