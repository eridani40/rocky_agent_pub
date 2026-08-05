/**
 * POST /session/:id/run — WORKING but currently TEST-ONLY.
 * Sync wrapper: enqueue + activate + await run terminal, returns final result.
 * Gate: NODE_ENV=test only (router 层 gate，非 test → 404). Do NOT expose in production API surface.
 * Rationale: eliminates test-side poll/SSE-await flakiness（tests 同步语义实验）。
 *
 * 参考: specs/api/overall/04-agent-session.md §3.2（POST /messages 语义：deliverTo + 202）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §2.4（deliverTo 调用方清单）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md §2（AgentRun.promise）
 *
 * 设计：
 *   - 复用 deliverTo（绝不重新实现 enqueue/activate）
 *   - await 复用 AgentRun.promise（loop 退出时 settle；attachRunPromise 已绑 resolve/reject）
 *   - timeout 兜底用 Promise.race（5min），不挂死
 *   - poll session.state 直到终态（loop 退出后 interrupting 收尾可能仍 < 1s）
 *   - 真实 stopReason / error 从 store.getRun 拿（agent-loop-lifecycle.persistRun 落盘）
 *   - run 期间 messages 从 store.getMessagesByRun 拿（user msg 无 runId，仅 assistant/system/tool）
 */
import {
  type SessionHandlerDeps,
  resolveErrorRunResult,
} from './session';
import type { Message, MessageInput, ContentBlock } from '../message/types';
// body.modelId 校验用 validateModelId（保留字白名单含 default/none）；
//   ModelNotConfiguredError 由 deliverTo 内部抛出 → catch 返 400 {code, message, detail}。
import { validateModelId, isReservedModelId, normalizeReservedModelId } from '../services/model-validation';
import { ModelNotConfiguredError } from '../services/model-resolver';
import { ulid } from '../config/ulid';

/** POST /session/:id/run 请求体（与 POST /messages 同，但不支持 activate——run 端点始终 activate + await） */
interface RunMessageBody {
  content: string;
  providerId?: string;
  modelId?: string;
  sender?: { source: string };
}

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** run 终态超时上限（5 min 兜底，防挂死）。超时返 504 + runId，调用方可重试或 abort。 */
const RUN_AWAIT_TIMEOUT_MS = 5 * 60 * 1000;
/** session.state 进入终态的 poll 兜底（10s）—— loop 退出后 interrupting 收尾通常 < 1s */
const STATE_SETTLE_MAX_MS = 10_000;
/** state poll 间隔 */
const STATE_POLL_INTERVAL_MS = 50;

/**
 * session.state 终态集合（非临时态 running/interrupting）。
 *
 * [v0.0.101 T4 O9] 加 'suspended'：tool_pending StopReason 触发 markSuspended 后 session 进入
 * suspended 合法存活态。POST /session/:id/run（test sync wrapper）await 终态必须把 suspended 视为
 * 终态返 state=suspended/stopReason=tool_pending，否则 /run 在 HITL 场景下挂起致 AT timeout
 * （tool_pending→suspended 是合法 run 退出，promise settle + state=suspended；不算异常）。
 *
 * suspended 不同于 idle：idle 表示「run 结束、空闲」，suspended 表示「run 退出但悬挂待用户回填」，
 * 两者都是「loop 不再活跃」的终态（无 in-flight controller），故 /run 应当 settle 返回。
 */
const TERMINAL_STATES = new Set(['idle', 'interrupted', 'error', 'suspended']);

/**
 * 等 session.state 进入终态（idle/interrupted/error/suspended）。
 *
 * 必要性：agentRun.promise resolve 时 loop 已退出，但 abort 4 步收尾可能仍处于
 * interrupting 临时态（abort step1 markInterrupting → loop 退出 → promise resolve
 * → abort step2-4 finalizeHalfData + markInterrupted）。故 promise resolve 后仍需
 * poll session.state，避免响应体里返回临时态 state=interrupting 让测试误判。
 *
 * [v0.0.101 O9] 含 suspended：tool_pending 退出后 onRunEnd 调 markSuspended，poll 时
 * 会捕获到 suspended 终态返回（不再挂死）。
 *
 * @returns 终态字符串，或 'unknown'（session 消失/超时兜底）
 */
async function waitSessionTerminalState(
  store: SessionHandlerDeps['store'],
  sid: string,
  maxMs = STATE_SETTLE_MAX_MS,
): Promise<'idle' | 'interrupted' | 'error' | 'suspended' | 'unknown'> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const s = await store.getSession(sid);
    if (!s) return 'unknown';
    if (TERMINAL_STATES.has(s.state)) {
      return s.state as 'idle' | 'interrupted' | 'error' | 'suspended';
    }
    await new Promise((r) => setTimeout(r, STATE_POLL_INTERVAL_MS));
  }
  // 超时兜底：返当前态（可能是临时态 running/interrupting；调用方据此判断异常）
  const s = await store.getSession(sid);
  return (s?.state as 'idle' | 'interrupted' | 'error' | 'suspended') ?? 'unknown';
}

/**
 * 处理 /session/:id/run：仅 POST；router 层已 gate NODE_ENV=test。
 *
 * 步骤（镜像 messages handler 的 gate/校验/body 解析）：
 *   1. session 存在 + 非 subagent 校验（对齐 messages handler）
 *   2. body 解析 + provider/model 校验（同 messages handler）
 *   3. 构造 user message（sender={source:'user'}，无 agent 字段——判别联合 user 变体）
 *   4. manager.deliverTo(sessionId, userMsg) 拿 AgentRun
 *   5. await agentRun.promise（loop 终态）+ 5min timeout 兜底
 *   6. poll session.state 直到终态（防 interrupting 临时态）
 *   7. store.getRun 拿 stopReason/error；getMessagesByRun 拿本次 run 期间 messages
 *   8. 200 同步返回（不是 202——因为已 await 到终态）
 */
export async function handleSessionRun(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  // 双重 gate：router 层 + handler 层（防 handler 被绕过直接调）
  if (process.env.NODE_ENV !== 'test') {
    return json(404, { error: 'Not Found' });
  }
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }

  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });
  // subagent 只读语义（对齐 messages handler）：拒绝 user-source POST
  if (got.derivation === 'subagent') {
    return json(403, { error: 'subagent_readonly' });
  }

  let body: RunMessageBody;
  try {
    body = (await req.json()) as RunMessageBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (typeof body.content !== 'string') {
    return json(400, { error: 'content must be a string' });
  }
  if (body.content.length === 0) {
    return json(400, { error: 'content must not be empty' });
  }

  // body.modelId 校验 + 落盘（保留字规范化 + 具体值校验），
  //   与 messages handler 同逻辑（PRD 04 §5.2 + 03 §2.2 保留字语义）。
  if (body.modelId !== undefined) {
    const mid = body.modelId;
    if (!isReservedModelId(mid)) {
      const v = validateModelId(deps.appConfig, mid);
      if (!v.ok) return json(400, { error: v.error });
    }
    const persistedModelId = normalizeReservedModelId(mid)!;
    if (persistedModelId !== got.modelId) {
      await deps.store.updateSession(id, { modelId: persistedModelId });
    }
  }

  // 构造 user message（对齐 messages handler：sender={source:'user'}）
  const userMsg: MessageInput = {
    id: ulid(),
    sessionId: id,
    role: 'user',
    content: [{ type: 'text', text: body.content }] as ContentBlock[],
    sender: { source: 'user' },
  };

  // deliverTo（manager 内部 enrich + enqueue + activate；绝不重新实现）
  // deliverTo 内部 resolveModel 跑空 → throw ModelNotConfiguredError → 400 错误体。
  let agentRun;
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

  // await run 终态：复用 AgentRun.promise（loop 退出时 settle）+ 5min timeout 兜底
  let timedOut = false;
  const timeoutSignal = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error('run_timeout'));
    }, RUN_AWAIT_TIMEOUT_MS);
  });
  try {
    await Promise.race([agentRun.promise, timeoutSignal]);
  } catch (e) {
    if (timedOut) {
      // 5min 超时 → 504（调用方可显式 abort 或重试）
      return json(504, { error: 'run_timeout', runId: agentRun.runId });
    }
    // 真 reject（loop 异常退出，agentRun.state='error'）→ 落到下面读 store 拿 error 详情
  }

  // poll session.state 直到终态（防 abort 收尾还在 interrupting 临时态）
  const finalState = await waitSessionTerminalState(deps.store, id);

  // 读 RunRecord（拿真实 stopReason + RunErrorInfo；agent-loop-lifecycle.persistRun 落盘）
  const runRec = await deps.store.getRun(id, agentRun.runId);
  // 读本次 run 期间产生的 messages（user msg 无 runId，仅 assistant/system/tool 出现）
  const messages = await deps.store.getMessagesByRun(id, agentRun.runId);

  return json(200, {
    runId: agentRun.runId,
    enqueueId: '',
    state: finalState,
    stopReason: runRec?.stopReason,
    error: runRec?.error,
    messages,
  });
}
