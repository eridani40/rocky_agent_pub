/**
 * Mention Search HTTP Handler —— GET /mention/search
 * 参考: specs/api/mention/GET-search.md（端点契约——本文件是 API 实现）
 *       specs/tech/mention/search-api.md（service 设计）
 *
 * 职责：
 *   - 解析 + 校验 query 参数（provider / query / sessionId / limit / cursor）
 *   - 调 searchMentions service 完成搜索
 *   - 错误映射：SessionNotFoundError → 404；ProviderNotFoundError → 404；其他 → 500
 *
 * 不含业务逻辑（workspaceDir 解析 + provider 路由均在 service 层）。
 */
import type { SessionStore } from '../agent/session-store';
import type { MentionProviderRegistry } from '../mention/registry';
import {
  searchMentions,
  SessionNotFoundError,
  ProviderNotFoundError,
  type SearchMentionsDeps,
} from '../mention/search-service';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** handler 依赖注入（router 从 BootstrapResult 构造） */
export interface MentionHandlerDeps {
  sessionStore: SessionStore;
  mentionRegistry: MentionProviderRegistry;
}

/** limit 默认值 + 范围 */
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/**
 * GET /mention/search handler（端点入口）。
 *
 * query 参数：
 *   - provider（必填，string）
 *   - query（必填，string，允许空串）
 *   - sessionId（必填，string）
 *   - limit（可选，number，默认 20，范围 1-100）
 *   - cursor（可选，string）
 *
 * @returns JSON Response（200 / 400 / 404 / 500）
 */
export async function handleMentionSearch(
  url: URL,
  deps: MentionHandlerDeps,
): Promise<Response> {
  try {
    // 1. 解析 + 校验必填参数
    const provider = url.searchParams.get('provider');
    const query = url.searchParams.get('query');
    const sessionId = url.searchParams.get('sessionId');

    if (!provider) {
      return json(400, { error: 'missing required parameter: provider' });
    }
    if (query === null) {
      return json(400, { error: 'missing required parameter: query' });
    }
    if (!sessionId) {
      return json(400, { error: 'missing required parameter: sessionId' });
    }

    // 2. 解析 limit（可选，默认 20，范围校验）
    const limitRaw = url.searchParams.get('limit');
    let limit = DEFAULT_LIMIT;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (!Number.isFinite(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
        return json(400, { error: 'limit must be between 1 and 100' });
      }
      limit = Math.floor(parsed);
    }

    // 3. 解析 cursor（可选）
    const cursor = url.searchParams.get('cursor') ?? undefined;

    // 4. 调 service
    const searchDeps: SearchMentionsDeps = {
      sessionStore: deps.sessionStore,
      mentionRegistry: deps.mentionRegistry,
    };
    const result = await searchMentions(searchDeps, {
      provider,
      query,
      sessionId,
      limit,
      cursor,
    });

    // 5. 返回 200 + SearchResult
    return json(200, {
      items: result.items,
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    });
  } catch (e) {
    // 错误映射（按 service 层抛出的类型分流）
    if (e instanceof SessionNotFoundError) {
      return json(404, { error: e.message });
    }
    if (e instanceof ProviderNotFoundError) {
      return json(404, { error: e.message });
    }
    // provider 内部异常 → 500
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: `internal search error: ${msg}` });
  }
}

/**
 * mention 路由分发（统一入口，便于 router 注册 + 未来扩展端点）。
 * 当前仅 GET /mention/search。
 */
export async function handleMentionRoute(
  req: Request,
  method: string,
  path: string,
  url: URL,
  deps: MentionHandlerDeps,
): Promise<Response> {
  if (path === '/mention/search') {
    if (method !== 'GET') {
      return json(405, { error: 'Method Not Allowed' });
    }
    return handleMentionSearch(url, deps);
  }
  return json(404, { error: 'Not Found' });
}
