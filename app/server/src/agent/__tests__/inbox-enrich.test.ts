/**
 * enrichForInbox UT（v0.0.31 task-2 功能 A）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2.5
 *   - §2.5.1 函数签名 / §2.5.2 伪代码（全分支覆盖）
 *   - §2.5.3 name 反查规则（subagent→templateType；parent/顶层→title||'parent'）
 *   - §2.5.4 source='user'/'system'/'approval' 不 enrich
 *
 * 白盒：测 enrichForInbox + mapSessionTypeToAgentRefType + deriveAgentRefName 纯逻辑。
 *
 * 文件系统隔离：纯内存 mock，无 fs 操作。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  enrichForInbox,
  mapSessionTypeToAgentRefType,
  deriveAgentRefName,
  type EnrichSessionLookup,
} from '../inbox-enrich';
import type { Message } from '../../message/types';
import type { Session } from '../session-store-types';
import type { MessageSenderAgent } from '../../message/types';

/** 构造 mock Session（enrich 反查返回值）。title 用 'title' in over 判断以兼容 undefined。 */
function mockSession(over: Partial<Session> = {}): Session {
  const title = 'title' in over ? over.title : '探查代码任务';
  return {
    id: over.id ?? '01SESSION',
    title,
    role: over.role,
    derivation: over.derivation,
    biz: over.biz,
    subAgentTemplateType: over.subAgentTemplateType,
    origin: over.origin,
    subAgentConfig: over.subAgentConfig,
    workspaceDir: over.workspaceDir ?? '/tmp/ws',
    state: over.state ?? 'idle',
    currentRunId: over.currentRunId ?? null,
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-01-01T00:00:00.000Z',
    version: over.version ?? 1,
  } as Session;
}

/** 构造 enrich lookup（mock store.getSession 行为） */
function makeLookup(sessionById: Record<string, Session | null>): EnrichSessionLookup {
  return {
    getSession: async (sid: string) => sessionById[sid] ?? null,
  };
}

/** 构造 source='agent' message（caller 可能传部分 ref） */
function agentMessage(over: {
  refType?: string;
  refName?: string;
  refSessionId?: string;
  needReply?: unknown;
  inReplyTo?: string;
}): Message {
  const agent: Record<string, unknown> = {
    ref: {
      type: over.refType ?? '',
      sessionId: over.refSessionId ?? '01SESSION',
      name: over.refName ?? '',
    },
  };
  if (over.needReply !== undefined) agent.needReply = over.needReply;
  if (over.inReplyTo) agent.inReplyTo = over.inReplyTo;
  return {
    id: '01MSG',
    sessionId: 'TARGET_SID',
    role: 'user',
    content: [{ type: 'text', text: 'child task' }],
    sender: {
      source: 'agent',
      agent: agent as never,
    },
  } as Message;
}

/**
 * 从 message 取 sender.agent（窄化 helper）。
 * 判别联合下 TS 要求 sender.source === 'agent' 窄化后才能访问 agent 字段；
 * 测试统一走本 helper 避免重复 cast。
 */
function agentOf(msg: Message): MessageSenderAgent {
  const s = msg.sender;
  if (!s || s.source !== 'agent') {
    throw new Error('test fixture: expected source=agent sender');
  }
  return s.agent;
}

// ============================================================
// 1. mapSessionTypeToAgentRefType
// [v0.0.56 hotfix] 入参从 string 改为 Session（直接从 role+derivation 派生）
// ============================================================
describe('mapSessionTypeToAgentRefType', () => {
  // Session 最小子集（mapSessionTypeToAgentRefType 仅读 role+derivation）
  const mkSession = (s: { role?: string; derivation?: string }): Session =>
    ({ id: 'x', status: 'active', state: 'idle', running: false, currentRunId: null, unread: false, workspaceDir: '', createdAt: '', updatedAt: '', version: 1, ...s }) as unknown as Session;

  it('derivation=subagent → subagent', () => {
    expect(mapSessionTypeToAgentRefType(mkSession({ role: 'rocky', derivation: 'subagent' }))).toBe('subagent');
    expect(mapSessionTypeToAgentRefType(mkSession({ role: 'leader', derivation: 'subagent' }))).toBe('subagent');
  });
  it('[v0.0.56] role=rocky 或 undefined（顶层 standalone）→ rocky', () => {
    expect(mapSessionTypeToAgentRefType(mkSession({ role: 'rocky', derivation: 'parent' }))).toBe('rocky');
    expect(mapSessionTypeToAgentRefType(mkSession({ derivation: 'parent' }))).toBe('rocky');
  });
  it('leader/mate/squad 同名直通', () => {
    expect(mapSessionTypeToAgentRefType(mkSession({ role: 'leader', derivation: 'parent' }))).toBe('leader');
    expect(mapSessionTypeToAgentRefType(mkSession({ role: 'mate', derivation: 'parent' }))).toBe('mate');
    expect(mapSessionTypeToAgentRefType(mkSession({ role: 'squad', derivation: 'parent' }))).toBe('squad');
  });
});

// ============================================================
// 2. deriveAgentRefName
// ============================================================
describe('deriveAgentRefName', () => {
  it('subagent → subAgentTemplateType', () => {
    expect(deriveAgentRefName(mockSession({ derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' }))).toBe('explorer');
  });
  it('subagent 无 templateType → "subagent"', () => {
    expect(deriveAgentRefName(mockSession({ derivation: 'subagent', role: 'rocky', subAgentTemplateType: undefined }))).toBe('subagent');
    expect(deriveAgentRefName(mockSession({ derivation: 'subagent', role: 'rocky', subAgentTemplateType: '' }))).toBe('subagent');
  });
  it('顶层 parent 有 title → title', () => {
    expect(deriveAgentRefName(mockSession({  title: '探查代码任务' }))).toBe('探查代码任务');
  });
  it('顶层 parent 无 title → "parent"', () => {
    expect(deriveAgentRefName(mockSession({  title: '' }))).toBe('parent');
    expect(deriveAgentRefName(mockSession({  title: undefined }))).toBe('parent');
  });
  it('leader/member/squad 有 title → title', () => {
    expect(deriveAgentRefName(mockSession({ role: 'leader', derivation: 'parent', title: 'Captain' }))).toBe('Captain');
  });
  it('name 不取 sessionId 片段（程序构造性原则）', () => {
    // 即使 session.id 是 ULID，name 也只取 title/templateType，不带 sid 前缀
    const s = mockSession({ id: '01KABCDEF', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' });
    expect(deriveAgentRefName(s)).toBe('explorer');
    expect(deriveAgentRefName(s)).not.toContain('01K');
  });
});

// ============================================================
// 3. enrichForInbox — source='agent' 反查补全
// ============================================================
describe('enrichForInbox — source=agent 反查补全', () => {
  it('subagent 发送方 → type=subagent, name=templateType', async () => {
    const lookup = makeLookup({
      '01SUB': mockSession({ id: '01SUB', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' }),
    });
    const msg = agentMessage({ refSessionId: '01SUB', needReply: false });
    const out = await enrichForInbox(msg, lookup);
    expect(out.sender!.source).toBe('agent');
    expect(agentOf(out).ref.type).toBe('subagent');
    expect(agentOf(out).ref.sessionId).toBe('01SUB');
    expect(agentOf(out).ref.name).toBe('explorer');
    expect(agentOf(out).needReply).toBe(false);
  });

  it('[v0.0.56] 顶层 parent 发送方 → type=rocky, name=title', async () => {
    const lookup = makeLookup({
      '01PARENT': mockSession({ id: '01PARENT',  title: '探查代码任务' }),
    });
    const msg = agentMessage({ refSessionId: '01PARENT', needReply: true });
    const out = await enrichForInbox(msg, lookup);
    expect(agentOf(out).ref.type).toBe('rocky');
    expect(agentOf(out).ref.name).toBe('探查代码任务');
    expect(agentOf(out).needReply).toBe(true);
  });

  it('顶层 parent 无 title → name="parent"', async () => {
    const lookup = makeLookup({
      '01P': mockSession({ id: '01P',  title: '' }),
    });
    const msg = agentMessage({ refSessionId: '01P', needReply: true });
    const out = await enrichForInbox(msg, lookup);
    expect(agentOf(out).ref.name).toBe('parent');
  });
});

// ============================================================
// 4. enrichForInbox — caller 传 type/name 校验
// ============================================================
describe('enrichForInbox — 防幻觉契约（caller 传了校验 warn）', () => {
  it('caller 传 type/name 与反查一致 → 不 warn，正常返回', async () => {
    const lookup = makeLookup({
      '01SUB': mockSession({ id: '01SUB', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const msg = agentMessage({
      refSessionId: '01SUB',
      refType: 'subagent',
      refName: 'explorer',
      needReply: false,
    });
    const out = await enrichForInbox(msg, lookup);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(agentOf(out).ref.type).toBe('subagent');
    expect(agentOf(out).ref.name).toBe('explorer');
    warnSpy.mockRestore();
  });

  it('caller 传 type 与反查不一致 → warn + 反查覆盖', async () => {
    const lookup = makeLookup({
      '01SUB': mockSession({ id: '01SUB', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const msg = agentMessage({
      refSessionId: '01SUB',
      refType: 'leader', // 错的
      refName: 'explorer',
      needReply: false,
    });
    const out = await enrichForInbox(msg, lookup);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('type mismatch');
    expect(warnSpy.mock.calls[0]![0]).toContain('actual=subagent');
    // 反查覆盖
    expect(agentOf(out).ref.type).toBe('subagent');
    warnSpy.mockRestore();
  });

  it('caller 传 name 与反查不一致 → warn + 反查覆盖', async () => {
    const lookup = makeLookup({
      '01SUB': mockSession({ id: '01SUB', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const msg = agentMessage({
      refSessionId: '01SUB',
      refType: 'subagent',
      refName: 'wrong-name',
      needReply: true,
    });
    const out = await enrichForInbox(msg, lookup);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('name mismatch');
    expect(agentOf(out).ref.name).toBe('explorer');
    warnSpy.mockRestore();
  });

  it('caller 没传 type/name（空串占位）→ 反查补全，不 warn', async () => {
    const lookup = makeLookup({
      '01SUB': mockSession({ id: '01SUB', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const msg = agentMessage({
      refSessionId: '01SUB',
      refType: '',
      refName: '',
      needReply: false,
    });
    const out = await enrichForInbox(msg, lookup);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(agentOf(out).ref.type).toBe('subagent');
    expect(agentOf(out).ref.name).toBe('explorer');
    warnSpy.mockRestore();
  });
});

// ============================================================
// 5. enrichForInbox — needReply / inReplyTo
// ============================================================
describe('enrichForInbox — needReply 必填 + inReplyTo 透传', () => {
  it('needReply=true 透传', async () => {
    const lookup = makeLookup({ '01S': mockSession({ id: '01S' }) });
    const out = await enrichForInbox(agentMessage({ refSessionId: '01S', needReply: true }), lookup);
    expect(agentOf(out).needReply).toBe(true);
  });
  it('needReply=false 透传', async () => {
    const lookup = makeLookup({ '01S': mockSession({ id: '01S', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'x' }) });
    const out = await enrichForInbox(agentMessage({ refSessionId: '01S', needReply: false }), lookup);
    expect(agentOf(out).needReply).toBe(false);
  });
  it('needReply 缺失 → throw（a2a 必填）', async () => {
    const lookup = makeLookup({ '01S': mockSession({ id: '01S' }) });
    const msg = agentMessage({ refSessionId: '01S' }); // needReply 不设
    await expect(enrichForInbox(msg, lookup)).rejects.toThrow(/needReply missing/);
  });
  it('inReplyTo 有 → 透传', async () => {
    const lookup = makeLookup({ '01S': mockSession({ id: '01S' }) });
    const msg = agentMessage({ refSessionId: '01S', needReply: false, inReplyTo: '01PARENTMSG' });
    const out = await enrichForInbox(msg, lookup);
    expect(agentOf(out).inReplyTo).toBe('01PARENTMSG');
  });
  it('inReplyTo 无 → 不注入', async () => {
    const lookup = makeLookup({ '01S': mockSession({ id: '01S' }) });
    const msg = agentMessage({ refSessionId: '01S', needReply: false });
    const out = await enrichForInbox(msg, lookup);
    expect(agentOf(out).inReplyTo).toBeUndefined();
  });
});

// ============================================================
// 6. enrichForInbox — user/system/approval 原样返回（不 enrich）
// ============================================================
describe('enrichForInbox — source 非 agent 原样返回', () => {
  it('source=user 原样返回', async () => {
    const lookup = makeLookup({});
    const msg: Message = {
      id: '01M', sessionId: 'S', role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      sender: { source: 'user' },
    };
    const out = await enrichForInbox(msg, lookup);
    expect(out).toBe(msg); // 同一对象引用
    expect(out.sender!.source).toBe('user');
  });
  it('source=system 原样返回', async () => {
    const lookup = makeLookup({});
    const msg: Message = {
      id: '01M', sessionId: 'S', role: 'system',
      content: [{ type: 'text', text: 'heartbeat' }],
      sender: { source: 'system', system: { kind: 'heartbeat' } },
    };
    const out = await enrichForInbox(msg, lookup);
    expect(out).toBe(msg);
  });
  it('source=approval 原样返回', async () => {
    const lookup = makeLookup({});
    const msg: Message = {
      id: '01M', sessionId: 'S', role: 'tool',
      content: [{ type: 'tool_result', toolCallId: 'tc1', content: [], isError: false }],
      sender: { source: 'approval', approval: { toolCallId: 'tc1', decision: 'allow' } },
    };
    const out = await enrichForInbox(msg, lookup);
    expect(out).toBe(msg);
  });
  it('[v0.0.101 T4] source=tool_reply 原样返回（不进 a2a enrich 链）', async () => {
    const lookup = makeLookup({});
    const msg: Message = {
      id: '01M', sessionId: 'S', role: 'user',
      content: [{ type: 'tool_reply', toolCallId: 'tc1', handleType: 'direct_result', payload: {} }],
      sender: { source: 'tool_reply', tool_reply: { toolCallId: 'tc1', runId: 'r1' } },
    };
    const out = await enrichForInbox(msg, lookup);
    expect(out).toBe(msg);
    expect(out.sender!.source).toBe('tool_reply');
  });
  it('无 sender → 原样返回', async () => {
    const lookup = makeLookup({});
    const msg: Message = {
      id: '01M', sessionId: 'S', role: 'user',
      content: [{ type: 'text', text: 'x' }],
    };
    const out = await enrichForInbox(msg, lookup);
    expect(out).toBe(msg);
  });
});

// ============================================================
// 7. enrichForInbox — throw 分支
// ============================================================
describe('enrichForInbox — 错误分支', () => {
  it('source=agent 但 ref.sessionId 缺失 → throw（路由权威）', async () => {
    const lookup = makeLookup({});
    const msg = agentMessage({ refSessionId: '', needReply: false });
    await expect(enrichForInbox(msg, lookup)).rejects.toThrow(/sessionId missing/);
  });
  it('发送方 session 不存在 → throw', async () => {
    const lookup = makeLookup({}); // 空 store，任何 sid 都查不到
    const msg = agentMessage({ refSessionId: 'NOT_EXIST', needReply: false });
    await expect(enrichForInbox(msg, lookup)).rejects.toThrow(/sender session not found/);
  });
});

// ============================================================
// 8. enrich 产出严格匹配判别联合 agent 变体形态
// ============================================================
describe('enrichForInbox — 产出形态', () => {
  it('enriched.sender.agent 严格匹配 {ref:{type,sessionId,name}, needReply, inReplyTo?}', async () => {
    const lookup = makeLookup({
      '01S': mockSession({ id: '01S', derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer' }),
    });
    const msg = agentMessage({
      refSessionId: '01S',
      refType: '',
      refName: '',
      needReply: true,
      inReplyTo: '01THREAD',
    });
    const out = await enrichForInbox(msg, lookup);
    const agent = agentOf(out);
    // ref 三字段全
    expect(Object.keys(agent.ref).sort()).toEqual(['name', 'sessionId', 'type']);
    expect(typeof agent.ref.type).toBe('string');
    expect(typeof agent.ref.sessionId).toBe('string');
    expect(typeof agent.ref.name).toBe('string');
    // needReply 必填 boolean
    expect(typeof agent.needReply).toBe('boolean');
    // inReplyTo 可选
    expect(agent.inReplyTo).toBe('01THREAD');
  });
});
