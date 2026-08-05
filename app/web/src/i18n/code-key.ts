/**
 * code-key —— type code i18n 通用辅助（snake/kebab → camelCase + localizedCode 查表）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §6（type code 累积映射表）+ §7（type vs dynamic 判定）
 *       specs/tech/i18n/index.md §⑥（5 类 type code 累积映射表 + camelCase leaf 范式）
 *
 * 设计意图（T6 块 A，消除重复）：
 *   - chat.run.stopReason / common.sessionState / studio.taskStatus / studio.reqStatus /
 *     studio.autoWorkReason / studio.autoWorkResult 都是「后端发 snake/kebab code、
 *     前端按 locale 查 <ns>.<entity>.<field>.<camelCaseCode>」的同范式。
 *   - 历史 stop-reason.ts::camelCaseStopReason + studio board 4 处内联 statusLeaf/resultLeaf
 *     重复实现 snake→camel 转换 + 查表；本 helper 抽取通用逻辑（T3 reviewer 备注 defer 到 T6）。
 *
 * 边界：
 *   - 仅处理可枚举 type 字段（spec §6 累积映射表）；自由文本/用户数据/LLM 内容不查表
 *   - missing key 检测与 stop-reason.ts / llm-error-category.ts 一致（含「【资源」前缀或返回 key 本身）
 */
import type { TFunction } from 'i18next';

/** 缺 key 兜底标记前缀（与 i18n/index.ts parseMissingKeyHandler 一致，用于检测查表 miss） */
export const MISSING_KEY_PREFIX = '【资源';

/**
 * i18next 查表 miss 检测（共享：code-key + llm-error-category 一致范式）。
 * 三种 miss 信号：返空 / 含 parseMissingKeyHandler 兜底标记 / i18next 默认返 key 本身。
 */
export function isMissingLookup(looked: string, key: string): boolean {
  return !looked || looked.includes(MISSING_KEY_PREFIX) || looked === key;
}

/**
 * snake_case / kebab-case → camelCase（如 no_tool_call → noToolCall、skipped_busy → skippedBusy）。
 * 纯 string 操作（split + capitalize），不引第三方 lib；空字符串兜底返回空。
 *
 * 与 stop-reason.ts::camelCaseStopReason / llm-error-category.ts::camelCaseCategory 行为等价，
 * 但兼容 snake_case + kebab-case 两种分隔符（type code 后端混用两种风格）。
 *
 * @example camelCaseCode('no_tool_call')     // → 'noToolCall'
 * @example camelCaseCode('skipped_busy')     // → 'skippedBusy'
 * @example camelCaseCode('interrupted')      // → 'interrupted'（单词原样返回）
 */
export function camelCaseCode(code: string): string {
  if (!code) return '';
  return code
    .split(/[_-]/)
    .map((part, i) => {
      const lower = part.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

/**
 * 派生本地化 type code 文案：i18n 查 `<keyPrefix>.<camelCaseCode>` locale 表。
 * 查不到（含 parseMissingKeyHandler 兜底标记 / i18next 默认返 key 本身）→ 返回空串
 * （defensive 兜底，由 caller 决定如何处理；理论上不应发生，ns bundle 已落全 leaf）。
 *
 * @param code 后端原始 code 字面（snake/kebab，如 'no_tool_call' / 'skipped_busy'）
 * @param t i18next t 函数（caller 已 useTranslation(<ns>) 绑定 ns）
 * @param keyPrefix 该 type code 在 ns 内的 dot.notation 前缀（如 'run.stopReason' / 'taskStatus'）
 * @returns 本地化文案（locale 表查到）或空串（查不到，defensive）
 *
 * @example localizedCode('no_tool_call', t, 'run.stopReason')   // → '已完成'（zh-CN）
 * @example localizedCode('in_progress', t, 'taskStatus')        // → '进行中'（zh-CN）
 * @example localizedCode('skipped_busy', t, 'autoWorkResult')   // → '忙'（zh-CN）
 */
export function localizedCode(code: string, t: TFunction, keyPrefix: string): string {
  if (!code || !keyPrefix) return '';
  const key = `${keyPrefix}.${camelCaseCode(code)}`;
  const looked = t(key);
  // 查表 miss 检测：parseMissingKeyHandler 输出含「【资源」前缀，或 i18next 默认返 key 本身
  return isMissingLookup(looked, key) ? '' : looked;
}
