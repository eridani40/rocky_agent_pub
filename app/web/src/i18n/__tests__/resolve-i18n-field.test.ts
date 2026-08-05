/**
 * @vitest-environment jsdom
 * resolve-i18n-field —— M5 占位符 helper UT（[P1] §4.6 三类 case）
 * 参考: specs/tech/i18n/[P1]manifest_i18n.md §4（helper 契约）+ §3（语法）+ §4.3（missing 不 fallback）
 *
 * 覆盖三类 case（[P1] §4.6）：
 *   1. 占位符识别 + 查到 → 返回 locale 文案
 *   2. 占位符识别 + missing key → 走 [P0] §3 规则 (4) 报错（不 fallback 原文 / 不 fallback 兜底文案）
 *   3. 非占位符（字面文案）→ 直展 value
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initI18n, i18n } from '../index';
import { resolveI18nField } from '../resolve-i18n-field';
import type { TFunction } from 'i18next';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 拿 i18n.t 绑定 plugin-config ns（manifest key 落此 ns） */
function getT(): TFunction {
  return i18n.getFixedT('zh-CN', 'plugin-config');
}

describe('resolveI18nField — [P1] §4.6 三类 case', () => {
  it('case 1: __MSG_<key>__ 占位符 + bundle 查到 → 返回 locale 文案', async () => {
    // 准备：临时往 plugin-config ns 加一条 builtin key（避免依赖未填的 manifest keys）
    i18n.addResourceBundle('zh-CN', 'plugin-config', {
      plugin: { builtin: { llm_anthropic: { label: 'Anthropic LLM' } } },
    });
    const t = getT();
    const out = resolveI18nField('__MSG_plugin.builtin.llm_anthropic.label__', t);
    expect(out).toBe('Anthropic LLM');
  });

  it('case 2: __MSG_<key>__ 占位符 + missing key → 「【资源 <key> 不存在】」不 fallback 原文', () => {
    const t = getT();
    const missingKey = 'plugin.builtin.__nonexistent_omg__.label';
    const out = resolveI18nField(`__MSG_${missingKey}__`, t);
    // [P1] §4.3 missing key 走 [P0] §3 规则 (4) 报错（parseMissingKeyHandler 输出）
    expect(out).toContain('【资源');
    expect(out).toContain(missingKey);
    expect(out).toContain('不存在】');
    // 关键断言：不 fallback raw `__MSG_...__` 字面（占位符声明翻译承诺）
    expect(out).not.toContain('__MSG_');
  });

  it('case 3: 非占位符（字面文案）→ 直展 value（兼容第三方 / 未改造 / 老 plugin）', () => {
    const t = getT();
    // 第三方 plugin 字面中文（未改造）
    expect(resolveI18nField('第三方 plugin 的字面描述', t)).toBe('第三方 plugin 的字面描述');
    // 老 plugin 字面英文
    expect(resolveI18nField('A legacy plugin description', t)).toBe('A legacy plugin description');
    // 含 __MSG_ 但不是首尾包裹（非占位符语法，应直展）
    expect(resolveI18nField('text __MSG_inside__ suffix', t)).toBe('text __MSG_inside__ suffix');
  });

  it('空值兜底：undefined / null / 空串 → 返回空（caller 判 !render 跳过节点）', () => {
    const t = getT();
    expect(resolveI18nField(undefined, t)).toBe('');
    expect(resolveI18nField(null, t)).toBe('');
    expect(resolveI18nField('', t)).toBe('');
  });

  it('正则严格匹配：仅 `^__MSG_(.+)__$` 整字符串识别（防误识别）', () => {
    const t = getT();
    // 前后有空格 → 不识别（直展）
    expect(resolveI18nField('  __MSG_plugin.builtin.x__  ', t)).toBe('  __MSG_plugin.builtin.x__  ');
    // 只有前缀无后缀 → 不识别
    expect(resolveI18nField('__MSG_plugin.builtin.x', t)).toBe('__MSG_plugin.builtin.x');
    // 只有后缀无前缀 → 不识别
    expect(resolveI18nField('plugin.builtin.x__', t)).toBe('plugin.builtin.x__');
  });
});

describe('resolveI18nField — 切语言跟切（react-i18next instance 共享）', () => {
  it('切到 en 后占位符查 en bundle（同一 t 函数响应语言变化）', async () => {
    i18n.addResourceBundle('en', 'plugin-config', {
      plugin: { builtin: { llm_anthropic: { label: 'Anthropic LLM' } } },
    });
    const t = i18n.getFixedT('en', 'plugin-config');
    const out = resolveI18nField('__MSG_plugin.builtin.llm_anthropic.label__', t);
    expect(out).toBe('Anthropic LLM');
  });
});
