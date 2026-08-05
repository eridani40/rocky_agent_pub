/**
 * skill-file-view — 版本 skill 浏览的视图派生纯函数（渲染分类 + 两级树）
 * 参考: specs/ui/components/academy-page/component-skill-browser-modal.md
 *       specs/api/overall/18-academy.md §1.8（文件树）/ §1.11.1（binary 由后端标记）
 *
 * skill 目录内可放任意附属文件（skill_definition §2），右侧面板据扩展名决定渲染方式：
 *   markdown → PrimitiveMarkdownView；text → mono <pre>；unknown → 「不可预览」。
 * 二进制判定不在此处——由后端 `binary` 标记决定（本模块只看路径，不读内容）。
 * 左侧两级树（skill 目录 → 目录内文件）派生也在此，保持组件文件只管渲染。
 *
 * markdown 分支渲染前还要剥离 YAML frontmatter（`stripMarkdownFrontmatter`）：frontmatter 是元信息
 * 而非正文，后端 `skills/resolver.ts parseSkillDir` 已用 gray-matter 把它解析成 name/description
 * 结构化字段，前端只需别把它当段落渲染。text/unknown 分支原样保留全部字符（含 `---`）。
 */
import { buildFileTree, type SkillFileTreeNode } from '../common/file-tree';
import type { SkillSummary } from '../../lib/academy-api';

/** 右侧面板渲染类别 */
export type SkillFileViewKind = 'markdown' | 'text' | 'unknown';

/** markdown 渲染的扩展名 */
const MARKDOWN_EXTS = new Set(['md', 'markdown']);

/** mono <pre> 渲染的扩展名（纯文本 / 代码 / 配置） */
const TEXT_EXTS = new Set([
  'py', 'sh', 'yaml', 'yml', 'json', 'txt', 'ts', 'js', 'toml', 'ini', 'csv',
]);

/**
 * 按扩展名分类 skill 文件的渲染方式。
 *
 * 取最后一个 `.` 之后的片段作扩展名并小写化（故 `A.MD` 与 `a.md` 同类、
 * `notes.v2.md` 取 `md`）；无扩展名（如 `LICENSE`）或未知扩展名 → 'unknown'。
 *
 * @param path 相对 skill 目录的文件路径
 */
export function classifySkillFile(path: string): SkillFileViewKind {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // 无点，或点在首位（如 `.gitignore` 视为无扩展名）→ unknown
  if (dot <= 0) return 'unknown';
  const ext = base.slice(dot + 1).toLowerCase();
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'unknown';
}

/**
 * 剥离 markdown 源文本开头的 YAML frontmatter，返回正文部分（仅 markdown 分支调用）。
 *
 * 语义与后端 gray-matter 对齐：分隔符 `---` **必须在文件最开头**，找到后续第一个单独成行的
 * `---` 作为闭合；闭合行之后的前导空行一并去掉，使正文首个 block（通常是 `# 标题`）顶到最前。
 *
 * 保守规则（宁可不剥离也不吞正文）：
 *   - 首行不是 `---`（如正文以段落/标题开头）→ 原样返回；
 *   - 有起始 `---` 但全文无闭合 `---` → 原样返回（视为普通正文，不当未闭合 frontmatter 吞掉）。
 * 仅正文只有 frontmatter 时返回空串（无正文可渲染）。
 *
 * @param source 文件原文（`.md` / `.markdown`）
 */
export function stripMarkdownFrontmatter(source: string): string {
  // BOM 只在判定时忽略；未命中 frontmatter 时返回的仍是原始 source（含 BOM）
  const text = source.startsWith('\ufeff') ? source.slice(1) : source;
  const lines = text.split('\n');
  // trimEnd 兼容 CRLF（'---\r'）与行尾空格
  if (lines[0]?.trimEnd() !== '---') return source;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() !== '---') continue;
    // 闭合行后的正文；去掉前导空行（含 CRLF 空行）
    return lines.slice(i + 1).join('\n').replace(/^(?:[ \t]*\r?\n)+/, '');
  }
  return source;
}

/** 给子树节点 path 统一加 `<skill>/` 前缀（保证跨 skill 的 path 全局唯一） */
function prefixPaths(nodes: SkillFileTreeNode[], prefix: string): SkillFileTreeNode[] {
  return nodes.map((n) => ({
    ...n,
    path: `${prefix}/${n.path}`,
    children: prefixPaths(n.children, prefix),
  }));
}

/**
 * SkillSummary[] → 两级嵌套树：顶层 = skill 目录，其下 = 目录内文件/子目录。
 * 每个 skill 的子树复用 common 的 buildFileTree（同一套排序/建树逻辑）。
 *
 * @returns 虚拟根（name='' path=''），children = 每个 skill 一个 dir 节点
 */
export function buildSkillsTree(skills: SkillSummary[]): SkillFileTreeNode {
  return {
    name: '',
    path: '',
    type: 'dir',
    children: skills.map((s) => ({
      name: s.name,
      path: s.name,
      type: 'dir' as const,
      children: prefixPaths(buildFileTree(s.files).children, s.name),
    })),
  };
}

/**
 * 树节点 path（`<skill>/<relPath>`）反解为 skill 名 + 相对 skill 目录的 path。
 * 无分隔符（= skill 目录本身）或分隔符在首/末位 → null。
 */
export function splitSkillSelection(sel: string): { skillName: string; path: string } | null {
  const i = sel.indexOf('/');
  if (i <= 0 || i === sel.length - 1) return null;
  return { skillName: sel.slice(0, i), path: sel.slice(i + 1) };
}
