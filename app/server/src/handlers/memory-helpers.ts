/**
 * memory UI handler 共享 helpers
 * 参考: specs/api/overall/15-memory-ui.md §3-§10（端点契约）
 *       specs/tech/agent/memory/[P0]memory_definition.md §3（entry schema）
 *
 * 集中：JSON response / scope 解析 / sessionId 解析 / 校验工具 / entry coercion / merge。
 * 纯函数无副作用，handlers/memory.ts 与 potential future test 共享。
 *
 * 注：appConfig 由 router.ts 经 bootstrap DI 注入 handleMemoryRoute（非每请求 new）。
 */
import type { MemoryType } from '../memory/memory-dir-store';
import { MemoryCharLimitError, MemoryQuotaExceededError } from '../memory/policy';

/**
 * scope 对外统一命名（不变量#1）：HTTP path `:scope` = `global` | `session`（直通值）。
 * UI 边界本版不暴露 group tab（PRD IN/OUT 边界）。
 * 旧的 `user` 外部值不再接受（前端 memory-api 已切 `global`）。
 */
const VALID_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];
/** type=feedback|project 强制 why + howToApply（spec §2） */
const TYPES_REQUIRE_WHY: readonly MemoryType[] = ['feedback', 'project'];

/** 构造 JSON Response（可选 headers，用于 405 Allow） */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * 字符硬限统一映射：dir store write 层 throw MemoryCharLimitError → HTTP 400
 *（携 field/current/limit，spec 15-memory-ui §4.2/§5；PRD §14.2.4）。非该错误重新抛出。
 */
export function charLimitTo400(e: unknown): Response {
  if (e instanceof MemoryCharLimitError) return json(400, { error: e.message });
  throw e;
}

/**
 * 存储配额溢出统一映射（v0.0.247）：dir store write 层 throw MemoryQuotaExceededError → HTTP 400
 *（携 scope/current/limit/nonEvolvableCount；req.md「溢出行为硬拒绝引导 archive」）。
 * 非该错误重新抛出（与 charLimitTo400 互斥，instanceof 各自识别）。
 */
export function quotaTo400(e: unknown): Response {
  if (e instanceof MemoryQuotaExceededError) return json(400, { error: e.message });
  throw e;
}

/** 当前 ISO8601 时间戳（写入类操作的 updatedAt / archivedAt 标记） */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 校验 path 中的 scope 段（直通 `global`|`session`；其余含旧 `user` 值 → null）。
 * @returns scope 供 handler 分流（global → <dataDir>/memory/ / session → <sessionWs>/.rocky/memory/）
 */
export function parseScope(s: string | undefined): 'global' | 'session' | null {
  return s === 'global' || s === 'session' ? s : null;
}

/**
 * 解析 scope=session 必需的 sessionId：优先 query，回退 body 顶层字段。
 * @returns sessionId 字符串；scope=user 或缺省时为 undefined
 */
export function resolveSessionId(url: URL, body: { sessionId?: unknown } | null): string | undefined {
  const q = url.searchParams.get('sessionId');
  if (q) return q;
  const b = body?.sessionId;
  return typeof b === 'string' && b.trim() ? b.trim() : undefined;
}

/** 校验 type=feedback|project 必须含 why + howToApply（spec §2 强制） */
export function validateWhyHow(
  type: MemoryType,
  why: string | undefined,
  howToApply: string | undefined,
): string | null {
  if (!TYPES_REQUIRE_WHY.includes(type)) return null;
  if (!why || !howToApply) {
    return `entry.type=${type} requires both why and howToApply (spec 15-memory-ui §2)`;
  }
  return null;
}

/**
 * UI entry 收敛/合并的统一形态。
 * [v0.0.112] 透传 `evolvable` + `archived`：evolvable 供 handler 路由到 write 的 `setEvolvable`（PATCH），
 * archived 供 PATCH 反归档（write 落盘恒 archived=false，透传保持 schema 忠实 + 反归档语义可见）。
 */
export interface CoercedEntry {
  name: string;
  /** 一句话摘要（v0.0.114 由 `description` 改名） */
  intro: string;
  type: MemoryType;
  body: string;
  why?: string;
  howToApply?: string;
  evolvable?: boolean;
  archived?: boolean;
}

/** 从弱类型对象收敛 entry 字段；非法 → 抛 Error（caller 转 400） */
export function coerceEntryInput(raw: unknown): CoercedEntry {
  if (!raw || typeof raw !== 'object') throw new Error('entry payload required');
  const e = raw as Record<string, unknown>;
  const name = String(e.name ?? '').trim();
  // 兼容读：新字段 intro，容忍旧 description（v0.0.114 改名）
  const intro = String(e.intro ?? e.description ?? '').trim();
  const body = String(e.body ?? '');
  if (!name) throw new Error('entry.name required');
  if (!intro) throw new Error('entry.intro required');
  if (!body) throw new Error('entry.body required');
  if (!VALID_TYPES.includes(e.type as MemoryType)) {
    throw new Error(`entry.type invalid: ${String(e.type)}`);
  }
  const type = e.type as MemoryType;
  return {
    name,
    intro,
    type,
    body,
    why: typeof e.why === 'string' && e.why.trim() ? e.why.trim() : undefined,
    howToApply: typeof e.howToApply === 'string' && e.howToApply.trim() ? e.howToApply.trim() : undefined,
    ...(typeof e.evolvable === 'boolean' ? { evolvable: e.evolvable } : {}),
    ...(typeof e.archived === 'boolean' ? { archived: e.archived } : {}),
  };
}

/**
 * 合并 partial 到 existing（name 不可改；type 合法时覆盖）。
 * [v0.0.112] evolvable/archived 透传：partial 携带则覆盖，否则保留既有（省略=保留原值）。
 */
export function mergeEntry(existing: CoercedEntry, partial: Record<string, unknown>): CoercedEntry {
  const typeRaw = partial.type;
  const mergedType = VALID_TYPES.includes(typeRaw as MemoryType) ? (typeRaw as MemoryType) : existing.type;
  const evolvable = typeof partial.evolvable === 'boolean' ? partial.evolvable : existing.evolvable;
  const archived = typeof partial.archived === 'boolean' ? partial.archived : existing.archived;
  // 兼容读 partial：优先 intro，容忍旧 description（v0.0.114 改名）
  const introRaw = typeof partial.intro === 'string' ? partial.intro
    : typeof partial.description === 'string' ? partial.description
      : undefined;
  return {
    name: existing.name,
    intro: typeof introRaw === 'string' ? introRaw.trim() : existing.intro,
    type: mergedType,
    body: typeof partial.body === 'string' ? partial.body : existing.body,
    why: typeof partial.why === 'string' ? partial.why.trim() || undefined : existing.why,
    howToApply: typeof partial.howToApply === 'string' ? partial.howToApply.trim() || undefined : existing.howToApply,
    ...(typeof evolvable === 'boolean' ? { evolvable } : {}),
    ...(typeof archived === 'boolean' ? { archived } : {}),
  };
}
