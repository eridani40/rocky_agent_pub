/**
 * resolve-i18n-field —— manifest 等产品代码静态字段的 i18n 占位符 helper
 * 参考: specs/tech/i18n/[P1]manifest_i18n.md（M5 占位符协议 + helper 契约）
 *       specs/tech/i18n/[P0]i18n_overview.md §3（KKV 协议基础）
 *
 * 设计意图：
 *   - builtin plugin.json manifest 的 label/description/extImpls[].description/schemaConfig.<key>.description
 *     是产品代码静态声明（与组件里写 `t('chat.sendButton')` 同质），用 `__MSG_<dotted.key>__` 占位符声明。
 *   - helper 识别 `__MSG_<key>__` 模式 → 提取 key 走 t() 查 locale 表；非占位符字面 → 原样直展（兼容
 *     第三方 plugin / 未改造字段 / 老 plugin 字面原文）。
 *
 * 边界（[P1] §3 + §4.3）：
 *   - 仅处理产品代码静态字段（manifest description 等）；不处理运行时动态数据（用户数据/LLM 输出）
 *   - missing key 不 fallback 原文（占位符声明 = 产品代码承诺翻译，缺翻译是 bug，必须暴露）
 *     → t() 内部走 [P0] §3 规则 (2)→(3)→(4)：查到返回 locale 文案；当前 lng 缺→兜底链→全缺→
 *       「【资源 <key> 不存在】」报错（parseMissingKeyHandler）
 */
import type { TFunction } from 'i18next';

/** __MSG_<key>__ 占位符识别正则（capture group = 完整 dotted key，[P1] §3.1） */
const MSG_PLACEHOLDER_RE = /^__MSG_(.+)__$/;

/**
 * 解析 manifest 等产品代码静态字段的 i18n 占位符（[P1] §4.2）。
 *
 * 顺序判定：
 *   1. value 匹配 `^__MSG_(.+)__$` → 提取 capturedKey，返回 `t(capturedKey)`
 *      - t() 内部走 [P0] §3 规则 (2)→(3)→(4)：查到 → locale 文案；当前 lng 缺 → en → zh-CN；三级全缺 →
 *        「【资源 <key> 不存在】」报错（**不 fallback 原文**，[P1] §4.3）
 *   2. 否则 → 直展 value（兼容第三方 plugin 字面原文 / 未改造字段 / 老 plugin，[P1] §4.2 第 2 条）
 *
 * @param value manifest 字段原值（string；占位符 / 字面文案 / undefined 等都兼容）
 * @param t i18next t 函数（caller 决定绑哪个 ns；manifest 跨 ns 时 caller 用 `t(key, { ns: ... })` 或
 *          配置 t 为支持跨 ns 查表的 i18next instance）
 * @returns 本地化文案（占位符 + 查到）/ 报错标记字符串（占位符 + missing key）/ 原值（非占位符直展）
 *
 * @example resolveI18nField('__MSG_plugin.builtin.rocky_context.label__', t)  // → 'Rocky Context'（zh-CN）
 * @example resolveI18nField('第三方 plugin 字面描述', t)                       // → '第三方 plugin 字面描述'（直展）
 * @example resolveI18nField(undefined, t)                                     // → ''（空值兜底）
 */
export function resolveI18nField(value: string | undefined | null, t: TFunction): string {
  // 空值兜底：undefined / null / 空串 → 直展为空（caller 通常基于此判 !render 跳过节点）
  if (value === undefined || value === null || value === '') return '';
  const match = MSG_PLACEHOLDER_RE.exec(value);
  if (match && match[1]) {
    const key = match[1];
    // [P1] §4.3 missing key 不 fallback 原文：t() 内部 parseMissingKeyHandler 会返回「【资源 <key> 不存在】」
    //   占位符声明翻译承诺，缺翻译是 bug 必须暴露，不静默 fallback raw `__MSG_...__` 字面 / 兜底文案
    return t(key);
  }
  // 非占位符 → 直展原值（兼容第三方 / 未改造 / 老 plugin 字面，[P1] §4.2 第 2 条 fallback 路径）
  return value;
}
