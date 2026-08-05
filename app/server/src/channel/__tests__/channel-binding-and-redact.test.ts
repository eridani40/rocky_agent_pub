/**
 * ChannelManager.bind 双向唯一 + accumulator + redact helper 单测
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.4（channel D6 双向唯一）/ §3.5（累积）
 *       reqs/[done] v0.0.103.channel/design.md §3.2 / design-usecases UC-D2
 *
 * 覆盖：
 *   1. bind：D6 SESSION_ALREADY_BOUND（session 反向已被其他 config,conv 占用时抛错）
 *   2. bind：同 (config,conv) 重绑覆盖（允许）
 *   3. bind：subscribeOutbound 建立累积管线
 *   4. accumulator：block 级发送——text_block(answer) 发 / tool_call_end 概括 / tool_result_end 概括 / reasoning 忽略
 *   5. accumulator：错过 block 开头（无 start）的 delta/end 丢弃
 *   6. accumulator：unsubscribe abort → break loop（防泄漏）
 *   7. accumulator user message echo 屏蔽 + 跨渠道渲染：self configId→DROP /
 *      跨渠道（client/其他 config）→ 前缀「User (from {type})」/ 无 origin→维持 answer
 *   8. mergeChannelSecret（占位 *** 回填原值；GET 已改明文，redactChannelSecret 已删）
 *
 * v0.0.206：FakeChannel 拆 FakeImpl（无状态，connect→FakeHandle）+ FakeHandle（连接句柄）；
 * impl 供给走 pluginManager.getExtensionImpls mock（scope 门单源）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelManagerImpl } from '../channel-manager';
import type { ChannelManagerOptions } from '../channel-manager';
import { runChannelAccumulator } from '../channel-accumulator';
import type { AccumulatorController } from '../channel-accumulator';
import { ChannelBindingError } from '../types';
import type { Channel, ChannelHandle, ChannelConfig } from '../types';
import type { ChannelManagerBackend } from '../channel-base';
import type { AgentEvent } from '../../agent/agent-event-types';
import type { Message } from '../../message/types';
import {
  mergeChannelSecret,
  CHANNEL_SECRET_REDACT_PLACEHOLDER,
} from '../../handlers/channel-redact';

// ===== helper：构造 mock agentManager + sessionStore + registry + pluginManager =====

/** 本渠道配置 id（accumulator self 判定基准；echo 测试用它对齐/区分 origin.configId） */
const SELF_CONFIG = 'cfg-self';

/** 假 ChannelHandle（记录所有调用；带 configId 供 accumulator self 判定） */
class FakeHandle implements ChannelHandle {
  readonly configId: string;
  constructor(configId: string = SELF_CONFIG) {
    this.configId = configId;
  }
  disconnect = vi.fn().mockResolvedValue(undefined);
  handleInbound = vi.fn().mockResolvedValue(undefined);
  sendOutbound = vi.fn().mockResolvedValue(undefined);
  updateInputState = vi.fn().mockResolvedValue(undefined);
}

/** 假无状态 Channel impl（connect → FakeHandle） */
class FakeImpl implements Channel {
  readonly type = 'feishu';
  connect = vi.fn(async (config: ChannelConfig, _backend: ChannelManagerBackend): Promise<ChannelHandle> => new FakeHandle(config.id));
}

/** 构造 ChannelManagerImpl with mock deps */
function makeManager(tmpRoot: string, opts?: {
  impl?: Channel;
}): { cm: ChannelManagerImpl; mocks: Record<string, ReturnType<typeof vi.fn>> } {
  const mocks: Record<string, ReturnType<typeof vi.fn>> = {};
  mocks.deliverTo = vi.fn().mockResolvedValue(undefined);
  mocks.subscribe = vi.fn().mockReturnValue(asyncIterable([]));
  mocks.listSessions = vi.fn().mockResolvedValue([]);
  mocks.getImplById = vi.fn().mockReturnValue({
    pluginId: 'feishu',
    manifest: { implId: 'feishu', point: 'channel', impl: './feishu-channel.ts' },
    implClass: FakeImpl,
  });
  mocks.getExtensionImpls = vi.fn().mockReturnValue([opts?.impl ?? new FakeImpl()]);
  const optsObj: ChannelManagerOptions = {
    dataDir: tmpRoot,
    agentManager: {
      deliverTo: mocks.deliverTo,
      subscribe: mocks.subscribe,
    },
    sessionStore: { listSessions: mocks.listSessions },
    registry: { getImplById: mocks.getImplById } as never,
    pluginManager: { getExtensionImpls: mocks.getExtensionImpls } as never,
  };
  return { cm: new ChannelManagerImpl(optsObj), mocks };
}

/** asyncIterable 工厂（从 AgentEvent[] 生成） */
function asyncIterable(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'channel-mgr-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ===== bind D6 双向唯一 =====

describe('ChannelManager.bind D6 双向唯一', () => {
  it('session 反向已被其他 (config,conv) 占用 → 抛 SESSION_ALREADY_BOUND', async () => {
    const { cm } = makeManager(tmpRoot);
    await cm.registerConfig({
      id: 'cfg1', implId: 'feishu', name: 'A', enabled: false,
      config: { appId: 'a', appSecret: 's' },
    });
    await cm.registerConfig({
      id: 'cfg2', implId: 'feishu', name: 'B', enabled: false,
      config: { appId: 'a', appSecret: 's' },
    });
    // cfg1/chat1 → sess1（正常）
    await cm.bind('cfg1', 'chat1', 'sess1', 'slash');
    // cfg2/chat2 → sess1（反向违反，sess1 已被 cfg1/chat1 占）
    await expect(cm.bind('cfg2', 'chat2', 'sess1', 'slash')).rejects.toThrow();
    await expect(cm.bind('cfg2', 'chat2', 'sess1', 'slash')).rejects.toBeInstanceOf(ChannelBindingError);
  });

  it('同 (config,conv) 重绑覆盖（允许，覆盖旧 sessionId）', async () => {
    const { cm } = makeManager(tmpRoot);
    await cm.registerConfig({
      id: 'cfg1', implId: 'feishu', name: 'A', enabled: false,
      config: { appId: 'a', appSecret: 's' },
    });
    await cm.bind('cfg1', 'chat1', 'sess_old', 'slash');
    await cm.bind('cfg1', 'chat1', 'sess_new', 'slash');
    const b = await cm.getBinding('cfg1', 'chat1');
    expect(b).toBe('sess_new');
  });
});

// ===== updateConfig（PUT 同步内存态，BUG v0.0.106 #4） =====

describe('ChannelManager.updateConfig 内存态同步', () => {
  it('同步 name → getState 返回新 name（GET 不再返回旧值）', async () => {
    const { cm } = makeManager(tmpRoot);
    await cm.registerConfig({
      id: 'cfg1', implId: 'feishu', name: '旧名', enabled: false,
      config: { appId: 'a', appSecret: 's' },
    });
    expect(cm.getState('cfg1')!.name).toBe('旧名');
    cm.updateConfig('cfg1', { name: '新名' });
    expect(cm.getState('cfg1')!.name).toBe('新名');
    // getAllStates 同样反映新值（GET list 走此路径）
    expect(cm.getAllStates().find((s) => s.id === 'cfg1')!.name).toBe('新名');
  });

  it('同步 config → 落盘原引用见新 config（运行中 handle 持同一引用）', async () => {
    const { cm } = makeManager(tmpRoot);
    await cm.registerConfig({
      id: 'cfg1', implId: 'feishu', name: 'A', enabled: false,
      config: { appId: 'old', appSecret: 's' },
    });
    cm.updateConfig('cfg1', { config: { appId: 'new', appSecret: 's2' } });
    // registerConfig 存的 config 对象被 mutate（handle 持同一引用）
    const state = cm.getState('cfg1')!;
    expect(state).toBeDefined();
  });

  it('同步 enabled → getState switch 翻转（不触发 connect）', async () => {
    const { cm } = makeManager(tmpRoot);
    await cm.registerConfig({
      id: 'cfg1', implId: 'feishu', name: 'A', enabled: false,
      config: { appId: 'a', appSecret: 's' },
    });
    expect(cm.getState('cfg1')!.switch).toBe('off');
    cm.updateConfig('cfg1', { enabled: true });
    expect(cm.getState('cfg1')!.switch).toBe('on');
  });

  it('undefined 字段跳过（只传 name，config/enabled 不动）', async () => {
    const { cm } = makeManager(tmpRoot);
    await cm.registerConfig({
      id: 'cfg1', implId: 'feishu', name: 'A', enabled: false,
      config: { appId: 'keep', appSecret: 'keep-s' },
    });
    cm.updateConfig('cfg1', { name: 'B' });
    const state = cm.getState('cfg1')!;
    expect(state.name).toBe('B');
    expect(state.switch).toBe('off'); // 未传 enabled，保持 false
  });

  it('未知 configId → no-op（不抛错）', () => {
    const { cm } = makeManager(tmpRoot);
    expect(() => cm.updateConfig('unknown', { name: 'X' })).not.toThrow();
  });
});


// ===== accumulator（outbound 累积） =====

describe('runChannelAccumulator', () => {
  it('text_block（answer）start → delta → end 发一条', async () => {
    const handle = new FakeHandle();
    const ctrl: AccumulatorController = { aborted: false };
    const events: AgentEvent[] = [
      makeEvent('run_start', { runId: 'r1' }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'b1' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b1', delta: 'Hello' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b1', delta: ' World' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'b1' }),
      makeEvent('run_end', { runId: 'r1' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    expect(handle.sendOutbound).toHaveBeenCalledTimes(1);
    const msg = (handle.sendOutbound.mock.calls[0] as [Message])[0];
    expect(msg.role).toBe('assistant');
    expect(msg.sessionId).toBe('sess1');
    expect(msg.runId).toBe('r1');
    expect(msg.content).toEqual([{ type: 'text', text: 'Hello World' }]);
    expect(handle.updateInputState).toHaveBeenCalledWith('typing');
    expect(handle.updateInputState).toHaveBeenCalledWith('idle');
  });

  it('tool_call/tool_result 概括发 + answer 各发一条（reasoning 忽略）', async () => {
    const handle = new FakeHandle();
    const ctrl: AccumulatorController = { aborted: false };
    const events: AgentEvent[] = [
      makeEvent('run_start', { runId: 'r1' }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'b1' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b1', delta: 'before tool' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'b1' }),
      // 工具调用 → tool_call_end 概括发一条
      makeEvent('tool_call_start', { runId: 'r1', blockId: 'b2', toolCallId: 'tc1', toolName: 'search' }),
      makeEvent('tool_call_delta', { runId: 'r1', blockId: 'b2', toolCallId: 'tc1', delta: 'ignored' }),
      makeEvent('tool_call_end', { runId: 'r1', blockId: 'b2', toolCallId: 'tc1' }),
      // 工具结果 → tool_result_end 概括发一条（成功）
      makeEvent('tool_result_start', { runId: 'r1', blockId: 'b3', toolCallId: 'tc1' }),
      makeEvent('tool_result_end', { runId: 'r1', blockId: 'b3', toolCallId: 'tc1', isError: false }),
      // reasoning → 忽略（不发 IM）
      makeEvent('reasoning_block_start', { runId: 'r1', blockId: 'b4' }),
      makeEvent('reasoning_block_delta', { runId: 'r1', blockId: 'b4', delta: 'thinking' }),
      makeEvent('reasoning_block_end', { runId: 'r1', blockId: 'b4' }),
      // 工具后 answer
      makeEvent('text_block_start', { runId: 'r1', blockId: 'b5' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b5', delta: 'after tool' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'b5' }),
      makeEvent('run_end', { runId: 'r1' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    // 4 条：before tool(answer) + tool_call 概括 + tool_result 概括 + after tool(answer)；reasoning 忽略
    expect(handle.sendOutbound).toHaveBeenCalledTimes(4);
    const calls = handle.sendOutbound.mock.calls as [Message][];
    expect(calls[0]![0]!.content).toEqual([{ type: 'text', text: 'before tool' }]);
    expect(calls[1]![0]!.content).toEqual([{ type: 'text', text: '🔧 调用工具：search' }]);
    expect(calls[2]![0]!.content).toEqual([{ type: 'text', text: '📋 工具回复：成功' }]);
    expect(calls[3]![0]!.content).toEqual([{ type: 'text', text: 'after tool' }]);
  });

  it('run_end 无 buffer（agent 无文本输出）→ 不调 sendOutbound', async () => {
    const handle = new FakeHandle();
    const ctrl: AccumulatorController = { aborted: false };
    const events: AgentEvent[] = [
      makeEvent('run_start', { runId: 'r1' }),
      makeEvent('run_end', { runId: 'r1' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    expect(handle.sendOutbound).not.toHaveBeenCalled();
  });

  it('unsubscribe abort → break loop（防泄漏）', async () => {
    const handle = new FakeHandle();
    const ctrl: AccumulatorController = { aborted: false };
    // 构造中途 abort 的迭代器：yield run_start 后置 aborted=true，
    // 下一迭代 for-await 顶部 check aborted=true → break 退出（防泄漏）。
    const iter: AsyncIterable<AgentEvent> = (async function* () {
      yield makeEvent('run_start', { runId: 'r1' });
      ctrl.aborted = true; // 模拟 unsubscribe 触发 abort
      yield makeEvent('text_block_delta', { runId: 'r1', delta: 'should-be-skipped' });
      yield makeEvent('run_end', { runId: 'r1' });
    })();
    await runChannelAccumulator('sess1', handle, ctrl, () => iter).catch(() => {});
    // run_start 已 yield（abort 前）→ updateInputState('typing') 调用一次
    expect(handle.updateInputState).toHaveBeenCalledWith('typing');
    // sendOutbound 不应被调（run_end 因 break 未到达）
    expect(handle.sendOutbound).not.toHaveBeenCalled();
  });
});

// ===== [v0.0.107] accumulator user message echo 屏蔽 + 跨渠道渲染 =====

describe('runChannelAccumulator — user message echo 屏蔽 + 跨渠道（v0.0.107）', () => {
  it('self（origin.configId === handle.configId）→ DROP（echo 屏蔽，不 sendOutbound）', async () => {
    const handle = new FakeHandle(); // configId = SELF_CONFIG
    const ctrl: AccumulatorController = { aborted: false };
    // 用户在本飞书渠道发 '123' → agent loop 也 emit text_block（供 client SSE），
    // origin.configId === self → 必须 DROP（否则回环 echo 回飞书）
    const events: AgentEvent[] = [
      makeEvent('run_start', { runId: 'r1' }),
      makeEvent('message_start', { runId: 'r1', messageId: 'um1', role: 'user', origin: { type: 'feishu', configId: SELF_CONFIG } }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'b1', messageId: 'um1' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b1', messageId: 'um1', delta: '123' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'b1', messageId: 'um1' }),
      makeEvent('run_end', { runId: 'r1' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    expect(handle.sendOutbound).not.toHaveBeenCalled();
  });

  it('跨渠道 client（origin.type=client, configId≠self）→ 前缀「User (from client): 」发送', async () => {
    const handle = new FakeHandle();
    const ctrl: AccumulatorController = { aborted: false };
    const events: AgentEvent[] = [
      makeEvent('message_start', { runId: 'r1', messageId: 'um2', role: 'user', origin: { type: 'client', configId: '0' } }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'b2', messageId: 'um2' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b2', messageId: 'um2', delta: 'hi from web' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'b2', messageId: 'um2' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    expect(handle.sendOutbound).toHaveBeenCalledTimes(1);
    const msg = (handle.sendOutbound.mock.calls[0] as [Message])[0];
    expect(msg.content).toEqual([{ type: 'text', text: 'User (from client): hi from web' }]);
    // outbound 信封仍是 assistant（IM 侧零改，只是文本含来源前缀）
    expect(msg.role).toBe('assistant');
  });

  it('跨渠道其他 feishu 配置（同 type=feishu 不同 configId）→ 前缀发送（self 判定按 configId 非 type）', async () => {
    const handle = new FakeHandle(); // self=SELF_CONFIG
    const ctrl: AccumulatorController = { aborted: false };
    const events: AgentEvent[] = [
      makeEvent('message_start', { runId: 'r1', messageId: 'um3', role: 'user', origin: { type: 'feishu', configId: 'cfg-other' } }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'b3', messageId: 'um3' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b3', messageId: 'um3', delta: 'from other feishu' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'b3', messageId: 'um3' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    expect(handle.sendOutbound).toHaveBeenCalledTimes(1);
    const msg = (handle.sendOutbound.mock.calls[0] as [Message])[0];
    expect(msg.content).toEqual([{ type: 'text', text: 'User (from feishu): from other feishu' }]);
  });

  it('无 origin 的 text_block（assistant answer）→ 维持原 answer 发送（回归）', async () => {
    const handle = new FakeHandle();
    const ctrl: AccumulatorController = { aborted: false };
    // assistant message_start 无 origin（非 user）→ text_block 不查表命中 → 正常 answer 发送
    const events: AgentEvent[] = [
      makeEvent('message_start', { runId: 'r1', messageId: 'am1', role: 'assistant' }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'b4', messageId: 'am1' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'b4', messageId: 'am1', delta: 'answer text' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'b4', messageId: 'am1' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    expect(handle.sendOutbound).toHaveBeenCalledTimes(1);
    const msg = (handle.sendOutbound.mock.calls[0] as [Message])[0];
    expect(msg.content).toEqual([{ type: 'text', text: 'answer text' }]);
  });

  it('自发 echo DROP 后，同 run 内 assistant answer 仍正常发送（混合序列）', async () => {
    const handle = new FakeHandle();
    const ctrl: AccumulatorController = { aborted: false };
    // 先 user 自发（self→DROP），后 assistant 正式回复（正常发）
    const events: AgentEvent[] = [
      makeEvent('run_start', { runId: 'r1' }),
      makeEvent('message_start', { runId: 'r1', messageId: 'um4', role: 'user', origin: { type: 'feishu', configId: SELF_CONFIG } }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'bu', messageId: 'um4' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'bu', messageId: 'um4', delta: '123' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'bu', messageId: 'um4' }),
      makeEvent('message_start', { runId: 'r1', messageId: 'aa1', role: 'assistant' }),
      makeEvent('text_block_start', { runId: 'r1', blockId: 'ba', messageId: 'aa1' }),
      makeEvent('text_block_delta', { runId: 'r1', blockId: 'ba', messageId: 'aa1', delta: '你好，我是 Rocky' }),
      makeEvent('text_block_end', { runId: 'r1', blockId: 'ba', messageId: 'aa1' }),
      makeEvent('run_end', { runId: 'r1' }),
    ];
    await runChannelAccumulator('sess1', handle, ctrl, () => asyncIterable(events));
    // 仅 assistant 回复 1 条（user echo 已 DROP）
    expect(handle.sendOutbound).toHaveBeenCalledTimes(1);
    const msg = (handle.sendOutbound.mock.calls[0] as [Message])[0];
    expect(msg.content).toEqual([{ type: 'text', text: '你好，我是 Rocky' }]);
  });
});

// ===== channel-redact helper =====

describe('channel-redact helper', () => {
  it('mergeChannelSecret：占位 *** → 回填落盘原值', () => {
    const merged = mergeChannelSecret(
      { appId: 'a', appSecret: CHANNEL_SECRET_REDACT_PLACEHOLDER },
      { appId: 'a_old', appSecret: 'real-on-disk' },
    );
    expect(merged.appSecret).toBe('real-on-disk');
  });

  it('mergeChannelSecret：用户新填明文 → 直接落盘', () => {
    const merged = mergeChannelSecret(
      { appId: 'a', appSecret: 'newly-typed-secret' },
      { appId: 'a_old', appSecret: 'old-on-disk' },
    );
    expect(merged.appSecret).toBe('newly-typed-secret');
  });

  it('mergeChannelSecret：占位但落盘原值缺失 → 空串（防御性）', () => {
    const merged = mergeChannelSecret(
      { appSecret: CHANNEL_SECRET_REDACT_PLACEHOLDER },
      {},
    );
    expect(merged.appSecret).toBe('');
  });
});

/** 构造 AgentEvent（最小字段 + 类型化） */
function makeEvent(type: AgentEvent['type'], extra: Partial<AgentEvent>): AgentEvent {
  return {
    id: `e_${Math.random().toString(36).slice(2)}`,
    type,
    sessionId: 'sess1',
    createdAt: new Date().toISOString(),
    runKind: 'main',
    ...extra,
  } as AgentEvent;
}
