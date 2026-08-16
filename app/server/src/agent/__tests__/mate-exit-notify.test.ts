/**
 * mate-exit-notify 纯函数单测（v0.0.273 块1）
 * 参考: specs/tech/version_logs/v0.0.273/change_plan.md（R4 内容来源 + test-plan 内容摘要）
 *
 * 覆盖：
 *   - truncateText：短文本原样 / 长文本前后 500 + 省略标记 + 省略字符数
 *   - formatMateExitNotify：block 过滤 5 类（text/tool_call/tool_result/tool_reply/image）
 *     不含 reasoning/usage；7 种 stopReason 全覆盖；tool_pending 带 pending 摘要；不带 runId
 *   - buildRunDeps 装配条件（R2 触发过滤）：mate+parent+squadId → 注入 mateExitNotify；
 *     leader/subagent/非 squad/旁路 run → 不注入（零通知）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { truncateText, formatMateExitNotify, hasRecentLeaderReport } from '../mate-exit-notify';
import type { ContentBlock, Message } from '../../message/types';
import type { StopReason } from '../agent-event-types';

describe('truncateText — 前后各 limit 截断', () => {
  it('短文本（≤1000）原样返回', () => {
    expect(truncateText('hello')).toBe('hello');
  });

  it('恰好 1000 字符原样返回', () => {
    const text = 'a'.repeat(1000);
    expect(truncateText(text)).toBe(text);
  });

  it('长文本 → 前后各 500 + 省略标记 + 省略字符数', () => {
    const text = 'A'.repeat(600) + 'B'.repeat(600); // 1200 字符
    const result = truncateText(text);
    expect(result.length).toBeLessThan(text.length);
    expect(result.startsWith('A'.repeat(500))).toBe(true);
    expect(result.endsWith('B'.repeat(500))).toBe(true);
    expect(result).toContain('...（省略 200 字符）...');
  });

  it('自定义 limit 生效', () => {
    const text = 'a'.repeat(30);
    const result = truncateText(text, 10);
    expect(result.startsWith('a'.repeat(10))).toBe(true);
    expect(result.endsWith('a'.repeat(10))).toBe(true);
    expect(result).toContain('省略 10 字符');
  });
});

describe('formatMateExitNotify — block 过滤 + 渲染', () => {
  const base = {
    name: 'coder',
    role: 'mate',
    stopReason: 'no_tool_call' as StopReason,
    durationSec: 12,
  };

  it('text/tool_call/tool_result/tool_reply/image 5 类渲染，reasoning/usage 排除', () => {
    const lastContent: ContentBlock[] = [
      { type: 'text', text: '处理完成' },
      { type: 'tool_call', id: 'tc-1', name: 'read', arguments: { filePath: '/tmp/a.ts' } },
      { type: 'tool_result', toolCallId: 'tc-1', content: [{ type: 'text', text: 'file content here' }], isError: false },
      { type: 'tool_reply', toolCallId: 'tc-1', handleType: 'direct_result', payload: { selections: {} } },
      { type: 'image', source: { kind: 'url', url: 'http://x/y.png' }, mediaType: 'image/png' },
      { type: 'reasoning', text: 'SHOULD-NOT-APPEAR' },
      { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } as never },
    ];
    const result = formatMateExitNotify({ ...base, lastContent });
    expect(result).toContain('text: 处理完成');
    expect(result).toContain('tool_call: read({"filePath":"/tmp/a.ts"})');
    expect(result).toContain('tool_result: file content here');
    expect(result).toContain('tool_reply: direct_result');
    expect(result).toContain('image: image/png');
    expect(result).not.toContain('SHOULD-NOT-APPEAR');
    expect(result).not.toContain('usage');
  });

  it('text 超长 → 前后 500 截断', () => {
    const long = 'X'.repeat(600) + 'Y'.repeat(600);
    const result = formatMateExitNotify({ ...base, lastContent: [{ type: 'text', text: long }] });
    expect(result).toContain('省略 200 字符');
    expect(result).toContain(`text: ${'X'.repeat(500)}`);
  });

  it('tool_result 内层嵌套 text 展平', () => {
    const lastContent: ContentBlock[] = [
      { type: 'tool_result', toolCallId: 'tc-2', content: [{ type: 'tool_result', toolCallId: 'tc-2', content: [{ type: 'text', text: 'nested-text' }], isError: false }], isError: false },
    ];
    const result = formatMateExitNotify({ ...base, lastContent });
    expect(result).toContain('tool_result: nested-text');
  });

  it('7 种 stopReason 全覆盖渲染', () => {
    const reasons: StopReason[] = ['no_tool_call', 'no_new_messages', 'max_iterations', 'doom_loop', 'error', 'tool_pending', 'interrupted'];
    for (const reason of reasons) {
      const result = formatMateExitNotify({ ...base, stopReason: reason });
      expect(result).toContain(`退出原因: ${reason}`);
      expect(result).toContain(`【mate 退出通知】coder（mate）run 已退出`);
      expect(result).toContain('耗时: 12s');
    }
  });

  it('[v0.0.338 M1] interrupted → 退出原因行追加「（由用户主动中断，无需处理）」且原值保留', () => {
    const result = formatMateExitNotify({ ...base, stopReason: 'interrupted' });
    expect(result).toContain('退出原因: interrupted（由用户主动中断，无需处理）');
    expect(result).toContain('退出原因: interrupted'); // 原枚举值保留
  });

  it('[v0.0.338 M1] 其他 6 种 reason → 不含「由用户中断」提示（输出逐字节不变）', () => {
    const others: StopReason[] = ['no_tool_call', 'no_new_messages', 'max_iterations', 'doom_loop', 'error', 'tool_pending'];
    for (const reason of others) {
      const result = formatMateExitNotify({ ...base, stopReason: reason });
      expect(result).toContain(`退出原因: ${reason}`);
      expect(result).not.toContain('由用户中断');
      expect(result).not.toContain('（由用户中断');
    }
  });

  it('tool_pending → pendingToolCalls 摘要行', () => {
    const result = formatMateExitNotify({
      ...base,
      stopReason: 'tool_pending',
      pendingToolCalls: [{ sessionId: 's', runId: 'r', toolCallId: 'pc-1', toolName: 'ask-question' } as never],
    });
    expect(result).toContain('[待审批] 悬挂工具: ask-question(pc-1)');
  });

  it('无 pending 时无悬挂行；不带 runId/迭代轮数', () => {
    const result = formatMateExitNotify(base);
    expect(result).not.toContain('待审批');
    expect(result).not.toContain('runId');
    expect(result).not.toContain('rounds');
    expect(result).not.toContain('迭代');
  });

  it('无 lastContent → 不渲染「最后消息:」段', () => {
    const result = formatMateExitNotify(base);
    expect(result).not.toContain('最后消息');
  });
});

// ── [v0.0.362] hasRecentLeaderReport run-end 汇报去重判定（纯函数六面） ──
const LEADER_SID = '01LEADER_SID_0001';

/** 造一条 assistant 消息（blocks 为 content） */
function asstMsg(blocks: ContentBlock[], i: number): Message {
  return { id: `m-${i}`, sessionId: 'sess-mate', role: 'assistant', content: blocks };
}

/** 造 send_message tool_call block（target 三形态可变） */
function sendCall(id: string, target: unknown): ContentBlock {
  return { type: 'tool_call', id, name: 'send_message', arguments: { target, content: [{ type: 'text', text: '汇报' }] } };
}

/** 造普通轮（无 send_message，如 read 工具） */
function otherCall(id: string): ContentBlock {
  return { type: 'tool_call', id, name: 'read', arguments: { filePath: '/tmp/a' } };
}

describe('hasRecentLeaderReport — [v0.0.362] run-end 汇报去重判定', () => {
  it('命中跳过：字符串 target="parent"（mate 的 parent 即 leader）', () => {
    const msgs = [asstMsg([sendCall('t1', 'parent')], 1)];
    expect(hasRecentLeaderReport(msgs, undefined, LEADER_SID)).toBe(true);
  });

  it('命中跳过：字符串 target === leaderSid 显式 sessionId', () => {
    const msgs = [asstMsg([sendCall('t1', LEADER_SID)], 1)];
    expect(hasRecentLeaderReport(msgs, undefined, LEADER_SID)).toBe(true);
  });

  it('命中跳过：AgentRef 形态 target.sessionId === leaderSid', () => {
    const msgs = [asstMsg([sendCall('t1', { type: 'agent', sessionId: LEADER_SID, name: 'Darvin' })], 1)];
    expect(hasRecentLeaderReport(msgs, undefined, LEADER_SID)).toBe(true);
  });

  it('未命中照发：窗口内无 send_message（仅其他工具）', () => {
    const msgs = [asstMsg([otherCall('t1')], 1), asstMsg([{ type: 'text', text: 'done' }], 2)];
    expect(hasRecentLeaderReport(msgs, undefined, LEADER_SID)).toBe(false);
  });

  it('未命中照发：send_message target 指向他人（sid 不等 / AgentRef sid 不等）', () => {
    const msgs = [
      asstMsg([sendCall('t1', '01OTHER_SID_0002')], 1),
      asstMsg([sendCall('t2', { type: 'agent', sessionId: '01OTHER_SID_0003' })], 2),
    ];
    expect(hasRecentLeaderReport(msgs, undefined, LEADER_SID)).toBe(false);
  });

  it('窗口边界：命中调用在第 4 轮（超出 3 轮窗口）→ 不命中', () => {
    const msgs = [
      asstMsg([sendCall('t0', 'parent')], 1), // 第 1 轮：命中调用（将被滑出窗口）
      asstMsg([{ type: 'text', text: 'r2' }], 2),
      asstMsg([{ type: 'text', text: 'r3' }], 3),
      asstMsg([{ type: 'text', text: 'r4' }], 4),
    ];
    expect(hasRecentLeaderReport(msgs, undefined, LEADER_SID)).toBe(false);
  });

  it('lastAssistantContent 伪消息参与窗口：末轮 send_message 不在 snapshot 时仍命中', () => {
    // snapshot 3 轮均无 send_message；末轮（不在 snapshot）有 → 伪消息补位后命中
    const msgs = [asstMsg([{ type: 'text', text: 'r1' }], 1), asstMsg([{ type: 'text', text: 'r2' }], 2), asstMsg([{ type: 'text', text: 'r3' }], 3)];
    expect(hasRecentLeaderReport(msgs, [sendCall('t9', 'parent')], LEADER_SID)).toBe(true);
  });

  it('伪消息把第 1 轮命中调用滑出窗口：3 snapshot 轮 + 伪消息 → 窗口=后 3，第 1 轮不命中', () => {
    const msgs = [
      asstMsg([sendCall('t0', 'parent')], 1), // 第 1 轮（滑出）
      asstMsg([{ type: 'text', text: 'r2' }], 2),
      asstMsg([{ type: 'text', text: 'r3' }], 3),
    ];
    const last: ContentBlock[] = [{ type: 'text', text: 'final' }]; // 伪消息无 send_message
    expect(hasRecentLeaderReport(msgs, last, LEADER_SID)).toBe(false);
  });

  it('snapshot null（防御）→ 未命中照发', () => {
    expect(hasRecentLeaderReport(null, [sendCall('t1', 'parent')], LEADER_SID)).toBe(false);
    expect(hasRecentLeaderReport(undefined, undefined, LEADER_SID)).toBe(false);
  });

  it('user/tool 消息不参与窗口（只数 assistant 轮）', () => {
    const msgs = [
      { id: 'u1', sessionId: 's', role: 'user', content: [sendCall('t1', 'parent')] as ContentBlock[] } as Message,
      { id: 'r1', sessionId: 's', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } as Message,
    ];
    expect(hasRecentLeaderReport(msgs, undefined, LEADER_SID)).toBe(false);
  });
});

// ── buildRunDeps 装配条件（R2 触发过滤：谁装配谁触发） ──
// mock RunLifecyclePort：断言 buildRunDeps 注入 mateExitNotify 标记（RunLifecyclePort 触发行为在 run-lifecycle-port.test.ts 直测）
// 注意：bun --bun 下 vi.mock 相对路径字面量不生效（C2 修复）——须用 require('path').resolve(__dirname, ...)
// 转绝对路径（主仓库先例：team-write-actions.test.ts / consolidation-handler.test.ts）
vi.mock(require('path').resolve(__dirname, '../run-lifecycle-port'), () => ({ RunLifecyclePort: vi.fn() }));
import { RunLifecyclePort as RunLifecyclePortCtor } from '../run-lifecycle-port';
import { buildRunDeps } from '../build-run-deps';
import type { BuildRunDepsOpts } from '../build-run-deps';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import { SessionKind } from '@app/shared';
import type { SessionConfig } from '../context-types';
import type { ReplayableEventBus } from '../event-bus';
import type { ContextEngine } from '../context-engine';
import type { SessionStore } from '../session-store';
import type { ToolExecutionEngine } from '../../tools/engine';
import type { AbortControllerHandle } from '../agent-interface';

const RunLifecyclePort = RunLifecyclePortCtor as unknown as ReturnType<typeof vi.fn>;

/** main mate profile（drainMode=eager / persistsRun / touchesStateMachine / usagePartition=current） */
function mockMainPolicy(): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: 'studio:mate:parent:main',
    enabled: true,
    toolBound: [],
    toolDefinitionsSource: 'own',
    runShape: { drainMode: 'eager', backgroundPath: false, maxIterDefault: 5, touchesStateMachine: true, persistsRun: true, usagePartition: 'current' },
    lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false },
    skillSource: 'none',
    eosStop: [],
    autoNaming: false,
    preloadContext: 'none',
  };
  return {
    profile: vi.fn(() => profile),
    resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })),
  };
}

/** 构造 main run 最小 BuildRunDepsOpts（inbox/contextEngine/store 全 mock） */
function newMainOpts(kind: SessionKind, overrides: Partial<BuildRunDepsOpts> = {}): BuildRunDepsOpts {
  const bus = { emit: vi.fn(), subscribe: vi.fn(), clearReplay: vi.fn(), isReplayable: () => false } as unknown as ReplayableEventBus;
  const store = { getMessages: vi.fn(async () => ({ items: [] as Message[] })) } as unknown as SessionStore;
  const ce = {
    ingest: vi.fn(async () => {}),
    assemble: vi.fn(async () => ({})),
    getCleanSnapshot: vi.fn(async () => ({})),
    getSideRunner: vi.fn(() => null),
    getConsolidateRunner: vi.fn(() => null),
    getPluginManager: vi.fn(() => null),
    getStateMachine: vi.fn(() => undefined),
    getTaskLock: vi.fn(() => undefined),
    clearScopeSession: vi.fn(async () => {}),
    getPluginManagerSafe: vi.fn(() => null),
  } as unknown as ContextEngine;
  const toolEngine = { execute: vi.fn(async () => ({ results: [], pending: [] })) } as unknown as ToolExecutionEngine;
  const controller: AbortControllerHandle = { runId: 'run-1', aborted: false };
  return {
    config: { sessionId: 'sess-mate', sessionContext: { squadId: 'squad-1' }, tools: [] } as unknown as SessionConfig,
    bus,
    store,
    contextEngine: ce,
    toolEngine,
    controller,
    runId: 'run-1',
    kind,
    sessionTypePolicy: mockMainPolicy(),
    inbox: { peek: vi.fn(() => []), drain: vi.fn() } as never,
    deliverToFn: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('buildRunDeps mateExitNotify 装配条件（R2 触发过滤）', () => {
  beforeEach(() => {
    RunLifecyclePort.mockClear();
  });

  it('main mate + parent + squadId + deliverToFn → 注入 mateExitNotify.squadId', () => {
    const kind = new SessionKind({ biz: 'studio', role: 'mate', derivation: 'parent' });
    buildRunDeps(newMainOpts(kind));
    const deps = RunLifecyclePort.mock.calls[0]![0] as { mateExitNotify?: { squadId: string } };
    expect(deps.mateExitNotify).toEqual({ squadId: 'squad-1' });
  });

  it('main leader → 不装配（mateExitNotify undefined）', () => {
    const kind = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'parent' });
    buildRunDeps(newMainOpts(kind));
    const deps = RunLifecyclePort.mock.calls[0]![0] as { mateExitNotify?: { squadId: string } };
    expect(deps.mateExitNotify).toBeUndefined();
  });

  it('main subagent（derivation=subagent）→ 不装配', () => {
    const kind = new SessionKind({ biz: 'studio', role: 'mate', derivation: 'subagent' });
    buildRunDeps(newMainOpts(kind));
    const deps = RunLifecyclePort.mock.calls[0]![0] as { mateExitNotify?: { squadId: string } };
    expect(deps.mateExitNotify).toBeUndefined();
  });

  it('main mate 但无 squadId（非 squad session）→ 不装配', () => {
    const kind = new SessionKind({ biz: 'studio', role: 'mate', derivation: 'parent' });
    const opts = newMainOpts(kind);
    (opts.config as SessionConfig).sessionContext = undefined;
    buildRunDeps(opts);
    const deps = RunLifecyclePort.mock.calls[0]![0] as { mateExitNotify?: { squadId: string } };
    expect(deps.mateExitNotify).toBeUndefined();
  });

  it('旁路 run（runKind=summary）→ 不装配（isMain=false）', () => {
    const kind = new SessionKind({ biz: 'studio', role: 'mate', derivation: 'parent', runKind: 'summary' });
    const opts = newMainOpts(kind, { snapshot: { system: {}, messages: [], inputCharCount: 0, contextWindowUsage: { systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 80000 }, summary: null, tools: [] } as never, userMessage: { id: 'u1', sessionId: 'sess-mate', role: 'user', content: [] } as never });
    buildRunDeps(opts);
    const deps = RunLifecyclePort.mock.calls[0]![0] as { mateExitNotify?: { squadId: string } };
    expect(deps.mateExitNotify).toBeUndefined();
  });
});
