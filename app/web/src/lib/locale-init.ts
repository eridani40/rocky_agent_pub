/**
 * locale-init —— 启动期读 app_config.appearance.language → 初始化 i18next（对齐 theme-init BUG-001 范式）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §5.2（启动期 init 链路）+ §6（locale 开关链路）
 *       specs/prd/version_logs/v0.0.89/01-config-page-tab.md §4（外观合并：language 归 appearance group）
 *
 * v0.0.89 变更：GET URL 从 `?group=locale&key=language` 改 `?group=appearance&key=language`
 *   （locale group 合并入 appearance）。fallback zh-CN 不变。
 *
 * 设计（与 lib/theme-init.ts 三段式同构）：
 *   - read：GET /config/app?group=appearance&key=language → lng
 *   - apply：initI18n(lng) + document.documentElement.lang = lng（无障碍）
 *   - try-catch：GET 失败 → fallback 'zh-CN'，永不抛错（保证 UI 可用）
 *
 * 调用点：main.tsx 在任何 React 渲染前 `await initI18nFromConfig()`
 */
import { req } from './api-client';
import { initI18n, type LocaleId } from '../i18n';

/** GET /config/app?group=appearance&key=language → 当前持久化 language（首次=null/缺省） */
async function fetchLocaleLanguage(base?: string): Promise<LocaleId | null> {
  const r = await req<{ value: LocaleId | null }>(
    '/config/app?group=appearance&key=language',
    undefined,
    base,
  );
  return r.value ?? null;
}

/** locale 合法值校验（防 GET 返回异常值导致 i18next 报错） */
function isLocaleId(v: unknown): v is LocaleId {
  return v === 'zh-CN' || v === 'en';
}

/**
 * 启动期初始化 i18n：读 GET /config/app?group=appearance&key=language → initI18n + 设 <html lang>。
 * 永不抛错（GET 失败 / 值非法 → fallback 'zh-CN'），保证 React 渲染前 i18n instance 就绪。
 *
 * @returns 实际应用的 locale（供调用方/测试断言）
 */
export async function initI18nFromConfig(): Promise<LocaleId> {
  let lng: LocaleId = 'zh-CN';
  try {
    const raw = await fetchLocaleLanguage();
    if (isLocaleId(raw)) lng = raw;
  } catch {
    // GET 失败保留默认 'zh-CN'（initI18n 仍执行，保证 instance 就绪）
  }
  await initI18n(lng);
  // 无障碍：<html lang> 同步（screen reader 等用）
  document.documentElement.lang = lng;
  return lng;
}
