import { ModelWorkerClient } from "../../src/engine/ModelWorkerClient";
import { MODEL_CATALOG } from "../../src/engine/models/config";
import { seededRandom } from "../../src/engine/models/math";
import { extractCompositionFeatures } from "../../src/engine/CompositionFeatures";

const output = document.querySelector<HTMLPreElement>("#results")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const random = seededRandom(20261027);
const samples = (n: number) => Array.from({ length: n }, () => {
  const { features } = extractCompositionFeatures({ Li: 1 + Math.floor(8 * random()), O: 1 + Math.floor(12 * random()),
    [(["P", "S", "Ge", "Sn", "La", "Zr", "Ti", "Sr"])[Math.floor(8 * random())]]: 1 + Math.floor(4 * random()) });
  return { features, trueProperty: Math.sin(4 * features[0]) + features[1] ** 2 + 0.5 * features[2] };
});
const train = samples(50), test = samples(1000);
const log = (line: string) => { output.textContent += line + "\n"; };
button.onclick = async () => {
  button.disabled = true;
  output.textContent = "50 训练样本 × 22 维组成特征，1000 独立合成候选（目标为合成函数）\n";
  try {
    for (const { id, zh } of MODEL_CATALOG) {
      const client = new ModelWorkerClient({ kind: id });
      try {
        await client.train(train);
        const predictions = await client.predictBatch(test);
        if (predictions.length !== 1000 || predictions.some(p => !Number.isFinite(p.mean) || !Number.isFinite(p.std) || p.std < 0)) throw new Error(`${id}: invalid predictions`);
        const rmse = Math.sqrt(predictions.reduce((sum, p, i) => sum + (p.mean - test[i].trueProperty) ** 2, 0) / predictions.length);
        const info = client.diagnostics!;
        log(`PASS ${zh}: 拟合 ${info.trainMs.toFixed(1)} ms / 批量预测 ${info.predictMs.toFixed(1)} ms / 合成留出 RMSE ${rmse.toFixed(4)}`);
      } finally { client.dispose(); }
    }
    const client = new ModelWorkerClient({ kind: "knn" });
    try {
      await client.train(samples(200));
      const stressCandidates = samples(20_000);
      let frames = 0, alive = true;
      const heartbeat = () => { if (alive) { frames++; requestAnimationFrame(heartbeat); } };
      requestAnimationFrame(heartbeat);
      const started = performance.now();
      const work = client.predictBatch(stressCandidates);
      setTimeout(() => client.cancel(), 80);
      let cancelled = false;
      try { await work; } catch (error) { cancelled = error instanceof Error && error.name === "AbortError"; }
      alive = false;
      if (!cancelled || frames < 1) throw new Error(`Cancellation/heartbeat failed: cancelled=${cancelled}, frames=${frames}`);
      log(`PASS 高负载中取消: ${(performance.now() - started).toFixed(1)} ms；主线程动画 ${frames} 帧`);
      await client.train(train);
      const restarted = await client.predictBatch(test.slice(0, 3));
      if (restarted.length !== 3) throw new Error("Restart failed");
      log("PASS 取消后立即重新训练与预测");
    } finally { client.dispose(); }
    log("ALL PASS — 七种真实 Worker 模型、主线程响应、取消与重启");
  } catch (error) { log(`FAIL ${error instanceof Error ? error.message : error}`); }
  finally { button.disabled = false; }
};
