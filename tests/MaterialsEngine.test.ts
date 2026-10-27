import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { MaterialsEngine } from "../src/engine/MaterialsEngine";
import { realResponse } from "./fixtures";

test("repeated fallback replaces the pool without accumulating duplicate IDs", async t => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(axios, "get", async () => { throw new Error("offline fixture"); });
  const engine = new MaterialsEngine();
  assert.equal(await engine.loadRealData(10), false);
  const previous = engine.getPool();
  assert.equal(previous.length, 20); // Preserve the existing two polymorphs per composition.
  assert.ok(previous.every(m => m.source === "mock"));
  await engine.loadRealData(10);
  const next = engine.getPool();
  assert.equal(next.length, 20);
  assert.equal(new Set(next.map(m => m.id)).size, 20);
  assert.notEqual(next, previous);
  assert.equal(previous.length, 20);
});

test("fallback after real data cannot mix real labels with synthetic scores", async t => {
  t.mock.method(console, "warn", () => {});
  let fail = false;
  t.mock.method(axios, "get", async () => {
    if (fail) throw new Error("offline fixture");
    return realResponse(["real-1"]);
  });
  const engine = new MaterialsEngine();
  assert.equal(await engine.loadRealData(1), true);
  assert.equal(engine.getPool()[0].source, "materials-project");
  fail = true;
  assert.equal(await engine.loadRealData(2), false);
  assert.equal(engine.getPool().length, 4);
  assert.ok(engine.getPool().every(m => m.id.startsWith("mock-")));
  assert.equal(engine.getGlobalMax(), Math.max(...engine.getPool().map(m => m.trueProperty)));
});

test("an older failed request cannot replace a newer real dataset", async t => {
  t.mock.method(console, "warn", () => {});
  let rejectOld!: (error: Error) => void;
  const old = new Promise((_resolve, reject) => { rejectOld = reject; });
  let calls = 0;
  t.mock.method(axios, "get", () => ++calls === 1 ? old : Promise.resolve(realResponse(["latest"])));
  const engine = new MaterialsEngine();
  const first = engine.loadRealData(10);
  assert.equal(await engine.loadRealData(1), true);
  rejectOld(new Error("late failure"));
  await first;
  assert.deepEqual(engine.getPool().map(m => m.id), ["latest"]);
  assert.equal(engine.getGlobalMax(), 1);
});

test("an older successful request cannot overwrite a newer fallback", async t => {
  t.mock.method(console, "warn", () => {});
  let resolveOld!: (response: ReturnType<typeof realResponse>) => void;
  const old = new Promise(resolve => { resolveOld = resolve; });
  let calls = 0;
  t.mock.method(axios, "get", () => ++calls === 1 ? old : Promise.reject(new Error("newer failure")));
  const engine = new MaterialsEngine();
  const first = engine.loadRealData(10);
  await engine.loadRealData(2);
  const latest = engine.getPool();
  resolveOld(realResponse(["old-real"]));
  await first;
  assert.equal(engine.getPool(), latest);
  assert.ok(engine.getPool().every(m => m.id.startsWith("mock-")));
});

test("empty real and fallback datasets have a safe empty maximum", async t => {
  t.mock.method(console, "warn", () => {});
  const get = t.mock.method(axios, "get", async () => realResponse([]));
  const engine = new MaterialsEngine();
  assert.equal(await engine.loadRealData(0), true);
  assert.equal(engine.getPool().length, 0);
  assert.equal(engine.getGlobalMax(), 0);
  get.mock.mockImplementation(async () => { throw new Error("offline fixture"); });
  await engine.loadRealData(0);
  assert.equal(engine.getPool().length, 0);
  assert.equal(engine.getGlobalMax(), 0);
});

test("fallback exposes only a safe reason and later real success clears it", async t => {
  t.mock.method(console, "warn", () => {});
  let shouldFail = true;
  t.mock.method(axios, "get", async () => {
    if (shouldFail) throw { response: { data: { code: "ACCESS_DENIED", error: "fake-secret-from-upstream" } } };
    return realResponse(["restored"]);
  });
  const engine = new MaterialsEngine();
  await engine.loadRealData(2);
  assert.equal(engine.getLoadIssue(), "ACCESS_DENIED");
  assert.equal(engine.getPool().length, 4);
  shouldFail = false;
  assert.equal(await engine.loadRealData(1), true);
  assert.equal(engine.getLoadIssue(), null);
});

test("newer loads actively abort the previous request", async t => {
  let previousSignal: AbortSignal | undefined;
  t.mock.method(axios, "get", (_url: string, options: { signal: AbortSignal }) => {
    if (!previousSignal) {
      previousSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ERR_CANCELED" }))));
    }
    return Promise.resolve(realResponse(["latest"]));
  });
  const engine = new MaterialsEngine();
  const previous = engine.loadRealData(2);
  await engine.loadRealData(1);
  await previous;
  assert.equal(previousSignal?.aborted, true);
  assert.deepEqual(engine.getPool().map(m => m.id), ["latest"]);
  assert.equal(engine.getLoadIssue(), null);
});

test("explicit cancellation leaves the previous dataset and does not generate Mock", async t => {
  t.mock.method(console, "warn", () => { throw new Error("Cancellation must not fall back to Mock"); });
  const get = t.mock.method(axios, "get", async () => realResponse(["existing"]));
  const engine = new MaterialsEngine();
  await engine.loadRealData(1);
  get.mock.mockImplementation((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ERR_CANCELED" })));
  }));
  const pending = engine.loadRealData(2);
  engine.cancelLoad();
  await pending;
  assert.deepEqual(engine.getPool().map(m => m.id), ["existing"]);
  assert.equal(engine.getLoadIssue(), null);
});
