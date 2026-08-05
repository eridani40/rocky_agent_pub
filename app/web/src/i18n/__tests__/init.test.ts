/**
 * @vitest-environment jsdom
 * i18n init / changeLanguage 单测（KKV 规则 init + 切换，spec §5 + §6）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §5（react-i18next 集成）+ §6（locale 开关链路）+ §5.4（changeLanguage）
 *
 * 覆盖：
 *   - initI18n(lng)：调用后 isInitialized===true + lng 设置 + 10 ns 资源加载 + fallbackLng/defaultNS
 *   - initI18nFromConfig：GET 成功应用 lng；GET 失败/非法值 → fallback zh-CN；<html lang> 同步
 *   - changeLanguage：切换 lng 后 t() 立即返回新语言文案（实时，不重建 instance）+ <html lang> 同步
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { i18n, initI18n } from '../index';
import { initI18nFromConfig } from '../../lib/locale-init';
import { changeLanguage } from '../change-language';

/** spec §4.1 期望加载的 10 ns */
const EXPECTED_NS = [
  'common', 'error', 'chat', 'studio', 'providers',
  'plugin-config', 'app-dev-config', 'skill', 'connector', 'framework',
];

/** mock fetch 路由（按 url 子串匹配；与 theme-init.test.ts 同范式） */
function mockFetch(routes: Record<string, (url: string) => unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) {
        const body = await routes[key]!(url);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":"NF"}' } as unknown as Response;
  });
}

describe('initI18n（i18n/index.ts §5.1）', () => {
  beforeAll(async () => {
    await initI18n('zh-CN');
  });

  it('调用后 i18n.isInitialized === true', () => {
    expect(i18n.isInitialized).toBe(true);
  });

  it('lng 设置为传入值（zh-CN）', () => {
    expect(i18n.language).toBe('zh-CN');
  });

  it('10 ns 全部加载到 zh-CN resources', () => {
    for (const ns of EXPECTED_NS) {
      const bundle = i18n.getResourceBundle('zh-CN', ns);
      expect(bundle, `zh-CN/${ns} should be loaded`).toBeDefined();
    }
  });

  it('10 ns 全部加载到 en resources', () => {
    for (const ns of EXPECTED_NS) {
      const bundle = i18n.getResourceBundle('en', ns);
      expect(bundle, `en/${ns} should be loaded`).toBeDefined();
    }
  });

  it('fallbackLng 配置为 [en, zh-CN]（spec §3 规则 3 兜底链）', () => {
    expect(i18n.options.fallbackLng).toEqual(['en', 'zh-CN']);
  });

  it('defaultNS = common（spec §4.1）', () => {
    expect(i18n.options.defaultNS).toBe('common');
  });
});

describe('initI18nFromConfig（lib/locale-init.ts §5.2）', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('GET 返回 en → 应用 en + 设 <html lang>=en', async () => {
    global.fetch = mockFetch({
      '/config/app': () => ({ value: 'en' }),
    }) as unknown as typeof fetch;

    const applied = await initI18nFromConfig();
    expect(applied).toBe('en');
    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('GET 返回 null（首次启动无持久化）→ fallback zh-CN', async () => {
    global.fetch = mockFetch({
      '/config/app': () => ({ value: null }),
    }) as unknown as typeof fetch;

    const applied = await initI18nFromConfig();
    expect(applied).toBe('zh-CN');
    expect(i18n.language).toBe('zh-CN');
  });

  it('GET 返回非法值（fr-FR）→ fallback zh-CN（防 i18next 报错）', async () => {
    global.fetch = mockFetch({
      '/config/app': () => ({ value: 'fr-FR' }),
    }) as unknown as typeof fetch;

    const applied = await initI18nFromConfig();
    expect(applied).toBe('zh-CN');
  });

  it('GET 失败（500）→ fallback zh-CN 不抛错（保证 instance 就绪）', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => '{"error":"boom"}',
    })) as unknown as typeof fetch;

    const applied = await initI18nFromConfig();
    expect(applied).toBe('zh-CN');
    expect(i18n.isInitialized).toBe(true);
  });
});

describe('changeLanguage（i18n/change-language.ts §5.4）', () => {
  const originalFetch = global.fetch;

  afterEach(async () => {
    // 重置回 zh-CN（避免污染同文件后续 describe）
    await i18n.changeLanguage('zh-CN');
    document.documentElement.lang = 'zh-CN';
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('切换 lng 后 t() 立即返回新语言文案（实时，不重建 instance）', async () => {
    // 初始 zh-CN：common.action.confirm → 「确认」
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('action.confirm', { ns: 'common' })).toBe('确认');

    // mock PUT 持久化（避免真实 fetch）
    global.fetch = mockFetch({
      '/config/app': () => ({ ok: true }),
    }) as unknown as typeof fetch;

    const wasInitializedBefore = i18n.isInitialized;
    await changeLanguage('en');

    // 同一 instance（未重建），t() 已切到 en
    expect(i18n.language).toBe('en');
    expect(i18n.t('action.confirm', { ns: 'common' })).toBe('Confirm');
    expect(i18n.isInitialized).toBe(true);
    expect(wasInitializedBefore).toBe(true);
  });

  it('切换后 <html lang> 同步（无障碍 §5.4）', async () => {
    global.fetch = mockFetch({
      '/config/app': () => ({ ok: true }),
    }) as unknown as typeof fetch;

    await changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
