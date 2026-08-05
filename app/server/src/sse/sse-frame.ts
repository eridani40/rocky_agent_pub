/**
 * SSE 帧 codec — 帧形状 / 响应头 / wire 解析（与 SseChannel 编排解耦）。
 * 参考: specs/tech/app/frontend/[P0]sse_channel.md §4 + [P0]sse_channel_multipub.md §3
 */

/** SSE 响应头（GET /sse 用） */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  // 禁用 Nagle + 保活（兼容 HTTP/1.1 长连接代理）
  connection: 'keep-alive',
});

/** SSE 帧 payload 形状（对齐 sse_channel.md §4 + multipub §3） */
export interface SseFrame<T = unknown> {
  topic: string;
  group: string;
  data: T;
  timestamp: string;
  /** 订阅唯一 id（前端 ULID 上行）；listener 闭包注入帧体；前端按此 id 路由到 handler */
  subId: string;
}

/**
 * 解析 SSE wire 帧（`data: {...}\n\n`）为 SseFrame（测试辅助 + handler 解析用）。
 * 非 SSE 帧或 JSON 非法返回 null。
 */
export function parseSseFrame(chunk: string): SseFrame | null {
  const lines = chunk.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const json = trimmed.slice('data:'.length).trim();
    try {
      const parsed = JSON.parse(json) as SseFrame;
      if (
        typeof parsed.topic === 'string' &&
        typeof parsed.group === 'string' &&
        'data' in parsed &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.subId === 'string'
      ) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}
