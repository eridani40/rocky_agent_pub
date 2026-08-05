/**
 * i18n 子系统入口 —— react-i18next instance + 启动期工厂
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §5.1（init 配置）+ §4.1（bundle 物理结构）
 *
 * 设计：
 *   - 静态 import 全量 ns × 2 lng JSON（build-time 打包，不懒加载，PRD §5 决策）
 *   - fallbackLng ['en','zh-CN']：当前语言缺翻译 → en → zh-CN（spec §3 规则 3 兜底链）
 *   - parseMissingKeyHandler 返回「【资源 ${key} 不存在】」（spec §3 规则 4 缺 key 报错）
 *   - react.useSuspense=false：启动期 main.tsx 已 await init，不需要 Suspense
 *
 * 调用链：
 *   main.tsx → lib/locale-init.ts::initI18nFromConfig() → initI18n(lng)
 *   组件侧：useTranslation(ns) → t(key)
 *   切换：i18n/change-language.ts::changeLanguage(lng)
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Resource } from 'i18next';

// zh-CN bundles
import zhCNCommon from './locales/zh-CN/common.json';
import zhCNError from './locales/zh-CN/error.json';
import zhCNChat from './locales/zh-CN/chat.json';
import zhCNStudio from './locales/zh-CN/studio.json';
import zhCNProviders from './locales/zh-CN/providers.json';
import zhCNPluginConfig from './locales/zh-CN/plugin-config.json';
import zhCNAppDevConfig from './locales/zh-CN/app-dev-config.json';
import zhCNSkill from './locales/zh-CN/skill.json';
import zhCNConnector from './locales/zh-CN/connector.json';
import zhCNChannel from './locales/zh-CN/channel.json';
import zhCNFramework from './locales/zh-CN/framework.json';
import zhCNAcademy from './locales/zh-CN/academy.json';

// en bundles
import enCommon from './locales/en/common.json';
import enError from './locales/en/error.json';
import enChat from './locales/en/chat.json';
import enStudio from './locales/en/studio.json';
import enProviders from './locales/en/providers.json';
import enPluginConfig from './locales/en/plugin-config.json';
import enAppDevConfig from './locales/en/app-dev-config.json';
import enSkill from './locales/en/skill.json';
import enConnector from './locales/en/connector.json';
import enChannel from './locales/en/channel.json';
import enFramework from './locales/en/framework.json';
import enAcademy from './locales/en/academy.json';

/** 支持的 locale id（与 app_config.locale.language 取值一致，spec §5） */
export type LocaleId = 'zh-CN' | 'en';

/** bundle 全量资源（build-time 静态 import，spec §4.1；类型对齐 i18next Resource） */
const resources: Resource = {
  'zh-CN': {
    common: zhCNCommon,
    error: zhCNError,
    chat: zhCNChat,
    studio: zhCNStudio,
    providers: zhCNProviders,
    'plugin-config': zhCNPluginConfig,
    'app-dev-config': zhCNAppDevConfig,
    skill: zhCNSkill,
    connector: zhCNConnector,
    channel: zhCNChannel,
    framework: zhCNFramework,
    academy: zhCNAcademy,
  },
  en: {
    common: enCommon,
    error: enError,
    chat: enChat,
    studio: enStudio,
    providers: enProviders,
    'plugin-config': enPluginConfig,
    'app-dev-config': enAppDevConfig,
    skill: enSkill,
    connector: enConnector,
    channel: enChannel,
    framework: enFramework,
    academy: enAcademy,
  },
};

/**
 * 初始化 i18next（启动期 main.tsx 在 React 渲染前 await）。
 * 幂等：i18next 内部已 init 时再次调用会复用 instance（不重复 init）。
 *
 * @param lng 当前 locale（来自 app_config.locale.language，启动期 GET 读）
 * @returns i18next.init 的 Promise（resolve 后 instance 就绪）
 */
export function initI18n(lng: LocaleId): Promise<unknown> {
  return i18n.use(initReactI18next).init({
    resources,
    lng,
    // §3 规则 (3) 兜底链：当前 → en → zh-CN（始终有文本可见）
    fallbackLng: ['en', 'zh-CN'],
    defaultNS: 'common',
    // 默认仅加载 common；各组件按需 useTranslation(ns)
    ns: ['common'],
    interpolation: {
      // React 已转义，避免双重转义（spec §4.3）
      escapeValue: false,
    },
    // §3 规则 (4) 缺 key 报错：开发期抓漏迁移 key
    parseMissingKeyHandler: (key: string) => `【资源 ${key} 不存在】`,
    // 触发 parseMissingKeyHandler（开发期 console.error missing key）
    saveMissing: true,
    react: {
      // 启动期 main.tsx 已 await initI18n，组件挂载时 instance 就绪，不需要 Suspense
      useSuspense: false,
    },
  });
}

/** 导出 instance 供 I18nextProvider + 调用方直接消费 */
export { i18n };
