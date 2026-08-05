/**
 * XML format/validate 纯函数 —— `fast-xml-parser` ^4.x
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B XML 行；§0.2 库选型
 *   specs/prd/version_logs/v0.0.241.md §3.2 XML
 *
 * 实际 API（已 probe 确认 fast-xml-parser 4.5.7）：
 *   - **format** 用 `XMLParser` + `XMLBuilder`：parse 是「宽容」解析（`<unclosed>` 当自闭合），
 *     build 输出 pretty XML。format 接受略微不规范的输入以尽量产出（用户要「格式化」而非「校验」）。
 *   - **validate** 用 `XMLValidator.validate()`：严格校验 well-formedness，返回 `true` 或
 *     `{err:{code,msg,line,col}}`。这是对 change_plan 的偏离（计划用 XMLParser 做校验），
 *     偏离理由 = XMLParser 宽容解析无法识别未闭合/错配标签，validate 失去意义；
 *     XMLValidator 专为校验设计，返回结构化 line/col，更符合用户「校验」预期（UC 反馈）。
 *
 * 已 probe 验证：build 后中文 `文本` 保留不转义。
 */
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import type { FormatResult } from '../file-format';

const PARSER_OPTS = { ignoreAttributes: false };
const BUILDER_OPTS = { format: true, indentBy: '  ', ignoreAttributes: false };

/** XML 格式化：parse（宽容） → build（2 空格缩进、保留属性）。 */
export function formatXml(text: string): FormatResult {
  try {
    const parser = new XMLParser(PARSER_OPTS);
    const obj = parser.parse(text);
    const builder = new XMLBuilder(BUILDER_OPTS);
    const output = builder.build(obj);
    return { ok: true, output };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** XML 校验：用 XMLValidator 严格校验（识别未闭合/错配标签，返回 line/col）。 */
export function validateXml(text: string): FormatResult {
  const result = XMLValidator.validate(text, {
    allowBooleanAttributes: false,
  });
  if (result === true) {
    return { ok: true, output: text };
  }
  // result 是 { err: { code, msg, line, col } }
  const err = (result as { err: { msg: string; line?: number; col?: number } }).err;
  return {
    ok: false,
    error: err.msg,
    line: typeof err.line === 'number' ? err.line : undefined,
    col: typeof err.col === 'number' ? err.col : undefined,
  };
}
