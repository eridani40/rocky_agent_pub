/**
 * Mention Search Service —— 从 sessionId 解析 workspaceDir + 构造 SearchCtx
 * 参考: specs/tech/mention/search-api.md §2（SearchCtx 构造逻辑）
 *       specs/api/mention/GET-search.md §5（workspaceDir 解析规则）
 *
 * 设计：
 *   - handler 层调用 searchMentions(deps, params) 完成全流程。
 *   - workspaceDir 解析：playground/studio 各 sessionType 在 session 创建时已设置正确的
 *     workspaceDir（squad-service / member-service 负责），本 service 直接用 session.workspaceDir。
 *   - subagent 特殊：从 parentSessionId 取 parent session 的 workspaceDir。
 *   - 不直接依赖 SquadStore/MemberStore（session record 已含所需字段）。
 */
import type { SessionStore } from '../agent/session-store';
import type { MentionProviderRegistry } from './registry';
import type { SearchCtx, SearchResult } from './types';
import type { BizType } from '@app/shared';
import { resolveMentionProviders } from '@app/shared';

/**
 * search service 依赖注入（handler 层从 BootstrapResult 构造）。
 * sessionStore 查 session record；mentionRegistry 路由到 provider 执行搜索。
 */
export interface SearchMentionsDeps {
  sessionStore: SessionStore;
  mentionRegistry: MentionProviderRegistry;
}

/**
 * search service 入参（handler 解析 query string 后传入）。
 * provider / query / sessionId 必填；limit 可选（默认 20）；cursor 可选。
 */
export interface SearchMentionsParams {
  provider: string;
  query: string;
  sessionId: string;
  limit: number;
  cursor?: string;
}

/** session 不存在时抛出的 404 错误 */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super('session not found');
    this.name = 'SessionNotFoundError';
  }
}

/** provider 未注册时抛出的 404 错误 */
export class ProviderNotFoundError extends Error {
  constructor(providerName: string) {
    super(`unknown provider: ${providerName}`);
    this.name = 'ProviderNotFoundError';
  }
}

/**
 * 执行 mention 搜索（全流程编排）。
 * 1. 从 sessionId 查 session record（不存在 → SessionNotFoundError）
 * 2. 解析 workspaceDir（subagent 走 parent；其余用 session.workspaceDir）
 * 3. resolver 校验 provider ∈ 允许集合（不在 → ProviderNotFoundError → 404）
 * 4. 检查 provider 是否注册（未注册 → ProviderNotFoundError）
 * 5. 组装 SearchCtx 并调 mentionRegistry.search 执行搜索
 *
 * @param deps 依赖注入
 * @param params 搜索参数
 * @returns 搜索结果（items + nextCursor）
 * @throws SessionNotFoundError | ProviderNotFoundError | Error（provider 内部异常）
 */
export async function searchMentions(
  deps: SearchMentionsDeps,
  params: SearchMentionsParams,
): Promise<SearchResult> {
  const { sessionStore, mentionRegistry } = deps;
  const { provider, query, sessionId, limit, cursor } = params;

  // 1. 查 session record
  const session = await sessionStore.getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

  // 2. 解析 workspaceDir
  const workspaceDir = await resolveWorkspaceDir(sessionStore, session);

  // 3. resolver 校验：provider 必须 ∈ resolveMentionProviders({biz,role,derivation})。
  //    不在允许集合 → ProviderNotFoundError（→ 404，不泄露 provider 存在性，resolver.md §5.2）。
  //    校验先于 registry.get：未授权 provider 即使注册了也拒绝（防御 + spec 一致）。
  const allowed = resolveMentionProviders({
    biz: (session.biz ?? 'playground') as BizType,
    role: session.role ?? 'rocky',
    derivation: session.derivation ?? 'parent',
  });
  if (!allowed.includes(provider as never)) {
    throw new ProviderNotFoundError(provider);
  }

  // 4. 检查 provider 是否注册（提前报错，避免 registry.search 内部抛出不一致的 Error 消息）
  if (!mentionRegistry.get(provider)) {
    throw new ProviderNotFoundError(provider);
  }

  // 5. 组装 SearchCtx 并执行搜索
  const ctx: SearchCtx = {
    query,
    limit,
    cursor,
    bizType: (session.biz ?? 'playground') as BizType,
    biz: session.biz ?? 'playground',
    role: session.role ?? 'rocky',
    derivation: session.derivation ?? 'parent',
    sessionId,
    workspaceDir,
    memberId: session.memberId,
    squadId: session.squadId,
    parentSessionId: session.parentSessionId,
  };

  return mentionRegistry.search(provider, ctx);
}

/**
 * 解析 workspaceDir（按 sessionType 分流）。
 * - subagent → 取 parentSessionId 对应 session 的 workspaceDir
 * - 其余 → 直接用 session.workspaceDir（创建时由 squad-service / member-service 设置）
 *
 * 参考: specs/api/mention/GET-search.md §5 workspaceDir 解析规则表
 */
async function resolveWorkspaceDir(
  sessionStore: SessionStore,
  session: { derivation?: string; workspaceDir: string; parentSessionId?: string },
): Promise<string> {
  // subagent 判定：derivation 是权威源
  const isSubagent = session.derivation === 'subagent';
  if (isSubagent && session.parentSessionId) {
    const parent = await sessionStore.getSession(session.parentSessionId);
    if (parent) {
      return parent.workspaceDir;
    }
    // parent 不存在 → fallback 到自身 workspaceDir（防御性兜底）
  }
  return session.workspaceDir;
}
