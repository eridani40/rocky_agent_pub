/**
 * sse handlers 单测 — GET /sse + POST subscribe/unsubscribe + 非法 topic 400
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §4
 *       AT: sse/sse_subscribe_tc1
 *
 * 校验点：
 *   - GET /sse → 200 + text/event-stream + 帧格式含 topic/group/data/timestamp
 *   - POST /sse/subscribe → 200 + {ok:true}；幂等
 *   - POST /sse/subscribe topic 非 agent_loop → 400
 *   - POST /sse/subscribe 非法 JSON / 缺字段 → 400
 *   - POST /sse/unsubscribe → 200 + {ok:true}
 *
 * 用真实 SseChannel + EventHub（resetForTest 隔离）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventHub, ReplayableEventBus } from '../agent/event-hub';
import { SseChannel, parseSseFrame } from '../sse/sse-channel';
import {
  handleSseStream,
  handleSseSubscribeOps,
} from '../handlers/sse';

const AGENT_LOOP_TOPIC = 'agent_loop';

let hub: EventHub;
let bus: ReplayableEventBus;
let channel: SseChannel;

beforeEach(() => {
  EventHub.resetForTest();
  hub = EventHub.singleton();
  bus = new ReplayableEventBus({ replayable: true });
  hub.registerTopic(AGENT_LOOP_TOPIC, bus);
  channel = new SseChannel(hub);
});

afterEach(() => {
  channel.destroy();
  EventHub.resetForTest();
});

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3700${path}`, init);
}

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

describe('sse handlers', () => {
  it('GET /sse → 200 + text/event-stream + cache-control no-cache', () => {
    const r = handleSseStream(channel);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.headers.get('cache-control')).toBe('no-cache');
  });

  it('POST /sse/subscribe → 200 + {ok:true}', async () => {
    const r = await handleSseSubscribeOps(
      req('POST', '/sse/subscribe', { topic: 'agent_loop', group: 'session_id:S1' }),
      'POST',
      '/sse/subscribe',
      channel,
    );
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).ok).toBe(true);
    expect(channel.activeSubscriptionCount()).toBe(1);
  });

  it('POST /sse/subscribe 幂等（同 topic:group 不重复登记）', async () => {
    const body = { topic: 'agent_loop', group: 'session_id:S1' };
    await handleSseSubscribeOps(req('POST', '/sse/subscribe', body), 'POST', '/sse/subscribe', channel);
    await handleSseSubscribeOps(req('POST', '/sse/subscribe', body), 'POST', '/sse/subscribe', channel);
    expect(channel.activeSubscriptionCount()).toBe(1);
  });

  it('POST /sse/subscribe topic 非 agent_loop → 400', async () => {
    const r = await handleSseSubscribeOps(
      req('POST', '/sse/subscribe', { topic: 'nope', group: 'session_id:S1' }),
      'POST',
      '/sse/subscribe',
      channel,
    );
    expect(r.status).toBe(400);
  });

  it('POST /sse/subscribe session_panel topic（v0.0.12 放开） → 200', async () => {
    // v0.0.12：允许订阅 session_panel 收 session_status_update（BUG-002 TEST-2 修复）
    const r = await handleSseSubscribeOps(
      req('POST', '/sse/subscribe', { topic: 'session_panel', group: 'session_id:S1' }),
      'POST',
      '/sse/subscribe',
      channel,
    );
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).ok).toBe(true);
  });

  it('POST /sse/subscribe 缺 group → 400', async () => {
    const r = await handleSseSubscribeOps(
      req('POST', '/sse/subscribe', { topic: 'agent_loop' }),
      'POST',
      '/sse/subscribe',
      channel,
    );
    expect(r.status).toBe(400);
  });

  it('POST /sse/subscribe 非法 JSON → 400', async () => {
    const r = await handleSseSubscribeOps(
      new Request('http://127.0.0.1:3700/sse/subscribe', {
        method: 'POST',
        body: 'not-json',
      }),
      'POST',
      '/sse/subscribe',
      channel,
    );
    expect(r.status).toBe(400);
  });

  it('POST /sse/unsubscribe → 200 + {ok:true}（订阅数减 1）', async () => {
    const subR = await handleSseSubscribeOps(
      req('POST', '/sse/subscribe', { topic: 'agent_loop', group: 'session_id:S1' }),
      'POST',
      '/sse/subscribe',
      channel,
    );
    const subBody = await jsonBody(subR);
    expect(channel.activeSubscriptionCount()).toBe(1);
    const r = await handleSseSubscribeOps(
      req('POST', '/sse/unsubscribe', {
        topic: 'agent_loop',
        group: 'session_id:S1',
        subId: subBody.subId,
      }),
      'POST',
      '/sse/unsubscribe',
      channel,
    );
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).ok).toBe(true);
    expect(channel.activeSubscriptionCount()).toBe(0);
  });

  it('POST /sse/unsubscribe 缺 subId → 400（不再兜底批量取消）', async () => {
    const r = await handleSseSubscribeOps(
      req('POST', '/sse/unsubscribe', { topic: 'agent_loop', group: 'session_id:S1' }),
      'POST',
      '/sse/unsubscribe',
      channel,
    );
    expect(r.status).toBe(400);
  });

  it('GET /sse 帧格式含 topic/group/data/timestamp（订阅后 emit 一个事件）', async () => {
    // 订阅 group=session_id:S1
    await handleSseSubscribeOps(
      req('POST', '/sse/subscribe', { topic: 'agent_loop', group: 'session_id:S1' }),
      'POST',
      '/sse/subscribe',
      channel,
    );
    // 建连
    const r = handleSseStream(channel);
    expect(r.status).toBe(200);
    // 触发一个事件
    bus.emit('session_id:S1', {
      data: { type: 'run_start', runId: 'R1' },
      timestamp: '2026-06-21T00:00:00.000Z',
    });
    // 读 stream 拿数据帧：openConnection 建连时会先同步 enqueue 一个 `: keepalive\n\n`
    // 注释帧刷头（v0.0.125 bf8956d4，与 EventSource 语义一致——注释帧对客户端零影响），
    // 真正的业务帧是第二个 chunk；循环跳过 parseSseFrame 解不出的注释帧直到拿到数据帧。
    const reader = r.body!.getReader();
    let frame: ReturnType<typeof parseSseFrame> = null;
    for (let i = 0; i < 5 && frame === null; i++) {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value!);
      frame = parseSseFrame(text);
    }
    expect(frame).not.toBeNull();
    expect(frame!.topic).toBe('agent_loop');
    expect(frame!.group).toBe('session_id:S1');
    expect(frame!.data).toEqual({ type: 'run_start', runId: 'R1' });
    expect(typeof frame!.timestamp).toBe('string');
    // 关流（防 leak）
    await reader.cancel();
  });

  it('GET /sse 方法非 GET 由 router 层 405（handler 不处理 method）', async () => {
    // handler 直接接收 GET；router.test 验证 405 路由层
    // 这里仅确认 handleSseStream 返回合法流
    const r = handleSseStream(channel);
    expect(r.status).toBe(200);
  });
});
