import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express from "express";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { demoConfigurations } from "../src/umlip/examples";
import { configurationFeatures, fromCrystalStructure, validateConfiguration, validatePool, validateSettings } from "../src/umlip/configurations";
import { importStructures } from "../src/structures/importStructure";
import { UmlipService, type UmlipServiceOptions } from "../server/umlip/service";
import { umlipRouter } from "../server/umlip/routes";
import type { RelaxationOracle } from "../server/umlip/oracle";
import type { ConfigurationInput, RelaxationResult, UmlipModel, UmlipSettings } from "../src/umlip/types";
import { listen } from "./httpFixtures";

const model: UmlipModel = { label: "TEST FIXTURE ONLY", filename: "fixture", sha256: "a".repeat(64), runnerSha256: "b".repeat(64),
  device: "cpu", dtype: "float64", threads: 1, atomicNumbers: [8, 22, 38], versions: { fixture: "not a physical calculation" } };
const ready = async () => ({ model: structuredClone(model), loadSeconds: 0.001 });
function result(candidate: ConfigurationInput, energyEv = -10, converged = true): RelaxationResult {
  return { converged, energyEv, energyPerAtomEv: energyEv / candidate.structure.elements.length, maxForceEvAngstrom: converged ? 0.01 : 1,
    rawMaxForceEvAngstrom: converged ? 0.01 : 1, steps: 1, elapsedSeconds: 0.001, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), structure: structuredClone(candidate.structure) };
}
function fixture(t: TestContext, overrides: Partial<UmlipServiceOptions> = {}) {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "ai4s-umlip-test-"));
  const service = new UmlipService({ root: process.cwd(), outputRoot, oracleFactory: () => ({ ready, close() {},
    async relax(candidate, _settings, progress, signal) {
      signal.throwIfAborted(); const r = result(candidate, -10 - Number(candidate.id.split("-").at(-1)));
      progress({ step: 1, energyEv: r.energyEv, maxForceEvAngstrom: 0.01, elapsedSeconds: 0.001, fractional: r.structure.fractional });
      return r;
    } }), ...overrides });
  t.after(() => { service.close(); rmSync(outputRoot, { recursive: true, force: true }); });
  return { service, outputRoot };
}
async function finished(service: UmlipService, id: string) {
  for (let i = 0; i < 200; i++) {
    const run = service.get(id);
    if (run.status !== "running") return run;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Fixture did not finish");
}

test("configuration pool requires actual full-occupancy geometry with identical counts and constraints", () => {
  const pool = demoConfigurations();
  assert.equal(validatePool(pool).length, 6);
  const changed = structuredClone(pool); changed[1].structure.elements[0] = "Ba";
  assert.throws(() => validatePool(changed), /元素计数/);
  const swapped = structuredClone(pool); swapped[1].structure.elements.reverse();
  assert.throws(() => validatePool(swapped), /元素顺序/);
  const frozen = structuredClone(pool); frozen[1].structure.movable[0][0] = false;
  assert.throws(() => validatePool(frozen), /运动约束/);
  assert.throws(() => validatePool([pool[0], pool[0]]), /重复/);
  for (const id of [undefined, null, true, 42]) assert.throws(() => validatePool([{ ...pool[0], id }, pool[1]]), /ID/);
  const mixed = importStructures(readFileSync(new URL("./structure-fixtures/mixed-multiblock.cif", import.meta.url), "utf8"), "mixed.cif");
  assert.throws(() => fromCrystalStructure(mixed[0]), /占位/);
});

test("configuration validation rejects nonperiodic, colliding, charged and malformed inputs", () => {
  const s = demoConfigurations()[0].structure;
  assert.throws(() => validateConfiguration({ ...s, pbc: [true, true, false] }), /周期/);
  assert.throws(() => validateConfiguration({ ...s, charge: 1 }), /带电/);
  assert.throws(() => validateConfiguration({ ...s, fractional: s.fractional.map(() => [0, 0, 0]) }), /间距/);
  assert.throws(() => validateConfiguration({ ...s, cell: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }), /晶格/);
  assert.throws(() => validateConfiguration({ ...s, movable: s.movable.map(() => [false, false, false]) }), /冻结/);
  assert.throws(() => validateConfiguration({ cell: [[1, 0, 0], [1, 0.1, 0], [0, 0, 1]], elements: ["Si"], fractional: [[0, 0, 0]], movable: [[true, true, true]], pbc: [true, true, true] }), /自身周期镜像/);
  assert.throws(() => validateSettings({ budget: 33 }, 6), /budget/);
  assert.throws(() => validateSettings({ fmax: NaN }, 6), /力阈值/);
  assert.equal(validateSettings({ budget: 1 }, 6).initialSamples, 1);
});

test("geometric descriptors distinguish coordinate perturbations and preserve periodic translation and permutations", () => {
  const pool = demoConfigurations(), first = configurationFeatures(pool[0].structure);
  assert.notDeepEqual(first, configurationFeatures(pool[1].structure));
  const translated = structuredClone(pool[1].structure);
  translated.fractional = translated.fractional.map(row => row.map(x => x + 0.37) as [number, number, number]);
  const next = configurationFeatures(translated), expected = configurationFeatures(pool[1].structure);
  next.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-12));
  const permuted = structuredClone(pool[1].structure);
  permuted.elements.reverse(); permuted.fractional.reverse(); permuted.movable.reverse();
  configurationFeatures(permuted).forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-12));
  assert.ok(first.length <= 128 && first.every(Number.isFinite));
});

test("online loop learns only evaluated results, minimizes energy, fixes reference and records real provenance fields", async t => {
  const trained: { features: number[]; trueProperty: number }[][] = [];
  const { service, outputRoot } = fixture(t, { surrogateFactory: () => ({
    async train(points) { trained.push(structuredClone(points)); assert.ok(points.every(p => Object.keys(p).sort().join() === "features,trueProperty")); },
    predict(point) { assert.deepEqual(Object.keys(point), ["features"]); return { mean: point.features[0], std: 0.3 }; },
  }) });
  const input = demoConfigurations(), original = JSON.stringify(input);
  const run = service.start(input, { budget: 4, initialSamples: 2, batchSize: 2 });
  assert.ok(run.candidates.every(c => !c.result && c.relativeEnergyEv === undefined));
  const done = await finished(service, run.id);
  assert.equal(done.status, "completed"); assert.equal(done.rounds.length, 2);
  assert.equal(done.candidates.filter(c => c.status === "converged").length, 4);
  assert.equal(trained.length, 1); assert.equal(trained[0].length, 2);
  assert.equal(done.reference?.id, "demo-0"); assert.equal(done.reference?.energyEv, -10);
  for (const c of done.candidates) {
    if (c.status === "converged") assert.equal(c.relativeEnergyEv, c.result!.energyEv + 10);
    else { assert.equal(c.result, undefined); assert.equal(c.relativeEnergyEv, undefined); }
  }
  assert.equal(done.bestRelativeEvPerAtom, Math.min(...done.candidates.filter(c => c.status === "converged").map(c => c.relativeEnergyPerAtomEv!)));
  assert.ok(done.bestRelativeEvPerAtom! < 0);
  assert.equal(done.model?.sha256, model.sha256); assert.ok(done.wallSeconds >= 0);
  const persisted = JSON.parse(readFileSync(path.join(outputRoot, run.id, "run.json"), "utf8"));
  assert.equal(persisted.status, "completed"); assert.equal(persisted.reference.id, "demo-0");
  assert.equal(JSON.stringify(input), original);
  done.reference!.energyEv = 1000;
  assert.equal(service.get(run.id).reference!.energyEv, -10);
});

test("unconverged energies remain visible but never become reference or surrogate labels", async t => {
  let trained = 0;
  const { service } = fixture(t, { oracleFactory: () => ({ ready, close() {}, async relax(c) { return result(c, -100, false); } }),
    surrogateFactory: () => ({ async train() { trained++; }, predict() { return { mean: 0, std: 1 }; } }) });
  const done = await finished(service, service.start(demoConfigurations(), { budget: 3, initialSamples: 1 }).id);
  assert.equal(done.status, "failed"); assert.equal(done.reference, undefined); assert.equal(trained, 0);
  assert.equal(done.candidates.filter(c => c.status === "unconverged").length, 3);
  assert.ok(done.candidates.every(c => c.relativeEnergyEv === undefined));
  assert.equal(done.candidates.find(c => c.result)?.result?.energyEv, -100);
});

test("the reference is the first input candidate, independent of lexicographic IDs", async t => {
  const order: string[] = [];
  const { service } = fixture(t, { oracleFactory: () => ({ ready, close() {}, async relax(c) { order.push(c.id); return result(c); } }) });
  const pool = demoConfigurations().slice(0, 2); pool[0].id = "z-first"; pool[1].id = "a-second";
  const done = await finished(service, service.start(pool, { budget: 2 }).id);
  assert.equal(order[0], "z-first"); assert.equal(done.reference?.id, "z-first");
});

test("negative-energy labels, exact LCB batch order and final budget truncation use minimization", async t => {
  const order: string[] = [], training: { features: number[]; trueProperty: number }[][] = [];
  const demos = demoConfigurations();
  const pool = validatePool([demos[0], demos[1], demos[3], demos[4]].map((c, i) => ({ ...c, id: `demo-${i}` })));
  const features = pool.map(c => configurationFeatures(c.structure));
  const predictions = [{ mean: 0, std: 0 }, { mean: 1, std: 0.1 }, { mean: 0, std: 2 }, { mean: 4, std: 0 }];
  const { service } = fixture(t, {
    oracleFactory: () => ({ ready, close() {}, async relax(c) { order.push(c.id); return result(c); } }),
    surrogateFactory: () => ({ async train(points) { training.push(structuredClone(points)); }, predict(point) {
      const index = features.findIndex(row => row.every((v, i) => Math.abs(v - point.features[i]) < 1e-12));
      assert.ok(index >= 0); return predictions[index];
    } }),
  });
  const done = await finished(service, service.start(pool, { budget: 3, initialSamples: 1, batchSize: 4 }).id);
  assert.equal(done.status, "completed", done.error);
  assert.deepEqual(order, ["demo-0", "demo-2", "demo-3"]);
  assert.equal(training.length, 1); assert.deepEqual(training[0].map(p => p.trueProperty), [2]); // -(-10 eV / 5 atoms)
  const rejected = done.candidates.find(c => c.id === "demo-1")!;
  assert.equal(rejected.status, "pending"); assert.equal(rejected.prediction?.meanRelativeEvPerAtom, 1);
  assert.equal(rejected.prediction?.lcbEvPerAtom, 0.8);
  assert.equal(done.candidates.find(c => c.id === "demo-2")!.prediction?.lcbEvPerAtom, -2);
  assert.equal(done.rounds[1].evaluated, 3);
});

test("interrupted persisted runs are marked once and the recovery state is saved across restarts", async t => {
  const { service, outputRoot } = fixture(t);
  const run = await finished(service, service.start(demoConfigurations(), { budget: 1 }).id);
  const filename = path.join(outputRoot, run.id, "run.json");
  const interrupted = JSON.parse(readFileSync(filename, "utf8")); interrupted.status = "running"; delete interrupted.finishedAt;
  interrupted.candidates[0].status = "running";
  writeFileSync(filename, JSON.stringify(interrupted));
  const recovered = new UmlipService({ root: process.cwd(), outputRoot });
  assert.equal(recovered.get(run.id).status, "failed");
  const persisted = JSON.parse(readFileSync(filename, "utf8"));
  assert.equal(persisted.status, "failed"); assert.equal(persisted.candidates[0].status, "failed");
  const restarted = new UmlipService({ root: process.cwd(), outputRoot });
  assert.equal(restarted.get(run.id).finishedAt, persisted.finishedAt);
  recovered.close(); restarted.close();
});

test("a result with inconsistent total and per-atom energy is rejected", async t => {
  const { service } = fixture(t, { oracleFactory: () => ({ ready, close() {}, async relax(c) {
    const r = result(c); r.energyPerAtomEv += 1; return r;
  } }) });
  const done = await finished(service, service.start(demoConfigurations(), { budget: 1 }).id);
  assert.equal(done.candidates[0].status, "failed"); assert.equal(done.reference, undefined);
  assert.match(done.candidates[0].error!, /单位/);
});

test("invalid returned geometry or energy normalization cannot enter the training set", async t => {
  const { service } = fixture(t, { oracleFactory: () => ({ ready, close() {}, async relax(c) {
    const r = result(c); r.structure.cell[0][0] += 0.1; return r;
  } }) });
  const done = await finished(service, service.start(demoConfigurations(), { budget: 1 }).id);
  assert.equal(done.status, "failed"); assert.equal(done.candidates[0].status, "failed");
  assert.equal(done.reference, undefined); assert.equal(done.candidates[0].result, undefined);
});

test("cancellation blocks late progress/results and a new run can start without stale writes", async t => {
  let resolveOld!: (value: RelaxationResult) => void;
  let oldProgress!: Parameters<RelaxationOracle["relax"]>[2];
  let oldCandidate!: ConfigurationInput;
  let count = 0;
  const { service } = fixture(t, { oracleFactory: () => {
    const first = count++ === 0;
    return { ready, close() {}, async relax(c, _s, progress) {
      if (!first) return result(c);
      oldCandidate = c; oldProgress = progress;
      return new Promise(resolve => { resolveOld = resolve; });
    } };
  } });
  const first = service.start(demoConfigurations(), { budget: 1 });
  for (let i = 0; !resolveOld && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(resolveOld);
  assert.throws(() => service.start(demoConfigurations()), /已有运行/);
  service.cancel(first.id);
  const second = service.start(demoConfigurations(), { budget: 1 });
  oldProgress({ step: 1, energyEv: -9999, maxForceEvAngstrom: 0, elapsedSeconds: 1, fractional: oldCandidate.structure.fractional });
  resolveOld(result(oldCandidate, -9999));
  const done = await finished(service, second.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(done.status, "completed"); assert.equal(done.reference?.energyEv, -10);
  const cancelled = service.get(first.id);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.reference, undefined);
  assert.ok(cancelled.candidates.every(c => !c.result));
});

test("HTTP API exposes jobs and rejects invalid pools, cross-origin requests and path escapes", async t => {
  const { service } = fixture(t);
  const base = await listen(t, http.createServer(express().use("/api/umlip", umlipRouter(service))));
  const post = (body: unknown, headers = {}) => fetch(`${base}/api/umlip/runs`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ candidates: demoConfigurations() }, { Origin: "https://unrelated.example" })).status, 403);
  assert.equal((await post({ candidates: [] })).status, 400);
  const response = await post({ candidates: demoConfigurations(), settings: { budget: 2 } });
  assert.equal(response.status, 202);
  const run = await response.json(); await finished(service, run.id);
  const loaded = await (await fetch(`${base}/api/umlip/runs/${run.id}`)).json();
  assert.equal(loaded.status, "completed");
  assert.equal((await fetch(`${base}/api/umlip/runs/${run.id}/candidates/unknown/poscar`)).status, 404);
  assert.equal((await fetch(`${base}/api/umlip/runs/not-a-run`)).status, 404);
});
