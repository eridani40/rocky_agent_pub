/**
 * memory-api —— memory UI HTTP 端点 CRUD 薄封装（v0.0.55 T5）
 * 参考: specs/api/overall/15-memory-ui.md §3-§6（GET/POST/PATCH/DELETE /memory/:scope）
 *       specs/tech/agent/memory/[P0]memory_definition.md §2（v0.0.55 介质分流）
 *
 * 拆出独立文件（而非塞进 api-client.ts）以保持单文件 ≤300 行（api-client 已 764 行）。
 * api-client.ts re-export 保旧 import 路径可用。
 *
 * scope 对外统一命名 `global`/`session`（存储统一为 per-entry dir store）：
 *   - global → `<dataDir>/memory/`（全局一份，**无 sessionId**）
 *   - session→ `<sessionWs>/.rocky/memory/`（**必带 sessionId**）
 *   URL 一律 `/memory/${scope}`。
 *
 * 调用方约束：
 *   - scope=session 时 sessionId 必填（后端 400 兜底，前端调用方负责传）
 *   - 写操作（POST/PATCH）type=feedback|project 强制 why+howToApply（后端 400 兜底）
 */
import { req } from './api-client';

/** memory type 枚举（对齐 memory_definition.md §3） */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** 单条 memory entry（对齐 specs/api/overall/15-memory-ui.md §2） */
export interface MemoryEntry {
  name: string;
  /** 一句话摘要（v0.0.114 由 `description` 改名，避免与 JSON-schema 关键字撞名） */
  intro: string;
  type: MemoryType;
  body: string;
  why?: string;
  howToApply?: string;
  /** [v0.0.112] 是否允许 agent 自动进化（后端 list 恒返回；存量缺省 true）。UI 全字段可编辑 */
  evolvable: boolean;
  archived?: boolean;
  updatedAt?: string;
}

/** 新建/更新 entry 入参（POST/PATCH body.entry） */
export type MemoryWriteInput = {
  name: string;
  /** 一句话摘要（v0.0.114 由 `description` 改名） */
  intro: string;
  type: MemoryType;
  body: string;
  why?: string;
  howToApply?: string;
  /** [v0.0.112] evolvable 开关值（POST 服务端强制 false；PATCH 走 setEvolvable 生效） */
  evolvable?: boolean;
};

/** scope 字面量（[v0.0.112] 对外统一命名） */
export type MemoryScope = 'global' | 'session';

/** sessionId query 拼接辅助（scope=session 必带；user 不带） */
function sidQuery(scope: MemoryScope, sessionId: string | undefined): string {
  if (scope === 'session') {
    if (!sessionId) throw new Error('scope=session 需要 sessionId');
    return `?sessionId=${encodeURIComponent(sessionId)}`;
  }
  return '';
}

/**
 * GET /memory/:scope —— 列 entry。
 * @param scope 'global'|'session'
 * @param opts.sessionId scope=session 必填
 * @param opts.includeArchived 缺省 false（不返归档项）
 */
export async function listMemory(
  scope: MemoryScope,
  opts: { sessionId?: string; includeArchived?: boolean } = {},
  base?: string,
): Promise<MemoryEntry[]> {
  let q = sidQuery(scope, opts.sessionId);
  const extra = opts.includeArchived ? `${q ? '&' : '?'}includeArchived=true` : '';
  const r = await req<{ entries: MemoryEntry[] }>(
    `/memory/${scope}${q}${extra}`,
    undefined,
    base,
  );
  return r.entries ?? [];
}

/**
 * POST /memory/:scope —— 新建 entry（201 created / 409 already exists）。
 */
export async function writeMemory(
  scope: MemoryScope,
  entry: MemoryWriteInput,
  sessionId?: string,
  base?: string,
): Promise<MemoryEntry> {
  const q = sidQuery(scope, sessionId);
  const body = sessionId !== undefined && scope === 'session'
    ? { sessionId, entry }
    : { entry };
  const r = await req<{ entry: MemoryEntry }>(
    `/memory/${scope}${q}`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
  return r.entry;
}

/**
 * PATCH /memory/:scope/:name —— 更新 entry（name 不可改，其余字段都可改）。
 */
export async function patchMemory(
  scope: MemoryScope,
  name: string,
  patch: Partial<Omit<MemoryWriteInput, 'name'>>,
  sessionId?: string,
  base?: string,
): Promise<MemoryEntry> {
  const q = sidQuery(scope, sessionId);
  const r = await req<{ entry: MemoryEntry }>(
    `/memory/${scope}/${encodeURIComponent(name)}${q}`,
    { method: 'PATCH', body: JSON.stringify({ entry: patch }) },
    base,
  );
  return r.entry;
}

/**
 * DELETE /memory/:scope/:name —— 归档 entry（不真删，archived=true，可恢复）。
 */
export async function archiveMemory(
  scope: MemoryScope,
  name: string,
  sessionId?: string,
  base?: string,
): Promise<{ ok: true; archivedAt: string }> {
  const q = sidQuery(scope, sessionId);
  return req(`/memory/${scope}/${encodeURIComponent(name)}${q}`, { method: 'DELETE' }, base);
}
