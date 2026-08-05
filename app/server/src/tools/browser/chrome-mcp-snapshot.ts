/**
 * Chrome MCP snapshot 解析。
 * 参考: refs/openclaw/extensions/browser/src/browser/chrome-mcp.snapshot.ts
 *       refs/openclaw/extensions/browser/src/browser/snapshot-roles.ts
 *       node_modules/chrome-devtools-mcp/build/src/formatters/SnapshotFormatter.js
 *
 * take_snapshot 响应的 structuredContent.snapshot 是 a11y 节点树（toJSON 输出），
 * 节点形态：{ id, role, name, children?, ...其他属性 }。**节点的 `id` 字段即 uid**
 * （形如 "1_0"），click/fill 的 uid 参数 = 此 id。
 *
 * 本模块把该树遍历为 rocky 的 SnapshotResult { snapshot: 缩进文本树, refs: Record<uid, RefInfo> }，
 * ref = uid（对齐 openclaw shouldCreateRef：INTERACTIVE_ROLES 全建 ref，
 * CONTENT_ROLES 有 name 时建 ref）。
 */
import type { SnapshotResult, RefInfo } from './types';

/** chrome-devtools-mcp take_snapshot 返回的结构化节点（最小字段集） */
export interface ChromeMcpSnapshotNode {
  /** 节点 uid（click/fill 用此定位；形如 "1_0"） */
  id?: string;
  /** aria role（button/textbox/...） */
  role?: string;
  /** accessible name */
  name?: string;
  /** 子节点 */
  children?: ChromeMcpSnapshotNode[];
  /** 其他 a11y 属性（value/description/...），透传不强制 */
  [key: string]: unknown;
}

/** 用户可交互的 role（always 建 ref）。参 openclaw INTERACTIVE_ROLES */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/** 承载内容的 role（有 name 时建 ref）。参 openclaw CONTENT_ROLES */
const CONTENT_ROLES = new Set([
  'article',
  'cell',
  'columnheader',
  'gridcell',
  'heading',
  'listitem',
  'main',
  'navigation',
  'region',
  'rowheader',
]);

/** 结构性 role（compact 模式下无 name 时跳过，减少噪音）。参 openclaw STRUCTURAL_ROLES */
const STRUCTURAL_ROLES = new Set([
  'application',
  'directory',
  'document',
  'generic',
  'grid',
  'group',
  'ignored',
  'list',
  'menu',
  'menubar',
  'none',
  'presentation',
  'row',
  'rowgroup',
  'table',
  'tablist',
  'toolbar',
  'tree',
  'treegrid',
]);

/** 规范化 role（小写；缺失→generic） */
function normalizeRole(role?: string): string {
  if (typeof role !== 'string') return 'generic';
  const r = role.toLowerCase();
  return r || 'generic';
}

/** 规范化 name（非空字符串或 undefined） */
function normalizeName(name?: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const n = name.trim();
  return n.length > 0 ? n : undefined;
}

/** 转义 name 中的引号和反斜杠（文本树用双引号包裹） */
function escapeQuoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** 判断节点是否应建 ref（INTERACTIVE 全建；CONTENT 有 name 建） */
function shouldCreateRef(role: string, name?: string): boolean {
  return INTERACTIVE_ROLES.has(role) || (CONTENT_ROLES.has(role) && Boolean(name));
}

/** 判断节点是否应在文本树中输出（结构性 role 无 name 时跳过降噪音） */
function shouldIncludeNode(role: string, name?: string): boolean {
  if (STRUCTURAL_ROLES.has(role) && !name) return false;
  return true;
}

/** 同 role+name 出现多次时的 nth 跟踪（第几次，从 0 起；首次不记 nth） */
interface DuplicateTracker {
  counts: Map<string, number>;
  keysByUid: Map<string, string>;
  duplicates: Set<string>;
}

function createDuplicateTracker(): DuplicateTracker {
  return { counts: new Map(), keysByUid: new Map(), duplicates: new Set() };
}

/** 注册一个 ref；返回 nth（重复时第几个，从 1 起；首次返回 undefined） */
function registerRef(
  t: DuplicateTracker,
  uid: string,
  role: string,
  name?: string,
): number | undefined {
  const key = `${role}:${name ?? ''}`;
  const count = t.counts.get(key) ?? 0;
  t.counts.set(key, count + 1);
  t.keysByUid.set(uid, key);
  if (count > 0) {
    t.duplicates.add(key);
    return count;
  }
  return undefined;
}

/**
 * 解析 chrome-devtools-mcp take_snapshot 的结构化响应为 rocky SnapshotResult。
 *
 * @param raw take_snapshot 返回的 structuredContent（期望形如 { snapshot: <a11y 树根节点> }，
 *            或直接是 a11y 树根节点）。形态脆弱，函数内防御性校验。
 * @returns {snapshot: 缩进文本树, refs: uid→RefInfo}；输入异常时返回空 snapshot + 空 refs
 *          （不抛，让上层决定如何处理空快照）。
 */
export function parseChromeMcpSnapshot(raw: unknown): SnapshotResult {
  const root = extractRootNode(raw);
  if (!root) return { snapshot: '', refs: {} };

  const refs: Record<string, RefInfo> = {};
  const tracker = createDuplicateTracker();
  const lines: string[] = [];

  const visit = (node: ChromeMcpSnapshotNode, depth: number): void => {
    const role = normalizeRole(node.role);
    const name = normalizeName(node.name);
    if (!shouldIncludeNode(role, name)) {
      // 仍递归子节点（结构性容器自身不输出，但子节点可能要输出）
      for (const child of node.children ?? []) visit(child, depth);
      return;
    }

    let line = `${'  '.repeat(depth)}- ${role}`;
    if (name) line += ` "${escapeQuoted(name)}"`;

    const uid = typeof node.id === 'string' ? node.id : undefined;
    if (uid && shouldCreateRef(role, name)) {
      // rocky RefInfo.nth 是 required number：首次出现记 0，重复时递增（对齐 rocky 协议）。
      // openclaw 用 optional nth，rocky types.ts 定义为 required，此处按 rocky 协议给默认 0。
      const nth = registerRef(tracker, uid, role, name) ?? 0;
      refs[uid] = { role, name: name ?? '', nth };
      line += ` [ref=${uid}]`;
    }
    lines.push(line);

    for (const child of node.children ?? []) visit(child, depth + 1);
  };

  visit(root, 0);

  return { snapshot: lines.join('\n'), refs };
}

/** 从 take_snapshot 响应中提取 a11y 树根节点（兼容多种包裹形态） */
function extractRootNode(raw: unknown): ChromeMcpSnapshotNode | null {
  if (!raw || typeof raw !== 'object') return null;
  // 形态 1：structuredContent.snapshot = <根节点>
  const sc = raw as { snapshot?: unknown };
  if (sc.snapshot && typeof sc.snapshot === 'object') {
    return sc.snapshot as ChromeMcpSnapshotNode;
  }
  // 形态 2：直接是根节点（含 role/children 之一）
  const maybe = raw as ChromeMcpSnapshotNode;
  if (typeof maybe.role === 'string' || Array.isArray(maybe.children)) {
    return maybe;
  }
  return null;
}
