/**
 * SseChannel 多订阅单测（v0.0.88 方案 B：广播 + subId 注入 + channel 侧 refcount）
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_channel_multipub.md §2-§7（设计权威）
 *   - specs/tech/version_logs/v0.0.88/change_plan.md §「后端 — SseChannel 多订阅」L31-44
 *   - specs/api/version_logs/v0.0.88/change_log.md §2-§5
 *
 * 校验点（对齐 task.json T2 acceptanceCriteria）：
 *   1. SubscriberProxy 不持 sink 引用 / writeFrame 广播不变 / 帧 subId 注入
 *   2. groupSubs Set<subId> refcount 控制 hub.unsub 时机（Set 非空不拆 bus 消费者）
 *   3. POST subscribe 带 subId / DELETE subscriber/:subId / 缺 subId 走 ULID 兜底
 *
 * 与 sse-channel.test.ts 关系：本文件专注 v0.0.88 多订阅新行为（subId 必传）；
 * sse-channel.test.ts 覆盖帧格式 / fan-out / destroy 等基础契约。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventHub } from '../agent/event-hub';
import { ReplayableEventBus } from '../agent/event-bus';
import { SseChannel, parseSseFrame } from '../sse/sse-channel';
import { handleSseSubscribeOps } from '../handlers/sse';

/** 从 ReadableStream<Uint8Array> 拉取所有 SSE 帧（按 \n\n 切分），返回非 null SseFrame[] */
async function drainFrames(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 500,
): Promise<NonNullable<ReturnType<typeof parseSseFrame>>[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: NonNullable<ReturnType<typeof parseSseFrame>>[] = [];
  const deadline = Date.now() + timeoutMs;
  let gotAny = false;
  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), 80),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done || value === undefined) {
      if (gotAny) break;
      continue;
    }
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx !== -1) {
      const raw = buf.slice(0, idx + 2);
      buf = buf.slice(idx + 2);
      const f = parseSseFrame(raw);
      if (f) {
        frames.push(f);
        gotAny = true;
      }
      idx = buf.indexOf('\n\n');
    }
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return frames;
}

describe('SseChannel 多订阅（v0.0.88 方案 B）', () => {
  let hub: EventHub;
  let bus: ReplayableEventBus;

  beforeEach(() => {
    EventHub.resetForTest();
    hub = EventHub.singleton();
    bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);
  });

  describe('帧格式 + subId 注入', () => {
    it('帧含 subId 字段（listener 闭包注入 subId）', async () => {
      const ch = new SseChannel(hub);
      const { body } = ch.openConnection();
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');

      await new Promise((r) => setTimeout(r, 10));
      bus.emit('session_id:S1', { data: 'X', timestamp: 't0' });

      const frames = await drainFrames(body);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[0]!.subId).toBe('subA');
      expect(frames[0]!.data).toBe('X');
    });

    it('不同 subId 各自的帧带各自 subId（fan-out 注入独立 subId）', async () => {
      const ch = new SseChannel(hub);
      const { body } = ch.openConnection();
      // 同 (topic,group) 两个 subId（多订阅者）
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      ch.subscribe('agent_loop', 'session_id:S1', 'subB');

      await new Promise((r) => setTimeout(r, 10));
      bus.emit('session_id:S1', { data: 'evt', timestamp: 't0' });

      const frames = await drainFrames(body);
      const subIds = new Set(frames.map((f) => f.subId));
      // dispatcher fan-out 到两个 proxy，每个写一帧带自己 subId
      expect(subIds.has('subA')).toBe(true);
      expect(subIds.has('subB')).toBe(true);
    });

    it('writeFrame 广播语义不变（多 sink 都收到带 subId 的帧）', async () => {
      const ch = new SseChannel(hub);
      const c1 = ch.openConnection();
      const c2 = ch.openConnection();

      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      await new Promise((r) => setTimeout(r, 10));
      bus.emit('session_id:S1', { data: 'BCAST', timestamp: 't1' });

      const [f1, f2] = await Promise.all([drainFrames(c1.body), drainFrames(c2.body)]);
      // 两个 sink 都收到 subA 帧（广播，不定向）
      expect(f1.some((f) => f.subId === 'subA')).toBe(true);
      expect(f2.some((f) => f.subId === 'subA')).toBe(true);
    });
  });

  describe('groupSubs refcount（channel 层）', () => {
    it('v0.0.207：每 subId 独立 hub.sub / hub refcount = N / channel groupSubs 仍 1（一个 topic:group）', () => {
      const ch = new SseChannel(hub);
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(1);

      // 二 sub 同 (topic,group)：v0.0.207 每 subId 各自 hub.sub（不再共享 dispatcher）
      ch.subscribe('agent_loop', 'session_id:S1', 'subB');
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(2);
      // channel 侧 activeSubscriptionCount = groupSubs.size 维度（topic:group 数），仍 1
      expect(ch.activeSubscriptionCount()).toBe(1);
    });

    it('v0.0.207：退订逐条 hub.unsub，归零才清 groupSubs + 触发 onUnsubscribe', () => {
      const ch = new SseChannel(hub);
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      ch.subscribe('agent_loop', 'session_id:S1', 'subB');
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(2);

      // 退一个：hub refcount -1，groupSubs Set 还有 subB → 不触发 onUnsubscribe
      ch.unsubscribe('subA');
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(1);

      // 退最后一个：hub refcount=0 + groupSubs Set.size=0 → onUnsubscribe
      ch.unsubscribe('subB');
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(0);
      expect(ch.activeSubscriptionCount()).toBe(0);
    });

    it('幂等：同 subId 重复 subscribe no-op（不重复入 subscribers）', () => {
      const ch = new SseChannel(hub);
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      ch.subscribe('agent_loop', 'session_id:S1', 'subA'); // 重复
      ch.subscribe('agent_loop', 'session_id:S1', 'subA'); // 再重复
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(1);
      expect(ch.activeSubscriptionCount()).toBe(1);
    });

    it('退订 subId 不存在 → no-op（不抛错）', () => {
      const ch = new SseChannel(hub);
      expect(() => ch.unsubscribe('not-exist')).not.toThrow();
    });

    it('onSubscribe/onUnsubscribe 在 groupSubs Set 0↔N 边界触发', () => {
      const events: string[] = [];
      const ch = new SseChannel(hub);
      ch.setSubscribeHooks({
        onSubscribe: () => {
          events.push('sub');
        },
        onUnsubscribe: () => {
          events.push('unsub');
        },
      });

      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      ch.subscribe('agent_loop', 'session_id:S1', 'subB'); // 不触发（非首）
      expect(events).toEqual(['sub']);

      ch.unsubscribe('subA'); // 不触发（非末）
      expect(events).toEqual(['sub']);

      ch.unsubscribe('subB'); // 触发（末）
      expect(events).toEqual(['sub', 'unsub']);
    });

    it('中间退订后 dispatcher 不再给已退订的 sub 投递', async () => {
      const ch = new SseChannel(hub);
      const { body } = ch.openConnection();
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      ch.subscribe('agent_loop', 'session_id:S1', 'subB');
      await new Promise((r) => setTimeout(r, 10));

      // 退 subA
      ch.unsubscribe('subA');
      bus.emit('session_id:S1', { data: 'after', timestamp: 't1' });
      const frames = await drainFrames(body);
      // 仅 subB 帧到达
      expect(frames.some((f) => f.subId === 'subA')).toBe(false);
      expect(frames.some((f) => f.subId === 'subB')).toBe(true);
    });
  });

  describe('isSessionActive（v0.0.88 改查 groupSubs size）', () => {
    beforeEach(() => {
      hub.registerTopic('session_panel', new ReplayableEventBus({ replayable: true }));
    });

    it('subscribe session_panel 后 isSessionActive=true', () => {
      const ch = new SseChannel(hub);
      ch.subscribe('session_panel', 'session_id:S1', 'subA');
      expect(ch.isSessionActive('S1')).toBe(true);
    });

    it('多 sub 时退一个不影响 active（groupSubs size > 0）', () => {
      const ch = new SseChannel(hub);
      ch.subscribe('session_panel', 'session_id:S1', 'subA');
      ch.subscribe('session_panel', 'session_id:S1', 'subB');
      expect(ch.isSessionActive('S1')).toBe(true);

      ch.unsubscribe('subA'); // 仍有 subB
      expect(ch.isSessionActive('S1')).toBe(true);

      ch.unsubscribe('subB'); // 全退
      expect(ch.isSessionActive('S1')).toBe(false);
    });
  });

  describe('handlers/sse.ts 路由（POST subscribe + DELETE subscriber）', () => {
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

    it('POST /sse/subscribe 带 subId → 200 + 响应回传 subId', async () => {
      const ch = new SseChannel(hub);
      const r = await handleSseSubscribeOps(
        req('POST', '/sse/subscribe', {
          topic: 'agent_loop',
          group: 'session_id:S1',
          subId: 'sub-explicit',
        }),
        'POST',
        '/sse/subscribe',
        ch,
      );
      expect(r.status).toBe(200);
      expect((await jsonBody(r)).subId).toBe('sub-explicit');
    });

    it('POST /sse/subscribe 缺 subId → 200 + 后端生成 ULID（26 字符）', async () => {
      const ch = new SseChannel(hub);
      const r = await handleSseSubscribeOps(
        req('POST', '/sse/subscribe', { topic: 'agent_loop', group: 'session_id:S1' }),
        'POST',
        '/sse/subscribe',
        ch,
      );
      expect(r.status).toBe(200);
      const body = await jsonBody(r);
      expect(body.ok).toBe(true);
      expect(typeof body.subId).toBe('string');
      expect(body.subId.length).toBe(26); // ULID 标准长度
    });

    it('DELETE /sse/subscriber/:subId → 200 + 精准取消该订阅', async () => {
      const ch = new SseChannel(hub);
      // 先订阅两个 subId
      await handleSseSubscribeOps(
        req('POST', '/sse/subscribe', {
          topic: 'agent_loop',
          group: 'session_id:S1',
          subId: 'sub-del-1',
        }),
        'POST',
        '/sse/subscribe',
        ch,
      );
      await handleSseSubscribeOps(
        req('POST', '/sse/subscribe', {
          topic: 'agent_loop',
          group: 'session_id:S1',
          subId: 'sub-del-2',
        }),
        'POST',
        '/sse/subscribe',
        ch,
      );
      expect(ch.activeSubscriptionCount()).toBe(1); // 一个 (topic,group)

      // DELETE 一个 sub
      const r = await handleSseSubscribeOps(
        req('DELETE', '/sse/subscriber/sub-del-1'),
        'DELETE',
        '/sse/subscriber/sub-del-1',
        ch,
      );
      expect(r.status).toBe(200);
      // 仍有 sub-del-2 → hub 订阅未拆
      expect(ch.activeSubscriptionCount()).toBe(1);

      // DELETE 另一个
      await handleSseSubscribeOps(
        req('DELETE', '/sse/subscriber/sub-del-2'),
        'DELETE',
        '/sse/subscriber/sub-del-2',
        ch,
      );
      // 全退 → hub 订阅拆
      expect(ch.activeSubscriptionCount()).toBe(0);
    });

    it('DELETE 不存在的 subId → 200 no-op（幂等）', async () => {
      const ch = new SseChannel(hub);
      const r = await handleSseSubscribeOps(
        req('DELETE', '/sse/subscriber/not-exist'),
        'DELETE',
        '/sse/subscriber/not-exist',
        ch,
      );
      expect(r.status).toBe(200);
      expect((await jsonBody(r)).ok).toBe(true);
    });

    it('POST /sse/unsubscribe 带 subId → 精准取消（POST 路径）', async () => {
      const ch = new SseChannel(hub);
      await handleSseSubscribeOps(
        req('POST', '/sse/subscribe', {
          topic: 'agent_loop',
          group: 'session_id:S1',
          subId: 'sub-post-unsub',
        }),
        'POST',
        '/sse/subscribe',
        ch,
      );
      const r = await handleSseSubscribeOps(
        req('POST', '/sse/unsubscribe', {
          topic: 'agent_loop',
          group: 'session_id:S1',
          subId: 'sub-post-unsub',
        }),
        'POST',
        '/sse/unsubscribe',
        ch,
      );
      expect(r.status).toBe(200);
      expect(ch.activeSubscriptionCount()).toBe(0);
    });
  });

  describe('destroy：遍历 subscribers unsubscribe', () => {
    it('destroy 后 subscribers 全清 + hub 订阅全拆', () => {
      const ch = new SseChannel(hub);
      ch.subscribe('agent_loop', 'session_id:S1', 'subA');
      ch.subscribe('agent_loop', 'session_id:S1', 'subB');
      ch.subscribe('agent_loop', 'session_id:S2', 'subC');
      expect(ch.activeSubscriptionCount()).toBe(2); // 两个 topic:group

      ch.destroy();
      expect(ch.activeSubscriptionCount()).toBe(0);
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(0);
      expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S2')).toBe(0);
    });
  });
});
