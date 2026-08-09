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
 *
 * [v0.0.263] workspace 文件树打开**不再用本函数判定**（handleOpen 改用 isRemoteLinkPath + 本地文件一律进 editor，
 * 见架构决策②）；本函数仍服务 link-target.ts 的 markdown 链接点击分发（12 格式进 viewer / 其它系统打开，v0.0.253 契约）。
 */
export function isBuiltinEditable(path: string): boolean {
  return getFileFormat(path) !== null;
}

/**
 * [v0.0.263] 远程链接判定纯函数：`.url` 快捷方式文件（大小写不敏感，basename 处理同 getFileFormat）。
 * v1 只处理 .url（PRD §6 边界：远程链接类型扩展留后续）。纯函数无 IO——内容嗅探在 openRemoteLink 异步做。
 */
export function isRemoteLinkPath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = basename(lower);
  return name.endsWith('.url');
}

/**
 * [v0.0.269] image 白名单 6 格式（浏览器原生 `<img>` 可渲染，零依赖）。
 * 范围不扩大铁律（PRD §6）：.bmp/.tiff/.ico 等非 6 格式图片不进白名单。
 * 键全部小写（含前导 `.`），与 EXT_TO_FORMAT 同算法。
 */
const IMAGE_EXTS: Readonly<Record<string, true>> = {
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.webp': true,
  '.svg': true,
};

/**
 * [v0.0.269] image 判定纯函数：路径扩展名 ∈ IMAGE_EXTS（大小写不敏感，basename 处理同 getFileFormat）。
 * 供 handleOpen 前置分流：isImagePath → image viewer（只读渲染）。
 */
export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = basename(lower);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false; // 无扩展名（如 Makefile）→ 非 image
  const ext = name.slice(dot);
  return IMAGE_EXTS[ext] === true;
}

/**
 * [v0.0.269] 二进制内容判定纯函数：含 NUL（\u0000）或替换符（\uFFFD）占比 >5% 判二进制。
 * 阈值保守防误判（文本文件罕见含替换符）；任一字符占比 ≤5% 视为文本。
 * 保留作 editor 内防御性检测（不作 handleOpen 主判定——v0.0.269 前置分流已按扩展名挡掉白名单外文件；
 * 仅 text 白名单内真二进制（如 .txt 改名成二进制）时仍提示「无法预览」）。
 */
export function looksBinary(content: string): boolean {
  if (!content) return false;
  let nul = 0;
  let repl = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === 0) nul++;
    else if (c === 0xfffd) repl++;
  }
  const ratio = (nul + repl) / content.length;
  return ratio > 0.05;
}
