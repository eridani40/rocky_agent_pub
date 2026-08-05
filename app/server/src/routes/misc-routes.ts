/**
 * misc-routes — 杂项路由组（health / counter / bootstrap-status / sse / provider /
 *   skill / mention / memory / history / consolidation / workspace seed / test-only）
 *
 * 纯 move 自 router.ts（v0.0.156 结构性拆分）。路由顺序 + 前缀匹配逻辑 100% copy-paste。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.8 + INV-R-1 + INV-R-2
 *
 * 分发块（按顺序）：
 *   1. /health / /counter / /counter/inc / /bootstrap/status
 *   2. /api/workspace/* ET seed 端点（test-only gate：非 test → 404）
 *   3. /test/consolidation（test-only gate）
 *   4. /sse /sse/subscribe /sse/unsubscribe /sse/subscriber/*
 *   5. /provider /provider/:id/model[/:modelId]
 *   6. /skill/*
 *   7. /mention/*
 *   8. /memory/*
 *   9. /history/search
 *   10. /consolidation/status
 *
 * 未命中返 null，主分发继续尝试下一个路由组。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env（仅读 NODE_ENV 做 test gate，
 *   test gate 保留原行为 = packaged 时 NODE_ENV !== 'test' 返 404）；不拼接相对路径。
 */
import { incrementCounter, readCounter, type CounterState } from '../counter';
import type { BootstrapResult } from '../bootstrap';
import { json, sessionDeps, buildConsolidationTestDeps, buildConsolidationRunDeps, HEALTH_PATH } from './router-helpers';
import {
  handleWorkspaceEnsureDir,
  handleWorkspaceTouch,
  handleWorkspaceEnsure,
} from '../handlers/session-workspace-seed';
import {
  handleTestConsolidationRun,
} from '../handlers/test-consolidation-run';
import { handleSseStream, handleSseSubscribeOps } from '../handlers/sse';
import {
  handleProviderCollection, handleProviderItem,
  handleModelCollection, handleModelItem,
} from '../handlers/provider';
import { handleSkillRoute } from '../handlers/skill';
import { handleSkillMarketRoute } from '../handlers/skill-market';
import { handleMentionRoute, type MentionHandlerDeps } from '../handlers/mention';
import { handleMemoryRoute } from '../handlers/memory';
import { handleHistorySearch } from '../handlers/history-search';
import { handleConsolidationStatus } from '../handlers/consolidation-status';
import { handleConsolidationRun } from '../handlers/consolidation-run';
import { handleBootstrapStatus } from '../handlers/bootstrap-status';

/**
 * 杂项路由组分发。命中返 Response；未命中返 null（主分发继续下个 group）。
 *
 * @param req      原始 Request
 * @param url      URL（query 参数透传）
 * @param method   HTTP method（大写）
 * @param path     pathname
 * @param bs       bootstrap 实例
 * @param dataDir  绝对路径
 */
export async function dispatchMiscRoutes(
  req: Request,
  url: URL,
  method: string,
  path: string,
  bs: BootstrapResult,
  dataDir: string,
): Promise<Response | null> {
  // /health
  if (path === HEALTH_PATH && method === 'GET') {
    return json(200, { ok: true });
  }

  // /counter 系列（v0.0.1 保留）
  if (path === '/counter') {
    if (method !== 'GET') {
      return json(405, { error: 'Method Not Allowed' }, { allow: 'GET' });
    }
    const state: CounterState = readCounter(dataDir);
    return json(200, state);
  }
  if (path === '/counter/inc') {
    if (method !== 'POST') {
      return json(405, { error: 'Method Not Allowed' }, { allow: 'POST' });
    }
    const state: CounterState = incrementCounter(dataDir);
    return json(200, state);
  }

  // [v0.0.150] GET /bootstrap/status（migrationErrors 前后端通道）
  if (path === '/bootstrap/status') {
    if (method !== 'GET') {
      return json(405, { error: 'Method Not Allowed' }, { allow: 'GET' });
    }
    return handleBootstrapStatus(bs, dataDir);
  }

  // [v0.0.17] /api/workspace/* ET seed 端点（test-only gate：非 test → 404）
  if (path.startsWith('/api/workspace/')) {
    if (process.env.NODE_ENV !== 'test') return json(404, { error: 'Not Found' });
    const sub = path.slice('/api/workspace/'.length);
    const sd = sessionDeps(bs, dataDir);
    if (sub === 'ensure-dir') return handleWorkspaceEnsureDir(req, method, sd);
    if (sub === 'touch') return handleWorkspaceTouch(req, method, sd);
    if (sub === 'ensure') return handleWorkspaceEnsure(req, method, sd);
    return json(404, { error: 'Not Found' });
  }

  // /test/consolidation — test-only 同步触发端点
  if (path.startsWith('/test/consolidation')) {
    if (process.env.NODE_ENV !== 'test') return json(404, { error: 'Not Found' });
    if (path === '/test/consolidation/run') {
      const consolidationDeps = buildConsolidationTestDeps(bs, dataDir);
      if (!consolidationDeps) {
        return json(503, { error: 'consolidation adapter not available' });
      }
      return handleTestConsolidationRun(req, method, consolidationDeps);
    }
    return json(404, { error: 'Not Found' });
  }

  // /sse 系列（v0.0.8 新增）
  if (path === '/sse') {
    if (method !== 'GET') {
      return json(405, { error: 'Method Not Allowed' }, { allow: 'GET' });
    }
    return handleSseStream(bs.sseChannel);
  }
  if (path === '/sse/subscribe' || path === '/sse/unsubscribe' || path.startsWith('/sse/subscriber/')) {
    return handleSseSubscribeOps(req, method, path, bs.sseChannel);
  }

  // /provider / /provider/:id / /provider/:id/model / /provider/:id/model/:modelId
  if (path === '/provider') {
    return handleProviderCollection(req, method, bs.appConfig, bs.pluginManager);
  }
  const providerMatch = path.match(/^\/provider\/([^/]+)(\/model)?(\/([^/]+))?$/);
  if (providerMatch) {
    const id = providerMatch[1]!;
    const isModelRoute = providerMatch[2] === '/model';
    const modelId = providerMatch[4];
    if (!isModelRoute) {
      return handleProviderItem(req, method, id, bs.appConfig, bs.pluginManager);
    }
    if (modelId === undefined) {
      return handleModelCollection(req, method, id, bs.appConfig);
    }
    return handleModelItem(req, method, id, modelId, bs.appConfig);
  }

  // [v0.0.166] /skills/market/* 路由组（复数，skill 市场 search/detail/install/capabilities）
  // MUST 放在 /skill/* 单数分支前：`/skills/`(复数) ≠ `/skill/`(单数)，两者互不 startsWith，无冲突。
  if (path === '/skills/market' || path.startsWith('/skills/market/')) {
    return handleSkillMarketRoute(req, method, path, url, bs.appConfig, bs.pluginManager, dataDir);
  }

  // [v0.0.21] /skill/* 路由组（sessionStore 支持 ?sessionId= 派生 workspace/groupDir）
  if (path === '/skill' || path === '/skill/install' || path.startsWith('/skill/')) {
    return handleSkillRoute(req, method, path, url, bs.appConfig, dataDir, bs.store);
  }

  // [v0.0.45] /mention/* 路由组
  if (path === '/mention/search' || path.startsWith('/mention/')) {
    const md: MentionHandlerDeps = {
      sessionStore: bs.store,
      mentionRegistry: bs.mentionRegistry,
    };
    return handleMentionRoute(req, method, path, url, md);
  }

  // [v0.0.55] /memory/* 路由组（UI 专用 memory CRUD；sessionStore 解析 session ws）
  // [v0.0.247] 透传 bs.appConfig 给 POST 新建路径做存储配额检查（createEntry → writeLocked）
  if (path === '/memory' || path.startsWith('/memory/')) {
    return handleMemoryRoute(req, method, path, url, bs.store, bs.appConfig);
  }

  // [v0.0.126] GET /history/search —— 历史检索端点（与 history_search tool 同源）
  if (method === 'GET' && path === '/history/search') {
    // searchEngine 装配失败（search.sqlite 损坏 / FTS5 不可用）→ 503 SERVICE_UNAVAILABLE
    if (!bs.searchEngine) {
      return json(503, { code: 'SERVICE_UNAVAILABLE', message: 'history search engine not initialized' });
    }
    return handleHistorySearch(url, bs.searchEngine);
  }

  // GET /consolidation/status —— 天级二级整理任务只读状态端点
  if (method === 'GET' && path === '/consolidation/status') {
    if (!bs.consolidationAdapter) {
      return json(503, { error: 'consolidation adapter not available' });
    }
    // [v0.0.205.t2_cons] 补 appTaskLock 实参（响应加 status/startedAt 内存实时态）
    return handleConsolidationStatus(bs.consolidationAdapter, bs.appTaskLock);
  }

  // [v0.0.164] POST /consolidation/run —— 手动触发二级整理（生产端点，与 test-only /test/consolidation/run 分离）。
  //   acquire 成功 → 202 + fire-and-forget spawn；acquire 失败 → 409。
  //   consolidationAdapter/appTaskLock 缺任一 → 503（buildConsolidationRunDeps 内部判定）。
  if (path === '/consolidation/run') {
    const runDeps = buildConsolidationRunDeps(bs, dataDir);
    if (!runDeps) {
      return json(503, { error: 'consolidation adapter not available' });
    }
    return handleConsolidationRun(req, method, runDeps);
  }

  return null;
}
