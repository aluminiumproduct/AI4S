import { extractCompositionFeatures } from "../../src/engine/CompositionFeatures";
import { DEFAULT_MODEL_CONFIG } from "../../src/engine/models/config";
import { buildDistillationSnapshot } from "../../src/engine/distillation/features";
import { DEFAULT_DISTILLATION_OPTIONS } from "../../src/engine/distillation/types";
import { DistillationWorkerClient } from "../../src/engine/distillation/DistillationWorkerClient";
import type { Material } from "../../src/types";

const output = document.querySelector<HTMLPreElement>("#results")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
button.onclick = async () => {
  button.disabled = true; output.textContent = "";
  const log = (message: string) => { output.textContent += message + "\n"; };
  const materials: Material[] = Array.from({ length: 60 }, (_, i) => {
    const composition = { Li: i + 1, O: 2 }, data = extractCompositionFeatures(composition);
    return { id: "demo-" + i, formula: "Li" + (i + 1) + "O2", composition, ...data, targetKind: "synthetic-score",
      trueProperty: i < 34 ? 1 + 0.4 * data.descriptors.statistics.electronegativityPauling.mean! ** 2 : 123456789,
      isSampled: i < 34, cost: 1 };
  });
  const snapshot = buildDistillationSnapshot(materials, { runId: 1, iteration: 16, target: "observed", objective: "synthetic-score", modelConfig: DEFAULT_MODEL_CONFIG });
  const client = new DistillationWorkerClient();
  try {
    if (JSON.stringify(snapshot).includes("123456789")) throw new Error("Hidden candidate label leaked");
    for (const target of ["observed", "teacher"] as const) {
      const result = await client.run({ ...snapshot, id: target, target }, { ...DEFAULT_DISTILLATION_OPTIONS, l0: 0, l1: 0 });
      if (!result.formulas.length || result.metrics.rmse === null || !Number.isFinite(result.metrics.rmse)) throw new Error("Invalid formula result");
      if (target === "observed" && result.metrics.rmse > 1e-6) throw new Error("Known relation not recovered");
      log("PASS " + target + ": " + result.formulas.map(formula => formula.text).join(" ; ") + " · 测试 RMSE " + result.metrics.rmse.toPrecision(4));
    }
    const pending = client.run(snapshot, DEFAULT_DISTILLATION_OPTIONS);
    client.cancel();
    let cancelled = false;
    try { await pending; } catch (error) { cancelled = error instanceof Error && error.name === "AbortError"; }
    if (!cancelled) throw new Error("Cancellation failed");
    await client.run(snapshot, DEFAULT_DISTILLATION_OPTIONS);
    log("PASS 取消与立即重启；未采样标签隔离");
    log("ALL PASS — 真实公式 Worker、符号拟合与教师蒸馏");
  } catch (error) { log("FAIL " + (error instanceof Error ? error.message : error)); }
  finally { client.dispose(); button.disabled = false; }
};
