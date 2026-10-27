import { SurrogateModel } from "../src/engine/SurrogateModel";
import { MODEL_CATALOG } from "../src/engine/models/config";
import { seededRandom } from "../src/engine/models/math";

const random = seededRandom(20261027);
const samples = (n: number) => Array.from({ length: n }, () => {
  const features = Array.from({ length: 11 }, random);
  return { features, trueProperty: Math.sin(4 * features[0]) + features[1] ** 2 + 0.5 * features[2] };
});
const train = samples(50), test = samples(1000), results = [];
for (const { id } of MODEL_CATALOG) {
  const model = new SurrogateModel({ kind: id });
  await model.train(train);
  const predictions = model.predictBatch(test);
  const rmse = Math.sqrt(predictions.reduce((sum, p, i) => sum + (p.mean - test[i].trueProperty) ** 2, 0) / test.length);
  results.push({ ...model.diagnostics, syntheticHoldoutRMSE: rmse });
}
console.log(JSON.stringify({
  warning: "Synthetic engineering benchmark; not evidence of real-material accuracy or discovery speedup.",
  runtime: process.version, platform: process.platform, architecture: process.arch,
  seed: 20261027, trainingSamples: 50, dimensions: 11, predictionSamples: 1000, results,
}, null, 2));
