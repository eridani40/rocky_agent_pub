/**
 * @vitest-environment jsdom
 * i18n 兜底链单测（KKV 规则 3，spec §3）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §3（规则 3：当前 → en → zh-CN，始终有文本可见）
 *
 * 覆盖：
 *   - 当前 zh-CN 缺翻译但 en 有 → 显示 en 文案
 *   - 当前 en 缺翻译但 zh-CN 有 → 显示 zh-CN 文案
 *   - 兜底链生效：当前仍能正常展示其自有翻译
 *
 * 实现细节：用 i18n.addResourceBundle 注入单语言测试 key（en/zh-CN 单边），
 * 不污染持久 bundle。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initI18n, i18n } from '../index';

beforeAll(async () => {
  await initI18n('zh-CN');
  // 注入测试专用 key：仅在 en 中存在（zh-CN 缺）—— 模拟「当前 zh-CN 缺翻译但 en 有」
  i18n.addResourceBundle('en', 'common', { testOnlyEn: 'EN_ONLY_TEXT' }, true, true);
});

afterAll(async () => {
  // 还原语言，保持 instance 干净
  await i18n.changeLanguage('zh-CN');
});

describe('兜底链 当前 → en → zh-CN（spec §3 规则 3）', () => {
  it('zh-CN 缺、en 有 → t() 返回 en 文案', async () => {
    await i18n.changeLanguage('zh-CN');
    const out = i18n.t('testOnlyEn', { ns: 'common' });
    expect(out).toBe('EN_ONLY_TEXT');
  });

  it('en 缺、zh-CN 有 → t() 返回 zh-CN 文案（反向兜底）', async () => {
    // 注入仅 zh-CN 的 key
    i18n.addResourceBundle('zh-CN', 'common', { testOnlyZh: 'ZH_ONLY_TEXT' }, true, true);
    await i18n.changeLanguage('en');
    const out = i18n.t('testOnlyZh', { ns: 'common' });
    expect(out).toBe('ZH_ONLY_TEXT');
  });

  it('兜底链生效不影响当前语言自有翻译（zh-CN 仍正常显示 action.confirm）', async () => {
    await i18n.changeLanguage('zh-CN');
    // 兜底路径：testOnlyEn 仍能拿到 en 文案
    expect(i18n.t('testOnlyEn', { ns: 'common' })).toBe('EN_ONLY_TEXT');
    // 当前 zh-CN 自有翻译正常工作
    expect(i18n.t('action.confirm', { ns: 'common' })).toBe('确认');
  });

  it('fallbackLng 顺序 = [en, zh-CN]（先 en 后 zh-CN）', () => {
    expect(i18n.options.fallbackLng).toEqual(['en', 'zh-CN']);
  });
});
