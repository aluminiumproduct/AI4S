import assert from "node:assert/strict";
import test from "node:test";
import { DistillationWorkerClient, type DistillationWorker } from "../src/engine/distillation/DistillationWorkerClient";
import { DEFAULT_DISTILLATION_OPTIONS, type DistillationResult, type DistillationSnapshot } from "../src/engine/distillation/types";

class FakeWorker implements DistillationWorker {
  onmessage: DistillationWorker["onmessage"] = null;
  onerror: DistillationWorker["onerror"] = null;
  onmessageerror: DistillationWorker["onmessageerror"] = null;
  requests: Parameters<DistillationWorker["postMessage"]>[0][] = [];
  terminated = false;
  postMessage(message: Parameters<DistillationWorker["postMessage"]>[0]) { this.requests.push(message); }
  terminate() { this.terminated = true; }
  reply(snapshotId: string) { this.onmessage!({ data: { id: this.requests.at(-1)!.id, result: { snapshotId } as DistillationResult } }); }
}
const snapshot = { id: "run-1-model-gpr", samples: [], queries: [] } as unknown as DistillationSnapshot;
test("distillation cancellation rejects work, ignores old responses and permits restart", async () => {
  const workers: FakeWorker[] = [], client = new DistillationWorkerClient(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const first = client.run(snapshot, DEFAULT_DISTILLATION_OPTIONS), rejected = assert.rejects(first, { name: "AbortError" });
  const oldMessage = workers[0].onmessage!;
  client.cancel(); await rejected;
  const next = client.run(snapshot, DEFAULT_DISTILLATION_OPTIONS);
  oldMessage({ data: { id: workers[0].requests[0].id, result: { snapshotId: snapshot.id } as DistillationResult } });
  assert.equal(workers[1].terminated, false);
  workers[1].reply("wrong-snapshot");
  assert.equal(workers[1].terminated, false);
  workers[1].reply(snapshot.id);
  assert.equal((await next).snapshotId, snapshot.id);
  assert.equal(workers[1].terminated, true);
  client.dispose();
});
for (const reason of ["error", "messageerror", "timeout", "dispose"] as const) {
  test("distillation " + reason + " releases its worker and pending promise", async () => {
    const worker = new FakeWorker(), client = new DistillationWorkerClient(() => worker, 10);
    const work = client.run(snapshot, DEFAULT_DISTILLATION_OPTIONS), rejected = assert.rejects(work);
    if (reason === "error") worker.onerror!({});
    if (reason === "messageerror") worker.onmessageerror!({});
    if (reason === "dispose") client.dispose();
    await rejected; assert.equal(worker.terminated, true);
  });
}
test("distillation worker startup and postMessage errors settle requests", async () => {
  const unavailable = new DistillationWorkerClient(() => { throw new Error("missing"); });
  await assert.rejects(unavailable.run(snapshot, DEFAULT_DISTILLATION_OPTIONS), /Worker/);
  const worker = new FakeWorker();
  worker.postMessage = () => { throw new Error("uncloneable"); };
  const broken = new DistillationWorkerClient(() => worker);
  await assert.rejects(broken.run(snapshot, DEFAULT_DISTILLATION_OPTIONS), /快照/);
});
