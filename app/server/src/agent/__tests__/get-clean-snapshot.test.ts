/**
 * ContextEngine.getCleanSnapshot 单元测试（v0.0.173 新增）
 * 参考: specs/tech/version_logs/v0.0.173/change_plan.md §三、§五
 *
 * 覆盖 4 子 case（change_plan §五）：
 *   1. 深克隆不变性 — 入参 snapshot.messages 字段值/元素引用不变（关键 invariant）
 *   2. 链含 role_merge → 返回的 messages 已合并，但原 snapshot.messages 未被 mutate
 *   3. pluginManager=null → 返回的 messages 是深克隆副本（fallback 不抛错）
 *   4. 返回 snapshot 其他字段（system/tools/summary/contextWindowUsage/inputCharCount）与原一致
 *
 * 测试策略：fake pluginManager + inline fake reducer。偏离 change_plan §五「真实 reducer」约束：
 * server tsconfig rootDir:./src 限制使 server 测试无法 import plugins/ 源码（TS6059）。本测试验证
 * structuredClone 深克隆 invariant（reducer 只需能 mutate cloned messages 让 invariant 可观测），
 * 与具体 reducer 实例无关；端到端真实 reducer 行为由 append-tool-pair 场景 E 覆盖。
 */
import { describe, it, expect } from 'vitest';
import type { Message, ContextWindowUsage } from '../../message/types';
import { ContextEngine } from '../context-engine';
import type { ContextSnapshot } from '../context-types';
import type { PluginManager } from '../../plugin/plugin-manager';

/** fake pluginManager：仅实现 getExtensionImpls（鸭子类型，返回注入的 reducer 实例列表） */
function fakePluginManager(reducers: unknown[]): PluginManager {
  return {
    getExtensionImpls: () => reducers,
  } as unknown as PluginManager;
}

/**
 * fake store：ContextEngine 构造器读 opts.store.stateMachine（即使 stateMachine 显式注入也会
 * 触发访问，因 `??` 右侧表达式在左侧 undefined 时被求值）。getCleanSnapshot 不读 store，
 * 但构造器需要它存活，故提供最小 stub。
 */
const fakeStore = { stateMachine: undefined } as never;

/**
 * inline fake reducer：模拟 role_merge 算法（相邻同 role 合并，后者 content 并入前者）。
 * 关键：本 reducer 会 mutate input 元素的 content 数组（push 进 last.content）——
 * 这是测深克隆 invariant 的关键，若 structuredClone 未落实，原 snapshot 会被污染。
 */
function fakeRoleMergeReducer() {
  return {
    reduce(_data: unknown, input: Message[] | null): Message[] {
      if (input === null) return [];
      const out: Message[] = [];
      for (const m of input) {
        if (m.role === 'system') {
          out.push(m);
          continue;
        }
        const last = out[out.length - 1];
        if (last && last.role === m.role) {
          last.content = [...last.content, ...m.content];
        } else {
          out.push({ ...m, content: [...m.content] });
        }
      }
      return out;
    },
  };
}

/** 构造测试用 ContextSnapshot */
function mkSnapshot(messages: Message[]): ContextSnapshot {
  const usage: ContextWindowUsage = {
    systemTokens: 10,
    messageTokens: 100,
    toolTokens: 0,
    totalTokens: 110,
    maxOutputTokens: 20000,
    tokenLimit: 100000,
    remainingTokens: 99990,
  };
  return {
    system: {
      id: 'system',
      sessionId: 'test-sid',
      role: 'system',
      content: [{ type: 'text', text: 'SYSTEM PROMPT' }],
    },
    messages,
    inputCharCount: 42,
    contextWindowUsage: usage,
    summary: null,
    tools: [],
  };
}

describe('ContextEngine.getCleanSnapshot', () => {
  it('1. 深克隆不变性 — 调用后入参 snapshot.messages 字段值 / 元素引用不变（关键 invariant）', async () => {
    const pm = fakePluginManager([fakeRoleMergeReducer()]);
    const engine = new ContextEngine({ store: fakeStore, pluginManager: pm });

    const originalMessages: Message[] = [
      {
        id: 'u1', sessionId: 'test-sid', role: 'user',
        content: [{ type: 'text', text: 'q1' }],
      },
      {
        id: 'u2', sessionId: 'test-sid', role: 'user',
        content: [{ type: 'text', text: 'q2' }],
      },
    ];
    const snapshot = mkSnapshot(originalMessages);

    // 拍照：原始 messages 元素引用 + content 数组引用 + 字段值
    const msgRefsBefore = [...snapshot.messages];
    const u1ContentArrBefore = snapshot.messages[0]!.content;

    await engine.getCleanSnapshot(snapshot, 'default');

    // 关键 invariant 1：messages 数组元素引用未变（未被 mutate / reassign）
    expect(snapshot.messages.length).toBe(2);
    expect(snapshot.messages[0]).toBe(msgRefsBefore[0]);
    expect(snapshot.messages[1]).toBe(msgRefsBefore[1]);
    // 关键 invariant 2：元素内部 content 数组引用未变（structuredClone 落实——
    //   若未克隆，fake role_merge 的 last.content = [...last.content, ...m.content]
    //   会替换原 content 数组引用）
    expect(snapshot.messages[0]!.content).toBe(u1ContentArrBefore);
    // 关键 invariant 3：字段值未被 role_merge 合并改写
    expect(snapshot.messages[0]!.id).toBe('u1');
    expect(snapshot.messages[0]!.content).toHaveLength(1);
    expect(snapshot.messages[1]!.id).toBe('u2');
    expect(snapshot.messages[1]!.content).toHaveLength(1);
  });

  it('2. 链含 role_merge → 返回 messages 已合并但原 snapshot.messages 未被 mutate', async () => {
    const pm = fakePluginManager([fakeRoleMergeReducer()]);
    const engine = new ContextEngine({ store: fakeStore, pluginManager: pm });

    const originalMessages: Message[] = [
      { id: 'u1', sessionId: 'test-sid', role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { id: 'u2', sessionId: 'test-sid', role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { id: 'a1', sessionId: 'test-sid', role: 'assistant', content: [{ type: 'text', text: 'ans' }] },
    ];
    const snapshot = mkSnapshot(originalMessages);

    const result = await engine.getCleanSnapshot(snapshot, 'default');

    // 返回的 messages 已合并（u2 并入 u1，从 3 降到 2）
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.id).toBe('u1');
    expect(result.messages[0]!.content).toHaveLength(2); // q1 + q2 合并

    // 关键：原 snapshot 未被 mutate（messages 仍是 3 条，id 都在）
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages.map((m) => m.id)).toEqual(['u1', 'u2', 'a1']);
    // 原 u1 content 也未变
    expect(snapshot.messages[0]!.content).toEqual([{ type: 'text', text: 'q1' }]);
  });

  it('3. pluginManager=null → 返回深克隆 fallback（不抛错，messages 内容一致但引用独立）', async () => {
    const engine = new ContextEngine({ store: fakeStore, pluginManager: null });

    const originalMessages: Message[] = [
      { id: 'u1', sessionId: 'test-sid', role: 'user', content: [{ type: 'text', text: 'q1' }] },
    ];
    const snapshot = mkSnapshot(originalMessages);

    // 不抛错
    const result = await engine.getCleanSnapshot(snapshot, 'default');

    // 内容一致
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe('u1');
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'q1' }]);
    // 引用独立（深克隆 fallback，不是原数组）
    expect(result.messages).not.toBe(snapshot.messages);
    expect(result.messages[0]).not.toBe(snapshot.messages[0]);
  });

  it('4. 返回 snapshot 其他字段（system/tools/summary/contextWindowUsage/inputCharCount）与原一致', async () => {
    const pm = fakePluginManager([fakeRoleMergeReducer()]);
    const engine = new ContextEngine({ store: fakeStore, pluginManager: pm });

    const originalMessages: Message[] = [
      { id: 'u1', sessionId: 'test-sid', role: 'user', content: [{ type: 'text', text: 'q1' }] },
    ];
    const snapshot = mkSnapshot(originalMessages);

    const result = await engine.getCleanSnapshot(snapshot, 'default');

    // 其他字段引用复用（与原 snapshot 同值 / 同引用）
    expect(result.system).toBe(snapshot.system); // 引用复用
    expect(result.tools).toBe(snapshot.tools);
    expect(result.summary).toBe(snapshot.summary);
    expect(result.contextWindowUsage).toBe(snapshot.contextWindowUsage);
    expect(result.inputCharCount).toBe(snapshot.inputCharCount);
    // 返回的是新 snapshot 对象（不 mutate 原 snapshot）
    expect(result).not.toBe(snapshot);
  });
});
