/**
 * 日志与导出脱敏（PRD §9：密钥、授权头及敏感配置不得进入日志/结果）。
 */
const SENSITIVE_KEYS = /^(token|access_?token|refresh_?token|authorization|api_?key|apikey|secret|password|pairing|code|credential)/i;

/** 递归脱敏对象中的敏感字段（键名命中或值形如密钥） */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 字符串级脱敏：Bearer 头、常见密钥前缀 */
export function redactString(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|zpk|zp)-[A-Za-z0-9._-]{8,}\b/g, '$1-[redacted]')
    .replace(/\b[0-9a-f]{64}\b/gi, (m) => (looksLikeToken(m) ? '[redacted]' : m));
}

function looksLikeToken(_s: string): boolean {
  return true; // 64 位十六进制串一律视为潜在凭据
}

export function redactJson(value: unknown): string {
  return JSON.stringify(redactValue(value));
}

/** 审计日志 detail 字段：只保留结构化摘要并脱敏 */
export function auditDetail(detail: Record<string, unknown>): string {
  return redactJson(detail);
}
