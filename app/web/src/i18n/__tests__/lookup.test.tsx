/**
 * @vitest-environment jsdom
 * i18n t() 查表 + {{name}} 占位符插值单测（KKV 规则 2，spec §3 + §4.3）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §3（四规则）+ §4.3（占位符插值）+ §5.3（useTranslation）
 *
 * 覆盖：
 *   - 占位 key 查表命中：t(key) → 当前语言文案（zh-CN 下 action.confirm→「确认」等）
 *   - {{name}} 单变量 / 多变量插值（interpolation.escapeValue=false，spec §4.3）
 *   - 多 ns useTranslation(['chat','common'])：chat 优先 → common 兜底
 */
import React from 'react';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { initI18n, i18n } from '../index';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 测试组件：用 useTranslation 取 t（验证 React 集成路径），渲染单个 span 文本 */
function TComp({
  ns,
  k,
  opts,
}: {
  ns: string | string[];
  k: string;
  opts?: Record<string, unknown>;
}) {
  const { t } = useTranslation(ns);
  const text = String(t(k, opts as never));
  return <span>{text}</span>;
}

describe('t() 查表命中（KKV 规则 2，spec §3）', () => {
  it('zh-CN common.action.confirm → 「确认」', () => {
    const { container } = render(<TComp ns="common" k="action.confirm" />);
    expect(container.textContent).toBe('确认');
  });

  it('zh-CN common.status.loading → 「加载中…」（含省略号）', () => {
    const { container } = render(<TComp ns="common" k="status.loading" />);
    expect(container.textContent).toBe('加载中…');
  });

  it('error ns：llm.authInvalid → 「认证失败，请检查 API Key」', () => {
    const { container } = render(<TComp ns="error" k="llm.authInvalid" />);
    expect(container.textContent).toBe('认证失败，请检查 API Key');
  });

  it('defaultNS=common 兜底：useTranslation() 无参也能查 common', () => {
    function DefaultNsComp() {
      const { t } = useTranslation();
      return <span>{t('action.cancel')}</span>;
    }
    const { container } = render(<DefaultNsComp />);
    expect(container.textContent).toBe('取消');
  });
});

describe('t() {{name}} 占位符插值（spec §4.3）', () => {
  it('单变量插值 {{name}}', () => {
    i18n.addResourceBundle('zh-CN', 'common', { testHello: '你好 {{name}}' }, true, true);
    const out = i18n.t('testHello', { ns: 'common', name: 'Alice' });
    expect(out).toBe('你好 Alice');
  });

  it('多变量插值 {{count}} {{name}}', () => {
    i18n.addResourceBundle(
      'zh-CN',
      'common',
      { testMulti: '{{count}} 条消息来自 {{name}}' },
      true,
      true,
    );
    const out = i18n.t('testMulti', { ns: 'common', name: 'Bob', count: 3 });
    expect(out).toBe('3 条消息来自 Bob');
  });

  it('escapeValue=false（React 已转义，spec §4.3）—— HTML 字符不被双重转义', () => {
    i18n.addResourceBundle('zh-CN', 'common', { testEscape: '<b>{{x}}</b>' }, true, true);
    const out = i18n.t('testEscape', { ns: 'common', x: '<a>' });
    // escapeValue=false → 不转义 < >，保持原样
    expect(out).toBe('<b><a></b>');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&gt;');
  });
});

describe('多 ns 用法（spec §5.3 多 ns：useTranslation([chat, common])）', () => {
  /**
   * 注：i18next v23 + react-i18next v15 下，useTranslation(['chat','common']) 数组的
   * 第二 ns 并非自动 fallback —— 自动跨 ns fallback 需在 init 设 `fallbackNS`。
   * 当前 T1 init 未设 fallbackNS（spec §5.1 仅设 fallbackLng）。
   * 故多 ns 跨查的合法用法：
   *   1) `t('key', { ns: 'common' })` —— 显式指定 ns（推荐）
   *   2) `t('common:key')` —— ns 前缀语法
   * 下面覆盖这两种合法路径；spec §5.3 「common 兜底」语义需 fallbackNS（留作 Batch 2 候选）。
   */

  it('显式 ns 参数：t("key", { ns: "chat" }) 跨 ns 查 chat', () => {
    i18n.addResourceBundle('zh-CN', 'chat', { testChatKey: '来自 chat' }, true, true);
    const { container } = render(
      <TComp ns={['chat', 'common']} k="testChatKey" opts={{ ns: 'chat' }} />,
    );
    expect(container.textContent).toBe('来自 chat');
  });

  it('显式 ns 参数：从 chat 组件内查 common 的 key', () => {
    i18n.addResourceBundle('zh-CN', 'common', { testCommonOnly: 'common only' }, true, true);
    const { container } = render(
      <TComp ns="chat" k="testCommonOnly" opts={{ ns: 'common' }} />,
    );
    expect(container.textContent).toBe('common only');
  });

  it('ns 前缀语法：t("common:key") 跨 ns 查 common', () => {
    i18n.addResourceBundle('zh-CN', 'common', { testPrefixKey: 'prefix common' }, true, true);
    const { container } = render(<TComp ns="chat" k="common:testPrefixKey" />);
    expect(container.textContent).toBe('prefix common');
  });
});
