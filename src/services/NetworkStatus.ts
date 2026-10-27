export const networkMessages = {
  MISSING_API_KEY: ["未配置材料数据库密钥。", "Materials API key is not configured."],
  AUTHENTICATION_FAILED: ["密钥认证未通过，请检查材料数据库密钥。", "Authentication failed. Check the materials API key."],
  ACCESS_DENIED: ["材料服务拒绝访问，请检查账号权限或网络访问限制。", "Access was denied. Check account permissions or network restrictions."],
  RATE_LIMITED: ["材料服务请求过于频繁，请稍后再同步。", "The materials service is rate limited. Try syncing later."],
  TIMEOUT: ["材料请求超时，请检查网络后重试。", "The materials request timed out. Check the network and retry."],
  PROXY_ERROR: ["无法通过当前代理连接材料服务，请检查已有代理是否可用。", "Cannot connect through the current proxy. Check that your proxy is available."],
  DNS_ERROR: ["无法解析服务或代理地址，请检查网络或 DNS。", "Cannot resolve the service or proxy hostname. Check the network or DNS."],
  TLS_ERROR: ["材料服务的证书验证失败，请检查系统证书或联系网络管理员。", "Certificate verification failed. Check system trust or contact your network administrator."],
  REDIRECT_ERROR: ["材料请求遇到异常重定向，请检查网络转发。", "The materials request encountered an unexpected redirect."],
  UPSTREAM_ERROR: ["材料服务暂时不可用，请稍后重试。", "The materials service is temporarily unavailable. Retry later."],
  BAD_RESPONSE: ["材料服务返回的数据格式不符合要求。", "The materials service returned an unexpected data format."],
  NETWORK_ERROR: ["无法连接材料服务，请检查网络后重试。", "Cannot connect to the materials service. Check the network and retry."],
} as const;

export type NetworkIssueCode = keyof typeof networkMessages;

export function networkIssueCode(value: unknown): NetworkIssueCode {
  return typeof value === "string" && Object.hasOwn(networkMessages, value)
    ? value as NetworkIssueCode : "NETWORK_ERROR";
}

export function networkMessage(code: NetworkIssueCode, language: "zh" | "en") {
  return networkMessages[code][language === "zh" ? 0 : 1];
}
