import http from "node:http";
import type { TestContext } from "node:test";

export async function listen(t: TestContext, server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}

export async function withProxyEnvironment(values: Record<string, string>, run: () => Promise<void> | void) {
  const names = new Set([...Object.keys(process.env).filter(name => /(^|_)proxy$/i.test(name)), ...Object.keys(values)]);
  const old = new Map([...names].map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  try { await run(); }
  finally {
    for (const name of names) {
      const value = old.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

export function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
