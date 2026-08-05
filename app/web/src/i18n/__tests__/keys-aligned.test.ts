/**
 * @vitest-environment jsdom
 * i18n bundle keys 对齐单测（zh-CN ↔ en 同 ns 同 key 集合，spec §4.1）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4.1（bundle 物理结构 + 10 ns 拆分）
 *
 * 防回归：当任一 ns 的 zh-CN / en 增删 key 不同步时 fail-fast。
 *
 * 本 task (T1) 重点是 common ns 增补（B9 ~9 类 + timeAgo / composer / saveBar / sessionState），
 * 但 UT 一次覆盖 10 ns —— 后续 T2-T5 填实其他 ns 时无需再扩此文件。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { collectLeafKeys } from './_test-helpers';

// 启动 i18next instance（加载 10 ns × 2 lng 静态资源），与本目录其他 UT 同范式
beforeAll(async () => {
  await initI18n('zh-CN');
});

/** spec §4.1 期望对齐的 10 ns */
const EXPECTED_NS = [
  'common',
  'error',
  'chat',
  'studio',
  'providers',
  'plugin-config',
  'app-dev-config',
  'skill',
  'connector',
  'framework',
] as const;

describe('i18n bundle keys 对齐（zh-CN ↔ en，spec §4.1）', () => {
  it('10 ns 全部加载到 zh-CN / en resources', () => {
    for (const ns of EXPECTED_NS) {
      const zh = i18n.getResourceBundle('zh-CN', ns);
      const en = i18n.getResourceBundle('en', ns);
      expect(zh, `zh-CN/${ns} bundle should be loaded`).toBeDefined();
      expect(en, `en/${ns} bundle should be loaded`).toBeDefined();
    }
  });

  it.each(EXPECTED_NS)('ns="%s" zh-CN 与 en key 集合完全一致', (ns) => {
    const zh = i18n.getResourceBundle('zh-CN', ns);
    const en = i18n.getResourceBundle('en', ns);
    const zhKeys = collectLeafKeys(zh);
    const enKeys = collectLeafKeys(en);

    const onlyInZh = [...zhKeys].filter((k) => !enKeys.has(k));
    const onlyInEn = [...enKeys].filter((k) => !zhKeys.has(k));

    expect(onlyInZh, `ns="${ns}" 仅 zh-CN 有的 key（en 缺）: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `ns="${ns}" 仅 en 有的 key（zh-CN 缺）: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

describe('common ns T1 新增分组（B9 + task.json T1 description）', () => {
  /** T1 应覆盖的 common ns 顶层分组（包含 v0.0.59 既有 + T1 新增） */
  const COMMON_TOP_GROUPS = [
    'action',
    'status',
    'validation',
    'modal',
    'error',
    'timeAgo',
    'composer',
    'saveBar',
    'sessionState',
  ] as const;

  it('common zh-CN 含 T1 全部分组（spec §4 + task description B9）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'common');
    for (const group of COMMON_TOP_GROUPS) {
      expect(zh[group], `common.${group} 分组应存在`).toBeDefined();
    }
  });

  it('common.modal 含 close + deleteTitle（B9：modal aria-label + 删除确认标题）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'common');
    expect(typeof zh.modal?.close).toBe('string');
    expect(typeof zh.modal?.deleteTitle).toBe('string');
  });

  it('common.error 含 loadFail/saveFail（错误 fallback；sendFail 已随唯一消费方删除清理为孤儿键）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'common');
    expect(typeof zh.error?.loadFail).toBe('string');
    expect(typeof zh.error?.saveFail).toBe('string');
    // sendFail 唯一消费方（academy use-academy-chat-usage）已删，键同步清理——断言不存在防孤儿键回潮
    expect(zh.error?.sendFail).toBeUndefined();
  });

  it('common.timeAgo 含 4 leaf（justNow + 三段相对时间，来自 conversation-item）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'common');
    expect(typeof zh.timeAgo?.justNow).toBe('string');
    expect(typeof zh.timeAgo?.minutesAgo).toBe('string');
    expect(typeof zh.timeAgo?.hoursAgo).toBe('string');
    expect(typeof zh.timeAgo?.daysAgo).toBe('string');
    // 三段相对时间含 {{count}} 插值
    expect(zh.timeAgo.minutesAgo).toContain('{{count}}');
    expect(zh.timeAgo.hoursAgo).toContain('{{count}}');
    expect(zh.timeAgo.daysAgo).toContain('{{count}}');
  });

  it('common.composer.placeholder 单 key（chat/studio/member/squad chat 共享）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'common');
    expect(typeof zh.composer?.placeholder).toBe('string');
  });

  it('common.saveBar 含 saving/dirty/save 三态（component-group-save-bar 视觉态机）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'common');
    expect(typeof zh.saveBar?.saving).toBe('string');
    expect(typeof zh.saveBar?.dirty).toBe('string');
    expect(typeof zh.saveBar?.save).toBe('string');
  });

  it('common.sessionState 含 5 leaf（为 T6 type code 查表准备）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'common');
    expect(typeof zh.sessionState?.idle).toBe('string');
    expect(typeof zh.sessionState?.running).toBe('string');
    expect(typeof zh.sessionState?.interrupting).toBe('string');
    expect(typeof zh.sessionState?.interrupted).toBe('string');
    expect(typeof zh.sessionState?.error).toBe('string');
  });
});
