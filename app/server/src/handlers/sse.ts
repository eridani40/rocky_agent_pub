/**
 * sse handlers — GET /sse + POST /sse/subscribe + POST /sse/unsubscribe + DELETE /sse/subscriber/:subId
 * 参考:
 *   - specs/api/version_logs/v0.0.8/change_log.md §4（GET /sse / subscribe / unsubscribe 端点）
 *   - specs/api/version_logs/v0.0.12/change_log.md（放开 session_panel topic 订阅）
 *   - specs/api/version_logs/v0.0.88/change_log.md §2-§4（subId 上行/下行 + DELETE /sse/subscriber/:subId）
 *   - specs/tech/app/frontend/[P0]sse_channel.md §2-§4 / §10
 *
 * 依赖 SseChannel（bootstrap 装配，router 透传）。非法 JSON / 字段缺失 / topic 非法 → 400 JSON。
 */
import type { SseChannel } from '../sse/sse-channel';
import { ulid } from '../config/ulid';

/**
 * 合法 topic 集合（agent_loop + session_panel + session_meta + app_task + panorama + squad_meta + provider_quota）。
 * 与 bootstrap-bus-phase.ts 的 registerTopic 清单一一对应（两处手维护；
 * __tests__/sse-topic-whitelist.test.ts 有双向对齐断言防漏配）。
 */
export const ALLOWED_TOPICS = new Set(['agent_loop', 'session_panel', 'session_meta', 'app_task', 'panorama', 'squad_meta', 'provider_quota']);

/** subscribe 请求体（specs/api §4.2） */
interface SubscribeBody {
  topic: string;
  group: string;
  /** 订阅唯一 id（前端生成 ULID 上行）；缺省时后端生成 ULID 兜底 */
  subId?: string;
}

/** unsubscribe 请求体（specs/api §4.3 subId 必传） */
interface UnsubscribeBody {
  topic: string;
  group: string;
  /** 精准取消一个订阅；必传（缺 subId → 400，无批量取消兜底） */
  subId: string;
}

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 解析 subscribe 请求体；非法返 { ok:false, status, error } 哨兵。
 * 协议设计缺省：caller 未带 subId 时后端生成 ULID 兜底（subId 是订阅唯一 key，必须有值）。
 */
function parseSubscribeBody(
  raw: unknown,
): { ok: true; body: { topic: string; group: string; subId: string } } | { ok: false; status: number; error: string } {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, status: 400, error: 'invalid json body' };
  }
  const b = raw as Partial<SubscribeBody>;
  if (typeof b.topic !== 'string' || b.topic.length === 0) {
    return { ok: false, status: 400, error: 'topic required' };
  }
  if (typeof b.group !== 'string' || b.group.length === 0) {
    return { ok: false, status: 400, error: 'group required' };
  }
  if (!ALLOWED_TOPICS.has(b.topic)) {
    return { ok: false, status: 400, error: `topic ${b.topic} not allowed` };
  }
  // 协议设计缺省：caller 未带 subId 时后端生成 ULID 兜底（订阅唯一 key 必须有值）
  const subId = typeof b.subId === 'string' && b.subId.length > 0 ? b.subId : ulid();
  return { ok: true, body: { topic: b.topic, group: b.group, subId } };
}

/** GET /sse — 建立一条新 SSE 连接（200 text/event-stream） */
export function handleSseStream(channel: SseChannel): Response {
  const { body, headers } = channel.openConnection();
  return new Response(body, { status: 200, headers });
}

/**
 * 处理 /sse/subscribe（POST）+ /sse/unsubscribe（POST）+ /sse/subscriber/:subId（DELETE）。
 * subscribe 调 channel.subscribe(topic, group, subId) 不传 sink（方案 B 后端广播）；
 * DELETE /sse/subscriber/:subId 路由精准取消一个订阅。
 */
export async function handleSseSubscribeOps(
  req: Request,
  method: string,
  path: string,
  channel: SseChannel,
): Promise<Response> {
  // DELETE /sse/subscriber/:subId 路由分支
  if (method === 'DELETE' && path.startsWith('/sse/subscriber/')) {
    const subId = path.slice('/sse/subscriber/'.length);
    if (!subId) return json(400, { error: 'subId required in path' });
    channel.unsubscribe(subId);
    return json(200, { ok: true });
  }

  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { error: 'invalid json body' });
  }

  const parsed = parseSubscribeBody(raw);
  if (!parsed.ok) {
    return json(parsed.status, { error: parsed.error });
  }

  if (path === '/sse/subscribe') {
    // 方案 B：channel 不需要 sink 归属，writeFrame 广播所有 sinks
    channel.subscribe(parsed.body.topic, parsed.body.group, parsed.body.subId);
    return json(200, { ok: true, subId: parsed.body.subId });
  }
  if (path === '/sse/unsubscribe') {
    const b = raw as Partial<UnsubscribeBody>;
    if (b.subId) {
      channel.unsubscribe(b.subId);
      return json(200, { ok: true });
    }
    // 缺 subId：协议设计要求 caller 必带 subId；缺时只能拒（无批量取消兜底）
    return json(400, { error: 'subId required' });
  }
  return json(404, { error: 'Not Found' });
}
