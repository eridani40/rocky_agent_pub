/**
 * message-api —— messages / inbox / pending-tool-call / abort / cancel HTTP 客户端（从 chat-api.ts 拆出）
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §3（messages 分页 + 发送）
 *       specs/api/overall/04-agent-session.md §3（messages 契约）/ §3.5（inbox）/ §3.6（pending-tool-call）
 *
 * 依赖 session-api.ts export 的 req helper（共享 fetch 封装）。
 * v0.0.156 拆分重构：从原单文件 chat-api.ts move，**签名/body/错误处理 100% 等价**（INV-B-3/G1）。
 */
import type { ContentBlock, FeedbackAnswer, Message, PendingToolCallView, ToolHandleType } from '../../components/chat-page/types';
import { req } from './session-api';

/** GET /session/:id/messages —— transcript 分页（§3.1） */
export async function getMessages(
  sessionId: string,
  opts?: { limit?: number; beforeId?: string },
  base?: string,
): Promise<{ items: Message[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.beforeId) params.set('beforeId', opts.beforeId);
  const q = params.toString();
  return req<{ items: Message[]; hasMore: boolean }>(
    `/session/${encodeURIComponent(sessionId)}/messages${q ? `?${q}` : ''}`,
    undefined,
    base,
  );
}

/**
 * [v0.0.97] GET /session/:id/inbox 响应条目（与 message_enqueued SSE content 同形——ContentBlock[]）。
 * 前端 useMessages onInit 在 GET /messages 后追加本端点 seed enqueueItems。
 */
export interface InboxItemView {
  enqueueId: string;
  content: ContentBlock[];
  enqueuedAt: string;
}

/**
 * [v0.0.97] GET /session/:id/inbox —— enqueue 排队项只读 seed（spec api 04-agent-session.md §3.5）。
 * 返当前 session inbox 中 kind:'message' 的条目（按入队顺序升序）。GET seed + SSE 增量 = 队列真相源。
 * 失败由 caller catch 降级空（useMessages onInit 不阻塞 SSE）。
 */
export async function getInbox(
  sessionId: string,
  base?: string,
): Promise<{ items: InboxItemView[] }> {
  return req<{ items: InboxItemView[] }>(
    `/session/${encodeURIComponent(sessionId)}/inbox`,
    undefined,
    base,
  );
}

/**
 * [v0.0.101] GET /session/:id/pending-tool-call —— 悬挂型 tool 队首只读 peek。
 * 参考: specs/api/overall/04-agent-session.md §3.6。
 * 用于前端 recover（切走切回 / 重启后重渲染提问卡），类比 v0.0.97 GET /inbox seed enqueue。
 * 空队列返 200 + { pending: null }（非 404——空是合法状态）。
 */
export async function getPendingToolCall(
  sessionId: string,
  base?: string,
): Promise<{ pending: PendingToolCallView | null }> {
  return req<{ pending: PendingToolCallView | null }>(
    `/session/${encodeURIComponent(sessionId)}/pending-tool-call`,
    undefined,
    base,
  );
}

/**
 * POST /session/:id/messages —— 发消息触发 run（§3.2，返回 runId）。
 * [v0.0.45] content 为字符串，mention 以 <mention type="..." path="..."/> 内联标签形式嵌入。
 * [v0.0.101] body 扩展 toolReply（HITL 回填分支）：含 toolReply 时后端构造 tool_reply sender
 *   + pre-process 走 handleType 三分发编辑占位 block；不含时走原 user query 路径。
 *   suspended 态接 query（无 toolReply）= 放弃 c 路径（后端清空 pending + 占位原样发 LLM）。
 * [v0.0.158] 删 body providerId/modelId 一次性 override：picker 变化在 handleModelChange
 *   立即走 PUT /session 落库；发消息 body 只含 content/toolReply，server 用 session record resolve。
 */
export async function postMessage(
  sessionId: string,
  body: {
    content: string;
    /** [v0.0.101] HITL 回填（ask-question 答案 / approval 决定 / callback payload） */
    toolReply?: {
      toolCallId: string;
      handleType: ToolHandleType;
      payload: FeedbackAnswer | unknown;
    };
  },
  base?: string,
): Promise<{ runId: string; enqueueId: string }> {
  return req<{ runId: string; enqueueId: string }>(
    `/session/${encodeURIComponent(sessionId)}/messages`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/** [v0.0.12] POST /session/:id/abort —— 中断当前 run（§3.3，202 fire-and-forget） */
export async function abortSession(
  sessionId: string,
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/abort`,
    { method: 'POST', body: '{}' },
    base,
  );
}

/** [v0.0.12] POST /session/:id/messages/:enqueueId/cancel —— 取消排队消息（§3.4，202） */
export async function cancelEnqueue(
  sessionId: string,
  enqueueId: string,
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(enqueueId)}/cancel`,
    { method: 'POST', body: '{}' },
    base,
  );
}
