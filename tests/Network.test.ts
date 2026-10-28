import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { getProxyForUrl } from "proxy-from-env";
import { createNetworkClient, httpFailure, networkFailure, NetworkFailure } from "../server/network";
import { json, listen, withProxyEnvironment } from "./httpFixtures";

test("no proxy environment means direct access", async t => {
  let hits = 0;
  const url = await listen(t, http.createServer((_req, res) => { hits++; json(res, { direct: true }); }));
  await withProxyEnvironment({}, async () => {
    const client = createNetworkClient();
    try { assert.deepEqual((await client.request({ url })).data, { direct: true }); }
    finally { client.close(); }
  });
  assert.equal(hits, 1);
});

test("existing HTTP_PROXY and NO_PROXY are honored automatically", async t => {
  let direct = 0, proxied = 0;
  const target = await listen(t, http.createServer((_req, res) => { direct++; json(res, { route: "direct" }); }));
  const proxy = await listen(t, http.createServer((req, res) => {
    proxied++;
    assert.equal(req.url, target + "/");
    json(res, { route: "proxy" });
  }));
  await withProxyEnvironment({ HTTP_PROXY: proxy }, async () => {
    const client = createNetworkClient();
    try {
      assert.deepEqual((await client.request({ url: target })).data, { route: "proxy" });
      process.env.NO_PROXY = new URL(target).host;
      assert.deepEqual((await client.request({ url: target })).data, { route: "direct" });
    } finally { client.close(); }
  });
  assert.equal(direct, 1); assert.equal(proxied, 1);
});

test("standard proxy precedence and NO_PROXY domain/port/wildcard rules remain intact", async () => {
  await withProxyEnvironment({ HTTPS_PROXY: "http://upper.test:1", https_proxy: "http://lower.test:2", ALL_PROXY: "socks5h://fallback.test:3" }, () => {
    assert.equal(getProxyForUrl("https://api.example.test"), "http://lower.test:2");
    assert.equal(getProxyForUrl("http://api.example.test"), "socks5h://fallback.test:3");
    for (const entry of ["api.example.test", ".example.test", "*.example.test", "api.example.test:443", "*"]) {
      process.env.NO_PROXY = entry;
      assert.equal(getProxyForUrl("https://api.example.test"), "");
    }
    process.env.NO_PROXY = "api.example.test:8443";
    assert.equal(getProxyForUrl("https://api.example.test"), "http://lower.test:2");
  });
});

test("HTTPS targets use CONNECT without exposing target credentials to the proxy", async t => {
  const seen: http.IncomingMessage[] = [];
  const proxyServer = http.createServer();
  proxyServer.on("connect", (req, socket) => {
    seen.push(req);
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  const proxy = await listen(t, proxyServer);
  const client = createNetworkClient({ proxyResolver: () => proxy, getRetries: 0 });
  try {
    const response = await client.request({ url: "https://target.invalid/materials", headers: { "X-API-KEY": "fake-secret", Authorization: "Bearer fake-chat-secret" } });
    assert.equal(response.status, 407);
  } finally { client.close(); }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "CONNECT");
  assert.equal(seen[0].url, "target.invalid:443");
  assert.equal(seen[0].headers["x-api-key"], undefined);
  assert.equal(seen[0].headers.authorization, undefined);
});

test("HTTPS CONNECT succeeds with a trusted certificate and rejects an untrusted one", async t => {
  // These committed credentials are generated fixtures, never real API credentials.
  const cert = readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url));
  const key = readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url));
  let targetHits = 0;
  const target = await listen(t, https.createServer({ cert, key }, (req, res) => {
    targetHits++;
    assert.equal(req.headers["x-api-key"], "fake-material-key");
    assert.equal(req.headers["proxy-authorization"], undefined);
    json(res, { tunnel: true });
  }));
  const targetPort = Number(new URL(target).port);
  const sockets = new Set<net.Socket>();
  const proxyServer = http.createServer();
  let connects = 0;
  proxyServer.on("connect", (req, socket, head) => {
    connects++;
    assert.equal(req.url, `127.0.0.1:${targetPort}`);
    assert.equal(req.headers["proxy-authorization"], "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"));
    assert.equal(req.headers["x-api-key"], undefined);
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(upstream); sockets.add(socket as net.Socket);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => { upstream.destroy(); sockets.delete(socket as net.Socket); });
    upstream.on("close", () => { socket.destroy(); sockets.delete(upstream); });
  });
  const proxy = new URL(await listen(t, proxyServer));
  proxy.username = "fixture-user"; proxy.password = "fixture-password";
  const client = createNetworkClient({ proxyResolver: () => proxy.href, getRetries: 0 });
  try {
    const url = target.replace("http:", "https:");
    // Node loads an extra CA at startup. A child proves the actual default TLS
    // path works, without changing trust or disabling verification in this process.
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import { createNetworkClient } from './server/network.ts';
      const client = createNetworkClient({ proxyResolver: () => process.env.AI4S_TEST_PROXY, getRetries: 0 });
      try {
        const response = await client.request({ url: process.env.AI4S_TEST_TARGET, headers: { 'X-API-KEY': 'fake-material-key' } });
        if (response.status !== 200 || response.data.tunnel !== true) throw new Error('Tunnel failed');
        process.stdout.write('trusted');
      } finally { client.close(); }
    `], { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 5000,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL("./fixtures/localhost-cert.pem", import.meta.url)), AI4S_TEST_PROXY: proxy.href, AI4S_TEST_TARGET: url } });
    assert.equal(stdout, "trusted");
    await assert.rejects(client.request({ url }), (error: NetworkFailure) => error.code === "TLS_ERROR");
    assert.equal(targetHits, 1);
    assert.equal(connects, 2);
  } finally {
    client.close();
    for (const socket of sockets) socket.destroy();
  }
});

for (const endBy of ["attempt timeout", "cancellation", "client shutdown"]) {
  test(`a stalled CONNECT socket is destroyed after ${endBy}`, async t => {
    let connected!: () => void, socket!: net.Socket;
    const started = new Promise<void>(resolve => { connected = resolve; });
    const proxyServer = http.createServer();
    proxyServer.on("connect", (_req, connection) => {
      socket = connection as net.Socket;
      // HTTP CONNECT sockets are half-open; complete the fixture's half-close too.
      socket.on("end", () => socket.end()); socket.resume(); connected();
    });
    const proxy = await listen(t, proxyServer);
    const client = createNetworkClient({ proxyResolver: () => proxy, getRetries: 0, attemptTimeoutMs: endBy === "attempt timeout" ? 80 : 2000, totalTimeoutMs: 3000 });
    const controller = new AbortController();
    const pending = client.request({ url: "https://target.invalid/", signal: controller.signal });
    const rejected = assert.rejects(pending, (error: NetworkFailure) => endBy === "cancellation" ? error.code === "CANCELLED" : error.code === "TIMEOUT");
    try {
      await started;
      const socketClosed = once(socket, "close");
      if (endBy === "cancellation") controller.abort();
      if (endBy === "client shutdown") client.close();
      await rejected;
      await Promise.race([socketClosed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Proxy handshake socket leaked")), 1000); timer.unref();
      })]);
      assert.equal(socket.destroyed, true);
    } finally { client.close(); socket?.destroy(); }
  });
}

test("ALL_PROXY supports SOCKS5h without resolving the destination locally", async t => {
  let destination = "";
  const proxy = net.createServer(socket => {
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0]));
      socket.once("data", request => {
        assert.equal(request[3], 3); // The hostname, not a locally resolved IP, reaches the proxy.
        destination = request.subarray(5, 5 + request[4]).toString();
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const address = proxy.address() as net.AddressInfo;
  await withProxyEnvironment({ ALL_PROXY: `socks5h://127.0.0.1:${address.port}` }, async () => {
    const client = createNetworkClient({ getRetries: 0 });
    try { await assert.rejects(client.request({ url: "https://destination.invalid/test" }), (error: NetworkFailure) => error.code === "PROXY_ERROR"); }
    finally { client.close(); }
  });
  assert.equal(destination, "destination.invalid");
});

test("a cancelled SOCKS handshake is cleaned within its fixed attempt timeout", async t => {
  let started!: () => void, socket!: net.Socket;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const proxy = net.createServer(connection => {
    socket = connection;
    socket.on("end", () => socket.end());
    socket.on("data", () => started());
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const client = createNetworkClient({ proxyResolver: () => `socks5h://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, getRetries: 0, attemptTimeoutMs: 100 });
  const controller = new AbortController();
  const pending = client.request({ url: "https://destination.invalid", signal: controller.signal });
  const cancelled = assert.rejects(pending, (error: NetworkFailure) => error.code === "CANCELLED");
  try {
    await ready;
    const closed = once(socket, "close");
    controller.abort(); await cancelled;
    await Promise.race([closed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("SOCKS handshake socket leaked")), 1000); timer.unref();
    })]);
    assert.equal(socket.destroyed, true);
  } finally { client.close(); socket?.destroy(); }
});

test("transient GET failures retry a bounded number of times", async t => {
  let hits = 0;
  const url = await listen(t, http.createServer((_req, res) => json(res, { hits: ++hits }, hits < 3 ? 503 : 200)));
  const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 });
  try { assert.equal((await client.request({ url })).status, 200); }
  finally { client.close(); }
  assert.equal(hits, 3);
});

test("GET retries stop at the configured internal limit", async t => {
  let hits = 0;
  const url = await listen(t, http.createServer((_req, res) => { hits++; json(res, {}, 503); }));
  const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 });
  try { assert.equal((await client.request({ url })).status, 503); }
  finally { client.close(); }
  assert.equal(hits, 3);
});

for (const status of [401, 403, 429]) {
  test(`HTTP ${status} is not retried prematurely`, async t => {
    let hits = 0;
    const url = await listen(t, http.createServer((_req, res) => {
      hits++; res.setHeader("Retry-After", "120"); json(res, {}, status);
    }));
    const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 });
    try { assert.equal((await client.request({ url })).status, status); }
    finally { client.close(); }
    assert.equal(hits, 1);
  });
}

test("paid POST requests are not retried by the transport", async t => {
  let hits = 0;
  const url = await listen(t, http.createServer((_req, res) => { hits++; json(res, {}, 500); }));
  const client = createNetworkClient({ proxyResolver: () => "" });
  try { assert.equal((await client.request({ url, method: "POST", data: { test: true } })).status, 500); }
  finally { client.close(); }
  assert.equal(hits, 1);
});

test("a single POST may use the full deadline rather than the shorter GET attempt timeout", async t => {
  let hits = 0;
  const url = await listen(t, http.createServer((_req, res) => {
    hits++;
    setTimeout(() => json(res, { ok: true }), 50);
  }));
  const client = createNetworkClient({ proxyResolver: () => "", attemptTimeoutMs: 10, totalTimeoutMs: 1000 });
  try { assert.equal((await client.request({ url, method: "POST" })).status, 200); }
  finally { client.close(); }
  assert.equal(hits, 1);
});

test("redirects are returned without sending credentials to their destination", async t => {
  let destinationHits = 0;
  const destination = await listen(t, http.createServer((_req, res) => { destinationHits++; json(res, {}); }));
  const origin = await listen(t, http.createServer((_req, res) => { res.writeHead(302, { Location: destination }); res.end(); }));
  const client = createNetworkClient({ proxyResolver: () => "" });
  try { assert.equal((await client.request({ url: origin, headers: { "X-API-KEY": "fake-key" } })).status, 302); }
  finally { client.close(); }
  assert.equal(destinationHits, 0);
});

test("a slow connection is bounded by the total deadline", async t => {
  const url = await listen(t, http.createServer(() => {}));
  const client = createNetworkClient({ proxyResolver: () => "", attemptTimeoutMs: 50, totalTimeoutMs: 100, backoffMs: 1 });
  const started = Date.now();
  try { await assert.rejects(client.request({ url }), (error: NetworkFailure) => error.code === "TIMEOUT"); }
  finally { client.close(); }
  assert.ok(Date.now() - started < 2000);
});

test("external cancellation stops an in-flight request without retry", async t => {
  let started!: () => void, hits = 0;
  const received = new Promise<void>(resolve => { started = resolve; });
  const url = await listen(t, http.createServer(() => { hits++; started(); }));
  const controller = new AbortController();
  const client = createNetworkClient({ proxyResolver: () => "", backoffMs: 1 });
  const result = client.request({ url, signal: controller.signal });
  await received;
  controller.abort();
  try { await assert.rejects(result, (error: NetworkFailure) => error.code === "CANCELLED"); }
  finally { client.close(); }
  assert.equal(hits, 1);
});

test("buffered SDK fetch preserves JSON Request/Response and decoded gzip", async t => {
  let seenBody = "";
  const url = await listen(t, http.createServer((req, res) => {
    req.on("data", chunk => { seenBody += chunk; });
    req.on("end", () => {
      const body = gzipSync(JSON.stringify({ ok: true }));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": body.length, "x-request-id": "test-request" });
      res.end(body);
    });
  }));
  const client = createNetworkClient({ proxyResolver: () => "" });
  try {
    const response = await client.fetch(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"test":true}' }));
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("x-request-id"), "test-request");
    assert.equal(seenBody, '{"test":true}');
  } finally { client.close(); }
});

test("failure classification never copies credential-bearing raw messages", () => {
  const secret = "fake-key user:password https://private.invalid/?token=secret";
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "CERT_HAS_EXPIRED", "ETIMEDOUT"]) {
    const failure = networkFailure(Object.assign(new Error(secret), { code }), true);
    assert.ok(!failure.message.includes("fake-key"));
    assert.ok(!failure.message.includes("password"));
    assert.ok(!failure.message.includes("private.invalid"));
  }
  assert.equal(networkFailure({ code: "CERT_HAS_EXPIRED" }).code, "TLS_ERROR");
  assert.equal(networkFailure({ code: "ENOTFOUND" }).code, "DNS_ERROR");
  assert.equal(networkFailure({ code: "ECONNREFUSED" }, true).code, "PROXY_ERROR");
  assert.equal(httpFailure(403).code, "ACCESS_DENIED");
  assert.ok(!httpFailure(403).message.includes("Authentication failed"));
});
