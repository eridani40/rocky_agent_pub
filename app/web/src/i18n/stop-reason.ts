/**
 * stop-reason —— Run.stopReason i18n 辅助（snake_case → camelCase + localizedStopReason 查表）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §6（type code 累积映射表）+ §7（type vs dynamic 判定）
 *       specs/tech/i18n/index.md §⑥（chat.run.stopReason.<camelCase> 6 leaf）
 *
 * [T6 块 A] snake→camel 转换 + miss 检测抽到通用 helper code-key.ts，本文件仅保留
 * Run.stopReason 范畴语义包装（消除与 llm-error-category / studio board 的重复）。
 *
 * 边界：本 helper 只处理可枚举 type 字段 Run.stopReason 的 6 个非 error code（error 走
 * RunErrorInfo.displayReason 范式不进表，由 localizedDisplayReason 处理）。
 */
import type { TFunction } from 'i18next';
import { camelCaseCode, localizedCode } from './code-key';

/** Run.stopReason 后端枚举（snake_case，对齐 chat-page/types.ts StopReason，但前端不依赖 chat-page） */
export type StopReason = string;

/** chat ns 内 stopReason 查表的 key 前缀（leaf = run.stopReason.<camelCase>） */
const KEY_PREFIX = 'run.stopReason';

/**
 * snake_case → camelCase（如 no_tool_call → noToolCall）。
 * [T6 块 A] 薄包装通用 helper camelCaseCode（行为不变，向后兼容）。
 *
 * @example camelCaseStopReason('no_tool_call') // → 'noToolCall'
 * @example camelCaseStopReason('max_iterations') // → 'maxIterations'
 * @example camelCaseStopReason('interrupted') // → 'interrupted'
 */
export function camelCaseStopReason(code: StopReason): string {
  return camelCaseCode(code);
}

/**
 * 派生本地化 stopReason 文案：i18n 查 `chat.run.stopReason.<camelCase>` locale 表。
 * 与 localizedDisplayReason 不同——stopReason 没有 sample 兜底字段（后端不发 sample），
 * 因此查不到时返回空串（理论上不应发生，T2 已落 6 leaf；defensive 兜底返 '' 由 caller 决定）。
 *
 * @param stopReason Run.stopReason 枚举值（snake_case，如 'no_tool_call'）
 * @param t i18next t 函数（useTranslation('chat') 取；ns 已绑 'chat'，故 key 用 'run.stopReason.<leaf>'）
 * @returns 本地化文案（locale 表查到）或空串（查不到，defensive）
 */
export function localizedStopReason(stopReason: StopReason, t: TFunction): string {
  return localizedCode(stopReason, t, KEY_PREFIX);
}
