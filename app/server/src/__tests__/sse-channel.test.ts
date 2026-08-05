/**
 * SseChannel 单测
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_channel.md §4 §5（帧格式 / 后端对象）
 *   - specs/api/version_logs/v0.0.8/change_log.md §4（SSE 端点契约）
 *   - specs/tech/version_logs/v0.0.8/change_log.md §7（EventBus/Hub + SSE channel 衔接）
 *
 * 校验点：
 *   - 帧格式严格 {topic, group, data, timestamp}（parseSseFrame 解析四字段非空）
 *   - openConnection 返回 ReadableStream + 正确 headers（text/event-stream + no-cache）
 *   - subscribe 幂等（同 topic:group 重复不重复登记 hub.sub）
 *   - D1 replay 时序：emit 后才 subscribe → 连接仍收到 replay 帧（依赖 replayable bus）
 *   - 多连接 fan-out：一帧广播到所有活跃连接
 *   - unsubscribe / destroy 清理
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventHub } from '../agent/event-hub';
import { ReplayableEventBus } from '../agent/event-bus';
import { SseChannel, parseSseFrame } from '../sse/sse-channel';

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

  // 拉直到超时或收到至少 1 帧后稍等
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

describe('SseChannel', () => {
  let hub: EventHub;
  let bus: ReplayableEventBus;

  beforeEach(() => {
    EventHub.resetForTest();
    hub = EventHub.singleton();
    bus = new ReplayableEventBus({ replayable: true });
    hub.registerTopic('agent_loop', bus);
  });

  it('openConnection 返回 ReadableStream + 正确 SSE headers', () => {
    const ch = new SseChannel(hub);
    const { body, headers } = ch.openConnection();
    expect(body).toBeInstanceOf(ReadableStream);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    body.cancel();
  });

  it('帧格式严格 {topic, group, data, timestamp, subId} 五字段非空', async () => {
    const ch = new SseChannel(hub);
    const { body } = ch.openConnection();
    ch.subscribe('agent_loop', 'session_id:S1', 'sub-frame');

    // 等消费循环启动
    await new Promise((r) => setTimeout(r, 10));
    bus.emit('session_id:S1', { data: { type: 'run_start', runId: 'R1' }, timestamp: 't0' });

    const frames = await drainFrames(body);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const f = frames[0];
    expect(f).not.toBeNull();
    expect(f!.topic).toBe('agent_loop');
    expect(f!.group).toBe('session_id:S1');
    expect(f!.timestamp).toBeTruthy();
    expect(typeof f!.timestamp).toBe('string');
    expect(f!.data).toEqual({ type: 'run_start', runId: 'R1' });
    expect(f!.subId).toBe('sub-frame');
  });

  it('subscribe 幂等：同 subId 重复订阅不重复登记', async () => {
    const ch = new SseChannel(hub);
    const { body } = ch.openConnection();

    ch.subscribe('agent_loop', 'session_id:S1', 'sub-idem');
    ch.subscribe('agent_loop', 'session_id:S1', 'sub-idem'); // 重复
    ch.subscribe('agent_loop', 'session_id:S1', 'sub-idem'); // 再重复

    expect(ch.activeSubscriptionCount()).toBe(1);
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(1);

    await new Promise((r) => setTimeout(r, 10));
    bus.emit('session_id:S1', { data: 'X', timestamp: 't1' });
    const frames = await drainFrames(body);
    // 去重生效：listener 只收一次（不重复）
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('X');
  });

  it('D1 replay 时序：emit 后才 subscribe 仍收到 replay 帧（replayable bus 保证）', async () => {
    const ch = new SseChannel(hub);
    const { body } = ch.openConnection();

    // 先 emit 两事件（此时未订阅，进入 bus buffer）
    bus.emit('session_id:S1', { data: 'A', timestamp: 't1' });
    bus.emit('session_id:S1', { data: 'B', timestamp: 't2' });

    await new Promise((r) => setTimeout(r, 10));
    // 之后才 subscribe —— replayable bus 会回放 buffer 给 hub.sub 的 listener
    ch.subscribe('agent_loop', 'session_id:S1', 'sub-replay');

    const frames = await drainFrames(body, 800);
    const dataVals = frames.map((f) => f.data);
    expect(dataVals).toContain('A');
    expect(dataVals).toContain('B');
  });

  it('多连接 fan-out：同一订阅的帧广播到所有活跃连接', async () => {
    const ch = new SseChannel(hub);
    const c1 = ch.openConnection();
    const c2 = ch.openConnection();

    ch.subscribe('agent_loop', 'session_id:S1', 'sub-fan');
    await new Promise((r) => setTimeout(r, 10));
    bus.emit('session_id:S1', { data: 'FANOUT', timestamp: 't1' });

    const [f1, f2] = await Promise.all([
      drainFrames(c1.body),
      drainFrames(c2.body),
    ]);
    expect(f1.some((f) => f.data === 'FANOUT')).toBe(true);
    expect(f2.some((f) => f.data === 'FANOUT')).toBe(true);
  });

  it('unsubscribe 后新事件不再到达连接', async () => {
    const ch = new SseChannel(hub);
    const { body } = ch.openConnection();
    ch.subscribe('agent_loop', 'session_id:S1', 'sub-unsub');
    await new Promise((r) => setTimeout(r, 10));

    bus.emit('session_id:S1', { data: 'BEFORE', timestamp: 't1' });
    const beforeFrames = await drainFrames(body, 300);
    expect(beforeFrames.some((f) => f.data === 'BEFORE')).toBe(true);

    ch.unsubscribe('sub-unsub');
    expect(ch.activeSubscriptionCount()).toBe(0);

    bus.emit('session_id:S1', { data: 'AFTER', timestamp: 't2' });
    // 重新 openConnection 观察新订阅场景下 AFTER 不到达
    const { body: body2 } = ch.openConnection();
    await new Promise((r) => setTimeout(r, 20));
    const afterFrames = await drainFrames(body2, 300);
    expect(afterFrames.some((f) => f.data === 'AFTER')).toBe(false);
  });

  it('destroy 后 activeConnectionCount / activeSubscriptionCount 归零', () => {
    const ch = new SseChannel(hub);
    ch.openConnection();
    ch.subscribe('agent_loop', 'session_id:S1', 'sub-destroy');
    expect(ch.activeSubscriptionCount()).toBe(1);

    ch.destroy();
    expect(ch.activeSubscriptionCount()).toBe(0);
    // hub 侧订阅也被取消
    expect(hub.activeSubscriptionCount('agent_loop', 'session_id:S1')).toBe(0);
  });

  it('openConnection 立即推送 keepalive 注释帧（首字节不阻塞）', async () => {
    // 修复 Bun ReadableStream 惰性刷头问题：连接建立后无需任何 subscribe/emit，
    // 应立即能从 stream 读到第一个字节（keepalive 注释帧 `: keepalive\n\n`）
    const ch = new SseChannel(hub);
    const { body } = ch.openConnection();
    const reader = body.getReader();
    const deadline = Date.now() + 200; // 200ms 内必须收到首字节
    let gotBytes = false;
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 150),
        ),
      ]);
      if (done || value === undefined) break;
      if (value.length > 0) {
        gotBytes = true;
        break;
      }
    }
    reader.cancel().catch(() => {});
    expect(gotBytes).toBe(true); // 连接后应立即收到 keepalive 注释帧字节
  });

  it('parseSseFrame：合法帧解析五字段（含 subId）/ 非法帧返 null', () => {
    const valid = parseSseFrame(
      'data: {"topic":"agent_loop","group":"g","data":{"x":1},"timestamp":"2026-06-21T00:00:00Z","subId":"sub-parse"}\n\n',
    );
    expect(valid).toEqual({
      topic: 'agent_loop',
      group: 'g',
      data: { x: 1 },
      timestamp: '2026-06-21T00:00:00Z',
      subId: 'sub-parse',
    });

    // 缺 subId 的帧视为非法（v0.0.88 subId 必填）
    expect(
      parseSseFrame(
        'data: {"topic":"agent_loop","group":"g","data":{"x":1},"timestamp":"2026-06-21T00:00:00Z"}\n\n',
      ),
    ).toBeNull();
    expect(parseSseFrame('data: not-json\n\n')).toBeNull();
    expect(parseSseFrame('event: foo\ndata: {}\n\n')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });

  /**
   * [v0.0.27] isSessionActive 前台判定（spec sse_channel.md §5/§7 + session_state.md §6.2）。
   * 唯一前台原语：subs Map 含 `session_panel:session_id:<sid>` → true；否则 false。
   * 用于 agent-loop markIdle/markError 后决定是否产生未读。
   */
  describe('isSessionActive — 前台判定（v0.0.27）', () => {
    let sseChannel: SseChannel;
    const SESSION_PANEL_TOPIC = 'session_panel';

    beforeEach(() => {
      hub.registerTopic(SESSION_PANEL_TOPIC, new ReplayableEventBus({ replayable: true }));
      sseChannel = new SseChannel(hub);
    });

    it('subscribe 前 isSessionActive=false（无订阅）', () => {
      const sid = 'sess-123';
      expect(sseChannel.isSessionActive(sid)).toBe(false);
    });

    it('subscribe session_panel:session_id:<sid> 后 isSessionActive=true（前台）', () => {
      const sid = 'sess-123';
      sseChannel.subscribe(SESSION_PANEL_TOPIC, `session_id:${sid}`, 'sub-active-1');
      expect(sseChannel.isSessionActive(sid)).toBe(true);
    });

    it('unsubscribe session_panel 后 isSessionActive=false（切走/离开）', () => {
      const sid = 'sess-123';
      sseChannel.subscribe(SESSION_PANEL_TOPIC, `session_id:${sid}`, 'sub-active-2');
      expect(sseChannel.isSessionActive(sid)).toBe(true);
      sseChannel.unsubscribe('sub-active-2');
      expect(sseChannel.isSessionActive(sid)).toBe(false);
    });

    it('只 subscribe agent_loop 不影响 isSessionActive（非 session_panel topic）', () => {
      const sid = 'sess-123';
      sseChannel.subscribe('agent_loop', `session_id:${sid}`, 'sub-active-3');
      expect(sseChannel.isSessionActive(sid)).toBe(false); // 仅 agent_loop 订阅不算前台
    });

    it('多 session 隔离：subscribe A 不影响 B 的 isSessionActive', () => {
      const sidA = 'sess-A';
      const sidB = 'sess-B';
      sseChannel.subscribe(SESSION_PANEL_TOPIC, `session_id:${sidA}`, 'sub-active-A');
      expect(sseChannel.isSessionActive(sidA)).toBe(true);
      expect(sseChannel.isSessionActive(sidB)).toBe(false);
    });
  });
});
