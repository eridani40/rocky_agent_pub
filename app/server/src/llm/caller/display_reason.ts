/**
 * display_reason —— errorCategory → 用户可读理由 派生（纯函数）
 * 参考: specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1（权威 17 行映射表）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1（RunErrorInfo.displayReason）
 *       specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.2（displayReason 派生）
 *
 * 设计要点（rev2_changes §1 实现要点）：
 *   - deriveDisplayReason 是纯函数（category + 可选 context → string），易单测。
 *   - displayReason 是 i18n 候选（默认中文，后续 locale 切换时按 category 查表）。
 *   - errorDetail 是 raw provider message（给 debug tooltip / log），不直接给终端用户。
 *
 * 边界：ABORTED_BY_USER 不走 error 路径（走 interrupted），但本函数仍兜底返兜底文案
 *       （调用方按 spec 不应传入；防御性返回避免 undefined）。
 *
 * 纯函数无副作用。
 */
import { LlmErrorCategory, type ClassifiedLlmError } from './error_types';

/**
 * category → 用户可读 displayReason 完整映射表（权威：rev2_changes §1）。
 *
 * key 是 LlmErrorCategory 枚举值，value 是用户可读中文文案。
 * 前端可直接显示；errorDetail（raw provider message）才给 debug tooltip。
 */
const DISPLAY_REASON_TABLE: Record<LlmErrorCategory, string> = {
  // ── 凭证（不重试同 key） ──
  [LlmErrorCategory.AUTH_INVALID]: '认证失败，请检查 API Key',
  [LlmErrorCategory.AUTH_FORBIDDEN]: 'API Key 无权限或地域受限',
  // ── 可重试-瞬时（同 provider 内退避重试） ──
  [LlmErrorCategory.RATE_LIMITED]: '模型限流，请稍后重试',
  [LlmErrorCategory.PROVIDER_OVERLOADED]: '服务商过载，请稍后重试',
  [LlmErrorCategory.SERVER_ERROR]: '服务商内部错误',
  [LlmErrorCategory.NETWORK]: '网络错误，请检查网络连接',
  [LlmErrorCategory.STREAM_INCOMPLETE]: '响应流中断',
  [LlmErrorCategory.EMPTY_RESPONSE]: '模型返回空响应',
  [LlmErrorCategory.MAX_TOKENS_TOO_HIGH]: '输出长度超限（请求参数越界）',
  // ── 超时（看门狗触发） ──
  [LlmErrorCategory.TIMEOUT_FIRST_CHUNK]: '响应超时',
  [LlmErrorCategory.TIMEOUT_INTER_CHUNK]: '响应超时',
  // ── 请求（参数 / 内容问题） ──
  [LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED]: '上下文过长且压缩失败',
  [LlmErrorCategory.MAX_TOKENS_EXCEEDED]: '输出达到模型上限',
  [LlmErrorCategory.CONTENT_FILTERED]: '内容被审核拒绝',
  [LlmErrorCategory.MODEL_NOT_FOUND]: '模型不存在或未配置',
  [LlmErrorCategory.MALFORMED_TOOL_CALL]: '模型工具调用格式错误',
  [LlmErrorCategory.BAD_REQUEST_OTHER]: '请求参数错误',
  // ── 用户中断（spec：不走 error 路径；兜底文案，调用方不应传此 category） ──
  [LlmErrorCategory.ABORTED_BY_USER]: '用户已中断',
  // ── 客户端内部错误（编程错误 / 不变量违反） ──
  [LlmErrorCategory.INTERNAL]: '内部错误，请重试或联系支持',
};

/** 兜底文案（未识别 category 的防御性返回；理论上不会命中，因 enum 闭合）。 */
const FALLBACK_REASON = '未知错误';

/**
 * 派生用户可读 displayReason（从 ClassifiedLlmError 或 category）。
 *
 * @param errOrCategory ClassifiedLlmError 实例 或 LlmErrorCategory 枚举值
 * @returns 用户可读中文文案（前端可直接显示；i18n 候选，后续按 category 查表）
 *
 * @example
 *   deriveDisplayReason(LlmErrorCategory.AUTH_INVALID)  // → 「认证失败，请检查 API Key」
 *   deriveDisplayReason(classifiedErr)                   // → 据 err.category 派生
 */
export function deriveDisplayReason(
  errOrCategory: ClassifiedLlmError | LlmErrorCategory,
): string {
  const category =
    typeof errOrCategory === 'string'
      ? (errOrCategory as LlmErrorCategory)
      : errOrCategory.category;
  return DISPLAY_REASON_TABLE[category] ?? FALLBACK_REASON;
}

/**
 * 从 ClassifiedLlmError 派生 errorDetail（raw provider message，给 debug tooltip / log）。
 *
 * spec（rev2_changes §3）：errorDetail = err.rawError?.message ?? err.message。
 * 不直接给终端用户（displayReason 才给用户看）。
 *
 * @param err ClassifiedLlmError 实例
 * @returns raw provider message 字符串；无 rawError/message 时返 undefined
 */
export function deriveErrorDetail(err: ClassifiedLlmError): string | undefined {
  return err.rawError?.message ?? err.message;
}

/**
 * 兜底 category（throwable 不是 ClassifiedLlmError 时用）。
 * LLM 路径的 throw 基本都是 ClassifiedLlmError（llm_caller 不塌缩 LOOP_ERROR），
 * 但 agent loop 还有 tool 执行等可能 throw 非 LLM 错；用 SERVER_ERROR 兜底（语义最接近「运行时错误」）。
 */
const FALLBACK_CATEGORY = LlmErrorCategory.SERVER_ERROR;

/**
 * 从任意 throwable 派生 { category, runError }（agent loop catch 块用）。
 *
 * spec（rev2_changes §3 / agent_loop_base §9.1）：
 *   - err 是 ClassifiedLlmError → 用 err.category（权威分类）
 *   - err 非 ClassifiedLlmError → 兜底 SERVER_ERROR（保留 message 作 errorDetail）
 *   - 派生 RunErrorInfo { errorCategory, displayReason: deriveDisplayReason(category), errorDetail }
 *
 * ABORTED_BY_USER 由 caller（agent-loop catch 块）在调本函数前判断 isInterrupted() 短路，
 * 故本函数不需要单独处理 ABORTED（理论上不会传到这里）。
 *
 * @param e agent loop catch 到的 throwable
 * @returns { category: LlmErrorCategory; runError: RunErrorInfo }
 */
export function buildRunErrorFromThrowable(e: unknown): {
  category: LlmErrorCategory;
  runError: import('../../agent/session-store-types').RunErrorInfo;
} {
  const classified = e as Partial<ClassifiedLlmError> & Error;
  const category: LlmErrorCategory =
    classified?.category && typeof classified.category === 'string'
      ? classified.category
      : FALLBACK_CATEGORY;
  const message = e instanceof Error ? e.message : String(e);
  const displayReason = deriveDisplayReason(category);
  // 若是 ClassifiedLlmError，用 rawError.message 优先（rev2_changes §3）；否则用 e.message
  const errorDetail: string | undefined =
    classified?.rawError?.message ?? (e instanceof Error ? e.message : String(e));
  void message; // message 仅作 debug；errorDetail 已含等价信息
  return {
    category,
    runError: {
      errorCategory: category,
      displayReason,
      errorDetail,
    },
  };
}
