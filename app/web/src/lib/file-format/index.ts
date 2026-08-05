/**
 * format/validate dispatcher —— 按 FileFormat 路由到对应格式的纯函数
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B index.ts 行
 *   specs/prd/version_logs/v0.0.241.md §3.1（FormatResult + 调用方按 category 守门）
 *
 * 调用约定：调用方（modal-md-editor.tsx）按 category 守门——
 *   - 仅 `category === 'structured'` 时调用 formatText/validateText
 *   - md/plain 形态理论上不会被调用，但本 dispatcher 仍兜底返回 unsupported 错误（防御性）
 */
import type { FileFormat, FormatResult } from '../file-format';
import { formatJson, validateJson } from './json';
import { formatJsonl, validateJsonl } from './jsonl';
import { formatYaml, validateYaml } from './yaml';
import { formatXml, validateXml } from './xml';
import { formatToml, validateToml } from './toml';
import { formatCsv, validateCsv } from './csv';
import { formatTsv, validateTsv } from './tsv';

/** 按 format 路由到 format* 纯函数；md/plain 返 unsupported 错误。 */
export function formatText(format: FileFormat, text: string): FormatResult {
  switch (format) {
    case 'json':
      return formatJson(text);
    case 'jsonl':
      return formatJsonl(text);
    case 'yaml':
      return formatYaml(text);
    case 'xml':
      return formatXml(text);
    case 'toml':
      return formatToml(text);
    case 'csv':
      return formatCsv(text);
    case 'tsv':
      return formatTsv(text);
    case 'md':
    case 'txt':
    case 'ini':
    case 'env':
    case 'log':
      return { ok: false, error: '该格式不支持格式化' };
    default: {
      // 闭合 union 兜底（不应命中）
      const _exhaustive: never = format;
      return { ok: false, error: `不支持的格式: ${String(_exhaustive)}` };
    }
  }
}

/** 按 format 路由到 validate* 纯函数；md/plain 返 unsupported 错误。 */
export function validateText(format: FileFormat, text: string): FormatResult {
  switch (format) {
    case 'json':
      return validateJson(text);
    case 'jsonl':
      return validateJsonl(text);
    case 'yaml':
      return validateYaml(text);
    case 'xml':
      return validateXml(text);
    case 'toml':
      return validateToml(text);
    case 'csv':
      return validateCsv(text);
    case 'tsv':
      return validateTsv(text);
    case 'md':
    case 'txt':
    case 'ini':
    case 'env':
    case 'log':
      return { ok: false, error: '该格式不支持校验' };
    default: {
      const _exhaustive: never = format;
      return { ok: false, error: `不支持的格式: ${String(_exhaustive)}` };
    }
  }
}
