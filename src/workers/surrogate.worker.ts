import { SurrogateModel } from "../engine/SurrogateModel";
import type { ModelRequest, ModelResponse } from "../engine/ModelWorkerClient";

let model: SurrogateModel | undefined;
self.onmessage = async ({ data }: MessageEvent<ModelRequest>) => {
  let response: ModelResponse;
  try {
    if (data.operation === "train") {
      model = new SurrogateModel(data.config);
      await model.train(data.data);
      response = { id: data.id, result: { diagnostics: model.diagnostics! } };
    } else {
      if (!model?.diagnostics) throw new Error("Train the surrogate before predicting");
      response = { id: data.id, result: { predictions: model.predictBatch(data.data), diagnostics: model.diagnostics } };
    }
  } catch (error) {
    response = { id: data.id, error: error instanceof Error ? error.message : "Model computation failed" };
  }
  self.postMessage(response);
};
