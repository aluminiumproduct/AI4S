import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { demoCrystal, isStrontiumTitanate, parseExperimentalSpectrum, sameComposition, spectrumText, xrdPayload } from "../src/synthesis/client";
import { applySynthesisFeedback, constrainAcquisition } from "../src/synthesis/feedback";
import type { SynthesisFeedback } from "../src/synthesis/types";
import { closeSynthesisEngine, demoPreflight, runSynthesis } from "../server/synthesis";
import { runActiveLearningStep } from "../src/engine/ActiveLearningLoop";
import { material, state } from "./fixtures";
import { materialRecordKey } from "../src/materialContext";

const feedback: SynthesisFeedback = { materialId: "test-5", formula: "Li2O", status: "impurity", score: 90, mainFraction: 40,
  prior: .3, sampleId: "S-1", filename: "sample.xy", createdAt: "2026-10-28T00:00:00Z", demo: true,
  schemaVersion: 2, recordKey: materialRecordKey(material(5, { source: "mock" })),
  reference: { kind: "demo", structureHash: "a".repeat(64), recordKey: materialRecordKey(material(5, { source: "mock" })) } };

test("the perovskite demo is associated only with the actual SrTiO3 composition", () => {
  assert.equal(isStrontiumTitanate({ Sr: 2, Ti: 2, O: 6 }), true);
  assert.equal(isStrontiumTitanate({ Sr: 2, Ti: 1, O: 4 }), false);
  assert.equal(isStrontiumTitanate({ Sr: 1, Ti: 1, F: 3 }), false);
  assert.equal(sameComposition({ Li: 2, O: 1 }, { Li: 4, O: 2 }), true);
  assert.equal(demoCrystal({ Sr: 2, Ti: 1, O: 4 }).sites.length, 7);
});

test("XY/CSV parser handles headers, comments, order and duplicate angles", () => {
  const lines = ["2theta,intensity", "# instrument", ...Array.from({ length: 10 }, (_, i) => `${20+i},${i*10}`), "20,20"];
  const points = parseExperimentalSpectrum(lines.reverse().join("\r\n"));
  assert.equal(points.length, 10);
  assert.deepEqual(points[0], { twoTheta: 20, intensity: 10 });
  assert.deepEqual(parseExperimentalSpectrum(spectrumText(points)), points);
  assert.throws(() => parseExperimentalSpectrum("header\n1,2"), /至少 8/);
});

test("preflight responds to energy, firing temperature and atmosphere", () => {
  assert.equal(demoPreflight({ Sr: 1, Ti: 1, O: 3 }).grade, "A");
  assert.equal(demoPreflight({ Sr: 1, Ti: 1, O: 3 }, 900, "air", .3).grade, "C");
  const normal = demoPreflight({ Sr: 1, Ti: 1, O: 3 });
  assert.ok(demoPreflight({ Sr: 1, Ti: 1, O: 3 }, 500, "reducing").score < normal.score);
  assert.equal(normal.source, "demo");
  assert.equal(demoPreflight({ Ti: 1, O: 2 }, 900, "air", 0).source, "materials-project");
});

test("bound demonstration feedback downweights Mock ranking without changing labels; repeated application is idempotent", () => {
  const original = [material(5, { source: "mock", acquisitionValue: 10 })];
  const next = applySynthesisFeedback(original, feedback);
  assert.equal(next[0].acquisitionValue, 3);
  assert.equal(next[0].trueProperty, original[0].trueProperty);
  assert.equal(next[0].isSampled, false);
  assert.equal(original[0].synthesisFeedback, undefined);
  assert.deepEqual(applySynthesisFeedback(next, feedback), next);
  assert.equal(constrainAcquisition(-2, .1), -20);
});

test("feedback influences the actual next AL sample, not just table ordering", async () => {
  const pool = Array.from({ length: 7 }, (_, i) => material(i, { source: "mock", isSampled: i < 5, iteration: i < 5 ? 0 : undefined }));
  const constrained = applySynthesisFeedback(pool, feedback);
  const result = await runActiveLearningStep(constrained, state({ iteration: 1, sampledCount: 5 }),
    { totalBudget: 7, batchSize: 1, strategy: "UCB" }, { train() {}, predict() { return { mean: 10, std: .5 }; } });
  assert.equal(result.pool[5].isSampled, false);
  assert.equal(result.pool[6].isSampled, true);
});

test("pymatgen diffraction and controlled mixtures recover peak positions, phase contributions and zero offset", { skip: !existsSync(process.env.AI4S_PYTHON || ".venv/bin/python") }, async t => {
  t.after(closeSynthesisEngine);
  const xrd = await runSynthesis("xrd", xrdPayload(demoCrystal()));
  assert.ok(Math.abs(xrd.pattern.peaks[0].twoTheta-22.77210344) < 1e-5);
  assert.equal(xrd.pattern.peaks[0].hkl, "(1 0 0)");
  assert.equal(xrd.references.length, 2);
  for (const [kind, expected, passed] of [["clean", 98.4, true], ["impurity", 65, false]] as const) {
    const sample = await runSynthesis("demo", { ...xrd, kind });
    const result = await runSynthesis("compare", { ...xrd, points: sample.points });
    assert.ok(Math.abs(result.mainFraction-expected) < .2, JSON.stringify(result.phases));
    assert.equal(result.passed, passed);
    assert.ok(Math.abs(result.shift-.04) < .011);
    assert.ok(result.score > (passed ? 95 : 50));
  }
  const interrupted = runSynthesis("demo", { ...xrd, kind: "clean" });
  const rejection = assert.rejects(interrupted, /引擎已停止/);
  closeSynthesisEngine();
  await rejection;
  const restarted = await runSynthesis("xrd", xrdPayload(demoCrystal()));
  assert.equal(restarted.pattern.name, xrd.pattern.name);
  assert.ok(Math.abs(restarted.pattern.peaks[0].twoTheta-22.77210344) < 1e-5);
});
