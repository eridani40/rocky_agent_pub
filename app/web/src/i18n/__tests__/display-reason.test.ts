/**
 * @vitest-environment jsdom
 * displayReason 前端查表全量覆盖单测（spec §8 displayReason 后端范式样板契约）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §8（displayReason 18 LlmErrorCategory 查表）+ §7（type 字段判定）
 *
 * 覆盖：
 *   - camelCaseCategory：SCREAMING_SNAKE_CASE → camelCase（含/不含下划线，含多段）
 *   - 18 LlmErrorCategory × 2 lng 全覆盖（zh-CN + en 无 missing key）
 *   - localizedDisplayReason：查表命中 + 未知 category 回退字段
 *   - camelCase 转换结果与 error.json keys 一一对应
 *
 * 注意：LlmErrorCategory 用前端字面量列表（不 import 后端代码），
 *   与 i18n/locales/{zh-CN,en}/error.json keys 对齐。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { TFunction } from 'i18next';
import { initI18n, i18n } from '../index';
import { camelCaseCategory, localizedDisplayReason } from '../llm-error-category';

/** 18 个 LlmErrorCategory 字面量列表（与 error.json.llm keys 对齐，spec §8） */
const ERROR_CATEGORIES = [
  'AUTH_INVALID',
  'AUTH_FORBIDDEN',
  'RATE_LIMITED',
  'PROVIDER_OVERLOADED',
  'SERVER_ERROR',
  'NETWORK',
  'STREAM_INCOMPLETE',
  'EMPTY_RESPONSE',
  'MAX_TOKENS_TOO_HIGH',
  'TIMEOUT_FIRST_CHUNK',
  'TIMEOUT_INTER_CHUNK',
  'CONTEXT_LENGTH_EXCEEDED',
  'MAX_TOKENS_EXCEEDED',
  'CONTENT_FILTERED',
  'MODEL_NOT_FOUND',
  'MALFORMED_TOOL_CALL',
  'BAD_REQUEST_OTHER',
  'ABORTED_BY_USER',
] as const;

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 制造绑 ns=error 的 t 函数（每次取最新 lng 的翻译） */
function getTError(): TFunction {
  return ((key: string, opts?: Record<string, unknown>) =>
    i18n.t(key, { ns: 'error', ...opts })) as unknown as TFunction;
}

describe('camelCaseCategory（SCREAMING_SNAKE_CASE → camelCase）', () => {
  it('AUTH_INVALID → authInvalid（含下划线，2 段）', () => {
    expect(camelCaseCategory('AUTH_INVALID')).toBe('authInvalid');
  });

  it('RATE_LIMITED → rateLimited（含下划线）', () => {
    expect(camelCaseCategory('RATE_LIMITED')).toBe('rateLimited');
  });

  it('MAX_TOKENS_TOO_HIGH → maxTokensTooHigh（多段下划线，4 段）', () => {
    expect(camelCaseCategory('MAX_TOKENS_TOO_HIGH')).toBe('maxTokensTooHigh');
  });

  it('NETWORK → network（不含下划线，单段）', () => {
    expect(camelCaseCategory('NETWORK')).toBe('network');
  });

  it('SERVER_ERROR → serverError（含下划线，2 段）', () => {
    expect(camelCaseCategory('SERVER_ERROR')).toBe('serverError');
  });

  it('空字符串 → 空字符串（兜底）', () => {
    expect(camelCaseCategory('')).toBe('');
  });

  it('全 18 category camelCase 与 error.json keys 一一对应', () => {
    const zhBundle = i18n.getResourceBundle('zh-CN', 'error') as { llm: Record<string, string> };
    const zhKeys = Object.keys(zhBundle.llm).sort();
    const camelized = ERROR_CATEGORIES.map(camelCaseCategory).sort();
    expect(camelized).toEqual(zhKeys);
  });
});

describe('displayReason 18 category × 2 lng 全覆盖（spec §8）', () => {
  /** 在指定 lng 下遍历 18 category，断言 t('llm.<camelCase>') 命中（无 missing） */
  function assertAllCategoriesResolve(lng: 'zh-CN' | 'en') {
    for (const cat of ERROR_CATEGORIES) {
      const leaf = camelCaseCategory(cat);
      const looked = i18n.t(`llm.${leaf}`, { ns: 'error', lng });
      expect(looked, `${lng}/error.llm.${leaf} should resolve (category=${cat})`).not.toContain('【资源');
      expect(looked, `${lng}/error.llm.${leaf} should not equal raw key`).not.toBe(`llm.${leaf}`);
      expect(looked.length, `${lng}/error.llm.${leaf} should be non-empty`).toBeGreaterThan(0);
    }
  }

  it('zh-CN：18 category 全部查表命中（无 missing key）', () => {
    assertAllCategoriesResolve('zh-CN');
  });

  it('en：18 category 全部查表命中（无 missing key）', () => {
    assertAllCategoriesResolve('en');
  });

  it('zh-CN 与 en 文案不同（验证翻译确实有差异）', () => {
    for (const cat of ERROR_CATEGORIES) {
      const leaf = camelCaseCategory(cat);
      const zh = i18n.t(`llm.${leaf}`, { ns: 'error', lng: 'zh-CN' });
      const en = i18n.t(`llm.${leaf}`, { ns: 'error', lng: 'en' });
      expect(zh, `category=${cat} should differ between zh-CN and en`).not.toBe(en);
    }
  });

  it('zh-CN 文案与后端 DISPLAY_REASON_TABLE 一致（保证回退无缝）—— 抽查 AUTH_INVALID', () => {
    // spec §8：zh-CN 文案与 app/server/src/llm/caller/display_reason.ts 的 DISPLAY_REASON_TABLE 一致
    // 抽查典型值（避免复制整张表，整张表一致性已在 T2 验收时 diff 比对）
    expect(i18n.t('llm.authInvalid', { ns: 'error', lng: 'zh-CN' })).toBe('认证失败，请检查 API Key');
    expect(i18n.t('llm.rateLimited', { ns: 'error', lng: 'zh-CN' })).toBe('模型限流，请稍后重试');
    expect(i18n.t('llm.providerOverloaded', { ns: 'error', lng: 'zh-CN' })).toBe('服务商过载，请稍后重试');
  });
});

describe('localizedDisplayReason 查表 + 回退（spec §8 契约）', () => {
  it('AUTH_INVALID → zh-CN locale 文案', async () => {
    await i18n.changeLanguage('zh-CN');
    const out = localizedDisplayReason('AUTH_INVALID', 'raw fallback', getTError());
    expect(out).toBe('认证失败，请检查 API Key');
  });

  it('AUTH_INVALID → en locale 文案', async () => {
    await i18n.changeLanguage('en');
    const out = localizedDisplayReason('AUTH_INVALID', 'raw fallback', getTError());
    expect(out).toBe('Authentication failed. Please check your API Key.');
  });

  it('未知 category → 回退 displayReason 字段（零 breakage）', async () => {
    await i18n.changeLanguage('zh-CN');
    const out = localizedDisplayReason('__UNKNOWN_NEW__', 'this is raw provider text', getTError());
    expect(out).toBe('this is raw provider text');
  });

  it('全部 18 category 在 zh-CN 下 localizedDisplayReason 均查表命中（不回退字段）', async () => {
    await i18n.changeLanguage('zh-CN');
    const t = getTError();
    for (const cat of ERROR_CATEGORIES) {
      const out = localizedDisplayReason(cat, 'SHOULD_NOT_RETURN_THIS', t);
      expect(out, `category=${cat}`).not.toContain('SHOULD_NOT_RETURN_THIS');
      expect(out, `category=${cat}`).not.toContain('【资源');
      expect(out.length, `category=${cat}`).toBeGreaterThan(0);
    }
  });
});
