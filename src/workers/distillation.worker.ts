import { searchPhysicalFormulas } from "../engine/distillation/search";
import type { DistillationOptions, DistillationSnapshot } from "../engine/distillation/types";

self.onmessage = async ({ data }: MessageEvent<{ id: number; snapshot: DistillationSnapshot; options: DistillationOptions }>) => {
  try {
    const result = await searchPhysicalFormulas(data.snapshot, data.options);
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : "公式搜索失败" });
  }
};
