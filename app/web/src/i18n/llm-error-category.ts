/**
 * llm-error-category —— LlmErrorCategory i18n 辅助（camelCase 转换 + localizedDisplayReason 查表回退）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §7（type vs dynamic 判定）+ §8（displayReason 契约）
 *
 * 设计：
 *   - camelCaseCategory：纯 string 操作（SCREAMING_SNAKE_CASE → camelCase）
 *   - localizedDisplayReason：优先 i18n 查 `error.llm.<camelCase>` locale 表（查到 → 本地化文案），
 *     查不到（含 parseMissingKeyHandler 兜底标记 / 返回 key 本身）→ 回退 displayReason 字段（零 breakage）
 *
 * 边界：本 helper 只处理可枚举 type 字段 errorCategory；不做 LLM 内容 / 用户数据 / error_message i18n。
 *
 * [T6 块 A] SCREAMING_SNAKE→camel 走通用 helper camelCaseCode（snake/kebab/SCREAMING_SNAKE
 * 统一处理）。本文件保留 displayReason 回退语义（与 stop-reason 的「查不到返空串」不同）。
 *
 * 注：不引 server 端 LlmErrorCategory enum（前端不依赖 app/server），用 string 类型对齐。
 */
import type { TFunction } from 'i18next';
import { camelCaseCode, isMissingLookup } from './code-key';

/** LlmErrorCategory 枚举值类型（SCREAMING_SNAKE_CASE 字符串；对齐 server src/llm/caller/error_types.ts 但不引 server 代码）。 */
export type LlmErrorCategory = string;

/**
 * SCREAMING_SNAKE_CASE → camelCase（如 AUTH_INVALID → authInvalid）。
 * [T6 块 A] 薄包装通用 helper camelCaseCode（行为不变，向后兼容；camelCaseCode 用 /[_-]/
 * 切分，对 SCREAMING_SNAKE_CASE 同样适用——split('_') 后 lowercase 首段 + capitalize 后续）。
 *
 * @example camelCaseCategory('AUTH_INVALID') // → 'authInvalid'
 * @example camelCaseCategory('RATE_LIMITED') // → 'rateLimited'
 */
export function camelCaseCategory(category: LlmErrorCategory): string {
  return camelCaseCode(category);
}

/**
 * 派生本地化 displayReason：优先 i18n 查 `error.llm.<camelCase>` locale 表（t 来自 useTranslation('error')），
 * 查不到（含 parseMissingKeyHandler 兜底标记 / i18next 默认返 key）→ 回退 displayReason 字段（零 breakage）。
 *
 * @param errorCategory LlmErrorCategory 枚举值（如 'AUTH_INVALID'）
 * @param displayReason 后端兜底文案（zh-CN，作 locale 表查不到时的回退源）
 * @param t i18next t 函数（useTranslation('error') 取；ns 已绑 'error'，故 key 用 'llm.<leaf>'）
 * @returns 本地化文案（locale 表查到）或 displayReason 字段（查不到回退）
 */
export function localizedDisplayReason(
  errorCategory: LlmErrorCategory,
  displayReason: string,
  t: TFunction,
): string {
  const key = `llm.${camelCaseCategory(errorCategory)}`;
  const looked = t(key);
  // 查表 miss 检测：parseMissingKeyHandler 输出含「【资源」前缀，或 i18next 默认行为返回 key 本身
  return isMissingLookup(looked, key) ? displayReason : looked;
}
