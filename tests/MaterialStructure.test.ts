import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import axios from "axios";
import { createApiApp } from "../server/api";
import { createNetworkClient } from "../server/network";
import { json, listen } from "./httpFixtures";
import { isMaterialId, normalizeMaterialStructure } from "../src/structures/materialStructure";
import { StructureCache } from "../src/structures/StructureCache";
import { MaterialStructureService } from "../src/services/MaterialStructureService";
import { fractionalToCartesian, structureComposition } from "../src/structures/geometry";

// Synthetic contract fixture, not a claim about the real mp-1234 material.
const fixture = () => JSON.parse(readFileSync(new URL("./structure-fixtures/mp-structure.json", import.meta.url), "utf8"));
const at = "2026-10-27T06:00:00.000Z";
const key = "fake-private-structure-key";
const response = (doc = fixture()) => ({ data: { data: doc, meta: { materialId: doc.material_id, fetchedAt: at, cached: false } } });
const real = { id: "mp-1234", source: "materials-project" as const };
const request = (url: string, signal?: AbortSignal) => axios.get(url, { signal, proxy: false, validateStatus: () => true });

test("current alphabetic MP IDs are accepted alongside legacy numeric IDs", () => {
  for (const id of ["mp-aaafkmdf", "mp-1234", "mvc-12345"]) {
    assert.equal(isMaterialId(id), true);
    const doc = fixture(); doc.material_id = id;
    assert.equal(normalizeMaterialStructure(doc, id, at).source.materialId, id);
  }
  for (const id of ["mock-0-0", "mp-1,mp-2", "mp-1?x=2", "mp-../etc", "mp-" + "a".repeat(100)]) assert.equal(isMaterialId(id), false);
});

test("pymatgen full cells preserve lattice, fractional sites and occupancy without symmetry expansion", () => {
  const doc = fixture(); const s = normalizeMaterialStructure(doc, real.id, at);
  assert.deepEqual(s.lattice, [[0, 2, 2], [2, 0, 2], [2, 2, 0]]);
  assert.deepEqual(fractionalToCartesian(s.sites[0].fractional, s.lattice), [1, 1, 1]);
  assert.deepEqual(structureComposition(s), { Li: 2, O: 1 });
  assert.equal(s.sites.length, 3); assert.equal(s.source.materialId, real.id);
  assert.equal(s.source.spaceGroup, "Fm-3m"); assert.equal(s.source.fetchedAt, at);
  assert.deepEqual(JSON.parse(s.source.raw), doc.structure);
  assert.ok(!("trueProperty" in s)); assert.deepEqual(doc, fixture());
  doc.structure.sites[0].species = [{ element: "Li", occu: 0.5 }, { element: "Na", occu: 0.5 }];
  assert.equal(normalizeMaterialStructure(doc, real.id, at).sites[0].species.length, 2);
});

test("wrong IDs, invalid lattices, coordinates and species cannot be shown as a real structure", () => {
  for (const mutate of [
    (d: any) => { d.material_id = "mp-999"; },
    (d: any) => { d.structure.lattice.matrix[0] = [0, 0, 0]; },
    (d: any) => { d.structure.sites[0].abc = [NaN, 0, 0]; },
    (d: any) => { d.structure.sites[0].species[0].occu = 2; },
    (d: any) => { d.structure.sites[0].species[0].element = "Foo"; },
    (d: any) => { d.structure.lattice.pbc = [true, false, true]; },
    (d: any) => { d.structure.sites = []; },
  ]) { const doc = fixture(); mutate(doc); assert.throws(() => normalizeMaterialStructure(doc, real.id, at)); }
});

test("structure LRU expires entries and bounds count and total serialized bytes", () => {
  let now = 0; const cache = new StructureCache<string>(() => now, 100, 2, 12);
  cache.set("a", "one"); cache.set("b", "two"); assert.equal(cache.get("a"), "one");
  cache.set("c", "tri"); assert.equal(cache.get("b"), undefined); // a was recently used
  cache.set("big", "this does not fit"); assert.equal(cache.get("big"), undefined);
  now = 100; assert.equal(cache.get("a"), undefined);
  cache.set("d", "123456789"); assert.equal(cache.get("c"), undefined);
  const bytes = new StructureCache<string>(() => 0, 100, 10, 12);
  bytes.set("a", "one"); bytes.set("b", "two"); bytes.set("c", "tri");
  assert.equal(bytes.get("a"), undefined); assert.equal(bytes.get("b"), "two");
});

test("Mock and unverified provenance never make a structure request, even with an MP-shaped ID", async t => {
  t.mock.method(axios, "get", () => { throw new Error("Must not request"); });
  const service = new MaterialStructureService();
  for (const source of ["mock", undefined] as const) assert.deepEqual(await service.get({ id: "mp-1234", source }), { kind: "unavailable" });
});

test("client caches by material ID, keeping same-formula polymorphs distinct", async t => {
  const seen: string[] = [];
  t.mock.method(axios, "get", async (url: string) => {
    seen.push(url); const doc = fixture(); doc.material_id = url.includes("mp-999/") ? "mp-999" : "mp-1234";
    return response(doc);
  });
  const service = new MaterialStructureService();
  const first = await service.get(real); const second = await service.get(real);
  const other = await service.get({ ...real, id: "mp-999" });
  assert.equal(first.kind, "ready"); assert.equal(second.kind === "ready" && second.cached, true);
  assert.equal(other.kind === "ready" && other.structure.source.materialId, "mp-999");
  assert.equal(seen.length, 2);
});

test("failed and cancelled client requests never poison the structure cache", async t => {
  let attempts = 0; const controller = new AbortController();
  t.mock.method(axios, "get", async () => {
    attempts++;
    if (attempts === 1) throw { response: { data: { code: "ACCESS_DENIED" } } };
    if (attempts === 2) controller.abort();
    return response();
  });
  const service = new MaterialStructureService();
  await assert.rejects(service.get(real)); await assert.rejects(service.get(real, controller.signal));
  assert.equal((await service.get(real)).kind, "ready"); assert.equal(attempts, 3);
});

test("client rejects a mismatched successful response and can retry", async t => {
  let attempts = 0;
  t.mock.method(axios, "get", async () => { const doc = fixture(); if (++attempts === 1) doc.material_id = "mp-999"; return response(doc); });
  const service = new MaterialStructureService();
  await assert.rejects(service.get(real), { code: "BAD_RESPONSE" });
  assert.equal((await service.get(real)).kind, "ready"); assert.equal(attempts, 2);
});

test("structure endpoint requests exactly one ID and serves later requests from its cache", async t => {
  let hits = 0;
  const upstream = await listen(t, http.createServer((req, res) => {
    hits++; const query = new URL(req.url!, "http://fixture").searchParams;
    assert.equal(query.get("material_ids"), real.id); assert.equal(query.get("_limit"), "1");
    assert.equal(query.get("elements"), null); assert.ok(query.get("_fields")?.split(",").includes("structure"));
    assert.equal(req.headers["x-api-key"], key); json(res, { data: [fixture()] });
  }));
  const network = createNetworkClient({ proxyResolver: () => "" }); t.after(() => network.close());
  const url = await listen(t, http.createServer(createApiApp({ network, env: { MP_API_KEY: key }, materialsEndpoint: upstream })));
  const first = await request(url + "/api/materials/mp-1234/structure");
  const second = await request(url + "/api/materials/mp-1234/structure");
  assert.equal(first.status, 200); assert.equal(first.data.meta.cached, false);
  assert.equal(second.data.meta.cached, true); assert.equal(hits, 1);
  assert.equal(first.data.data.material_id, real.id); assert.equal(first.data.meta.fetchedAt, second.data.meta.fetchedAt);
  assert.ok(!JSON.stringify(first.data).includes(key));
  for (const id of ["mock-0-0", "Li2O", "mp-1234,mp-99", "mp-1?x=1"]) {
    const invalid = await request(url + `/api/materials/${encodeURIComponent(id)}/structure`); assert.equal(invalid.status, 400);
  }
  assert.equal(hits, 1);
});

test("structure access with no key does not call upstream", async t => {
  let hits = 0;
  const upstream = await listen(t, http.createServer((_req, res) => { hits++; json(res, {}); }));
  const network = createNetworkClient({ proxyResolver: () => "" }); t.after(() => network.close());
  const url = await listen(t, http.createServer(createApiApp({ network, env: {}, materialsEndpoint: upstream })));
  const result = await request(url + "/api/materials/mp-1234/structure");
  assert.equal(result.data.code, "MISSING_API_KEY"); assert.equal(hits, 0);
});

for (const mode of ["missing", "wrong-id", "malformed", "forbidden"] as const) {
  test(`structure ${mode} returns a safe result and is not cached`, async t => {
    t.mock.method(console, "error", () => {}); let hits = 0;
    const upstream = await listen(t, http.createServer((_req, res) => {
      if (++hits > 1) return json(res, { data: [fixture()] });
      if (mode === "missing") return json(res, { data: [] });
      if (mode === "forbidden") return json(res, { error: key }, 403);
      const doc = fixture(); if (mode === "wrong-id") doc.material_id = "mp-999"; else doc.structure.sites[0].abc = [null, 0, 0];
      json(res, { data: [doc] });
    }));
    const network = createNetworkClient({ proxyResolver: () => "" }); t.after(() => network.close());
    const url = await listen(t, http.createServer(createApiApp({ network, env: { MP_API_KEY: key }, materialsEndpoint: upstream })));
    const first = await request(url + "/api/materials/mp-1234/structure");
    assert.equal(first.status, mode === "missing" ? 404 : mode === "forbidden" ? 403 : 502);
    assert.ok(!JSON.stringify(first.data).includes(key));
    assert.equal((await request(url + "/api/materials/mp-1234/structure")).status, 200); assert.equal(hits, 2);
  });
}

test("closing a structure request aborts upstream instead of caching a late response", async t => {
  let started!: () => void, closed!: () => void, hits = 0;
  const began = new Promise<void>(resolve => { started = resolve; });
  const ended = new Promise<void>(resolve => { closed = resolve; });
  const upstream = await listen(t, http.createServer((req, res) => {
    if (++hits === 1) { req.socket.once("close", closed); started(); } else json(res, { data: [fixture()] });
  }));
  const network = createNetworkClient({ proxyResolver: () => "" }); t.after(() => network.close());
  const url = await listen(t, http.createServer(createApiApp({ network, env: { MP_API_KEY: key }, materialsEndpoint: upstream })));
  const controller = new AbortController(); const pending = request(url + "/api/materials/mp-1234/structure", controller.signal);
  const cancelled = assert.rejects(pending, e => axios.isCancel(e)); await began; controller.abort(); await cancelled;
  await Promise.race([ended, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Structure upstream leaked")), 1000); timer.unref(); })]);
  assert.equal((await request(url + "/api/materials/mp-1234/structure")).status, 200); assert.equal(hits, 2);
});
