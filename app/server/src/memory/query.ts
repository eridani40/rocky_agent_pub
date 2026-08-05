/**
 * memory query —— 单点读源（read 单条正文 + search 全字段定位）
 * 参考: specs/tech/agent/memory/[P0]memory_tool.md §2（read/search 契约）+ §3（search 匹配规则）
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4（统一 MemoryScope + dir store）
 *
 * 单点读源原则（不变量#4）：readMemoryEntry 是全项目**唯一**单条读取实现，
 * 被 `memory` 纯读工具 + `memory_manage.read` 共享——不新造第二份读源，避免两处漂移。
 *
 * scope 语义（'global'/'session'/'group'/undefined，全链统一命名，无 internal/external 映射层）：
 *   - 'global'  → `<dataDir>/memory/`（global 介质根）
 *   - 'session' → `<sessionWsDir>/.rocky/memory/`（session ws 由 caller 从 session.workspaceDir 解析）
 *   - 'group'   → `<groupWsDir>/.rocky/memory/`（squad 共享 ws，resolveGroupWsDir 产出）
 *   - undefined → 跨 scope：**只合并 session + global 两源**；**group 不进跨 scope 兜底**
 *     （防跨 group 读到别组数据，v0.0.164 用户拍板隔离 invariant 延续）
 *
 * 纯读不治理（memory_tool §5）：read/search 不校验 evolvable、不校验长度——那是写侧约束。
 */
import {
  globalMemoryDir,
  wsMemoryDir,
  listEntries,
  readEntry,
  type MemoryEntry,
  type MemoryType,
} from './memory-dir-store';

/** 统一 scope（re-export 单点源 = memory-dir-store；工具/handler/mapper/inject-quota 同值） */
export type { MemoryScope } from './memory-dir-store';
import type { MemoryScope } from './memory-dir-store';

/** query 层返回的 metadata 级条目（不含 body；search 返回，不变量#5） */
export interface MemoryQueryMeta {
  name: string;
  /** 一句话摘要 */
  intro: string;
  type: MemoryType;
  /** 统一 scope（由读取方按目录位置 stamp——位置即 scope） */
  scope: MemoryScope;
  archived: boolean;
  evolvable: boolean;
}

/** query 层返回的单条全文（read 返回，含 body + why + howToApply） */
export interface MemoryQueryEntry extends MemoryQueryMeta {
  body: string;
  why?: string;
  howToApply?: string;
}

/** read/search 共用的读取依赖（caller 从 ctx/config 解析后传入，query 层不碰 ctx） */
export interface MemoryQueryDeps {
  /** app 数据根（绝对路径，global scope 用） */
  dataDir: string;
  /** 调用方 session 的 ws 根（session.workspaceDir；session scope 用，缺省时 session scope 报错/跳过） */
  sessionWsDir?: string;
  /** 调用方 group 的 ws 根（resolveGroupWsDir 产出；group scope 用，缺省时 group scope 报错） */
  groupWsDir?: string;
}

/** readMemoryEntry 入参 */
export interface ReadMemoryEntryOpts extends MemoryQueryDeps {
  /** scope；undefined = 跨 scope（先 session 后 global，不含 group） */
  scope?: MemoryScope;
  name: string;
}

/** searchMemory 入参 */
export interface SearchMemoryOpts extends MemoryQueryDeps {
  /** scope；undefined = 跨 scope（合并 session + global 两源 active 全文） */
  scope?: MemoryScope;
  keyword: string;
}

/** Error.message 是否表示「未命中」（dir store 以 `... not found ...` 抛出） */
function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && /not found/i.test(e.message);
}

/** dir store entry → query 层 entry（按目录位置 stamp scope） */
function stampScope(e: MemoryEntry, scope: MemoryScope): MemoryQueryEntry {
  return { ...e, scope };
}

/** 读 global scope 单条 */
function readGlobalEntry(dataDir: string, name: string): MemoryQueryEntry {
  return stampScope(readEntry(globalMemoryDir(dataDir), name), 'global');
}

/** 读 session scope 单条（缺 sessionWsDir → 抛错） */
function readSessionEntry(deps: MemoryQueryDeps, name: string): MemoryQueryEntry {
  const ws = String(deps.sessionWsDir ?? '').trim();
  if (!ws) throw new Error('session memory requires session workspace (sessionWsDir not resolved)');
  return stampScope(readEntry(wsMemoryDir(ws), name), 'session');
}

/** 读 group scope 单条（缺 groupWsDir → 抛错） */
function readGroupEntry(deps: MemoryQueryDeps, name: string): MemoryQueryEntry {
  const ws = String(deps.groupWsDir ?? '').trim();
  if (!ws) throw new Error('group memory requires group workspace (caller not in a squad)');
  return stampScope(readEntry(wsMemoryDir(ws), name), 'group');
}

/**
 * 读单条完整正文（唯一读源，不变量#4）。
 * - scope='global'/'session'/'group' → 对应介质
 * - scope=undefined → 先 session（有 sessionWsDir 时）后 global；**不含 group 兜底**（隔离 invariant）
 *
 * 未命中统一抛 Error（message 含 `not found`），caller 边界映射为 not_found 错误码。
 */
export function readMemoryEntry(opts: ReadMemoryEntryOpts): MemoryQueryEntry {
  const { scope, dataDir } = opts;
  const name = String(opts.name ?? '').trim();
  if (!name) throw new Error('memory entry name is required');

  if (scope === 'global') return readGlobalEntry(dataDir, name);
  if (scope === 'session') return readSessionEntry(opts, name);
  if (scope === 'group') return readGroupEntry(opts, name);

  // 跨 scope：先 session 后 global；不含 group 兜底（隔离 invariant）
  if (String(opts.sessionWsDir ?? '').trim()) {
    try {
      return readSessionEntry(opts, name);
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
  }
  try {
    return readGlobalEntry(dataDir, name);
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
  }
  throw new Error(`memory entry not found: ${name}`);
}

/** keyword 大小写不敏感子串匹配 name/intro/type/body/why/howToApply（任一命中即入选） */
function matchesKeyword(e: MemoryQueryEntry, kw: string): boolean {
  const fields = [e.name, e.intro, e.type, e.body, e.why ?? '', e.howToApply ?? ''];
  return fields.some((f) => f.toLowerCase().includes(kw));
}

/** 丢弃正文 → 轻量 meta（不变量#5：search 不返 body） */
function toMeta(e: MemoryQueryEntry): MemoryQueryMeta {
  return {
    name: e.name,
    intro: e.intro,
    type: e.type,
    scope: e.scope,
    archived: e.archived,
    evolvable: e.evolvable,
  };
}

/** 取某 scope active 全文（listEntries 默认仅 active，供 search 匹配 body） */
function collectEntries(dir: string, scope: MemoryScope): MemoryQueryEntry[] {
  return listEntries(dir).map((e) => stampScope(e, scope));
}

/**
 * 按 keyword 全字段子串匹配 active 记忆 → 返回轻量索引（不含 body，不变量#5；无排序）。
 * - scope='global'/'session'/'group' → 对应介质（缺依赖抛错）
 * - scope=undefined → **只合并 session + global 两源**；**不含 group 兜底**（隔离 invariant）
 */
export function searchMemory(opts: SearchMemoryOpts): MemoryQueryMeta[] {
  const { scope, dataDir } = opts;
  const kw = String(opts.keyword ?? '').trim().toLowerCase();
  if (!kw) throw new Error('keyword is required');

  const pool: MemoryQueryEntry[] = [];
  if (scope === 'global') {
    pool.push(...collectEntries(globalMemoryDir(dataDir), 'global'));
  } else if (scope === 'session') {
    const ws = String(opts.sessionWsDir ?? '').trim();
    if (!ws) throw new Error('session memory requires session workspace (sessionWsDir not resolved)');
    pool.push(...collectEntries(wsMemoryDir(ws), 'session'));
  } else if (scope === 'group') {
    const ws = String(opts.groupWsDir ?? '').trim();
    if (!ws) throw new Error('group memory requires group workspace (caller not in a squad)');
    pool.push(...collectEntries(wsMemoryDir(ws), 'group'));
  } else {
    // 跨 scope：只合并 session + global（不含 group，防跨组污染）
    const ws = String(opts.sessionWsDir ?? '').trim();
    if (ws) pool.push(...collectEntries(wsMemoryDir(ws), 'session'));
    pool.push(...collectEntries(globalMemoryDir(dataDir), 'global'));
  }

  return pool.filter((e) => matchesKeyword(e, kw)).map(toMeta);
}
