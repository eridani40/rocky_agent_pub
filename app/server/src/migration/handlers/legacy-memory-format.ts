/**
 * legacy-memory-format — 旧版「多 entry 单文件」memory 格式的 frozen parser（冻结不再演进）
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A3
 *       app/server/src/memory/managed-store.ts（v0.0.205 删除，本文件是其格式的冻结拷贝）
 *
 * 职责：
 *   - 解析/序列化旧格式（一个 md 文件顺序堆叠多条 entry：`---\n<yaml>\n---\n<body>` 重复）
 *   - 供两类 consumer 使用：
 *     ① 旧 handler（memory-source-updated / memory-intro，versionRange <0.0.151）——只改 import 保编译
 *     ② 新 handler（session-memory-per-entry / squad-rocky-dir）——把旧单文件拆成 per-entry md
 *
 * 自包含约束（MUST）：不 import memory/*（旧 store 已删，本文件是格式的唯一存活拷贝）。
 * 冻结约束（MUST NOT）：不再随 memory 格式演进而修改；新格式 = memory-dir-store per-entry md。
 */
import { join } from 'node:path';
import matter from 'gray-matter';

/** 旧格式内部 scope 标记（仅 in-memory stamp；frontmatter 从不落 scope 字段） */
export type LegacyMemoryScope = 'session' | 'squad';
export type LegacyMemoryType = 'user' | 'feedback' | 'project' | 'reference';
const VALID_TYPES: readonly LegacyMemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** 旧格式 entry（与 v0.0.204 managed-store MemoryEntry 同构，冻结） */
export interface LegacyMemoryEntry {
  name: string;
  /** 一句话摘要（兼容读存量 description） */
  intro: string;
  type: LegacyMemoryType;
  scope: LegacyMemoryScope;
  archived: boolean;
  /** 存量缺省 true */
  evolvable: boolean;
  /** 存量缺省 'agent' */
  source: 'user' | 'agent';
  /** 存量缺省 '' */
  updatedAt: string;
  body: string;
  why?: string;
  howToApply?: string;
}

/** 旧 per-session session_memory.md 路径：`<dataDir>/sessions/<sid>/session_memory.md` */
export function legacySessionMemoryFilePath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sessions', sessionId, 'session_memory.md');
}

function assertType(t: unknown): LegacyMemoryType {
  if (!VALID_TYPES.includes(t as LegacyMemoryType)) {
    throw new Error(`invalid memory type: ${String(t)} (expected one of ${VALID_TYPES.join('|')})`);
  }
  return t as LegacyMemoryType;
}

/**
 * 多 entry 文件切分：按行扫描 frontmatter 块（`---` 分隔）。
 * 每条 entry 形态：`---\n<yaml>\n---\n<body>`，多 entry 顺序拼接。
 * body 内禁止出现单独成行的 `---`（会被识别为下条 entry 起始）。
 */
export function splitEntries(raw: string): Array<{ fm: string; body: string }> {
  const out: Array<{ fm: string; body: string }> = [];
  const lines = raw.split('\n');
  const at = (i: number): string => lines[i] ?? '';
  let i = 0;
  while (i < lines.length && at(i).trim() === '') i++;
  while (i < lines.length) {
    if (at(i).trim() !== '---') break;
    i++;
    const fmLines: string[] = [];
    while (i < lines.length && at(i).trim() !== '---') {
      fmLines.push(at(i));
      i++;
    }
    if (i >= lines.length) break;
    i++;
    const bodyLines: string[] = [];
    while (i < lines.length && at(i).trim() !== '---') {
      bodyLines.push(at(i));
      i++;
    }
    const body = bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    out.push({ fm: fmLines.join('\n'), body });
    while (i < lines.length && at(i).trim() === '') i++;
  }
  return out;
}

/**
 * 读 frontmatter updatedAt：容忍 YAML 类型胁迫（js-yaml 把未引号 ISO 串解析为 Date 对象
 * → 统一转回 ISO string；缺失/非法 → ''）。
 */
function readUpdatedAt(d: Record<string, unknown>): string {
  const v = d.updatedAt;
  if (typeof v === 'string') return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return '';
}

/** 从单 entry 的 frontmatter 字符串解析字段（gray-matter 包一层复用 YAML 解析） */
export function parseEntry(fm: string, body: string, scope: LegacyMemoryScope = 'session'): LegacyMemoryEntry | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(`---\n${fm}\n---\n${body}`);
  } catch {
    return null;
  }
  const d = parsed.data || {};
  const name = String(d.name ?? '').trim();
  if (!name) return null;
  // 兼容读：字段名为 intro，存量 frontmatter 可能仍为 description
  const intro = String(d.intro ?? d.description ?? '').trim();
  const rawType = (d.metadata && typeof d.metadata === 'object' ? (d.metadata as { type?: unknown }).type : d.type);
  let type: LegacyMemoryType;
  try {
    type = assertType(rawType);
  } catch {
    return null;
  }
  const entry: LegacyMemoryEntry = {
    name,
    intro,
    type,
    scope,
    archived: Boolean(d.archived),
    evolvable: typeof d.evolvable === 'boolean' ? d.evolvable : true,
    source: d.source === 'user' ? 'user' : 'agent',
    updatedAt: readUpdatedAt(d),
    body: String(parsed.content ?? '').trim(),
  };
  if (typeof d.why === 'string' && d.why.trim()) entry.why = d.why.trim();
  if (typeof d.howToApply === 'string' && d.howToApply.trim()) entry.howToApply = d.howToApply.trim();
  return entry;
}

/** 整文件解析 → entries（空文件 → []）。 */
export function parseMemoryFile(raw: string, scope: LegacyMemoryScope = 'session'): LegacyMemoryEntry[] {
  if (!raw || !raw.trim()) return [];
  return splitEntries(raw)
    .map((c) => parseEntry(c.fm, c.body, scope))
    .filter((e): e is LegacyMemoryEntry => e !== null);
}

/** 序列化单 entry → `---\n<yaml>\n---\n<body>` 文本（旧格式，写侧恒显式 evolvable/source/updatedAt） */
function serializeEntry(e: LegacyMemoryEntry): string {
  const fm: Record<string, unknown> = { name: e.name, intro: e.intro, metadata: { type: e.type } };
  fm.evolvable = e.evolvable;
  fm.source = e.source;
  fm.updatedAt = e.updatedAt;
  if (e.archived) fm.archived = true;
  if (e.why) fm.why = e.why;
  if (e.howToApply) fm.howToApply = e.howToApply;
  return `${matter.stringify('', fm).trim()}\n${e.body}\n`;
}

/** 整文件序列化：entries 顺序拼接（空 → 空串） */
export function serializeMemoryFile(entries: LegacyMemoryEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map(serializeEntry).join('\n');
}
