/**
 * session handlers — /session CRUD + /session/:id/summary（只读）
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §2 §3（GET summary）
 *       specs/tech/version_logs/v0.0.8/change_log.md §6
 *       states/v0.0.46.connector_opt/design.md §5（DELETE 兜底 disconnect）
 *
 * 职责（CRUD + summary；messages 分页/发送在 session-messages.ts；
 *      SessionHandlerDeps + 请求体 + provider/model 校验在 session-deps.ts）：
 *   - Session CRUD：POST/GET 列 / GET:id / DELETE:id（级联，兜底 connectorManager.disconnect）
 *   - summary 只读：GET /session/:id/summary → {summary: SummaryInfo|null}
 *
 * 不直接持有依赖：经 SessionHandlerDeps 注入 SessionStore / AgentManager / AppConfigService /
 * PluginManager / ConnectorManager（bootstrap 装配，router 透传）。
 *
 * SessionHandlerDeps + 请求体类型 + 校验 helper 由 session-deps.ts 权威定义；
 * 本文件 re-export 保持外部导入路径（`from './session'`）稳定。
 */
import { ulid } from '../config/ulid';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCallerWorkspaceDir } from './session-workspace-seed';
import type { Session } from '../agent/session-store-types';
import type { BizType } from '@app/shared';
import type { ContextEngine } from '../agent/context-engine';
import type { SessionWorkspaceManager } from '../agent/session-workspace-manager';
import type { OpenKind, OpenResult } from '../platform/workspace-open';
import type { PickResult } from '../platform/workspace-dialog';
import {
  type SessionHandlerDeps,
  type CreateSessionBody,
  type UpdateSessionBody,
  listEnabledProviders,
  findProvider,
  validateProviderModel,
  validateEffortApproval,
  validatePinned,
} from './session-deps';
// 保留字 / 规范化 helper（modelId 校验统一权威）
import {
  isReservedModelId,
  normalizeReservedModelId,
} from '../services/model-validation';

// re-export：外部（router / handlers / tests）从 './session' 导入这些符号仍然兼容
export type { SessionHandlerDeps, CreateSessionBody, UpdateSessionBody } from './session-deps';
export {
  listEnabledProviders,
  findProvider,
  validateProviderModel,
  validateEffortApproval,
  resolveErrorRunResult,
} from './session-deps';

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

// ============================================================
// Session CRUD
// ============================================================

/** 处理 /session（无 id）：POST 创 / GET 列 */
export async function handleSessionCollection(
  req: Request,
  method: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method === 'GET') {
    // biz 过滤（11-squad.md §4.1 + 18-academy.md §4.1）：
    //   缺省 playground（保 Playground 列表干净，不含 squad/academy session）；
    //   ?biz=studio 仅返 studio；?biz=playground 同缺省；?biz=academy 仅返 academy。
    // 向后兼容旧 ?bizType= 参数；?biz= 优先。
    // 无 biz 字段的历史 session 视为 playground（session_biztype.md §1 lazy 默认）。
    const url = new URL(req.url);
    const bizParam = url.searchParams.get('biz') ?? url.searchParams.get('bizType');
    let bizFilter: BizType | undefined;
    if (bizParam === 'studio') bizFilter = 'studio';
    else if (bizParam === 'academy') bizFilter = 'academy';
    else bizFilter = 'playground'; // 缺省 / playground / 非法值 都按 playground
    const items: Session[] = await deps.store.listSessions({ biz: bizFilter });
    return json(200, { items });
  }
  if (method === 'POST') {
    // body 可选（specs/api §2.1 CreateSessionBody?）。无 body / 空 body 视作 {}
    // 读取方式：取 text，空字符串 → 空 body；非空则 JSON.parse（非法 → 400）
    let body: CreateSessionBody = {};
    let rawText = '';
    try {
      rawText = await req.text();
    } catch {
      // 无 body（部分 runtime 读空 body 抛错）→ 视作空 {}
      rawText = '';
    }
    if (rawText.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return json(400, { error: 'invalid json body' });
      }
      if (parsed !== null && typeof parsed === 'object') {
        body = parsed as CreateSessionBody;
      }
    }
    // 校验 providerId 命中（提供时）。空串视同未提供（前端「默认模型」发 providerId:''，
    // 走 resolveModel fallback，非无效 provider）——与 session-messages.ts POST /messages 同口径。
    if (body.providerId && !findProvider(deps.appConfig, body.providerId)) {
      return json(400, { error: `provider ${body.providerId} not found` });
    }
    // body.modelId 处理：保留字 'default'/'none'/'' 短路（不查 provider 命中），
    //   规范化为 'default' 落盘；具体 modelId 校验命中某 enabled provider 的 model 列表。
    //   参考: PRD 03 §2.2（保留字 default）+ §3.1（新建 session 默认 'default'）。
    if (body.modelId !== undefined && !isReservedModelId(body.modelId)) {
      const providers = listEnabledProviders(deps.appConfig);
      const pid = body.providerId ?? providers[0]?.id;
      const p = pid ? providers.find((it) => it.id === pid) : undefined;
      if (!p || !p.models.some((m) => m.modelId === body.modelId)) {
        return json(400, { error: `model ${body.modelId} not found` });
      }
    }
    // 新建 session 默认 modelId='default'。
    //   body.modelId 提供 → 规范化保留字为 'default' / 具体 modelId 原样；缺省 → 'default'。
    const effectiveModelId =
      body.modelId === undefined ? 'default' : normalizeReservedModelId(body.modelId);
    const id = ulid();
    // workspaceDir 初始策略（spec session_workspace.md §3）：
    //   - body.workspaceDir 提供 → 校验（abs + exists + isDir，任一失败 400）→ 用它（caller 负责，不自动建）
    //   - 未提供 → 默认 <DATA_DIR>/workspaces/<sid>，mkdir recursive（幂等）
    let workspaceDir: string;
    if (body.workspaceDir !== undefined && body.workspaceDir.length > 0) {
      const err = validateCallerWorkspaceDir(body.workspaceDir);
      if (err) return json(400, { error: err });
      workspaceDir = body.workspaceDir;
    } else {
      workspaceDir = resolve(deps.dataDir, 'workspaces', id);
      try {
        mkdirSync(workspaceDir, { recursive: true });
      } catch {
        // 忽略：已存在或权限（运行时再报）
      }
    }
    // POST /session 落库 providerId/modelId（手动选 model 持久化）
    // 落库 workspaceDir（caller 建好目录后传入，spec §2.2 不改 createSession 签名）
    // modelId 恒写（默认 'default'；spec session_store.md §2）
    const created = await deps.store.createSession({
      id,
      title: body.title ?? '新会话',
      workspaceDir,
      modelId: effectiveModelId,
      ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
    });
    // body.title 时同步置 titled=true（对齐 PUT title 行为）——
    //   createSession 内部强制 titled=false（session-store.ts 设计 invariant：新建一律未命名），
    //   故走 updateSession CAS gate 翻 true。POST 时若用户已命名而 titled 缺省 false，AI 后续
    //   auto-naming 会 CAS 误判「未命名」覆盖用户字面。
    //   spec session_store.md §2 + auto_naming/[P0]auto_naming_service.md §6 竞态矩阵。
    if (body.title !== undefined) {
      await deps.store.updateSession(id, { titled: true });
      // 回读最新值（created 是 updateSession 前的 snapshot，titled 仍 false）
      const updated = await deps.store.getSession(id);
      return json(201, updated ?? created);
    }
    return json(201, created);
  }
  return json(405, { error: 'Method Not Allowed' }, 'GET,POST');
}

/**
 * 处理 /session/:id：GET 单 / PUT 部分更新 / DELETE 删（级联）。
 * DELETE 分支兜底调 connectorManager.disconnect 释放 browser attach owner（design §5）。
 */
export async function handleSessionItem(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method === 'GET') {
    const got = await deps.store.getSession(id);
    if (!got) return json(404, { error: 'session not found' });
    // lazy 修复：旧 session（无 workspaceDir）→ 建默认目录 + 回填（spec §5）
    if (!got.workspaceDir || got.workspaceDir.length === 0) {
      const fixed = await deps.store.ensureWorkspaceDir(id);
      if (fixed) got.workspaceDir = fixed;
    }
    return json(200, got);
  }
  if (method === 'PUT') {
    // 部分更新（title/providerId/modelId）
    const got = await deps.store.getSession(id);
    if (!got) return json(404, { error: 'session not found' });
    let body: UpdateSessionBody = {};
    try {
      const text = await req.text();
      if (text.length > 0) {
        const parsed = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object') {
          body = parsed as UpdateSessionBody;
        }
      }
    } catch {
      return json(400, { error: 'invalid json body' });
    }
    // 校验 providerId/modelId 命中（提供时）
    const err = validateProviderModel(deps, body);
    if (err) return json(400, { error: err });
    // [v0.0.148] 校验 effort/approvalMode enum 值（非法返 400）
    const effErr = validateEffortApproval(body);
    if (effErr) return json(400, { error: effErr });
    // [v0.0.231] 校验 pinned 类型（提供但非 boolean 返 400，fail-fast 防字符串静默无效）
    const pinErr = validatePinned(body);
    if (pinErr) return json(400, { error: pinErr });
    // body.modelId 保留字规范化为 'default'（PUT 接受 default/none/空串 → 落盘 'default'）
    //   参考: PRD 03 §2.2 + 04 §5.2 API（PUT /session/:id body.modelId 接受保留字）。
    const persistedModelId = normalizeReservedModelId(body.modelId);
    // body.title 时同步置 titled=true（防 AI 名返回时 CAS 覆盖；
    //   spec auto_naming/[P0]auto_naming_service.md §6 竞态矩阵）
    const hasTitle = body.title !== undefined;
    // [v0.0.231] pinned 透传（部分更新语义，未提供不覆盖；已校验 boolean）
    const hasPinned = body.pinned !== undefined;
    await deps.store.updateSession(id, {
      ...(hasTitle ? { title: body.title } : {}),
      ...(hasTitle ? { titled: true } : {}),
      ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
      ...(persistedModelId !== undefined ? { modelId: persistedModelId } : {}),
      // [v0.0.148] effort/approvalMode 透传（部分更新语义，未提供不覆盖；已校验 enum）
      ...(body.effort !== undefined ? { effort: body.effort } : {}),
      ...(body.approvalMode !== undefined ? { approvalMode: body.approvalMode } : {}),
      ...(hasPinned ? { pinned: body.pinned } : {}),
    });
    // PUT title/pinned 后直调 metaBroadcaster.broadcast（让前端列表实时刷新；
    //   title 先例 spec auto_naming §6，pinned 同路径多端归位。
    //   broadcast 同步 void 且内部已 catch，调用层无需 try）
    if ((hasTitle || hasPinned) && deps.metaBroadcaster) deps.metaBroadcaster.broadcast(id);
    const updated = await deps.store.getSession(id);
    return json(200, updated);
  }
  if (method === 'DELETE') {
    const got = await deps.store.getSession(id);
    if (!got) return json(404, { error: 'session not found' });
    // 级联删子孙：先快照 descendants（删 parent 后 childrenIndex.onDeleted 清空 child set
    // 再查会漏子孙）；子孙先删（每个触发 onSessionDestroyed → 清内存 cron，堵潜伏调度，PRD §3.2），
    // parent 最后删。
    const descendants = await deps.store.collectDescendants(id);
    for (const sid of descendants) {
      await deps.store.deleteSession(sid);
    }
    await deps.store.deleteSession(id);
    // 删除 session → recycleSession 回收全部 tab 监听（v0.0.139 懒监听；与 SSE unsubscribe
    // 路径互补，幂等）。仅针对 parent（tab/连接器是 parent 维度，子孙无独立 tab）
    if (deps.workspaceManager) await deps.workspaceManager.recycleSession(id);
    // 兜底 disconnect：若 owner=id 则真断，否则 no-op（design §5）；异常吞掉不影响 204
    if (deps.connectorManager?.disconnect) {
      await deps.connectorManager.disconnect('browser', id).catch(() => {
        /* graceful，不阻断 DELETE 语义 */
      });
    }
    // [v0.0.105] computer 去连接器语义（无 owner 锁）：session DELETE 不再兜底断开 computer。
    return new Response(null, { status: 204 });
  }
  return json(405, { error: 'Method Not Allowed' }, 'GET,PUT,DELETE');
}

// ============================================================
// Session Summary（D2 只读端点）
// ============================================================

/** GET /session/:id/summary — 200 + {summary: SummaryInfo|null} */
export async function handleSessionSummary(
  _req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });
  const summary = await deps.store.getSummary(id);
  return json(200, { summary });
}
