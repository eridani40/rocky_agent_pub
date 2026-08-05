/**
 * display_reason + RunErrorInfo 构造 单测（v0.0.25 rev2 T15）
 * 参考: specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1 §3（权威 17 行映射表 + 收尾机制）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1（RunErrorInfo）
 *
 * 覆盖：
 *   1. deriveDisplayReason：17 行 category→displayReason 全覆盖（按 spec §1 映射表逐条对齐）
 *   2. deriveDisplayReason：兜底文案（未知 category，防御性）
 *   3. deriveDisplayReason：支持 ClassifiedLlmError 实例 + category 枚举两种入参形态
 *   4. deriveErrorDetail：rawError.message 优先；无 rawError 用 err.message
 *   5. buildRunErrorFromThrowable：ClassifiedLlmError → 用 err.category；非 Classified 兜底 SERVER_ERROR
 *   6. RunErrorInfo 三件套（errorCategory/displayReason/errorDetail）形态正确
 *
 * 测试方式：纯函数单测（不依赖 LlmClient / store）。
 */
import { describe, it, expect } from 'vitest';
import { LlmErrorCategory, type ClassifiedLlmError } from '../error_types';
import {
  deriveDisplayReason,
  deriveErrorDetail,
  buildRunErrorFromThrowable,
} from '../display_reason';

/** 构造一个 ClassifiedLlmError stub（带 category + rawError）。 */
function mkClassified(
  category: LlmErrorCategory,
  opts: { rawMessage?: string; message?: string } = {},
): ClassifiedLlmError {
  const err = new Error(opts.message ?? `${category} occurred`) as ClassifiedLlmError;
  err.category = category;
  err.hints = {
    retryable: false, shouldRotateKey: false, shouldFallbackProvider: false,
    shouldCompressContext: false, shouldBumpMaxTokens: false,
  };
  if (opts.rawMessage !== undefined) {
    err.rawError = { message: opts.rawMessage };
  }
  return err;
}

// ============================================================
// 1. deriveDisplayReason：17 行映射表全覆盖（spec rev2_changes §1 权威表）
// ============================================================
describe('deriveDisplayReason — 17 行映射表（spec rev2_changes §1）', () => {
  // 逐条对齐权威表（注：TIMEOUT_FIRST_CHUNK 与 TIMEOUT_INTER_CHUNK 共享「响应超时」文案）
  const cases: Array<[LlmErrorCategory, string]> = [
    [LlmErrorCategory.AUTH_INVALID, '认证失败，请检查 API Key'],
    [LlmErrorCategory.AUTH_FORBIDDEN, 'API Key 无权限或地域受限'],
    [LlmErrorCategory.RATE_LIMITED, '模型限流，请稍后重试'],
    [LlmErrorCategory.PROVIDER_OVERLOADED, '服务商过载，请稍后重试'],
    [LlmErrorCategory.SERVER_ERROR, '服务商内部错误'],
    [LlmErrorCategory.NETWORK, '网络错误，请检查网络连接'],
    [LlmErrorCategory.STREAM_INCOMPLETE, '响应流中断'],
    [LlmErrorCategory.EMPTY_RESPONSE, '模型返回空响应'],
    [LlmErrorCategory.MAX_TOKENS_TOO_HIGH, '输出长度超限（请求参数越界）'],
    [LlmErrorCategory.TIMEOUT_FIRST_CHUNK, '响应超时'],
    [LlmErrorCategory.TIMEOUT_INTER_CHUNK, '响应超时'],
    [LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED, '上下文过长且压缩失败'],
    [LlmErrorCategory.MAX_TOKENS_EXCEEDED, '输出达到模型上限'],
    [LlmErrorCategory.CONTENT_FILTERED, '内容被审核拒绝'],
    [LlmErrorCategory.MODEL_NOT_FOUND, '模型不存在或未配置'],
    [LlmErrorCategory.MALFORMED_TOOL_CALL, '模型工具调用格式错误'],
    [LlmErrorCategory.BAD_REQUEST_OTHER, '请求参数错误'],
  ];

  for (const [category, expected] of cases) {
    it(`${category} → 「${expected}」`, () => {
      expect(deriveDisplayReason(category)).toBe(expected);
    });
  }

  // 共 17 个枚举值（不含 ABORTED_BY_USER 走 interrupted 不填 RunErrorInfo，但本函数仍兜底返文案）
  it('覆盖全部 17 个 error category（不含 ABORTED_BY_USER）', () => {
    expect(cases).toHaveLength(17);
  });

  it('ABORTED_BY_USER 兜底返文案（spec：不走 error 路径；防御性返回，不 undefined）', () => {
    const reason = deriveDisplayReason(LlmErrorCategory.ABORTED_BY_USER);
    expect(reason).toBeTruthy();
    expect(typeof reason).toBe('string');
  });
});

// ============================================================
// 2. deriveDisplayReason 兜底（未知 category）
// ============================================================
describe('deriveDisplayReason — 未知 category 兜底', () => {
  it('未知 category 字符串返兜底「未知错误」（防御性，不 undefined）', () => {
    // enum 闭合，正常不会出现；模拟 i18n 误删表项的兜底
    const reason = deriveDisplayReason('UNKNOWN_CATEGORY' as LlmErrorCategory);
    expect(reason).toBe('未知错误');
  });
});

// ============================================================
// 3. deriveDisplayReason 双入参形态（ClassifiedLlmError 实例 + 枚举）
// ============================================================
describe('deriveDisplayReason — 入参形态', () => {
  it('接受 ClassifiedLlmError 实例（按 err.category 派生）', () => {
    const err = mkClassified(LlmErrorCategory.AUTH_INVALID);
    expect(deriveDisplayReason(err)).toBe('认证失败，请检查 API Key');
  });

  it('接受 LlmErrorCategory 枚举值（直接查表）', () => {
    expect(deriveDisplayReason(LlmErrorCategory.RATE_LIMITED))
      .toBe('模型限流，请稍后重试');
  });
});

// ============================================================
// 4. deriveErrorDetail
// ============================================================
describe('deriveErrorDetail', () => {
  it('rawError.message 优先（rev2_changes §3：errorDetail = err.rawError?.message ?? err.message）', () => {
    const err = mkClassified(LlmErrorCategory.PROVIDER_OVERLOADED, {
      rawMessage: 'anthropic overloaded_error: 529',
      message: 'outer message',
    });
    expect(deriveErrorDetail(err)).toBe('anthropic overloaded_error: 529');
  });

  it('无 rawError 时 fallback 到 err.message', () => {
    const err = mkClassified(LlmErrorCategory.NETWORK, { message: 'fetch failed: ECONNREFUSED' });
    expect(deriveErrorDetail(err)).toBe('fetch failed: ECONNREFUSED');
  });
});

// ============================================================
// 5. buildRunErrorFromThrowable（agent loop catch 块用）
// ============================================================
describe('buildRunErrorFromThrowable', () => {
  it('ClassifiedLlmError → 用 err.category 派生 RunErrorInfo', () => {
    const err = mkClassified(LlmErrorCategory.AUTH_INVALID, { rawMessage: 'invalid api key' });
    const { category, runError } = buildRunErrorFromThrowable(err);
    expect(category).toBe(LlmErrorCategory.AUTH_INVALID);
    expect(runError.errorCategory).toBe(LlmErrorCategory.AUTH_INVALID);
    expect(runError.displayReason).toBe('认证失败，请检查 API Key');
    expect(runError.errorDetail).toBe('invalid api key');
  });

  it('非 ClassifiedLlmError（普通 Error）→ 兜底 SERVER_ERROR，errorDetail 用 err.message', () => {
    const err = new Error('something broke');
    const { category, runError } = buildRunErrorFromThrowable(err);
    expect(category).toBe(LlmErrorCategory.SERVER_ERROR);
    expect(runError.errorCategory).toBe(LlmErrorCategory.SERVER_ERROR);
    expect(runError.displayReason).toBe('服务商内部错误');
    expect(runError.errorDetail).toBe('something broke');
  });

  it('非 Error 的 throwable（字符串）→ 兜底 SERVER_ERROR，errorDetail 用 String(e)', () => {
    const { category, runError } = buildRunErrorFromThrowable('string error');
    expect(category).toBe(LlmErrorCategory.SERVER_ERROR);
    expect(runError.errorDetail).toBe('string error');
  });

  it('RunErrorInfo 形态：三件套（errorCategory/displayReason/errorDetail）齐全', () => {
    const err = mkClassified(LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED, { rawMessage: 'context too long' });
    const { runError } = buildRunErrorFromThrowable(err);
    expect(runError).toEqual({
      errorCategory: LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED,
      displayReason: '上下文过长且压缩失败',
      errorDetail: 'context too long',
    });
  });

  it('capability 容量错误（PROVIDER_OVERLOADED）→ displayReason 对齐 spec', () => {
    const err = mkClassified(LlmErrorCategory.PROVIDER_OVERLOADED);
    const { runError } = buildRunErrorFromThrowable(err);
    expect(runError.displayReason).toBe('服务商过载，请稍后重试');
  });
});
