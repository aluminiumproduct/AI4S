import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import axios from "axios";
import { createApiApp } from "../server/api";
import { createNetworkClient } from "../server/network";
import { json, listen } from "./httpFixtures";

const keys = { MP_API_KEY: "fake-private-material-key", DEEPSEEK_API_KEY: "fake-private-chat-key" };
const row = (index: number) => ({ material_id: `fixture-${index}`, formula_pretty: "Li2O", composition: { Li: 2, O: 1 }, band_gap: 1 });
const local = (url: string, options = {}) => axios.request({ url, proxy: false, validateStatus: () => true, ...options });

test("missing and placeholder keys return safe errors without outbound requests", async t => {
  const client = createNetworkClient({ proxyResolver: () => "" });
  t.after(() => client.close());
  const app = createApiApp({ network: client, env: { MP_API_KEY: "YOUR_MP_API_KEY" } });
  const url = await listen(t, http.createServer(app));
  for (const [path, method] of [["/api/materials?limit=5", "GET"], ["/api/chat", "POST"]]) {
    const response = await local(url + path, { method, data: { messages: [{ role: "user", content: "test" }] } });
    assert.equal(response.status, 503);
    assert.equal(response.data.code, "MISSING_API_KEY");
  }
});

test("invalid material counts are rejected before touching an upstream", async t => {
  const client = createNetworkClient({ proxyResolver: () => "" }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys })));
  for (const limit of ["0", "-1", "1.5", "2oops", "10001", "1&limit=2"]) {
    const response = await local(url + "/api/materials?limit=" + limit);
    assert.equal(response.status, 400);
    assert.equal(response.data.code, "INVALID_REQUEST");
  }
});

test("retried pagination neither duplicates nor loses a material page", async t => {
  const skips: number[] = [];
  const upstream = await listen(t, http.createServer((req, res) => {
    const query = new URL(req.url!, "http://fixture").searchParams;
    const skip = Number(query.get("_skip")); const size = Number(query.get("_limit"));
    skips.push(skip);
    if (skips.length === 1) return json(res, { error: "temporary" }, 503);
    assert.equal(req.headers["x-api-key"], keys.MP_API_KEY);
    json(res, { data: Array.from({ length: size }, (_, i) => row(skip + i)) });
  }));
  const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, materialsEndpoint: upstream })));
  const response = await local(url + "/api/materials?limit=1001");
  assert.equal(response.status, 200);
  assert.deepEqual(skips, [0, 0, 1000]);
  assert.equal(response.data.data.length, 1001);
  assert.equal(new Set(response.data.data.map((m: any) => m.material_id)).size, 1001);
  assert.equal(response.data.meta.total_doc, 1001);
});

test("empty/short upstream pages remain valid datasets", async t => {
  let count = 0;
  const upstream = await listen(t, http.createServer((_req, res) => json(res, { data: Array.from({ length: count }, (_, i) => row(i)) })));
  const client = createNetworkClient({ proxyResolver: () => "" }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, materialsEndpoint: upstream })));
  assert.equal((await local(url + "/api/materials?limit=5")).data.data.length, 0);
  count = 2;
  assert.equal((await local(url + "/api/materials?limit=5")).data.data.length, 2);
});

test("403 is reported as access denied without exposing upstream data or keys", async t => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args) => { logs.push(args.join(" ")); });
  let hits = 0;
  const upstream = await listen(t, http.createServer((_req, res) => { hits++; json(res, { error: keys.MP_API_KEY, details: "user:proxy-password" }, 403); }));
  const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, materialsEndpoint: upstream })));
  const response = await local(url + "/api/materials?limit=5");
  assert.equal(response.status, 403);
  assert.equal(response.data.code, "ACCESS_DENIED");
  assert.equal(hits, 1);
  const visible = JSON.stringify(response.data) + logs.join(" ");
  assert.ok(!visible.includes(keys.MP_API_KEY));
  assert.ok(!visible.includes("proxy-password"));
});

test("redirects cannot carry a material key to a new origin", async t => {
  t.mock.method(console, "error", () => {});
  let redirected = 0;
  const destination = await listen(t, http.createServer((_req, res) => { redirected++; json(res, { data: [] }); }));
  const upstream = await listen(t, http.createServer((_req, res) => { res.writeHead(301, { Location: destination }); res.end(); }));
  const client = createNetworkClient({ proxyResolver: () => "" }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, materialsEndpoint: upstream })));
  const response = await local(url + "/api/materials?limit=5");
  assert.equal(response.status, 502);
  assert.equal(response.data.code, "REDIRECT_ERROR");
  assert.equal(redirected, 0);
});

test("route deadline cancels a slow upstream and returns a safe timeout", async t => {
  t.mock.method(console, "error", () => {});
  let hits = 0;
  const upstream = await listen(t, http.createServer(() => { hits++; }));
  const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, materialsEndpoint: upstream, materialsDeadlineMs: 40 })));
  const response = await local(url + "/api/materials?limit=5");
  assert.equal(response.status, 504);
  assert.equal(response.data.code, "TIMEOUT");
  assert.equal(hits, 1);
});

test("bad upstream bodies produce a stable error instead of HTML or raw exceptions", async t => {
  t.mock.method(console, "error", () => {});
  const upstream = await listen(t, http.createServer((_req, res) => res.end("<html>unavailable</html>")));
  const client = createNetworkClient({ proxyResolver: () => "" }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, materialsEndpoint: upstream })));
  const response = await local(url + "/api/materials?limit=5");
  assert.equal(response.status, 502);
  assert.equal(response.data.code, "BAD_RESPONSE");
  assert.ok(!JSON.stringify(response.data).includes("<html>"));
});

test("chat SDK uses the shared transport and preserves its success response", async t => {
  let body: any, hits = 0;
  const upstream = await listen(t, http.createServer((req, res) => {
    hits++; let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      body = JSON.parse(raw);
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer " + keys.DEEPSEEK_API_KEY);
      json(res, { id: "chat-test", object: "chat.completion", created: 1, model: "fixture-model", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
  }));
  const client = createNetworkClient({ proxyResolver: () => "" }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, chatBaseURL: upstream + "/v1" })));
  const response = await local(url + "/api/chat", { method: "POST", data: { messages: [{ role: "user", content: "test" }] } });
  assert.equal(response.status, 200);
  assert.equal(response.data.choices[0].message.content, "OK");
  assert.equal(response.data.usage.total_tokens, 2);
  assert.equal(body.stream, false);
  assert.equal(hits, 1);
});

test("malformed chat success is a non-retryable bad response", async t => {
  t.mock.method(console, "error", () => {});
  let hits = 0;
  const upstream = await listen(t, http.createServer((_req, res) => { hits++; json(res, {}); }));
  const client = createNetworkClient({ proxyResolver: () => "" }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, chatBaseURL: upstream + "/v1" })));
  const response = await local(url + "/api/chat", { method: "POST", data: { messages: [{ role: "user", content: "test" }] } });
  assert.equal(response.status, 502);
  assert.equal(response.data.code, "BAD_RESPONSE");
  assert.equal(response.data.retryable, false);
  assert.equal(hits, 1);
});

for (const failure of ["reset", "timeout"]) {
  test(`chat ${failure} does not repeat a paid POST`, async t => {
    t.mock.method(console, "error", () => {});
    let hits = 0;
    const upstream = await listen(t, http.createServer((req) => {
      hits++;
      if (failure === "reset") req.socket.destroy();
    }));
    const client = createNetworkClient({ proxyResolver: () => "" }); t.after(() => client.close());
    const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, chatBaseURL: upstream + "/v1", chatDeadlineMs: 100 })));
    const response = await local(url + "/api/chat", { method: "POST", data: { messages: [{ role: "user", content: "test" }] } });
    assert.equal(response.status, failure === "reset" ? 502 : 504);
    assert.equal(response.data.code, failure === "reset" ? "NETWORK_ERROR" : "TIMEOUT");
    assert.equal(hits, 1);
  });
}

for (const status of [429, 500]) {
  test(`chat failure ${status} causes exactly one upstream POST`, async t => {
    const logs: string[] = [];
    t.mock.method(console, "error", (...args) => { logs.push(args.join(" ")); });
    let hits = 0;
    const upstream = await listen(t, http.createServer((_req, res) => { hits++; json(res, { error: { message: keys.DEEPSEEK_API_KEY, type: "fixture_error" } }, status); }));
    const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 }); t.after(() => client.close());
    const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, chatBaseURL: upstream + "/v1" })));
    const response = await local(url + "/api/chat", { method: "POST", data: { messages: [{ role: "user", content: "test" }] } });
    assert.equal(response.status, status === 429 ? 429 : 502);
    assert.equal(hits, 1);
    assert.ok(!(JSON.stringify(response.data) + logs.join(" ")).includes(keys.DEEPSEEK_API_KEY));
  });
}

test("client disconnect cancels the current material page and prevents another page", async t => {
  t.mock.method(console, "error", () => {});
  let hits = 0, started!: () => void, closed!: () => void;
  const secondPageStarted = new Promise<void>(resolve => { started = resolve; });
  const secondPageClosed = new Promise<void>(resolve => { closed = resolve; });
  const upstream = await listen(t, http.createServer((req, res) => {
    hits++;
    if (hits === 1) json(res, { data: Array.from({ length: 1000 }, (_, i) => row(i)) });
    else { req.socket.once("close", closed); started(); }
  }));
  const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 }); t.after(() => client.close());
  const url = await listen(t, http.createServer(createApiApp({ network: client, env: keys, materialsEndpoint: upstream })));
  const controller = new AbortController();
  const result = local(url + "/api/materials?limit=2001", { signal: controller.signal });
  const cancelled = assert.rejects(result, error => axios.isCancel(error));
  await secondPageStarted;
  controller.abort();
  await cancelled;
  await Promise.race([secondPageClosed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Upstream socket was not cancelled")), 1000);
    timer.unref();
  })]);
  assert.equal(hits, 2);
});
