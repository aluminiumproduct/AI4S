import { importStructures } from "./importStructure";

self.onmessage = (event: MessageEvent<{ text: string; filename: string; format: "auto" | "cif" | "poscar" }>) => {
  try {
    const { text, filename, format } = event.data;
    self.postMessage({ structures: importStructures(text, filename, format) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "结构解析失败。" });
  }
};
