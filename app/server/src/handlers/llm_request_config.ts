/**
 * llm_request config handler — GET/PUT /config/app/llm_request
 * 参考: specs/api/version_logs/v0.0.25/change_log.md §1.3
 *       specs/tech/agent/llm_caller/[P0]llm_request_config.md §1
 *
 * 设计：
 *   - 不同于通用 /config/app（KV shape），llm_request 是单实例 group（key="default"），
 *     有固定 schema（timeout/retry/degradation/length/fallback_chain）+ 缺省回退默认。
 *   - GET 返回完整 LlmRequestConfig（record 不存在返回 DEFAULT_LLM_REQUEST_CONFIG）。
 *   - PUT 整体替换（body 即新 LlmRequestConfig 的 raw 形态，snake_case fallback_chain）。
 *
 * 响应形态（GET 响应 JSON，对齐 api spec §1.3）：
 * ```json
 * {
 *   "timeout": {...}, "retry": {...}, "degradation": {...},
 *   "length": {...}, "fallback_chain": []
 * }
 * ```
 */
import type { LlmRequestConfigService } from '../config/llm_request_config';
import type { LlmRequestConfig } from '../config/llm_request_config';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** GET 响应体形态（snake_case fallback_chain，对齐 api spec §1.3 + 持久化形态） */
interface LlmRequestConfigResponse {
  timeout: LlmRequestConfig['timeout'];
  retry: LlmRequestConfig['retry'];
  degradation: LlmRequestConfig['degradation'];
  length: LlmRequestConfig['length'];
  fallback_chain: LlmRequestConfig['fallbackChain'];
}

/** 把 service 返回的 camelCase 转 snake_case 响应形态 */
function toResponse(c: LlmRequestConfig): LlmRequestConfigResponse {
  return {
    timeout: c.timeout,
    retry: c.retry,
    degradation: c.degradation,
    length: c.length,
    fallback_chain: c.fallbackChain,
  };
}

/**
 * GET /config/app/llm_request — 取 llm_request config。
 *
 * record 不存在时返回 DEFAULT_LLM_REQUEST_CONFIG（service.get 缺省回退）。
 */
export function handleLlmRequestConfigGet(
  service: LlmRequestConfigService,
): Response {
  const config = service.get();
  return json(200, toResponse(config));
}

/**
 * PUT /config/app/llm_request — 整体替换 llm_request config。
 *
 * body 即完整 LlmRequestConfig raw 形态（timeout/retry/degradation/length/fallback_chain）。
 * 缺字段 → service.set 时 normalizeRawConfig 会用 DEFAULT 兜底（向后兼容旧形态）。
 *
 * 校验：body 必须是对象；timeout/retry/degradation/length 若提供必须是对象。
 */
export async function handleLlmRequestConfigPut(
  req: Request,
  service: LlmRequestConfigService,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (typeof body !== 'object' || body === null) {
    return json(400, { error: 'body must be object' });
  }
  // 基本字段校验（任一存在则必须是对象；fallback_chain 存在则必须是数组）
  const sections = ['timeout', 'retry', 'degradation', 'length'];
  for (const sec of sections) {
    const v = body[sec];
    if (v !== undefined && (typeof v !== 'object' || v === null)) {
      return json(400, { error: `${sec} must be object` });
    }
  }
  const chain = body['fallback_chain'];
  if (chain !== undefined && !Array.isArray(chain)) {
    return json(400, { error: 'fallback_chain must be array' });
  }

  // 把 raw body 转回 LlmRequestConfig 形态（camelCase fallbackChain），交 service.set 落盘。
  // service.set 内部会再转 snake_case 持久化；这里先把 body 整体当作 raw 传入。
  // 由于 service.set 接收的是 LlmRequestConfig（camelCase），这里手动转换。
  const config: LlmRequestConfig = {
    timeout: body['timeout'] as LlmRequestConfig['timeout'],
    retry: body['retry'] as LlmRequestConfig['retry'],
    degradation: body['degradation'] as LlmRequestConfig['degradation'],
    length: body['length'] as LlmRequestConfig['length'],
    fallbackChain: (body['fallback_chain'] ??
      []) as LlmRequestConfig['fallbackChain'],
  };
  service.set(config);
  return json(200, { ok: true });
}
