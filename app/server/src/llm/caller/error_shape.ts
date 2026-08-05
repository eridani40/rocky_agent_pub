/**
 * 错误归一化 — rawError 形态探测（鸭子类型，从 unknown 抽取结构化字段）
 * 参考: specs/tech/agent/llm_caller/[P0]error_normalization.md §4（adapter 用）
 *
 * rawError 是 unknown（LlmClient 抛的 Error / WireResponse / 流内事件 / fetch throw 都可能）。
 * adapter 不依赖具体 class，用形态探测把 unknown 转为可判定的 union。
 *
 * 探测的 3 种形态（覆盖 §4.1/§4.2/§4.3）：
 *   - WireResponse: HTTP 非 2xx 响应（{ status, body, headers? }）
 *   - StreamErrorShape: 流内 error 事件（{ type:'error', error:{type,message} } 或 {kind:'stream_error',...}）
 *   - StopReasonInfo: 流正常结束但需 length 处理（{ stopReason:'max_tokens', partial? }）
 */
export interface WireResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface StreamErrorShape {
  type: string;
  message: string;
}

export interface StopReasonInfo {
  stopReason: string;
  partial?: { message?: unknown };
}

/** 探测 rawError 是否 WireResponse 形态（HTTP 非 2xx 响应） */
export function asWireResponse(e: unknown): WireResponse | null {
  if (typeof e !== 'object' || e === null) return null;
  const obj = e as Record<string, unknown>;
  const status = obj['status'];
  if (typeof status === 'number' && status > 0) {
    return {
      status,
      body: obj['body'],
      headers: typeof obj['headers'] === 'object' && obj['headers'] !== null
        ? (obj['headers'] as Record<string, string>)
        : undefined,
    };
  }
  return null;
}

/** 探测 rawError 是否流内 error 事件形态 */
export function asStreamError(e: unknown): StreamErrorShape | null {
  if (typeof e !== 'object' || e === null) return null;
  const obj = e as Record<string, unknown>;
  // 形态1: { type:'error', error:{ type, message } }（anthropic SSE event:error data）
  if (obj['type'] === 'error') {
    const inner = obj['error'];
    if (typeof inner === 'object' && inner !== null) {
      const ie = inner as Record<string, unknown>;
      if (typeof ie['type'] === 'string' && typeof ie['message'] === 'string') {
        return { type: ie['type'], message: ie['message'] };
      }
    }
  }
  // 形态2: { kind:'stream_error', errorType, message }（LlmCaller 流处理产出的中间态）
  if (obj['kind'] === 'stream_error') {
    const t = obj['errorType'];
    const m = obj['message'];
    if (typeof t === 'string' && typeof m === 'string') {
      return { type: t, message: m };
    }
  }
  return null;
}

/** 探测 rawError 是否 stop_reason 形态 */
export function asStopReasonInfo(e: unknown): StopReasonInfo | null {
  if (typeof e !== 'object' || e === null) return null;
  const obj = e as Record<string, unknown>;
  const sr = obj['stopReason'] ?? obj['stop_reason'];
  if (typeof sr === 'string') {
    return {
      stopReason: sr,
      partial:
        typeof obj['partial'] === 'object'
          ? (obj['partial'] as { message?: unknown })
          : undefined,
    };
  }
  return null;
}

/** 从 unknown error 抽取 message 字符串 */
export function errMsg(e: unknown): string | undefined {
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj['message'] === 'string') return obj['message'];
  }
  return undefined;
}

/** 任一 pattern 匹配即 true（大小写不敏感） */
export function matchAny(text: string, patterns: RegExp[]): boolean {
  if (!text) return false;
  return patterns.some((p) => p.test(text));
}

/**
 * 从 anthropic 响应 body 抽取 { type, message }。
 * 兼容两种形态：{error:{type,message}}（标准）和裸 {type,message}（部分网关）。
 */
export function extractAnthropicErrorBody(body: unknown): { type?: string; message: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const err = obj['error'];
  if (typeof err === 'object' && err !== null) {
    const ie = err as Record<string, unknown>;
    return {
      type: typeof ie['type'] === 'string' ? ie['type'] : undefined,
      message: typeof ie['message'] === 'string' ? ie['message'] : '',
    };
  }
  // 裸形态
  return {
    type: typeof obj['type'] === 'string' ? obj['type'] : undefined,
    message: typeof obj['message'] === 'string' ? obj['message'] : '',
  };
}
