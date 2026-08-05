/**
 * squad-api —— Studio 管理 UI 的 squad/member HTTP 客户端
 * 参考: specs/api/overall/11a-squad-endpoints.md（§1 Squad / §2 Member）
 *       specs/api/overall/11-squad.md §4.1（GET /session?biz 过滤）
 *
 * 复用 api-base.resolveApiBase（与 chat-api/api-client 同 fetch 风格）；仅暴露 Studio 用到的端点子集。
 * 错误时抛 Error（调用方 catch 显示）。所有响应 shape 对齐 11a 契约。
 */
import { resolveApiBase } from './api-base';
import type { Session } from '../components/chat-page/types';
import type {
  CreateSquadBody,
  HireMemberBody,
  Member,
  PatchMemberBody,
  PatchSquadBody,
  SquadDetail,
  SquadSummary,
  BudgetUsage,
  SchedulerHistoryEntry,
} from '../components/studio-page/squad-types';
import type { TokenUsageQueryResult } from '../components/studio-page/component-token-stats-types';

/** 统一 fetch 封装（与 chat-api 同风格：拼 URL + 错误转异常 + 透传 status） */
export async function req<T>(path: string, init?: RequestInit, base?: string): Promise<T> {
  const res = await fetch(`${resolveApiBase(base)}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

// —— Squad CRUD（11a §1）——

/** GET /squad —— squad 列表（按 updatedAt desc，11a §1.2） */
export async function listSquads(base?: string): Promise<SquadSummary[]> {
  const r = await req<{ items: SquadSummary[] }>('/squad', undefined, base);
  return r.items ?? [];
}

/** GET /squad/:id —— squad 详情（含 members，11a §1.3） */
export async function getSquad(id: string, base?: string): Promise<SquadDetail> {
  return req<SquadDetail>(`/squad/${encodeURIComponent(id)}`, undefined, base);
}

/** POST /squad —— 建 squad（事务，201 + SquadDetail，11a §1.1） */
export async function createSquad(body: CreateSquadBody, base?: string): Promise<SquadDetail> {
  return req<SquadDetail>('/squad', { method: 'POST', body: JSON.stringify(body) }, base);
}

/** PATCH /squad/:id —— 改 squad 元信息（200 + SquadDetail，11a §1.4） */
export async function patchSquad(id: string, body: PatchSquadBody, base?: string): Promise<SquadDetail> {
  return req<SquadDetail>(
    `/squad/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    base,
  );
}

/** DELETE /squad/:id —— team 硬删除（解散，200 + { deleted:true }，11a §1.5，v0.0.111 块②） */
export async function deleteSquad(id: string, base?: string): Promise<void> {
  await req<{ deleted: boolean }>(
    `/squad/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    base,
  );
}

// —— Member 管理（11a §2）——

/** POST /squad/:id/member —— hire（fresh/derive，201 + { member, sessionId }，11a §2.1） */
export async function hireMember(
  squadId: string,
  body: HireMemberBody,
  base?: string,
): Promise<{ member: Member; sessionId: string }> {
  return req<{ member: Member; sessionId: string }>(
    `/squad/${encodeURIComponent(squadId)}/member`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

// —— derive_academy 继承预检（11a §2.5，v0.0.233）——

/** derive_academy 预检请求体（与 hire body academySource 同结构） */
export interface PreviewRequest {
  classroomId: string;
  studentId: string;
  versionId: string;
}

/** 预检清单项（skill / memory 顶层 entry） */
export interface PreviewItem {
  name: string;
  /** true = squad 团队盘已有同名（用户裁决：默认 skip 保留 / 可选 overwrite 覆盖） */
  sameNameConflict: boolean;
}

/** POST /squad/:id/member/derive-academy/preview 响应（11a §2.5，纯只读无副作用） */
export interface PreviewResult {
  /** 学生 AGENTS.md 是否存在（个人差异文件无同名概念，仅标「将带入」） */
  agentsMd: { exists: boolean };
  skills: PreviewItem[];
  memory: PreviewItem[];
}

/**
 * POST /squad/:id/member/derive-academy/preview —— derive_academy 派生前预检（v0.0.233）。
 * 读学生版本源 + squad 团队盘目标，返「将带入」清单 + 同名标记，供前端预览面板渲染。
 * 纯只读无副作用；squad 不存在 → 404；三字段缺/version 非 formal+active/classroom 不存在 → 400。
 */
export async function previewDeriveAcademy(
  squadId: string,
  body: PreviewRequest,
  base?: string,
): Promise<PreviewResult> {
  return req<PreviewResult>(
    `/squad/${encodeURIComponent(squadId)}/member/derive-academy/preview`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/** PATCH /squad/:id/member/:mid —— edit（200 + { member }，11a §2.2） */
export async function patchMember(
  squadId: string,
  memberId: string,
  body: PatchMemberBody,
  base?: string,
): Promise<{ member: Member }> {
  return req<{ member: Member }>(
    `/squad/${encodeURIComponent(squadId)}/member/${encodeURIComponent(memberId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    base,
  );
}

/** POST /squad/:id/member/:mid/deploy —— 恢复 deployed（200 + { member }，11a §2.3，幂等） */
export async function deployMember(
  squadId: string,
  memberId: string,
  base?: string,
): Promise<{ member: Member }> {
  return req<{ member: Member }>(
    `/squad/${encodeURIComponent(squadId)}/member/${encodeURIComponent(memberId)}/deploy`,
    { method: 'POST', body: '{}' },
    base,
  );
}

/** POST /squad/:id/member/:mid/bench —— 下岗（leader 返 403，200 + { member }，11a §2.4） */
export async function benchMember(
  squadId: string,
  memberId: string,
  reason: string,
  base?: string,
): Promise<{ member: Member }> {
  return req<{ member: Member }>(
    `/squad/${encodeURIComponent(squadId)}/member/${encodeURIComponent(memberId)}/bench`,
    { method: 'POST', body: JSON.stringify({ reason }) },
    base,
  );
}

// —— v0.0.33.4 自主性 infra（budget usage / scheduler history；heartbeat 改走 PATCH /squad）——

/**
 * GET /squad/:id/budget/usage —— 当前 daily 窗口消耗（200 + BudgetUsage，v0.0.33.4 §4）。
 * budget=null → limit=-1/remaining=-1（consumed 仍算）；reactive+proactive 都计入 consumed。
 */
export async function getBudgetUsage(squadId: string, base?: string): Promise<BudgetUsage> {
  return req<BudgetUsage>(`/squad/${encodeURIComponent(squadId)}/budget/usage`, undefined, base);
}

// —— token 用量统计（11c-token-stats.md §3）——

/**
 * GET /squad/:id/token-stats —— squad token 用量时序数据（200 + TokenUsageQueryResult，11c §3）。
 * 可选 query：from/to（YYYY-MM-DD）/ scope（'team' 或 memberId）/ granularity（'day'|'hour'）
 *              / providerId+modelId（可选 model 筛选，必须同时提供）。
 * 503（sqlite 未就绪）由调用方 catch 降级。
 */
export async function fetchTokenStats(
  squadId: string,
  opts: {
    from?: string;
    to?: string;
    scope?: string;
    granularity?: 'day' | 'hour';
    providerId?: string;
    modelId?: string;
  } = {},
  base?: string,
): Promise<TokenUsageQueryResult> {
  const params = new URLSearchParams();
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.scope) params.set('scope', opts.scope);
  if (opts.granularity) params.set('granularity', opts.granularity);
  if (opts.providerId && opts.modelId) {
    params.set('providerId', opts.providerId);
    params.set('modelId', opts.modelId);
  }
  const qs = params.toString();
  return req<TokenUsageQueryResult>(
    `/squad/${encodeURIComponent(squadId)}/token-stats${qs ? '?' + qs : ''}`,
    undefined,
    base,
  );
}

/**
 * GET /squad/:id/scheduler/history —— 自动工作历史（200 + { items }，v0.0.33.4 §5）。
 * 时间倒序。limit 缺省 50（max 200），roleId 可选过滤。
 */
export async function getSchedulerHistory(
  squadId: string,
  opts: { limit?: number; roleId?: string } = {},
  base?: string,
): Promise<SchedulerHistoryEntry[]> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.roleId) params.set('roleId', opts.roleId);
  const qs = params.toString();
  const r = await req<{ items: SchedulerHistoryEntry[] }>(
    `/squad/${encodeURIComponent(squadId)}/scheduler/history${qs ? '?' + qs : ''}`,
    undefined,
    base,
  );
  return r.items ?? [];
}

// —— Studio session 列表（11-squad.md §4.1：biz=studio 过滤）——

/**
 * GET /session?biz=studio —— Studio 侧 session 列表（squad 树展开用）。
 * 缺省 biz=playground（保 Playground 列表干净），Studio 显式传 studio。
 */
export async function listStudioSessions(base?: string): Promise<Session[]> {
  const r = await req<{ items: Session[] }>('/session?biz=studio', undefined, base);
  return r.items ?? [];
}
