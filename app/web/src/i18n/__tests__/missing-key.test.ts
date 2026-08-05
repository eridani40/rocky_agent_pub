/**
 * @vitest-environment jsdom
 * i18n 缺 key 报错单测（KKV 规则 4，spec §3 + parseMissingKeyHandler）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §3（规则 4：三级全缺 → 「【资源 xxx 不存在」」）
 *
 * 覆盖：
 *   - 三级全缺 key → t() 返回「【资源 xxx 不存在」」格式（parseMissingKeyHandler 触发）
 *   - key 嵌入返回值（开发者能定位漏迁移 key）
 *   - 嵌套路径全缺同样走 parseMissingKeyHandler
 *   - 缺 key 不抛错（dev/prod 均不阻塞渲染）
 *
 * i18n/index.ts §5.1 配置：
 *   parseMissingKeyHandler = (key) => `【资源 ${key} 不存在】`
 *   saveMissing = true（开发期触发 handler）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initI18n, i18n } from '../index';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('缺 key 报错「【资源 xxx 不存在」」（spec §3 规则 4）', () => {
  it('三级全缺 key → 返回值含「【资源」前缀 + key + 「不存在」」', () => {
    // 用一个保证不存在的随机 key（避免历史 addResourceBundle 残留）
    const missingKey = `__testMissing_${Date.now()}`;
    const out = i18n.t(missingKey, { ns: 'common' });
    expect(out).toContain('【资源');
    expect(out).toContain(missingKey);
    expect(out).toContain('不存在】');
  });

  it('嵌套路径全缺 → 同样走 parseMissingKeyHandler', () => {
    const out = i18n.t('deeply.nested.path.that.does.not.exist', { ns: 'common' });
    expect(out).toContain('【资源');
    expect(out).toContain('不存在】');
  });

  it('指定 ns=error 全缺 key → 返回值含 key（不抛错）', () => {
    const out = i18n.t(`__errorMissing_${Date.now()}`, { ns: 'error' });
    expect(out).toContain('【资源');
    expect(out).toContain('不存在】');
  });

  it('t() 对缺 key 不抛错（dev/prod 均不阻塞渲染）', () => {
    expect(() => i18n.t(`__noThrow_${Date.now()}`, { ns: 'common' })).not.toThrow();
  });

  it('返回的格式严格匹配「【资源 <key> 不存在」」（spec §3 规则 4 模板）', () => {
    const key = `__strict_${Date.now()}`;
    const out = i18n.t(key, { ns: 'common' });
    expect(out).toBe(`【资源 ${key} 不存在】`);
  });
});
