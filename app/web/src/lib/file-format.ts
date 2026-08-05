/**
 * 文件格式分类常量 —— 内置 viewer/editor 的格式识别与分类
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 A（分类常量闭合）
 *   specs/prd/version_logs/v0.0.241.md §2.1（11 格式 + md 分类表）
 *
 * 设计背景：v0.0.227 仅识别 `.md`，本版本扩到 11 种格式 + md（共 12 FileFormat 形态）。
 * 分类（FileFormatCategory）决定 modal 行为：
 *   - md         → PrimitiveMarkdownView 渲染（v0.0.227 既有链路）
 *   - structured → <pre> 渲染 + edit 模式显示「格式化」「校验」按钮（json/jsonl/yaml/xml/toml/csv/tsv）
 *   - plain      → <pre> 渲染、无格式按钮（txt/ini/env/log）
 *
 * 不含编程语言后缀（.py/.js/.java 等）—— PRD §6 用户铁律：编程语言不做。
 */

/** 文件格式枚举（12 形态 = 11 新格式 + md 向后兼容） */
export type FileFormat =
  | 'md'
  | 'json'
  | 'jsonl'
  | 'yaml'
  | 'xml'
  | 'toml'
  | 'csv'
  | 'tsv'
  | 'txt'
  | 'ini'
  | 'env'
  | 'log';

/** 格式分类（决定 modal view 分流 + edit 按钮显隐） */
export type FileFormatCategory = 'md' | 'structured' | 'plain';

/**
 * format/validate 纯函数统一返回形。
 * 成功：`{ ok: true, output }`（output 为格式化后文本 / validate 时为原文本不变）
 * 失败：`{ ok: false, error, line?, col? }`（line/col 可选：CSV/JSONL 行号必有；JSON/YAML 等尽力提取）
 */
export type FormatResult =
  | { ok: true; output: string }
  | { ok: false; error: string; line?: number; col?: number };

/**
 * 扩展名 → FileFormat 映射表。键全部小写（含前导 `.`）。
 * 注意：`.env` 不在此表（特殊处理：basename 整体匹配，见 `getFileFormat`）。
 */
const EXT_TO_FORMAT: Readonly<Record<string, FileFormat>> = {
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.toml': 'toml',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.txt': 'txt',
  '.ini': 'ini',
  '.log': 'log',
  '.md': 'md',
};

/**
 * 取路径的 basename（最后一段）。兼容 `/` 与 `\`。
 * 用 lastIndexOf 而非 split 避免 Windows 路径多次分割开销。
 */
function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * 从 workspace 路径识别文件格式。
 *
 * 算法：
 *   1. 大小写归一化（`.JSON`/`.Json` 命中 `.json`）
 *   2. 取 basename
 *   3. basename === '.env' 或以 '.env.' 开头（`.env.local`/`.env.production`）→ 'env'
 *   4. 否则取最后一个 `.` 起的子串（含 `.`）作为扩展名查表
 *      —— 用 lastIndexOf 防多扩展名误判（`.user.config.json` → `.json`）
 *   5. 未命中返 null（unsupported，走系统打开）
 *
 * @param path 相对 workspaceDir 的文件路径
 * @returns FileFormat 或 null（编程语言后缀 .py/.js/.java 等不在表里 → null）
 */
export function getFileFormat(path: string): FileFormat | null {
  const lower = path.toLowerCase();
  const name = basename(lower);

  // .env / .env.local / .env.production 等 → env
  if (name === '.env' || name.startsWith('.env.')) {
    return 'env';
  }

  const dot = name.lastIndexOf('.');
  if (dot < 0) return null; // 无扩展名（如 Makefile）→ unsupported
  const ext = name.slice(dot);
  return EXT_TO_FORMAT[ext] ?? null;
}

/**
 * 格式 → 分类映射（决定 modal 行为）。
 * switch 闭合覆盖全部 12 FileFormat case，default 兜底 'plain'（防御性，理论上不会命中）。
 */
export function getCategory(format: FileFormat): FileFormatCategory {
  switch (format) {
    case 'md':
      return 'md';
    case 'json':
    case 'jsonl':
    case 'yaml':
    case 'xml':
    case 'toml':
    case 'csv':
    case 'tsv':
      return 'structured';
    case 'txt':
    case 'ini':
    case 'env':
    case 'log':
      return 'plain';
    default:
      // 防御性兜底：FileFormat 闭合 union 不会走到这里
      return 'plain';
  }
}

/**
 * 便利函数：是否走内置 editor（命中 11 格式或 md → true；unsupported → false 走系统打开）。
 * 直接复用 getFileFormat 判定，不重复实现（DRY）。
 */
export function isBuiltinEditable(path: string): boolean {
  return getFileFormat(path) !== null;
}
