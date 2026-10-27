import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { ProxyAgent } from "proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { setTimeout as delay } from "node:timers/promises";
import type { NetworkIssueCode } from "../src/services/NetworkStatus";

type FailureCode = NetworkIssueCode | "CANCELLED" | "INVALID_REQUEST";

const messages: Record<FailureCode, string> = {
  MISSING_API_KEY: "API key is not configured on the server.",
  AUTHENTICATION_FAILED: "Authentication failed. Check the configured API key.",
  ACCESS_DENIED: "Access denied by the upstream service. Check permissions or network restrictions.",
  RATE_LIMITED: "The upstream service is rate limited. Try again later.",
  TIMEOUT: "The upstream request timed out. Check your connection and retry.",
  PROXY_ERROR: "The configured proxy could not establish the connection.",
  DNS_ERROR: "The upstream hostname could not be resolved.",
  TLS_ERROR: "Certificate verification failed. Check system trust or contact your network administrator.",
  REDIRECT_ERROR: "Unexpected upstream redirect. Check the endpoint and network forwarding.",
  UPSTREAM_ERROR: "The upstream service is temporarily unavailable.",
  BAD_RESPONSE: "The upstream service returned an unexpected response.",
  NETWORK_ERROR: "The upstream connection failed. Check your network and retry.",
  CANCELLED: "The request was cancelled.",
  INVALID_REQUEST: "Invalid request parameters.",
};

export class NetworkFailure extends Error {
  constructor(public code: FailureCode, public httpStatus = 502, public retryable = false, public upstreamStatus?: number) {
    super(messages[code]);
    this.name = "NetworkFailure";
  }
}

export function httpFailure(status: number): NetworkFailure {
  if (status >= 300 && status < 400) return new NetworkFailure("REDIRECT_ERROR", 502, false, status);
  if (status === 401) return new NetworkFailure("AUTHENTICATION_FAILED", 401, false, status);
  if (status === 403) return new NetworkFailure("ACCESS_DENIED", 403, false, status);
  if (status === 407) return new NetworkFailure("PROXY_ERROR", 502, false, status);
  if (status === 408) return new NetworkFailure("TIMEOUT", 504, true, status);
  if (status === 429) return new NetworkFailure("RATE_LIMITED", 429, true, status);
  if (status >= 400 && status < 500) return new NetworkFailure("INVALID_REQUEST", 400, false, status);
  return new NetworkFailure("UPSTREAM_ERROR", 502, true, status);
}

export function networkFailure(error: unknown, usingProxy = false): NetworkFailure {
  if (error instanceof NetworkFailure) return error;
  const candidate = error as { code?: string; status?: number; cause?: unknown; name?: string };
  // The SDK wraps custom-fetch transport errors; retain the safe underlying classification.
  if (candidate?.cause instanceof NetworkFailure) return candidate.cause;
  if (typeof candidate?.status === "number") return httpFailure(candidate.status);
  if (candidate?.code === "ERR_CANCELED" || candidate?.name === "AbortError" || candidate?.name === "APIUserAbortError") {
    return new NetworkFailure("CANCELLED", 499);
  }
  if (["ECONNABORTED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(candidate?.code)) return new NetworkFailure("TIMEOUT", 504, true);
  if (["ENOTFOUND", "EAI_AGAIN"].includes(candidate?.code)) return new NetworkFailure("DNS_ERROR", 502, true);
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(candidate?.code)) {
    return new NetworkFailure("TLS_ERROR");
  }
  return new NetworkFailure(usingProxy ? "PROXY_ERROR" : "NETWORK_ERROR", 502, true);
}

export interface NetworkClient {
  request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  /** Buffered, non-streaming fetch for the chat SDK; not a general SSE/upload transport. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  close(): void;
}

interface ClientOptions {
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
  getRetries?: number;
  backoffMs?: number;
  proxyResolver?: (url: string) => string;
}

const retryStatuses = new Set([408, 429, 500, 502, 503, 504]);

function retryDelay(response: AxiosResponse | undefined, attempt: number, backoff: number): number {
  const value = response?.headers["retry-after"];
  if (value !== undefined) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(value)) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, ms);
  }
  return backoff * 2 ** attempt;
}

export function createNetworkClient(options: ClientOptions = {}): NetworkClient {
  const resolveProxy = options.proxyResolver ?? getProxyForUrl;
  const closed = new AbortController();
  const agents = new Set<ProxyAgent>();
  const attemptTimeout = options.attemptTimeoutMs ?? 15_000;
  const totalTimeout = options.totalTimeoutMs ?? 45_000;
  const retries = options.getRetries ?? 2;
  const backoff = options.backoffMs ?? 250;
  const client = axios.create({
    proxy: false, maxRedirects: 0,
    maxContentLength: 20 * 1024 * 1024, maxBodyLength: 1024 * 1024,
    validateStatus: () => true,
  });

  async function request<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const method = (config.method ?? "GET").toUpperCase();
    // A chat generation may take longer than a single retriable material GET.
    const requestTimeout = method === "GET" ? attemptTimeout : totalTimeout;
    const deadline = Date.now() + totalTimeout;
    const timeoutSignal = AbortSignal.timeout(totalTimeout);
    const external = config.signal as AbortSignal | undefined;
    const signal = AbortSignal.any([...(external ? [external] : []), timeoutSignal, closed.signal]);
    let usingProxy = false;
    try { usingProxy = Boolean(resolveProxy(new URL(config.url!, config.baseURL).href)); }
    catch { throw new NetworkFailure("PROXY_ERROR"); }
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new NetworkFailure(external?.aborted ? "CANCELLED" : "TIMEOUT", external?.aborted ? 499 : 504);
      let response: AxiosResponse<T> | undefined;
      const remaining = Math.min(requestTimeout, Math.max(1, deadline - Date.now()));
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      // A proxy handshake happens before Axios owns the socket. Bind cancellation
      // to HTTP(S) proxy sockets too; SOCKS handshakes have the same bounded timeout.
      const agent = new ProxyAgent({ getProxyForUrl: resolveProxy, signal: attemptSignal, timeout: remaining });
      agents.add(agent);
      try {
        response = await client.request<T>({
          ...config, signal: attemptSignal, timeout: remaining,
          proxy: false, httpAgent: agent, httpsAgent: agent, maxRedirects: 0, validateStatus: () => true,
        });
        if (method !== "GET" || attempt >= retries || !retryStatuses.has(response.status)) return response;
      } catch (error) {
        if (signal.aborted) throw new NetworkFailure(external?.aborted ? "CANCELLED" : "TIMEOUT", external?.aborted ? 499 : 504);
        const failure = attemptSignal.aborted ? new NetworkFailure("TIMEOUT", 504, true) : networkFailure(error, usingProxy);
        if (method !== "GET" || attempt >= retries || !failure.retryable) throw failure;
      } finally {
        agent.destroy();
        agent.httpAgent.destroy();
        agent.httpsAgent.destroy();
        agents.delete(agent);
      }
      const wait = retryDelay(response, attempt, backoff);
      // Respect long Retry-After values by returning the error, not retrying earlier than requested.
      if (wait > 2000 || Date.now() + wait >= deadline) {
        if (response) return response;
        throw new NetworkFailure("TIMEOUT", 504, true);
      }
      try { await delay(wait, undefined, { signal }); }
      catch { throw new NetworkFailure(external?.aborted ? "CANCELLED" : "TIMEOUT", external?.aborted ? 499 : 504); }
    }
  }

  return {
    request,
    async fetch(input, init) {
      const requestObject = new Request(input, init);
      try {
        const response = await request<ArrayBuffer>({
          url: requestObject.url, method: requestObject.method,
          headers: Object.fromEntries(requestObject.headers), signal: requestObject.signal,
          data: ["GET", "HEAD"].includes(requestObject.method) ? undefined : Buffer.from(await requestObject.arrayBuffer()),
          responseType: "arraybuffer",
        });
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && value !== null && !["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name.toLowerCase())) {
            headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
          }
        }
        const body = requestObject.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : new Uint8Array(response.data);
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        if (error instanceof NetworkFailure && error.code === "CANCELLED") throw new DOMException("Request cancelled", "AbortError");
        throw error;
      }
    },
    close() {
      closed.abort();
      for (const agent of agents) {
        agent.destroy();
        agent.httpAgent.destroy();
        agent.httpsAgent.destroy();
      }
    },
  };
}
