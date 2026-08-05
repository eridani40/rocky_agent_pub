/**
 * change-language —— locale 切换（实时 + 持久化）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §5.4（changeLanguage）+ §6（locale 开关链路）
 *       specs/prd/version_logs/v0.0.89/01-config-page-tab.md §4（外观合并：language 归 appearance group）
 *
 * v0.0.89 变更：locale group 合并入 appearance。language 现与 theme 同 group。
 *   PUT 必须 read-modify-write（GET appearance → 改 language 字段 → PUT 整组含 theme + language），
 *   避免 PUT 单 key 覆盖丢 theme。
 *
 * 设计：用户在设置页外观 group 选语言时调用，三步原子：
 *   1) i18n.changeLanguage(lng) —— react-i18next 触发组件重渲染（无需刷新）
 *   2) document.documentElement.lang = lng —— 无障碍同步
 *   3) GET appearance group → 合并 language → PUT appearance 整组（持久化，切即生效）
 *
 * 调用方：app-dev-config-page 的 ComponentLocaleCard onChange（切即生效，不进 page-tab dirty）
 */
import { i18n, type LocaleId } from './index';
import { getConfigGroup, putConfigGroup } from '../lib/api-client';

/**
 * 切换 locale（实时切 + 持久化）。
 *
 * @param lng 目标 locale（'zh-CN' / 'en'）
 * @throws PUT 失败时抛 Error（i18n.changeLanguage 已生效，仅持久化失败；
 *   调用方可吞错或反馈 UI，不影响切换即时性）
 */
export async function changeLanguage(lng: LocaleId): Promise<void> {
  // 1) 实时切（react-i18next 内部触发组件重渲染，无刷新）
  await i18n.changeLanguage(lng);
  // 2) 无障碍：<html lang> 同步（screen reader 等）
  document.documentElement.lang = lng;
  // 3) 持久化：read-modify-write appearance group（含 theme + language，避免覆盖 theme）
  //    v0.0.89：language 从 locale group 迁到 appearance group
  try {
    const items = await getConfigGroup('app', 'appearance');
    const themeItem = items.find((i) => i.key === 'theme');
    const next = [
      // 保留 theme（若存在）
      ...(themeItem ? [{ key: 'theme', data: themeItem.data }] : []),
      // 写入新 language
      { key: 'language', data: lng },
    ];
    await putConfigGroup('app', 'appearance', next);
  } catch {
    // 持久化失败不影响切换即时性（i18next 已切，<html lang> 已设）
  }
}
