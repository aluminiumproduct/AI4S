import dotenv from "dotenv";
import { HubStore, parseHubQuery } from "../server/hubStore";
import { fetchMPRecords } from "../server/mpProvider";
import { createNetworkClient } from "../server/network";
import { resolve } from "node:path";

dotenv.config();
const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((out, value, i, all) => {
  if (value.startsWith("--")) out.push([value.slice(2), all[i + 1]]);
  return out;
}, []));
const query = parseHubQuery({ source: "mp-live", elements: args.elements ?? "Li,O", exclude_elements: args.exclude,
  limit: args.limit ?? "20", match: args.match ?? "contains", objective: "band-gap" });
const store = new HubStore(resolve(process.env.AI4S_HUB_DB || "data/ai4s_hub.db"));
const network = createNetworkClient();
try {
  const records = await fetchMPRecords(network, process.env, "https://api.materialsproject.org/materials/summary/", query, AbortSignal.timeout(60_000));
  if (records.length) store.import("mp-snapshot", records, true);
  console.log(JSON.stringify({ captured: records.length, query, database: store.filename, catalog: store.catalog(), note: "Personal local snapshot; preserve provenance and review original licensing before redistribution." }, null, 2));
} catch (error) {
  console.error(`Snapshot capture failed: ${(error as { code?: string }).code ?? "INVALID_DATA"}`);
  process.exitCode = 1;
} finally { network.close(); store.close(); }
