/**
 * session-inbox handler — GET /session/:id/inbox 只读端点
 * 参考: specs/prd/version_logs/v0.0.97.enqueue_sse/change_log.md §2.1
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2 §10
 *
 * 职责：
 *   - GET /session/:id/inbox：peek 当前 session inbox（只读，无副作用——不 drain / 不 emit / 不锁），
 *     过滤 kind:'message' 条目，映射成 InboxItemView[] 返回。前端 useMessages onInit 在
 *     GET /messages 后追加本端点 seed enqueueItems（GET seed + SSE 增量 = 队列真相源，对齐 INV-1）。
 *
 * 设计要点（O1：peek 返直接引用，drain splice 改同数组）：
 *   - handler 在调用时刻浅拷贝快照 `[...peek]` 再 filter/map，防止 drain 并发清空已返引用。
 *   - 不改 InboxStore.peek 既有 normal-mode live-ref 调用方语义。
 *
 * 排序：InboxEntry.enqueuedAt 为 isoDate + enqueueId 为 ULID（同批共享 enqueuedAt，ULID 字典序天然升序）。
 *   按入队顺序（bucket 数组原序）返回即可，无需重排。
 */
import type { ContentBlock } from '../message/types';
import type { InboxEntry } from '../agent/inbox';
import type { SessionHandlerDeps } from './session';

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * GET /session/:id/inbox 响应条目（与 message_enqueued SSE content 同形——ContentBlock[]）。
 * INV-2：content 为 ContentBlock[]，前端走 contentBlocksToPreviewText 入口拍平为预览串。
 */
export interface InboxItemView {
  /** 入队句柄（ULID）—— 与 AgentEvent.enqueueId / cancel POST 对应 */
  enqueueId: string;
  /** 入队消息内容（与 SSE message_enqueued.content 同构的 ContentBlock[]） */
  content: ContentBlock[];
  /** 进 inbox 的时刻（isoDate，与 enqueueId 同步注入） */
  enqueuedAt: string;
}

/**
 * 处理 GET /session/:id/inbox — 返当前 session 排队中（kind:'message'）的条目。
 *
 * 响应：
 *   - 200 + `{ items: InboxItemView[] }`（过滤 kind:'message'，按入队顺序升序；只读无副作用）
 *   - 404 session 不存在
 *   - 405 非 GET
 *
 * @param _req Request（GET /inbox 无请求体）
 * @param method HTTP 方法（用于 405 判定）
 * @param id session id（path param）
 * @param deps SessionHandlerDeps（用 store.getSession 判存在 + agentManager.peekInbox 透传）
 */
export async function handleSessionInbox(
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
  // O1：peek 返直接引用（inbox.ts:140），drain splice(0) 改同数组。
  //   handler 浅拷贝快照在调用时刻冻结，防 drain 并发清空已返引用。
  //   只暴露 kind:'message'（cancel 条目不进队列视图，MUST NOT 暴露）。
  const peeked: InboxEntry[] = [...deps.agentManager.peekInbox(id)];
  const items: InboxItemView[] = peeked
    .filter((e): e is Extract<InboxEntry, { kind: 'message' }> => e.kind === 'message')
    .map((e) => ({ enqueueId: e.enqueueId, content: e.message.content, enqueuedAt: e.enqueuedAt }));
  return json(200, { items });
}
