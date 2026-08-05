/**
 * session-messages handlers — /session/:id/messages（分页 GET + 发送触发 run POST）
 * 参考: specs/api/overall/04-agent-session.md §3.1 §3.2
 *       specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §D
 *
 * v0.0.158：删 body.providerId / body.modelId 一次性 override。
 *   - 前端不再传 provider/model 到发消息 body；旧 client 传字段后端**静默忽略**（不 400、不解析、不落 session）
 *   - model 改动的生效点 = 用户改设置那一刻（PUT /session 或 PATCH squad），下次发消息走 server 记录
 *
 * session CRUD + summary 在 session.ts；resolveProviderModel 在 session-provider-utils.ts。
 */
import { ulid } from '../config/ulid';
import {
  type SessionHandlerDeps,
  resolveErrorRunResult,
} from './session';
import type { Message, MessageInput, ContentBlock } from '../message/types';
import type { MessagePage, Run } from '../agent/session-store-types';
import type { AgentRun } from '../agent/agent-interface';
// ModelNotConfiguredError 由 deliverTo 内部抛出 → catch 返 400 错误体 {code, message, detail}。
import { ModelNotConfiguredError } from '../services/model-resolver';

/**
 * POST /session/:id/messages 请求体（specs/api §3.2）。
 *
 * cancel 走专用端点 `POST /session/:id/messages/:enqueueId/cancel`；`enqueueId` 为响应字段。
 * `activate` 字段仅 NODE_ENV=test 生效（测试专用，生产始终激活）。
 *
 * [v0.0.101 T4] 可选 `toolReply?: { toolCallId, handleType, payload }` ——
 *   含 toolReply 时 handler 走回填分支（构造 sender.source='tool_reply' message → deliverTo，
 *   复用 inbox 统一入口 INV-5；不独立接口）。pre-process drain 时识别 sender.source='tool_reply'
 *   → handleToolReply 按 handleType 三分发编辑占位 block。body 不含 toolReply 时走原 user query 路径。
 *
 * v0.0.158：删 providerId/modelId 字段（body override 整删）。旧 client 传字段：
 *   TS 类型不承认，运行时**静默忽略**（后端不解析、不 400、不落 session）。
 *   模型改动的生效点 = PUT /session 或 PATCH squad，下次发消息走 server 记录。
 */
interface PostMessageBody {
  /**
   * 消息内容（纯字符串）。
   * mention 以内嵌单行 XML tag 形式出现在字符串中（如
   * `<mention type="file" path="src/utils/helper.ts"/>`），server 不解析，原样落库 +
   * 原样发 LLM。参考 specs/tech/mention/message-content.md。
   */
  content: string;
  /**
   * 是否跳过 activate（可选，默认 true=激活）。
   *
   * **测试专用守卫**：`activate=false`（skipActivate）仅在
   * `process.env.NODE_ENV === 'test'` 时生效；生产环境忽略此参数（始终 activate）。
   * 主要用于 AT 测试构造「多条消息在 inbox 排队」确定性场景（不依赖 LLM 速度维持 run）。
   * 生产前端不使用此参数（始终激活）。
   */
  activate?: boolean;
  /**
   * [v0.0.101 T4] HITL 回填（可选）。存在时走 tool_reply 分支（非 user query）。
   * handleType: direct_result | approval | callback（pre-process 据此三分发）。
   * payload: FeedbackAnswer | ApprovalDecision | unknown（按 handleType）。
   */
  toolReply?: {
    toolCallId: string;
    handleType: 'direct_result' | 'approval' | 'callback';
    payload: unknown;
  };
}

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 处理 /session/:id/messages：GET 分页 / POST 发消息触发 run */
export async function handleSessionMessages(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method === 'GET') {
    return handleMessagesGet(req, id, deps);
  }
  if (method === 'POST') {
    return handleMessagesPost(req, id, deps);
  }
  return json(405, { error: 'Method Not Allowed' }, 'GET,POST');
}

/** GET /session/:id/messages — transcript 分页（limit 默认 50 上限 200，beforeId 可选） */
async function handleMessagesGet(
  req: Request,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const beforeId = url.searchParams.get('beforeId') ?? undefined;

  let limit = 50;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      return json(400, { error: 'limit must be an integer in [1,200]' });
    }
    limit = n;
  }

  const page: MessagePage = await deps.store.getMessages(id, { limit, beforeId });
  // run 级 stopReason join：消息只带 runId 外键，stopReason 持久化在 runs/{runId}.json。
  // 所有 stopReason 原样下发（不筛选类型）；展示/过滤归前端（与 SSE run_end 同一展示链路）。
  // run 未结束（无 stopReason）/ user 消息（无 runId）不附加字段。
  const runIds = [...new Set(page.items.map((m) => m.runId).filter((r): r is string => !!r))];
  const runById = new Map<string, Run | null>();
  await Promise.all(
    runIds.map(async (rid) => {
      runById.set(rid, await deps.store.getRun(id, rid));
    }),
  );
  const items = page.items.map((m) => {
    const run = m.runId ? runById.get(m.runId) : undefined;
    if (!run?.stopReason) return m;
    return {
      ...m,
      stopReason: run.stopReason,
      ...(run.error ? { runError: run.error } : {}),
    };
  });
  return json(200, { items, hasMore: page.hasMore });
}

/**
 * POST /session/:id/messages — user 入口消息投递。
 *
 * handler 不自行构造 SessionConfig，收敛到 deliverTo。
 *   - 构造 role:user Message（sender={source:'user'}，无 agent 字段——判别联合 user 变体）
 *   - v0.0.158：body.providerId/modelId 静默忽略（不解析、不 400、不落 session）
 *   - skipActivate（NODE_ENV=test）：走 enqueue(sessionId) 新签名
 *   - 默认走 deliverTo(sessionId, userMsg)（manager 内部 enrich + enqueue + activate）
 */
async function handleMessagesPost(
  req: Request,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // studio session 走 deliverTo + AgentLoop（不 403）。
  // subagent 只读语义（api §4.2）：拒绝 user-source POST（仅接受 a2a deliverTo）。
  if (got.derivation === 'subagent') {
    return json(403, { error: 'subagent_readonly' });
  }

  let body: PostMessageBody;
  try {
    body = (await req.json()) as PostMessageBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }

  // [v0.0.101 T4] tool_reply 分支：body 含 toolReply → 构造 tool_reply message → deliverTo。
  // 不走 user query 校验（content 可空），不触发 auto-naming（非首 query）。
  // runId 从 store.peekPendingToolCall 匹配 toolCallId 取（pending.call.runId 即产出 run）。
  if (body.toolReply) {
    const tr = body.toolReply;
    if (typeof tr.toolCallId !== 'string' || tr.toolCallId.length === 0) {
      return json(400, { error: 'toolReply.toolCallId required' });
    }
    if (tr.handleType !== 'direct_result' && tr.handleType !== 'approval' && tr.handleType !== 'callback') {
      return json(400, { error: 'toolReply.handleType invalid' });
    }
    // peek 队首校验 toolCallId 匹配（队首串行 INV-4）+ 取 runId
    const head = await deps.store.peekPendingToolCall(id);
    if (!head || head.toolCallId !== tr.toolCallId) {
      return json(409, { error: 'tool_reply toolCallId mismatch or no pending' });
    }
    const replyMsg: MessageInput = {
      id: ulid(),
      sessionId: id,
      role: 'user',
      content: [{
        type: 'tool_reply',
        toolCallId: tr.toolCallId,
        handleType: tr.handleType,
        payload: tr.payload,
      }] as ContentBlock[],
      sender: {
        source: 'tool_reply',
        tool_reply: { toolCallId: tr.toolCallId, runId: head.runId },
      },
    };
    let agentRun: AgentRun & { enqueueId: string };
    try {
      agentRun = await deps.agentManager.deliverTo(id, replyMsg as Message);
    } catch (e) {
      if (e instanceof ModelNotConfiguredError) {
        return json(400, { code: e.code, message: e.message, detail: e.detail });
      }
      throw e;
    }
    if (agentRun.state === 'error') {
      void agentRun.promise.catch(() => {});
      return json(500, { error: `activate failed for runId: ${agentRun.runId}` });
    }
    return json(202, { runId: agentRun.runId, enqueueId: agentRun.enqueueId });
  }

  if (typeof body.content !== 'string') {
    return json(400, { error: 'content must be a string' });
  }
  if (body.content.length === 0) {
    return json(400, { error: 'content must not be empty' });
  }
  const plainText = body.content;

  // v0.0.158：body.providerId / body.modelId 静默忽略（兼容层）——
  //   前端不再传，旧 client 传字段也不解析、不校验、不落 session、不 400。
  //   模型改动的生效点 = 用户改设置那一刻（PUT /session 或 PATCH squad），
  //   下次发消息走 server 记录（resolveConfigBySid 读 session.modelId/providerId）。

  // 构造 role:user Message（content=[{type:text,text}], sender.source=user）
  // 判别联合：user 变体只 {source:'user'}，无 agentName/agentId/agent 子结构
  // mention 走内嵌 XML tag（`<mention type="..." path="..."/>`）方案：server 不解析、原样落库、原样发 LLM。参考 specs/tech/mention/message-content.md。
  // [v0.0.161] msgId 是 **throwaway 占位**（inbox schema 要求 id 非空）——drain 时会被
  //   agent-loop-stage-pre.drainAndPartition 用新 ulid() 重写（I1/I3）。
  //   本值绝不通过 HTTP 响应体外泄给前端（响应仅 {runId, enqueueId}；见下方 return）。
  const msgId = ulid();
  const userMsg: MessageInput = {
    id: msgId,
    sessionId: id,
    role: 'user',
    content: [{ type: 'text', text: plainText }] as ContentBlock[],
    sender: { source: 'user' },
  };

  // skipActivate 守卫——仅 NODE_ENV=test 时生效。
  // 测试场景只入队不激活：走 enqueue(sessionId)（不 deliverTo，跳过 activate）。
  // 生产环境忽略 activate=false（始终激活，避免 API surface 暴露测试行为）。
  if (body.activate === false && process.env.NODE_ENV === 'test') {
    const enqueueIds = await deps.agentManager.enqueue(id, [userMsg as Message]);
    return json(202, { runId: '', enqueueId: enqueueIds[0] ?? '' });
  }

  // AI 起名 hook（不 await，fire-and-forget；spec auto_naming §2.1）。
  // 触发条件由 AutoNamingService 内部 gate 判（playground + 非 subagent + 首 query + titled===false）。
  // 任何失败都 .catch 静默，不影响 202 返回时序 / 主 agent run。
  if (deps.autoNamingService) {
    void deps.autoNamingService.triggerIfFirstQuery(id, plainText).catch(() => {
      /* 静默：LLM/config/network/parse/DB 任何失败都不影响主 run */
    });
  }

  // user POST 收敛 deliverTo：manager 内部 enrich + enqueue + activate。
  // deliverTo 返 enqueueId（内部 inbox.enqueue 生成）→ HTTP 响应回前端，
  //   前端可乐观渲染排队项（reducer message_enqueued 幂等去重防 dup）+ cancel 用。
  // deliverTo 内部 buildSessionConfigFromDeps 调 resolveModel；
  //   fallback 链跑空 → throw ModelNotConfiguredError → catch 返 400 {code, message, detail}。
  let agentRun: AgentRun & { enqueueId: string };
  try {
    agentRun = await deps.agentManager.deliverTo(id, userMsg as Message);
  } catch (e) {
    if (e instanceof ModelNotConfiguredError) {
      return json(400, {
        code: e.code,
        message: e.message,
        detail: e.detail,
      });
    }
    throw e;
  }
  if (agentRun.state === 'error') {
    // activate 失败（session not found / AgentLoop 构造失败 / config resolve 失败）。
    // makeErrorRun 透传原 Error → resolveErrorRunResult 识别 ModelNotConfiguredError 返 400，
    //   其余 500；并消费 promise 防 unhandled rejection。
    const r = resolveErrorRunResult(agentRun);
    return json(r.status, r.body);
  }
  return json(202, { runId: agentRun.runId, enqueueId: agentRun.enqueueId });
}
