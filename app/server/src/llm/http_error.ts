/**
 * LlmHttpError — 非 2xx HTTP 响应的结构化错误。
 *
 * client.ts 非 2xx 时 throw 本类型（非裸 Error）：携带 numeric status + body + headers，
 * 让下游 classifier 的 asWireResponse 查 `typeof e.status === 'number'` 直接命中 → classifyWire
 * 正确分类（如 401→AUTH_INVALID）；否则裸 Error 无 status → 塌缩 NETWORK 兜底误判。
 * extends Error 保 .message，向后兼容 SSE error event / log / agent-loop catch。
 */
/**
 * LLM provider 非 2xx HTTP 响应错误。
 *
 * 设计要点：
 *   - extends Error：保留 .message 供现有上层 catch（agent loop / SSE / log）向后兼容
 *   - status: number：asWireResponse 形态探测的命中字段（必须是 number，不能 undefined）
 *   - body?: unknown：原始响应体（优先 JSON parse 后对象，parse 失败留 text 字符串），供 adapter 抽 error.type
 *   - headers?: Record<string,string>：lowercase key（Retry-After 等供 parseRetryAfter 用）
 */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    body?: unknown,
    headers?: Record<string, string>,
    message?: string,
  ) {
    // 沿用 extractHttpError 的人类可读格式，便于 log / SSE error event 透出
    super(message ?? `LLM provider returned ${status}`);
    this.name = 'LlmHttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/**
 * 把 Response.headers 转 lowercase Record。
 * 用途：LlmHttpError.headers（adapter 的 parseRetryAfter 查 'retry-after'）。
 * lowercase 化便于跨网关兼容（HTTP header 大小写不敏感）。
 */
function responseHeadersToRecord(h: Headers): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从非 2xx Response 构建 LlmHttpError（携 status + body + headers + 可读 message）。
 *
 * body 策略：优先 JSON.parse 成对象（adapter 的 extractAnthropicErrorBody 走 {error:{type,message}} 形态），
 *   parse 失败留 text 字符串（仍优于 undefined，至少 status 可用）。
 * headers 策略：转 lowercase Record（parseRetryAfter 查 'retry-after'）。
 * message 策略：沿用旧 extractHttpError 的人类可读格式 `LLM provider returned ${status}: ${detail}`，
 *   供 SSE error event / log / agent-loop 顶层 catch 向后兼容。
 *
 * @param resp 非 2xx 的 fetch Response（body 未被消费）
 */
export async function buildHttpErrorFromResponse(resp: Response): Promise<LlmHttpError> {
  const status = resp.status;
  let body: unknown = undefined;
  let detail = '';
  try {
    const text = await resp.text();
    if (text) {
      // 优先 JSON parse 成对象（adapter 走 error.type 形态判定，对象形态必要）
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text);
        body = parsed;
      } catch {
        // 非 JSON：留 text 字符串（仍优于 undefined，status-based 分类可用）
        body = text;
      }
      // detail：优先 JSON 的 error.message；否则截 text（detail 只为人类可读 message，不影响分类）
      detail = extractDetail(parsed, text);
    }
  } catch {
    // body 已被消费或不可读：忽略，body 留 undefined
  }
  const headers = responseHeadersToRecord(resp.headers);
  const message = detail
    ? `LLM provider returned ${status}: ${detail}`
    : `LLM provider returned ${status}`;
  return new LlmHttpError(status, body, headers, message);
}

/** 从已 parse 的 JSON 抽 error.message；parse 失败或无 message 则截 text 头（detail 仅人类可读，不参与分类） */
function extractDetail(parsed: unknown, text: string): string {
  if (parsed && typeof parsed === 'object') {
    const err = (parsed as Record<string, unknown>)['error'];
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>)['message'];
      if (typeof m === 'string') return m;
    }
  }
  return text.slice(0, 200);
}
