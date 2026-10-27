import assert from "node:assert/strict";
import test from "node:test";
import { ModelWorkerClient, type ModelWorker, type ModelRequest, type ModelResponse } from "../src/engine/ModelWorkerClient";
import type { ModelDiagnostics } from "../src/engine/SurrogateModel";
import { material } from "./fixtures";

class FakeWorker implements ModelWorker {
  onmessage: ModelWorker["onmessage"] = null;
  onerror: ModelWorker["onerror"] = null;
  onmessageerror: ModelWorker["onmessageerror"] = null;
  requests: ModelRequest[] = [];
  terminated = false;
  postMessage(message: ModelRequest) { this.requests.push(message); }
  terminate() { this.terminated = true; }
  reply(result: Extract<ModelResponse, { result: unknown }>["result"]) {
    this.onmessage!({ data: { id: this.requests.at(-1)!.id, result } });
  }
}
const diagnostics: ModelDiagnostics = { kind: "gpr", samples: 1, dimensions: 11, trainMs: 1, predictMs: 2, uncertainty: "gp" };

test("Worker messages expose only sampled labels for training and only features for prediction", async () => {
  const worker = new FakeWorker(), client = new ModelWorkerClient({}, () => worker);
  const pending = client.train([material(0)]);
  assert.equal(worker.requests[0].operation, "train");
  assert.deepEqual(Object.keys(worker.requests[0].data[0]).sort(), ["features", "trueProperty"]);
  worker.reply({ diagnostics });
  await pending;
  const prediction = client.predictBatch([material(1)]);
  assert.deepEqual(Object.keys(worker.requests[1].data[0]), ["features"]);
  worker.reply({ predictions: [{ mean: 2, std: 0.2 }], diagnostics });
  assert.deepEqual(await prediction, [{ mean: 2, std: 0.2 }]);
  assert.equal(client.diagnostics, diagnostics);
  client.dispose();
});

test("cancel terminates computation, rejects pending tasks, and allows immediate restart", async () => {
  const workers: FakeWorker[] = [];
  const client = new ModelWorkerClient({}, () => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const first = client.train([material()]);
  const rejected = assert.rejects(first, { name: "AbortError" });
  const oldMessage = workers[0].onmessage!, oldError = workers[0].onerror!;
  client.cancel();
  await rejected;
  assert.equal(workers[0].terminated, true);
  const next = client.train([material()]);
  oldMessage({ data: { id: workers[0].requests[0].id, result: { diagnostics } } });
  oldError({});
  assert.equal(workers[1].terminated, false);
  assert.equal(client.diagnostics, undefined);
  workers[1].reply({ diagnostics });
  await next;
  assert.equal(client.diagnostics, diagnostics);
  client.dispose();
});

for (const reason of ["error", "messageerror", "timeout", "dispose"] as const) {
  test(`Worker ${reason} settles pending work and releases resources`, async () => {
    const worker = new FakeWorker(), client = new ModelWorkerClient({}, () => worker, 10);
    const work = client.train([material()]);
    const rejected = assert.rejects(work);
    if (reason === "error") worker.onerror!({});
    if (reason === "messageerror") worker.onmessageerror!({});
    if (reason === "dispose") client.dispose();
    await rejected;
    assert.equal(worker.terminated, true);
    assert.equal(worker.onmessage, null);
  });
}

test("model and startup errors propagate without hanging promises", async () => {
  const worker = new FakeWorker(), client = new ModelWorkerClient({}, () => worker);
  const work = client.train([material()]);
  const rejected = assert.rejects(work, /invalid input/);
  worker.onmessage!({ data: { id: worker.requests[0].id, error: "invalid input" } });
  await rejected;
  client.dispose();
  const unavailable = new ModelWorkerClient({}, () => { throw new Error("Worker missing"); });
  await assert.rejects(unavailable.train([material()]), /Worker unavailable/);
});
