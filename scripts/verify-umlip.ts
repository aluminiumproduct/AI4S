import dotenv from "dotenv";
import { UmlipService } from "../server/umlip/service";
import { demoConfigurations } from "../src/umlip/examples";

dotenv.config({ path: ".env.umlip.local", quiet: true });
const service = new UmlipService({ root: process.cwd(), env: process.env });
const run = service.start(demoConfigurations(), { budget: 4, initialSamples: 2, batchSize: 2, fmax: 0.08, maxSteps: 100 });
console.log(`Real MACE CPU validation run ${run.id}`);
let previous = "";
try {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const current = service.get(run.id);
    const key = current.candidates.map(c => `${c.id}:${c.status}:${c.progress?.step ?? "-"}`).join(" ");
    if (key !== previous) { previous = key; console.log(key); }
    if (current.status !== "running") {
      console.log(JSON.stringify(current, null, 2));
      if (current.status !== "completed" || current.rounds.length < 2 || !current.reference
        || current.candidates.filter(c => c.status === "converged").length < 3
        || current.candidates.some(c => c.status === "pending" && c.result)) process.exitCode = 1;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (service.get(run.id).status === "running") { service.cancel(run.id); throw new Error("Validation deadline exceeded"); }
} finally { service.close(); }
