import type { AdvisorWireMessage, AdvisorLanguage } from "./AdvisorContext";

const errors = {
  MISSING_API_KEY: ["请先在本机 .env 中配置 DEEPSEEK_API_KEY，并重启服务。", "Configure DEEPSEEK_API_KEY in the local .env and restart the server."],
  AUTHENTICATION_FAILED: ["模型服务认证失败，请检查 API 密钥。", "Model authentication failed. Check the API key."],
  ACCESS_DENIED: ["模型服务拒绝访问，请检查账号权限或网络限制。", "Access denied. Check account permissions or network restrictions."],
  RATE_LIMITED: ["模型服务限流，请稍后再发送。", "Rate limited. Send again later."],
  TIMEOUT: ["分析超时，未自动重复请求。可以缩短问题后手动重试。", "Analysis timed out without an automatic retry. Try a shorter question."],
  PROXY_ERROR: ["当前代理无法连接模型服务。", "The current proxy cannot reach the model service."],
  DNS_ERROR: ["无法解析模型服务或代理地址。", "Cannot resolve the model or proxy hostname."],
  TLS_ERROR: ["模型服务证书验证失败，请检查网络信任配置。", "Model TLS certificate validation failed."],
  BAD_RESPONSE: ["模型没有返回有效文字，请稍后手动重试。", "The model did not return usable text. Retry manually."],
  NETWORK_ERROR: ["连接模型服务失败，请检查网络后手动重试。", "Cannot reach the model service. Check the network and retry manually."],
  UPSTREAM_ERROR: ["模型服务暂时不可用，请稍后再试。", "The model service is temporarily unavailable."],
  REDIRECT_ERROR: ["模型请求遇到异常重定向，请检查服务地址和网络。", "Unexpected model redirect. Check the endpoint and network."],
  INVALID_REQUEST: ["对话请求无效或过长，请清空会话后重试。", "Invalid or oversized request. Clear the conversation and retry."],
} as const;

export class AdvisorError extends Error {
  constructor(public code: keyof typeof errors) { super(code); this.name = "AdvisorError"; }
}

export function advisorErrorMessage(error: unknown, lang: AdvisorLanguage) {
  const code = error instanceof AdvisorError ? error.code : "NETWORK_ERROR";
  return errors[code][lang === "zh" ? 0 : 1];
}

export async function requestAdvisor(messages: AdvisorWireMessage[], signal: AbortSignal) {
  const deadline = AbortSignal.timeout(50_000);
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, deadline]),
      body: JSON.stringify({ messages, temperature: 0.3, max_tokens: 2048 }),
    });
    let data: any;
    try { data = await response.json(); } catch { throw new AdvisorError("BAD_RESPONSE"); }
    if (!response.ok) throw new AdvisorError(typeof data?.code === "string" && Object.hasOwn(errors, data.code) ? data.code : response.status === 413 ? "INVALID_REQUEST" : "UPSTREAM_ERROR");
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) throw new AdvisorError("BAD_RESPONSE");
    return {
      answer: answer.trim(), model: typeof data.model === "string" ? data.model.slice(0, 100) : "deepseek-flash",
      truncated: data.choices[0].finish_reason === "length",
      tokens: Number.isFinite(data.usage?.total_tokens) ? data.usage.total_tokens as number : undefined,
    };
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (deadline.aborted) throw new AdvisorError("TIMEOUT");
    if (error instanceof AdvisorError) throw error;
    throw new AdvisorError("NETWORK_ERROR");
  }
}
