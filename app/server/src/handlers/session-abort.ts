/**
 * session-abort handlers — POST /session/:id/abort + POST /session/:id/messages/:enqueueId/cancel
 * 参考: specs/api/overall/04-agent-session.md §3.3 §3.4
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §3 abort / cancel
 *       states/v0.0.12/design.md 板块 3.4 / 5
 *
 * 仅处理两个 fire-and-forget 端点。
 *
 * 行为契约（api §3.3 §3.4）：
 *   - POST /session/:id/abort → AgentManager.abort（4 步收尾）→ 202 {ok:true}
 *     幂等：session 无活跃 run / CAS 失败 → 仍 202
 *   - POST /session/:id/messages/:enqueueId/cancel → AgentManager.cancel（追加 cancel 消息到 inbox）
 *     → 202 {ok:true}。drain 时由 agent_loop 配对作废 + emit enqueued_message_canceled。
 */
import type { SessionHandlerDeps } from './session';
import type { RunKind } from '@app/shared';

/** 构造 JSON Response（可选 Allow 头） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * POST /session/:id/abort — 中断 session 当前 run（fire-and-forget）。
 *
 * body 传 { runId, runKind }（agent_interface §3 三参签名）。
 *   - runId：caller 从 activate/sideRun 返回的 AgentRun.runId 取
 *   - runKind："current"（主对话）/ "summary" / "memory_extract"（forked 旁路）
 *   - body 缺省字段：runId="" 回落取 session.currentRunId（兼容旧行为）；runKind 缺省 "current"
 *
 * 行为（design §5.2 / agent_interrupt.md §3）：
 *   AgentManager.abort 内部 step1 controller 校验 → 主对话 4 步收尾 / forked 直接置 aborted。
 *   返 202 = 服务端已接收中断请求；不 await 收尾完成，调用方通过 SSE run_end 感知。
 *
 * 幂等（api §3.3）：session 无活跃 controller → 返 202（无操作）；CAS 失败（并发 abort）→ 返 202。
 *
 * 错误：404 session 不存在；405 非 POST。
 */
export async function handleSessionAbort(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // subagent 只读语义（api §4.3）：subagent session 拒绝手动 abort。
  // 前端只读页隐藏 abort；abort 仅经 parent agent.abort LLM 工具触发（走 AgentManager.abort 内部路径，不经 HTTP）。
  if (got.derivation === 'subagent') {
    return json(403, { error: 'subagent_readonly' });
  }

  // 解析 body { runId, runKind }（容错：缺省 runId 取 currentRunId / runKind=main）
  // v0.0.204 T2-B4：runKind 收敛闭合枚举 RunKind（main / summary / consolidate）。
  //   非法值（含旧 'current' / 'memory_extract'）→ 兜底 'main'（兼容老 client，不抛 400）。
  let bodyRunId = '';
  let bodyRunKind: RunKind = 'main';
  try {
    if (req.body !== null && req.body !== undefined) {
      const parsed = (await req.json()) as { runId?: string; runKind?: string };
      if (typeof parsed.runId === 'string') bodyRunId = parsed.runId;
      if (parsed.runKind === 'main' || parsed.runKind === 'summary' || parsed.runKind === 'consolidate') {
        bodyRunKind = parsed.runKind;
      }
    }
  } catch {
    // body 解析失败：回落默认（runId=currentRunId, runKind=main）
  }
  const runId = bodyRunId || got.currentRunId || '';

  // fire-and-forget 语义：accepted:false 也是 202（幂等；详见 api §3.3）
  const result = await deps.agentManager.abort(id, runId, bodyRunKind);
  return json(202, { ok: true, accepted: result.accepted });
}

/**
 * POST /session/:id/messages/:enqueueId/cancel — 取消排队中的消息（fire-and-forget）。
 *
 * 行为（design 板块 3.4 / agent_enqueue_cancel.md §5）：
 *   AgentManager.cancel → inbox.appendCancel（追加 kind="cancel" 条目，cancelFor=enqueueId），
 *   不删原 message / 不删 inbox。agent_loop 下一轮 drain 同批配对处理：
 *     - 同批拿到 message+cancel（同 enqueueId）→ message 作废 + emit enqueued_message_canceled
 *     - cancel 来晚（message 已 processed）→ cancel 丢弃，无事件（幂等）
 *
 * 返 202 = 服务端已接收取消请求；不 await drain 完成，调用方通过 SSE 感知。
 *
 * 幂等（api §3.4）：enqueueId 不存在 / 已 processed / 多次 cancel → 都返 202（无副作用）。
 *
 * 错误：404 session 不存在；405 非 POST。
 */
export async function handleSessionMessageCancel(
  _req: Request,
  method: string,
  id: string,
  enqueueId: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });
  // fire-and-forget：appendCancel 同步；返回 202 即可
  await deps.agentManager.cancel(id, enqueueId);
  return json(202, { ok: true });
}
