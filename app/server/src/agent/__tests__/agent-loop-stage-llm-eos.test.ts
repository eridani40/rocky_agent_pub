/**
 * EOS 双保险 UT（白盒）
 * 参考: specs/tech/squad/[P1]agent_squad_chat.md §5.1（<EOS> 协议）
 *
 * 覆盖：
 *   ① stripEosToken 纯函数：strip 尾部 `<EOS>` + 环绕空白 / 多 text block / 非 text block 不动
 *   ② 现行生产接线（buildRunDeps 装配层）：
 *      - main + squad → spec.stopSequences=['<EOS>'] + spec.eosStripper=stripEosToken
 *      - main + 非 squad → 两者皆 undefined
 *      - 旁路 run（summary）→ 不注入（undefined）
 *   ③ EOS_STOP_TOKEN 常量 = '<EOS>'
 */
import { describe, it, expect, vi } from 'vitest';
import { stripEosToken, EOS_STOP_TOKEN } from '../agent-loop-stage-llm';
import { buildRunDeps, type BuildRunDepsOpts } from '../build-run-deps';
import type { SessionTypePolicy } from '../session-type-policy';
import type { ResolvedSessionProfile } from '../session-type-profile-loader';
import type { SessionConfig } from '../context-types';
import type { ContentBlock } from '../../message/types';
import { SessionKind } from '@app/shared';

// ============================================================
// ① stripEosToken 纯函数
// ============================================================
describe('stripEosToken — strip 尾部 <EOS>（EOS 双保险 · 保险二）', () => {
  it('strips trailing <EOS>', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'done<EOS>' }];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('done');
  });

  it('strips <EOS> with leading whitespace（保留前导内容空白）', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'done\n<EOS>' }];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('done');
  });

  it('strips <EOS> with surrounding whitespace（清残留空行）', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'done\n<EOS>\n  ' }];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('done');
  });

  it('no <EOS> → 不改 text', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'normal reply' }];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('normal reply');
  });

  it('mid-text <EOS> 不被 strip（只 strip 尾标记）', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: '<EOS>middle' }];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('<EOS>middle');
  });

  it('仅尾部的 <EOS> 被 strip（中间的同名 token 保留）', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'see <EOS> here done<EOS>' }];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('see <EOS> here done');
  });

  it('多 text block：每个 block 尾部 <EOS> 都 strip', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'part1<EOS>' },
      { type: 'text', text: 'part2<EOS>' },
    ];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('part1');
    expect((blocks[1] as { text: string }).text).toBe('part2');
  });

  it('非 text block（tool_call/reasoning）原样保留', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'calling<EOS>' },
      { type: 'tool_call', id: 'tc1', name: 'send_message', arguments: { to: 'leader' } },
    ];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('calling');
    expect(blocks[1]).toEqual({
      type: 'tool_call',
      id: 'tc1',
      name: 'send_message',
      arguments: { to: 'leader' },
    });
  });

  it('空数组 / 空 text → 安全无操作', () => {
    expect(() => stripEosToken([])).not.toThrow();
    const blocks: ContentBlock[] = [{ type: 'text', text: '' }];
    stripEosToken(blocks);
    expect((blocks[0] as { text: string }).text).toBe('');
  });

  it('EOS_STOP_TOKEN 常量 = "<EOS>"', () => {
    expect(EOS_STOP_TOKEN).toBe('<EOS>');
  });
});

// ============================================================
// ② 现行生产接线：buildRunDeps 装配 stopSequences / eosStripper
// ============================================================

/** profile mock（main / summary 两形态；EOS 装配只读 kind，profile 字段无关） */
function mockPolicy(runKind: 'main' | 'summary'): SessionTypePolicy {
  const profile: ResolvedSessionProfile = {
    id: `studio-squad:parent:${runKind}`,
    enabled: true,
    toolBound: [],
    toolDefinitionsSource: runKind === 'main' ? 'own' : 'host-snapshot',
    runShape: {
      drainMode: runKind === 'main' ? 'eager' : 'none',
      backgroundPath: false,
      maxIterDefault: runKind === 'main' ? 25 : 1,
      touchesStateMachine: runKind === 'main',
      persistsRun: runKind === 'main',
      usagePartition: runKind === 'main' ? 'current' : 'summary',
    },
    lifecycleHooks: { abortFinalize: runKind === 'main' ? 'four-step' : 'none', cascadeChildren: runKind === 'main' },
    eventChannel: { emitDefault: true },
    modelHints: { readsSquadDefault: false },
    skillSource: 'global-enabled',
    eosStop: [],
    autoNaming: false,
    preloadContext: 'none',
  };
  return {
    profile: vi.fn(() => profile),
    resolveToolSet: vi.fn(() => ({ tools: [], toolDefinitions: [], allowedTools: [] })),
  };
}

/** 构造最小 buildRunDeps 入参（构造期不触 store/bus 方法，mock cast 安全） */
function makeOpts(kind: SessionKind): BuildRunDepsOpts {
  const config = {
    sessionId: 's1',
    modelId: 'm1',
    systemPrompt: 'sys',
    tools: [],
    maxIterations: 25,
    kind,
  } as unknown as SessionConfig;
  const opts: BuildRunDepsOpts = {
    config,
    bus: { emit: vi.fn() } as unknown as BuildRunDepsOpts['bus'],
    store: {} as unknown as BuildRunDepsOpts['store'],
    contextEngine: {
      // buildRunDeps 构造期读取的三个 accessor（装配用，不触 store）
      getPluginManager: () => null,
      getStateMachine: () => ({}) ,
      getTaskLock: () => ({}),
    } as unknown as BuildRunDepsOpts['contextEngine'],
    toolEngine: {} as unknown as BuildRunDepsOpts['toolEngine'],
    controller: { runId: 'r1', aborted: false },
    sessionTypePolicy: mockPolicy(kind.runKind === 'main' ? 'main' : 'summary'),
    kind,
    runId: 'r1',
  };
  if (kind.runKind !== 'main') {
    // 旁路 run 必填：snapshot（toolDefinitions 复用源）+ userMessage
    opts.snapshot = { tools: [] } as unknown as NonNullable<BuildRunDepsOpts['snapshot']>;
    opts.userMessage = {
      id: 'u1', sessionId: 's1', role: 'user',
      content: [{ type: 'text', text: 'task' }],
    } as unknown as NonNullable<BuildRunDepsOpts['userMessage']>;
  }
  return opts;
}

describe('buildRunDeps — EOS 双保险装配（保险一 stop seq + 保险二 stripper）', () => {
  it('main + squad → spec.stopSequences=["<EOS>"] + spec.eosStripper=stripEosToken', () => {
    const kind = new SessionKind({ biz: 'studio', role: 'squad', derivation: 'parent', runKind: 'main' });
    const { spec } = buildRunDeps(makeOpts(kind));
    expect(spec.stopSequences).toEqual(['<EOS>']);
    expect(spec.eosStripper).toBe(stripEosToken);
  });

  it('main + 非 squad（rocky）→ stopSequences/eosStripper 皆 undefined', () => {
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });
    const { spec } = buildRunDeps(makeOpts(kind));
    expect(spec.stopSequences).toBeUndefined();
    expect(spec.eosStripper).toBeUndefined();
  });

  it('旁路 run（squad summary）→ 不注入 EOS（旁路无路由输出契约）', () => {
    const kind = new SessionKind({ biz: 'studio', role: 'squad', derivation: 'parent', runKind: 'summary' });
    const { spec } = buildRunDeps(makeOpts(kind));
    expect(spec.stopSequences).toBeUndefined();
    expect(spec.eosStripper).toBeUndefined();
  });
});
