import type { ExperimentRecord } from "./types";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ai4s-synthesis-lab", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("experiments", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveExperiment(record: ExperimentRecord): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("experiments", "readwrite");
    tx.objectStore("experiments").put(record);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}
export async function experimentHistory(): Promise<ExperimentRecord[]> {
  const db = await database();
  const records = await new Promise<ExperimentRecord[]>((resolve, reject) => {
    const request = db.transaction("experiments").objectStore("experiments").getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close();
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
