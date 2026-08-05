/**
 * @vitest-environment jsdom
 * i18n type vs dynamic 渲染判定单测（spec §7）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §7（type 字段 vs 自由文本处理判定流程）
 *
 * 核心：判定责任在前端组件（按字段名分支，不靠字符串启发式）：
 *   - 可枚举 type 字段（errorCategory）→ 走 localizedDisplayReason 查 locale 表
 *   - 自由文本（error_message / squad.name）→ 原样直展，不进 i18n
 *
 * 覆盖：
 *   - type 字段（errorCategory）→ localizedDisplayReason 优先查 `error.llm.<camelCase>`
 *   - 查不到 → 回退 displayReason 字段（零 breakage，spec §8）
 *   - 自由文本（error_message）→ 不进 i18n（前端组件按字段名分支直展）
 *   - localizedDisplayReason 不返回 missing 格式（始终回退到 displayReason 字段）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { TFunction } from 'i18next';
import { initI18n, i18n } from '../index';
import { localizedDisplayReason } from '../llm-error-category';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 制造追踪 t（绑 ns=error，记录调用 keys）—— 验证「是否走了 i18n 路径」 */
function makeTrackedT() {
  const calls: string[] = [];
  const t = ((key: string) => {
    calls.push(key);
    return i18n.t(key, { ns: 'error' });
  }) as unknown as TFunction;
  return { t, calls };
}

describe('type 字段（errorCategory）→ 走 i18n 查表（spec §7 主路径）', () => {
  it('AUTH_INVALID → 调 t("llm.authInvalid") 命中 zh-CN 文案', () => {
    const { t, calls } = makeTrackedT();
    const out = localizedDisplayReason('AUTH_INVALID', 'raw fallback should not return', t);
    expect(calls).toContain('llm.authInvalid');
    expect(out).toBe('认证失败，请检查 API Key');
  });

  it('查表命中 → 不返回 displayReason 字段（避免兜底文案污染）', () => {
    const { t } = makeTrackedT();
    const out = localizedDisplayReason('RATE_LIMITED', 'RAWMARK_SHOULD_NOT_RETURN', t);
    expect(out).not.toContain('RAWMARK');
    expect(out).toBe('模型限流，请稍后重试');
  });
});

describe('type 查不到 → 回退 displayReason 字段（spec §8 零 breakage）', () => {
  it('未知 category → 尝试查表 + 回退 displayReason 字段', () => {
    const { t, calls } = makeTrackedT();
    const out = localizedDisplayReason('__UNKNOWN_CATEGORY__', 'this is fallback', t);
    // 仍尝试查表（key = llm.__unknownCategory__，camelCase 处理）
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatch(/^llm\./);
    // 查不到 → 回退 displayReason
    expect(out).toBe('this is fallback');
  });

  it('displayReason 空字符串 + 查不到 → 返回空（不返回 missing 格式）', () => {
    const { t } = makeTrackedT();
    const out = localizedDisplayReason('__UNKNOWN__', '', t);
    expect(out).toBe('');
    expect(out).not.toContain('【资源');
  });

  it('localizedDisplayReason 始终不返回「【资源」格式（防 missing key 漏出）', () => {
    const { t } = makeTrackedT();
    for (const cat of ['UNKNOWN_1', 'UNKNOWN_2', 'not_a_real_category']) {
      const out = localizedDisplayReason(cat, 'safe fallback', t);
      expect(out).not.toContain('【资源');
    }
  });
});

describe('自由文本（error_message）→ 原样直展，不走 i18n（spec §7 硬边界）', () => {
  // 注：spec §7 的「自由文本直展」判定责任在**前端组件层**（按字段名分支），不在 i18n 模块内。
  // 故此处不模拟组件层（mock 自己无价值）；只验证 i18n 模块边界：即便误传自由文本给
  // localizedDisplayReason，函数仍只查 llm.<camelCase>，查不到回退 displayReason 字段，
  // 不会污染 / 错翻译（硬边界由组件层判定保证）。组件层分支由各组件 UT 覆盖。

  it('若误把自由文本传给 localizedDisplayReason → 仅按 type 路径查表，查不到回退字段', () => {
    // spec §7：判定责任在组件层。即便误传，函数仍只查 llm.<camelCase>，查不到回退 displayReason
    // 不会污染 / 错翻译（硬边界由组件层判定保证）
    const { t, calls } = makeTrackedT();
    // camelCase('rate limit exceeded') 不含下划线 → toLowerCase 即可
    const out = localizedDisplayReason('rate limit exceeded', 'fallback raw msg', t);
    expect(calls).toContain('llm.rate limit exceeded');
    // 查不到 → 回退 displayReason 字段（原样直展效果）
    expect(out).toBe('fallback raw msg');
  });
});
