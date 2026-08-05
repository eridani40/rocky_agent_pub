/**
 * MemoryDirStore — memory per-entry md 目录存储（三介质统一单点实现，读侧 + 共享层）
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §2/§3/§5/§5.1
 *       states/v0.0.205.t2_cons/context.md（存储模型定稿：per-entry + 位置即 scope）
 *
 * 职责：
 *   - 单 entry = 单 md 文件（`<dir>/<name>.md`，frontmatter + body）
 *   - 三介质统一：global=`<dataDir>/memory/`、session/group=`<wsDir>/.rocky/memory/`
 *   - frontmatter parse/serialize（兼容读 intro ?? description；evolvable 缺省 true；
 *     source 缺省 'agent'；updatedAt 缺省 ''）
 *   - 读侧 API：listMetas / listEntries / readEntry（读不持锁）
 *   - 写侧（writeEntry/createEntry/archiveEntry，per-entry 文件锁 + 长度硬限 + evolvable gate）
 *     在 `memory-dir-write.ts`（300 行红线拆分）
 *
 * 位置即 scope（核心约定）：
 *   - entry frontmatter **不落 scope 字段**；本层返回的 entry 也不携带 scope
 *   - scope 由读取方按目录来源自行 stamp（query/工具/handler 各边界知道自己读的哪个介质）
 *
 * per-entry 单文件设计：坏文件只影响单条 entry（list 跳过不抛）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

// —— 类型（全链唯一命名；scope 三层 global|group|session）——

/** 统一 scope（工具 schema / HTTP / UI / mapper / inject-quota 同值，无 internal/external 映射层） */
export type MemoryScope = 'global' | 'group' | 'session';
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
const VALID_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** list 返回的 metadata 级条目（不含 body，控 token；注入 L0 读源） */
export interface MemoryEntryMeta {
  name: string;
  /** 一句话摘要（兼容读存量 description） */
  intro: string;
  type: MemoryType;
  archived: boolean;
  /** 是否允许 agent 进化性写；解析侧存量缺省 true（memory_definition §5.1） */
  evolvable: boolean;
  /** 来源标记：'user'=UI 写 / 'agent'=agent 写；存量缺省 'agent' */
  source: 'user' | 'agent';
  /** 最后更新时间 ISO；存量缺省 ''（排序排末） */
  updatedAt: string;
}
/** read 返回的单条全文 */
export interface MemoryEntry extends MemoryEntryMeta {
  body: string;
  why?: string;
  howToApply?: string;
}
/** write/create 的 entry 入参 */
export interface MemoryWriteInput {
  name: string;
  intro: string;
  type: MemoryType;
  body: string;
  why?: string;
  howToApply?: string;
}

// —— 路径（仅 join 不 mkdir）——

/** global 介质根：`<dataDir>/memory/`（global ws = 数据根本身，资源直接放根不嵌套 .rocky） */
export function globalMemoryDir(dataDir: string): string {
  return join(dataDir, 'memory');
}

/** session/group 介质根：`<wsDir>/.rocky/memory/`（与 `.rocky/skills/` 同构） */
export function wsMemoryDir(wsDir: string): string {
  return join(wsDir, '.rocky', 'memory');
}

/** entry 文件路径：`<dir>/<name>.md`（写侧 memory-dir-write 复用） */
export function entryFilePath(dir: string, name: string): string {
  return join(dir, `${name}.md`);
}

// —— 校验 ——

/** 校验 memory type（写侧 memory-dir-write 复用） */
export function assertType(t: unknown): MemoryType {
  if (!VALID_TYPES.includes(t as MemoryType)) {
    throw new Error(`invalid memory type: ${String(t)} (expected one of ${VALID_TYPES.join('|')})`);
  }
  return t as MemoryType;
}

/**
 * 校验 entry name：非空 + 无空白控制符 + **无路径分隔符**。
 * per-entry 后 name = 文件名，必须拦 `/`、`\`、`.`、`..`（防逃逸 dir）。
 */
export function assertEntryName(n: unknown): string {
  const s = String(n ?? '').trim();
  if (!s) throw new Error('memory entry name is required');
  if (/[\n\r\t]/.test(s)) throw new Error(`memory entry name contains whitespace: ${JSON.stringify(s)}`);
  if (/[\/\\]/.test(s)) throw new Error(`memory entry name contains path separator: ${JSON.stringify(s)}`);
  if (s === '.' || s === '..') throw new Error(`memory entry name must not be path alias: ${JSON.stringify(s)}`);
  return s;
}

/**
 * 读 frontmatter updatedAt：容忍 YAML 类型胁迫（js-yaml 把未引号 ISO 串解析为 Date 对象
 * → 统一转回 ISO string；缺失/非法 → ''）。与 skills/resolver readUpdatedAt 同模式。
 */
function readUpdatedAt(d: Record<string, unknown>): string {
  const v = d.updatedAt;
  if (typeof v === 'string') return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return '';
}

// —— 单 entry 文件 parse / serialize ——

/**
 * 解析单 entry md（frontmatter + body）→ MemoryEntry；坏文件返 null（list 跳过不抛）。
 * 兼容读 `intro ?? description`；evolvable 缺省 true；source 缺省 'agent'；updatedAt 缺省 ''。
 */
export function parseEntryFile(raw: string): MemoryEntry | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const d = parsed.data || {};
  const name = String(d.name ?? '').trim();
  if (!name) return null;
  // 兼容读：字段名为 intro，存量 frontmatter 可能仍为 description
  const intro = String(d.intro ?? d.description ?? '').trim();
  const rawType = (d.metadata && typeof d.metadata === 'object' ? (d.metadata as { type?: unknown }).type : d.type);
  let type: MemoryType;
  try {
    type = assertType(rawType);
  } catch {
    return null;
  }
  const entry: MemoryEntry = {
    name,
    intro,
    type,
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

/**
 * 序列化单 entry → 完整 md 文件文本。
 * 写侧 MUST 恒显式落 evolvable/source/updatedAt（不走存量默认）；MUST NOT 落 scope（位置即 scope）。
 */
export function serializeEntryFile(e: MemoryEntry): string {
  const fm: Record<string, unknown> = { name: e.name, intro: e.intro, metadata: { type: e.type } };
  fm.evolvable = e.evolvable;
  fm.source = e.source;
  fm.updatedAt = e.updatedAt;
  if (e.archived) fm.archived = true;
  if (e.why) fm.why = e.why;
  if (e.howToApply) fm.howToApply = e.howToApply;
  return `${matter.stringify('', fm).trim()}\n${e.body}\n`;
}

// —— 文件 IO（裸读不持锁；写侧 memory-dir-write 持锁 + atomicWrite）——

/** 裸读文件文本（不存在/读失败 → ''；写侧 memory-dir-write 复用） */
export function readRaw(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// —— 公开 API ——

/**
 * listMetas：扫 dir 全部 `*.md` 只取 frontmatter 投影 → MemoryEntryMeta[]（含 archived 标记）。
 * 目录不存在 → `[]`；坏文件跳过不抛。按 name 升序返回（目录遍历顺序不确定，排序保确定性）。
 */
export function listMetas(dir: string): MemoryEntryMeta[] {
  return listEntries(dir, { includeArchived: true }).map((e) => ({
    name: e.name,
    intro: e.intro,
    type: e.type,
    archived: e.archived,
    evolvable: e.evolvable,
    source: e.source,
    updatedAt: e.updatedAt,
  }));
}

/**
 * listEntries：同 listMetas 但含 body。读不持锁。
 * @param opts.includeArchived 默认 false（仅 active）；true 返全部含 archived
 */
export function listEntries(
  dir: string,
  opts: { includeArchived?: boolean } = {},
): MemoryEntry[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const e = parseEntryFile(readRaw(join(dir, n)));
    if (!e) continue; // 坏文件跳过不抛
    if (!opts.includeArchived && e.archived) continue;
    out.push(e);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * readEntry：读单条全文；未命中抛 Error（message 含 `not found`，query.ts isNotFoundError 锚点）。
 * archived 可读（恢复/审计用）。
 */
export function readEntry(dir: string, name: string): MemoryEntry {
  const nm = assertEntryName(name);
  const e = parseEntryFile(readRaw(entryFilePath(dir, nm)));
  if (!e) throw new Error(`memory entry not found: ${nm}`);
  return e;
}
