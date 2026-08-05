/**
 * runCleanViewPipeline 单元测试（v0.0.173 新增）
 * 参考: specs/tech/version_logs/v0.0.173/change_plan.md §三、§五
 *
 * 覆盖 6 子 case（change_plan §五）：
 *   1. pluginManager=null → 返 null（caller fallback 用原 messages）
 *   2. 链空（EP 未激活 / 无 impl） → 返 null
 *   3. 链含 role_merge → 相邻同 role 合并
 *   4. 链含 orphan_tool_call → 无配对的 tool_call/tool_result 被剥
 *   5. 链含 think_remove → reasoning block 被剥
 *   6. 单 reducer throw → 降级跳过保留 acc（不中断链）
 *
 * 测试策略：inline fake reducer 模拟 6 个 clean reducer 行为（鸭子类型匹配 CleanViewReducer 签名）。
 * 偏离 change_plan §五「真实 reducer」约束：server tsconfig rootDir:./src 限制使 server 测试
 * 无法 import plugins/ 源码（TS6059）。本测试验证 pipeline 机制（取 EP / 链式 reduce / throw 降级），
 * 不验证 reducer 算法——端到端真实 reducer 行为由 append-tool-pair 场景 E 覆盖。
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock, Message } from '../../message/types';
import { runCleanViewPipeline } from '../clean-view-pipeline';
import type { PluginManager } from '../../plugin/plugin-manager';
import type { SessionConfig } from '../context-types';

/** minimal SessionConfig（clean reducer 仅读 ctx.config.sessionId 写 error log，fail-silent） */
const fakeConfig = { sessionId: 'test-sid' } as unknown as SessionConfig;

/** fake pluginManager：仅实现 getExtensionImpls（按 point.id 返回注入的 reducer 实例列表） */
function fakePluginManager(reducers: unknown[]): PluginManager {
  return {
    getExtensionImpls: () => reducers,
  } as unknown as PluginManager;
}

/** 造 message */
function msg(role: Message['role'], content: ContentBlock[], id: string): Message {
  return { id, sessionId: 'test-sid', role, content };
}

/** text block */
function text(t: string): ContentBlock {
  return { type: 'text', text: t };
}

/** tool_call block */
function callBlock(id: string): ContentBlock {
  return { type: 'tool_call', id, name: 'bash', arguments: {} };
}

/** tool_result block */
function resultBlock(toolCallId: string): ContentBlock {
  return { type: 'tool_result', toolCallId, content: [{ type: 'text', text: 'ok' }], isError: false };
}

/** reasoning block（assistant 思考，think_remove 剥） */
function reasoningBlock(): ContentBlock {
  return { type: 'reasoning', text: 'internal reasoning' } as ContentBlock;
}

/**
 * inline fake reducer：模拟 role_merge 算法（相邻同 role 合并，后者 content 并入前者）。
 * 鸭子类型匹配 CleanViewReducer 签名：reduce(data, input, ctx) → Message[]
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

/**
 * inline fake reducer：模拟 orphan_tool_call 算法（无配对的 tool_call/tool_result 被剥）。
 * 简化版（不实现 reorderToolAdjacency 邻接重排——本测试不涉及该场景）。
 */
function fakeOrphanToolCallReducer() {
  return {
    reduce(_data: unknown, input: Message[] | null): Message[] {
      if (input === null) return [];
      const callIds = new Set<string>();
      for (const m of input) for (const b of m.content) if (b.type === 'tool_call') callIds.add(b.id);
      const resultIds = new Set<string>();
      for (const m of input) for (const b of m.content) if (b.type === 'tool_result') resultIds.add(b.toolCallId);
      return input
        .map((m) => ({
          ...m,
          content: m.content.filter((b) => {
            if (b.type === 'tool_call') return resultIds.has(b.id);
            if (b.type === 'tool_result') return callIds.has(b.toolCallId);
            return true;
          }),
        }))
        .filter((m) => m.content.length > 0 || m.role === 'system');
    },
  };
}

/** inline fake reducer：模拟 think_remove 算法（删 reasoning block） */
function fakeThinkRemoveReducer() {
  return {
    reduce(_data: unknown, input: Message[] | null): Message[] {
      if (input === null) return [];
      return input.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== 'reasoning') }));
    },
  };
}

describe('runCleanViewPipeline', () => {
  it('1. pluginManager=null → 返 null（caller fallback）', () => {
    const out = runCleanViewPipeline(null, [], 'default', fakeConfig);
    expect(out).toBeNull();
  });

  it('2. 链空（无 clean view reducer） → 返 null', () => {
    const pm = fakePluginManager([]); // getExtensionImpls 返空数组
    const out = runCleanViewPipeline(pm, [msg('user', [text('hi')], 'u1')], 'default', fakeConfig);
    expect(out).toBeNull();
  });

  it('3. 链含 role_merge → 相邻同 role 合并（后者 content 并入前者）', () => {
    const pm = fakePluginManager([fakeRoleMergeReducer()]);
    const input: Message[] = [
      msg('user', [text('q1')], 'u1'),
      msg('user', [text('q2')], 'u2'), // 相邻同 role → 合并进 u1
      msg('assistant', [text('a1')], 'a1'),
    ];

    const out = runCleanViewPipeline(pm, input, 'default', fakeConfig);
    expect(out).not.toBeNull();
    const cleaned = out!;
    // 合并后从 3 条降到 2 条（u2 并入 u1）
    expect(cleaned).toHaveLength(2);
    expect(cleaned[0]!.id).toBe('u1');
    expect(cleaned[0]!.content).toEqual([text('q1'), text('q2')]); // content 合并
    expect(cleaned[1]!.id).toBe('a1');
  });

  it('4. 链含 orphan_tool_call → 无配对的 tool_call/tool_result 被剥', () => {
    const pm = fakePluginManager([fakeOrphanToolCallReducer()]);
    const input: Message[] = [
      // tc_orphan 无对应 tool_result → 应被剥；tc_paired 有对应 → 保留
      msg('assistant', [text('a'), callBlock('tc_orphan'), callBlock('tc_paired')], 'a1'),
      msg('tool', [resultBlock('tc_paired')], 't1'),
    ];

    const out = runCleanViewPipeline(pm, input, 'default', fakeConfig);
    expect(out).not.toBeNull();
    const cleaned = out!;
    // a1 仍存（剩 text + tc_paired），t1 紧跟 a1
    expect(cleaned.map((m) => m.id)).toEqual(['a1', 't1']);
    const a1 = cleaned[0]!;
    expect(a1.content.some((b) => b.type === 'tool_call' && b.id === 'tc_orphan')).toBe(false);
    expect(a1.content.some((b) => b.type === 'tool_call' && b.id === 'tc_paired')).toBe(true);
  });

  it('5. 链含 think_remove → assistant 的 reasoning block 被剥（其他 block 保留）', () => {
    const pm = fakePluginManager([fakeThinkRemoveReducer()]);
    const input: Message[] = [
      msg('assistant', [reasoningBlock(), text('visible')], 'a1'),
      msg('user', [text('q')], 'u1'),
    ];

    const out = runCleanViewPipeline(pm, input, 'default', fakeConfig);
    expect(out).not.toBeNull();
    const cleaned = out!;
    const a1 = cleaned.find((m) => m.id === 'a1')!;
    expect(a1.content.some((b) => b.type === 'reasoning')).toBe(false);
    expect(a1.content.some((b) => b.type === 'text' && b.text === 'visible')).toBe(true);
  });

  it('6. 单 reducer throw → 降级跳过保留 acc（链不中断）', () => {
    // 构造一个会 throw 的 reducer
    const throwingReducer = {
      reduce: (): Message[] => {
        throw new Error('intentional failure for test');
      },
    };
    // 后置一个 role_merge 验证「throw 后链继续」
    const pm = fakePluginManager([throwingReducer, fakeRoleMergeReducer()]);
    const input: Message[] = [
      msg('user', [text('q1')], 'u1'),
      msg('user', [text('q2')], 'u2'),
      msg('assistant', [text('a1')], 'a1'),
    ];

    const out = runCleanViewPipeline(pm, input, 'default', fakeConfig);
    // throwingReducer 失败 → 保留 acc（= input）；roleMerge 接力跑 → 合并 u1+u2
    expect(out).not.toBeNull();
    const cleaned = out!;
    expect(cleaned).toHaveLength(2); // u2 合并进 u1，剩 u1 + a1
    expect(cleaned[0]!.id).toBe('u1');
  });
});
