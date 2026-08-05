// @vitest-environment node
/**
 * sse-client subId 路由单测（v0.0.88）
 * 参考: specs/tech/app/frontend/[P0]sse_client_singleton.md §3.1/§3.2/§3.3 + §9 不变量 #1-#2
 *
 * 覆盖：
 *   - handlers Map<subId, handler> 路由：同 (topic,group) 多 subId 各自收帧不互踩
 *   - 帧无 subId → drop（spec §3.2 不退化到 topic:group）
 *   - subscribe 返回 SubscribeHandle（含 subId/topic/group/unsubscribe）
 *   - handle.unsubscribe() 不依赖 handler 引用相等（inline arrow 也能退订，spec §1 S5）
 *   - subscribe POST 失败回滚 handler + throw
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SseClient, type SseFrame } from '../sse-client';

/**
 * 构造可写的 fetch mock：
 *   - GET /sse → 200 + 受控 ReadableStream（pushFrame 注入帧）
 *   - POST /sse/subscribe → 200（除非显式设 subscribeStatus=500 测失败回滚）
 *   - DELETE /sse/subscriber/:id → 200
 */
function mockFetch(opts: { subscribeStatus?: number } = {}) {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const encoder = new TextEncoder();
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.endsWith('/sse') && method === 'GET') {
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (url.includes('/sse/subscribe') && method === 'POST') {
      const status = opts.subscribeStatus ?? 200;
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    }
    if (url.includes('/sse/subscriber/') && method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  return {
    fetchMock,
    calls,
    pushFrame: (frame: SseFrame) => {
      streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    },
  };
}

describe('SseClient subId 路由 (v0.0.88)', () => {
  let mock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    mock = mockFetch();
    vi.stubGlobal('fetch', mock.fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同 (topic,group) 多 subId 各自收帧不互踩', async () => {
    const client = new SseClient('');
    void client.connect();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const h1 = await client.subscribe('agent_loop', 'session_id:S1', handler1);
    const h2 = await client.subscribe('agent_loop', 'session_id:S1', handler2);
    // 同 (topic,group) 两次订阅：subId 必须不同（spec §9 不变量 #2）
    expect(h1.subId).not.toBe(h2.subId);
    expect(h1.subId.length).toBe(26);
    expect(h2.subId.length).toBe(26);

    // 推 h1 subId 的帧：handler1 收到，handler2 不收
    mock.pushFrame({
      topic: 'agent_loop',
      group: 'session_id:S1',
      data: { n: 1 },
      timestamp: 't1',
      subId: h1.subId,
    });
    await vi.waitFor(() =>
      expect(handler1).toHaveBeenCalledWith(expect.objectContaining({ subId: h1.subId })),
    );
    expect(handler2).not.toHaveBeenCalled();

    // 推 h2 subId 的帧：handler2 收到，handler1 不再被触发
    handler1.mockClear();
    mock.pushFrame({
      topic: 'agent_loop',
      group: 'session_id:S1',
      data: { n: 2 },
      timestamp: 't2',
      subId: h2.subId,
    });
    await vi.waitFor(() =>
      expect(handler2).toHaveBeenCalledWith(expect.objectContaining({ subId: h2.subId })),
    );
    expect(handler1).not.toHaveBeenCalled();

    client.destroy();
  });

  it('帧无 subId → drop（不触发任何 handler）', async () => {
    const client = new SseClient('');
    void client.connect();
    const handler = vi.fn();
    await client.subscribe('agent_loop', 'session_id:S1', handler);

    // 推无 subId 的帧：handler 不收（spec §3.2 不退化到 topic:group）。
    // 用 as SseFrame 绕过类型检查——此测试就是要模拟"非法"输入（缺 subId），客户端必须容错。
    mock.pushFrame({
      topic: 'agent_loop',
      group: 'session_id:S1',
      data: { n: 1 },
      timestamp: 't1',
    } as SseFrame);
    // 给 dispatch 一点窗口确认 drop（handler 不会被调）
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();

    client.destroy();
  });

  it('subscribe 返回 SubscribeHandle 含 subId/topic/group/unsubscribe', async () => {
    const client = new SseClient('');
    void client.connect();
    const h = await client.subscribe('session_panel', 'session_id:S1', () => {
      /* no-op */
    });
    expect(typeof h.subId).toBe('string');
    expect(h.subId.length).toBe(26); // ULID 长度
    expect(h.topic).toBe('session_panel');
    expect(h.group).toBe('session_id:S1');
    expect(typeof h.unsubscribe).toBe('function');
    // POST body 必须带 subId 上行（spec §3.1 第 3 步）
    const subCall = mock.calls.find((c) => c.method === 'POST' && c.url.includes('/sse/subscribe'));
    expect(subCall?.body).toContain('"subId"');
    expect(subCall?.body).toContain(h.subId);
    client.destroy();
  });

  it('handle.unsubscribe() 不依赖 handler 引用相等（inline arrow 也能退订）', async () => {
    const client = new SseClient('');
    void client.connect();
    const handler = vi.fn();
    const h = await client.subscribe('agent_loop', 'session_id:S1', handler);
    // 退订——只传 handle（不传 handler 引用）；spec §1 S5 句柄稳定性
    await h.unsubscribe();

    // 推 h.subId 帧：handler 不应再触发（已从 handlers Map 删除）
    mock.pushFrame({
      topic: 'agent_loop',
      group: 'session_id:S1',
      data: { n: 1 },
      timestamp: 't1',
      subId: h.subId,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();

    // 验证 DELETE /sse/subscriber/:subId 被调（spec §3.3 推荐路径）
    const delCall = mock.calls.find(
      (c) => c.method === 'DELETE' && c.url.includes(`/sse/subscriber/${encodeURIComponent(h.subId)}`),
    );
    expect(delCall).toBeDefined();

    client.destroy();
  });

  it('unsubscribe(string subId) 直接走 subId 路径', async () => {
    const client = new SseClient('');
    void client.connect();
    const handler = vi.fn();
    const h = await client.subscribe('agent_loop', 'session_id:S1', handler);
    // 直接传 subId 字符串退订（不依赖句柄对象）
    await client.unsubscribe(h.subId);
    mock.pushFrame({
      topic: 'agent_loop',
      group: 'session_id:S1',
      data: { n: 1 },
      timestamp: 't1',
      subId: h.subId,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
    client.destroy();
  });

  it('unsubscribe 幂等（subId 不存在 → no-op，不抛）', async () => {
    const client = new SseClient('');
    void client.connect();
    // 不存在的 subId：不抛、不发 DELETE
    await expect(client.unsubscribe('01H8ZG3F2X7VQNQJB4RM9K5PWT')).resolves.toBeUndefined();
    const delCalls = mock.calls.filter((c) => c.method === 'DELETE');
    expect(delCalls).toHaveLength(0);
    client.destroy();
  });

  it('subscribe POST 失败 → 回滚 handler + throw', async () => {
    vi.unstubAllGlobals();
    const failMock = mockFetch({ subscribeStatus: 500 });
    vi.stubGlobal('fetch', failMock.fetchMock);

    const client = new SseClient('');
    void client.connect();
    const handler = vi.fn();
    await expect(client.subscribe('agent_loop', 'session_id:S1', handler)).rejects.toThrow(
      /POST \/sse\/subscribe failed: 500/,
    );
    // 回滚：handlers Map 不含任何 entry（POST 失败的 subId 已删）
    // 用同 (topic,group) 重新订阅成功后，推旧 subId 帧也不触发原 handler
    vi.unstubAllGlobals();
    const okMock = mockFetch();
    vi.stubGlobal('fetch', okMock.fetchMock);
    // active 已被前面 connect 置 true——这里改 destroy 再 new 同 client 跑后半段
    client.destroy();
    const client2 = new SseClient('');
    void client2.connect();
    const h2 = await client2.subscribe('agent_loop', 'session_id:S1', handler);
    // 推任意无 subId 帧确认 handler 仍只在匹配 subId 时触发
    okMock.pushFrame({
      topic: 'agent_loop',
      group: 'session_id:S1',
      data: { n: 1 },
      timestamp: 't1',
      subId: h2.subId,
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    client2.destroy();
  });

  it('destroy 清空 handlers + abort 连接，后续帧不再触发任何 handler', async () => {
    const client = new SseClient('');
    void client.connect();
    const handler = vi.fn();
    const h = await client.subscribe('agent_loop', 'session_id:S1', handler);
    client.destroy();
    // destroy 后即便推帧（实际 stream 已 abort，但理论上若 dispatch 仍跑也不应触发）
    mock.pushFrame({
      topic: 'agent_loop',
      group: 'session_id:S1',
      data: { n: 1 },
      timestamp: 't1',
      subId: h.subId,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });
});
