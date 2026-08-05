/**
 * executeSpawn 直接调用 UT（v0.0.28 debug）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（spawn 执行流程）
 *
 * 目的：隔离 spawn 链路本身（不经 LLM），证明 executeSpawn 能正确创建 child session
 * 并触发 deliverTo。若本 UT 通过 → spawn 链路通，AT case fail 根因在 LLM 层
 * （工具 schema / prompt / provider），而非 spawn 编排 bug。
 *
 * 白盒：mock SpawnDeps（createChildSession / deliverTo / children / loadTemplate），
 * 直接调 executeSpawn，断言 child 创建 + deliverTo 激活 + sync 返 answer。
 */
import { describe, it, expect } from 'vitest';
import { executeSpawn, ensureSendMessage, getFinalAnswerFromStore } from '../spawn-action';
import { agentTool } from '../agent-tool';
import { ChildrenTracker } from '../../agent-manager-children';
import type { AgentRun, RunResult } from '../../agent-interface';
import type { LoadTemplateFn } from '../template-loader';
import type { SubAgentTemplate } from '../types';

/** explorer 模板（builtin，modelId=null inherit parent） */
const explorerTemplate: SubAgentTemplate = {
  name: 'explorer',
  description: '只读探索',
  systemPrompt: '你是 explorer 子 agent',
  tools: ['read', 'web_search', 'web_fetch', 'send_message'],
  skills: [],
  modelId: null,
  builtin: true,
};
const loadExplorer: LoadTemplateFn = async (n) => (n === 'explorer' ? explorerTemplate : null);

/** 构造 mock AgentRun（sync 模式 promise 立即 resolve） */
function makeMockRun(answer: string): AgentRun {
  const result = {
    answer,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'no_tool_call',
    rounds: 1,
  } as unknown as RunResult;
  return {
    sessionId: 'child-mock',
    runId: 'run-mock',
    state: 'running',
    promise: Promise.resolve(result),
  } as unknown as AgentRun;
}

/** 记录 createChildSession 入参（验证 eff 字段是否透传） */
function makeMockDeps(opts: {
  children: ChildrenTracker;
  createdConfig: { value: unknown };
  deliveredTo: { value: string | null };
}) {
  return {
    ctx: {
      parentSessionId: 'parent-001',
      parentModelId: 'parent-model',
      parentProviderId: 'parent-provider',
      parentRef: { type: 'leader' as const, sessionId: 'parent-001', name: 'parent' },
      parentRunId: 'parent-run-001',
      parentScope: 'session' as const,
    },
    createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
      opts.createdConfig.value = input.childConfig;
      return { sessionId: input.childSid };
    },
    deliverTo: async (sid: string, _msg: unknown) => {
      opts.deliveredTo.value = sid;
      return makeMockRun('探查结果：发现 3 个文件');
    },
    children: opts.children,
    loadTemplate: loadExplorer,
  };
}

describe('executeSpawn 直接调用（隔离 spawn 链路）', () => {
  it('sync spawn explorer → 创建 child + deliverTo 激活 + 返 answer', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deliveredTo = { value: null as string | null };
    const deps = makeMockDeps({ children, createdConfig, deliveredTo });

    const result = await executeSpawn(
      {
        templateRef: 'explorer',
        task: { content: [{ type: 'text', text: '探查当前目录文件' }] },
        mode: 'sync',
      },
      deps,
      'toolcall-001',
    );

    // sync 模式返 answer
    expect(result.mode).toBe('sync');
    expect(result.childSessionId).toBeTruthy();
    if (result.mode === 'sync') {
      expect(result.answer).toBe('探查结果：发现 3 个文件');
    }

    // createChildSession 被调，且 eff 字段透传到 childConfig
    expect(createdConfig.value).toBeTruthy();
    const cfg = createdConfig.value as {
      systemPrompt: string; modelId: string; tools: string[];
      scope: string; parentSessionId: string; subAgentTemplateType: string | null;
      maxIter: number;
    };
    expect(cfg.systemPrompt).toBe('你是 explorer 子 agent');
    expect(cfg.tools).toEqual(['read', 'web_search', 'web_fetch', 'send_message']);
    expect(cfg.scope).toBe('subagent');
    expect(cfg.parentSessionId).toBe('parent-001');
    expect(cfg.subAgentTemplateType).toBe('explorer');
    expect(cfg.modelId).toBe('parent-model'); // inherit parent（模板 modelId=null）
    // [v0.0.246] providerId 透传（ctx.parentProviderId → childConfig.providerId）
    expect((cfg as { providerId?: string }).providerId).toBe('parent-provider');

    // deliverTo 被调且目标是 childSid
    expect(deliveredTo.value).toBe(result.childSessionId);

    // sync 完成后 children untrack（run settle 清理）
    expect(children.trackedOf('parent-001')).toHaveLength(0);
  });

  it('[v0.0.203] spawn 传 workspaceDir → childConfig 透传；不传 → 不出现该字段（createChildSessionImpl 继承 parent）', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = makeMockDeps({ children, createdConfig, deliveredTo: { value: null } });
    await executeSpawn(
      {
        templateRef: 'explorer',
        task: { content: [{ type: 'text', text: '带工作目录 spawn' }] },
        mode: 'sync',
        workspaceDir: '/tmp/draft-dir-v0.1',
      },
      deps,
      'toolcall-ws',
    );
    expect((createdConfig.value as { workspaceDir?: string }).workspaceDir).toBe('/tmp/draft-dir-v0.1');

    // 不传 workspaceDir → childConfig 不含该键（缺省继承 parent 行为不破）
    const created2 = { value: null as unknown };
    const deps2 = makeMockDeps({ children: new ChildrenTracker(), createdConfig: created2, deliveredTo: { value: null } });
    await executeSpawn(
      {
        templateRef: 'explorer',
        task: { content: [{ type: 'text', text: '默认继承 spawn' }] },
        mode: 'sync',
      },
      deps2,
      'toolcall-ws2',
    );
    expect('workspaceDir' in (created2.value as Record<string, unknown>)).toBe(false);
  });

  it('async spawn → 返 runId/status，children 在 promise settle 后 untrack', async () => {
    const children = new ChildrenTracker();
    const deps = makeMockDeps({
      children,
      createdConfig: { value: null },
      deliveredTo: { value: null },
    });

    const result = await executeSpawn(
      {
        templateRef: 'explorer',
        task: { content: [{ type: 'text', text: '异步探查' }] },
        mode: 'async',
      },
      deps,
      'toolcall-002',
    );

    expect(result.mode).toBe('async');
    if (result.mode === 'async') {
      expect(result.status).toBe('running');
      expect(result.childSessionId).toBeTruthy();
      expect(result.runId).toBeTruthy();
    }
    // mock promise 已 resolve → finally(untrack) 在微任务里执行；
    // 等一个宏任务让微任务跑完，验证最终 untrack（不泄漏）
    await new Promise((r) => setTimeout(r, 10));
    expect(children.trackedOf('parent-001')).toHaveLength(0);
  });

  it('spawn 时 children.track 注册 parent→child 关系（sync 期间可查）', async () => {
    // 用延迟 resolve 的 promise 验证 sync await 期间 children 有追踪
    const children = new ChildrenTracker();
    let resolveRun!: (v: RunResult) => void;
    const pendingPromise = new Promise<RunResult>((r) => { resolveRun = r; });
    const deps = {
      ctx: {
        parentSessionId: 'parent-002',
        parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'parent-002', name: 'p' },
        parentRunId: 'run-002',
        parentScope: 'session' as const,
      },
      createChildSession: async (i: { childSid: string }) => ({ sessionId: i.childSid }),
      deliverTo: async (_sid: string) => ({
        sessionId: 'c', runId: 'r', state: 'running', promise: pendingPromise,
      }),
      children,
      loadTemplate: loadExplorer,
    };

    const spawnP = executeSpawn(
      { templateRef: 'explorer', task: { content: [{ type: 'text', text: 'x' }] }, mode: 'sync' },
      deps as never, 'tc-003',
    );
    // 让 microtask 跑（track 已执行）
    await new Promise((r) => setTimeout(r, 5));
    expect(children.trackedOf('parent-002')).toHaveLength(1); // sync 期间 tracked
    resolveRun({ answer: 'done', usage: {}, stopReason: 'no_tool_call', rounds: 1 } as never);
    await spawnP;
    expect(children.trackedOf('parent-002')).toHaveLength(0); // settle 后 untrack
  });
});

// ============================================================
// Bug5 修复测试：sync spawn 从 transcript 提取 answer（不依赖 run.promise.answer）
// ============================================================
describe('Bug5: sync spawn 从 child transcript 提取最终 answer', () => {
  /** mock store：getMessages 返回指定 items */
  function makeMockStore(items: Array<{ role: string; content: Array<{ type: string; text?: string }> }>) {
    return {
      getMessages: async (_sid: string) => ({ items, hasMore: false }),
    };
  }

  it('run.promise.answer="" 但 transcript 有 assistant → getFinalAnswer 提取最后 assistant text', async () => {
    const children = new ChildrenTracker();
    const transcript = [
      { role: 'user', content: [{ type: 'text', text: '探查目录' }] },
      { role: 'assistant', content: [{ type: 'text', text: '中间结果' }] },
      { role: 'assistant', content: [{ type: 'text', text: '我已经收集并验证了足够的信息' }] },
    ];
    // run.promise 模拟 eager run 的硬填空 answer=''
    const emptyAnswerRun: AgentRun = {
      sessionId: 'c', runId: 'r', state: 'running',
      promise: Promise.resolve({
        answer: '', usage: { inputTokens: 10 }, stopReason: 'no_tool_call', rounds: 1,
      } as unknown as RunResult),
    } as unknown as AgentRun;
    const deps = {
      ctx: {
        parentSessionId: 'p1', parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'p1', name: 'p' },
        parentRunId: 'r1', parentScope: 'session' as const,
      },
      createChildSession: async (i: { childSid: string }) => ({ sessionId: i.childSid }),
      deliverTo: async () => emptyAnswerRun,
      children,
      loadTemplate: loadExplorer,
      getFinalAnswer: (sid: string) => getFinalAnswerFromStore(makeMockStore(transcript), sid),
    };

    const result = await executeSpawn(
      { templateRef: 'explorer', task: { content: [{ type: 'text', text: '探查' }] }, mode: 'sync' },
      deps as never, 'tc-bug5-1',
    );

    expect(result.mode).toBe('sync');
    if (result.mode === 'sync') {
      // ★ 核心断言：answer 来自 transcript 最后 assistant，不是 run.promise.answer（空）
      expect(result.answer).toBe('我已经收集并验证了足够的信息');
    }
  });

  it('getFinalAnswer 注入失败（store 读异常）→ fallback run.promise.answer（不阻断 spawn）', async () => {
    const children = new ChildrenTracker();
    const deps = {
      ctx: {
        parentSessionId: 'p2', parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'p2', name: 'p' },
        parentRunId: 'r2', parentScope: 'session' as const,
      },
      createChildSession: async (i: { childSid: string }) => ({ sessionId: i.childSid }),
      deliverTo: async () => ({
        sessionId: 'c', runId: 'r', state: 'running',
        promise: Promise.resolve({
          answer: 'fallback-answer', usage: {}, stopReason: 'no_tool_call', rounds: 1,
        } as unknown as RunResult),
      }),
      children,
      loadTemplate: loadExplorer,
      // 注入一个会 throw 的 getFinalAnswer（模拟 store 读失败）
      getFinalAnswer: async () => { throw new Error('store read failed'); },
    };

    const result = await executeSpawn(
      { templateRef: 'explorer', task: { content: [{ type: 'text', text: 'x' }] }, mode: 'sync' },
      deps as never, 'tc-bug5-2',
    );

    expect(result.mode).toBe('sync');
    if (result.mode === 'sync') {
      expect(result.answer).toBe('fallback-answer'); // fallback 不抛
    }
  });

  it('getFinalAnswer 未注入（旧调用方）→ fallback run.promise.answer（保持兼容）', async () => {
    const children = new ChildrenTracker();
    const deps = {
      ctx: {
        parentSessionId: 'p3', parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'p3', name: 'p' },
        parentRunId: 'r3', parentScope: 'session' as const,
      },
      createChildSession: async (i: { childSid: string }) => ({ sessionId: i.childSid }),
      deliverTo: async () => ({
        sessionId: 'c', runId: 'r', state: 'running',
        promise: Promise.resolve({
          answer: 'compat-answer', usage: {}, stopReason: 'no_tool_call', rounds: 1,
        } as unknown as RunResult),
      }),
      children,
      loadTemplate: loadExplorer,
      // 不注入 getFinalAnswer
    };

    const result = await executeSpawn(
      { templateRef: 'explorer', task: { content: [{ type: 'text', text: 'x' }] }, mode: 'sync' },
      deps as never, 'tc-bug5-3',
    );

    expect(result.mode).toBe('sync');
    if (result.mode === 'sync') {
      expect(result.answer).toBe('compat-answer');
    }
  });
});

// ============================================================
// getFinalAnswerFromStore 纯函数 UT
// ============================================================
describe('getFinalAnswerFromStore：从 transcript 提取最后 assistant text', () => {
  it('多条 assistant → 取最后一条，text blocks 用 \\n 聚合', async () => {
    const store = {
      getMessages: async () => ({
        items: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          { role: 'assistant', content: [{ type: 'text', text: '旧' }] },
          { role: 'assistant', content: [{ type: 'text', text: '行1' }, { type: 'text', text: '行2' }] },
        ],
        hasMore: false,
      }),
    };
    const ans = await getFinalAnswerFromStore(store as never, 'sid');
    expect(ans).toBe('行1\n行2');
  });

  it('无 assistant message → 返空字符串', async () => {
    const store = {
      getMessages: async () => ({
        items: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
        hasMore: false,
      }),
    };
    const ans = await getFinalAnswerFromStore(store as never, 'sid');
    expect(ans).toBe('');
  });

  it('assistant 含非 text block（如 tool_use）→ 只聚合 text block', async () => {
    const store = {
      getMessages: async () => ({
        items: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x' }, { type: 'text', text: 'final' }] },
        ],
        hasMore: false,
      }),
    };
    const ans = await getFinalAnswerFromStore(store as never, 'sid');
    expect(ans).toBe('final');
  });
});

// ============================================================
// v0.0.28 恢复白名单：spawn 不再强制追加 send_message
// 历史：v0.0.30 为修 Bug #3（subagent send_message unknown_tool）曾改成全集 +
//       async 强制 ensureSendMessage；现恢复 subAgentConfig.tools 白名单过滤，
//       并移除 async 强制追加（白名单本身定义可用工具，不再画蛇添足）。
// Bug #3 不回退依据：explorer 模板白名单本身含 send_message（见 tc-v0028-4）。
// ============================================================
describe('v0.0.28: spawn 不再强制追加 send_message（白名单语义）', () => {
  /** 不含 send_message 的模板（自定义 worker，模拟用户声明无回报场景） */
  const noReplyTemplate: SubAgentTemplate = {
    name: 'worker',
    description: '无回报工具的 worker',
    systemPrompt: '你是 worker',
    tools: ['web_search', 'web_fetch'], // ★ 缺 send_message（用户主动声明）
    skills: [],
    modelId: null,
    builtin: false,
  };
  const loadNoReply: LoadTemplateFn = async (n) => (n === 'worker' ? noReplyTemplate : null);

  it('async spawn 模板 tools 不含 send_message → eff.tools 原样透传（不追加）', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = {
      ctx: {
        parentSessionId: 'p-async', parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'p-async', name: 'p' },
        parentRunId: 'r-async', parentScope: 'session' as const,
      },
      createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
        createdConfig.value = input.childConfig;
        return { sessionId: input.childSid };
      },
      deliverTo: async () => makeMockRun(''),
      children,
      loadTemplate: loadNoReply,
    };

    const result = await executeSpawn(
      { templateRef: 'worker', task: { content: [{ type: 'text', text: '异步任务' }] }, mode: 'async' },
      deps as never, 'tc-v0028-1',
    );

    expect(result.mode).toBe('async');
    // ★ 核心断言（恢复白名单后）：不再强制追加 send_message，原样透传模板 tools
    const cfg = createdConfig.value as { tools: string[] };
    expect(cfg.tools).toEqual(['web_search', 'web_fetch']);
    expect(cfg.tools).not.toContain('send_message');
  });

  it('sync spawn 模板 tools 不含 send_message → 原样透传（与 async 一致）', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = {
      ctx: {
        parentSessionId: 'p-sync', parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'p-sync', name: 'p' },
        parentRunId: 'r-sync', parentScope: 'session' as const,
      },
      createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
        createdConfig.value = input.childConfig;
        return { sessionId: input.childSid };
      },
      deliverTo: async () => makeMockRun('sync answer'),
      children,
      loadTemplate: loadNoReply,
    };

    await executeSpawn(
      { templateRef: 'worker', task: { content: [{ type: 'text', text: '同步任务' }] }, mode: 'sync' },
      deps as never, 'tc-v0028-2',
    );

    const cfg = createdConfig.value as { tools: string[] };
    expect(cfg.tools).toEqual(['web_search', 'web_fetch']);
    expect(cfg.tools).not.toContain('send_message');
  });

  it('async spawn LLM 传 input.tools（覆盖模板）→ 原样透传（不追加）', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = {
      ctx: {
        parentSessionId: 'p-override', parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'p-override', name: 'p' },
        parentRunId: 'r-override', parentScope: 'session' as const,
      },
      createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
        createdConfig.value = input.childConfig;
        return { sessionId: input.childSid };
      },
      deliverTo: async () => makeMockRun(''),
      children,
      loadTemplate: loadExplorer,
    };

    await executeSpawn(
      {
        templateRef: 'explorer',
        tools: ['web_search'], // ★ LLM 显式覆盖，不含 send_message
        task: { content: [{ type: 'text', text: 'x' }] },
        mode: 'async',
      },
      deps as never, 'tc-v0028-3',
    );

    // ★ input.tools 覆盖模板后原样透传，不再被强制追加 send_message
    const cfg = createdConfig.value as { tools: string[] };
    expect(cfg.tools).toEqual(['web_search']);
  });

  it('explorer 模板白名单含 send_message → Bug #3 不回退（subagent 天然有 a2a 工具）', async () => {
    // 验证：恢复白名单后，builtin explorer 模板的白名单本身含 send_message，
    // 所以 spawn explorer 的 subagent 自然有 send_message 工具（Bug #3 不回退）。
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = {
      ctx: {
        parentSessionId: 'p-has', parentModelId: 'm',
        parentRef: { type: 'leader' as const, sessionId: 'p-has', name: 'p' },
        parentRunId: 'r-has', parentScope: 'session' as const,
      },
      createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
        createdConfig.value = input.childConfig;
        return { sessionId: input.childSid };
      },
      deliverTo: async () => makeMockRun(''),
      children,
      loadTemplate: loadExplorer, // explorer tools = [read,web_search,web_fetch,send_message]
    };

    await executeSpawn(
      { templateRef: 'explorer', task: { content: [{ type: 'text', text: 'x' }] }, mode: 'async' },
      deps as never, 'tc-v0028-4',
    );

    const cfg = createdConfig.value as { tools: string[] };
    // ★ explorer 模板自带 send_message（白名单语义保证），Bug #3 不回退
    expect(cfg.tools).toContain('send_message');
    expect(cfg.tools.filter((t) => t === 'send_message')).toHaveLength(1); // 不重复
  });
});

// ============================================================
// ensureSendMessage 纯函数 UT
// ============================================================
describe('ensureSendMessage 纯函数', () => {
  it('tools undefined → [send_message]', () => {
    expect(ensureSendMessage(undefined)).toEqual(['send_message']);
  });

  it('tools 不含 send_message → 追加', () => {
    expect(ensureSendMessage(['web_search', 'read'])).toEqual(['web_search', 'read', 'send_message']);
  });

  it('tools 已含 send_message → 原样返回（不重复）', () => {
    expect(ensureSendMessage(['read', 'send_message'])).toEqual(['read', 'send_message']);
  });

  it('空数组 → [send_message]', () => {
    expect(ensureSendMessage([])).toEqual(['send_message']);
  });
});

// ============================================================
// v0.0.222: spawn tools 三态落库值（mock 下沉到 store.createSession 边界）
// 背景：agent-tool.ts createChildSessionImpl 内 `tools: input.childConfig.tools`
//   曾用 `?? []` 把 undefined 降级成 []，导致下游 resolveToolSet 走交集分支得空集 →
//   subagent 零工具 + tool_guidance prompt 段缺席。
//   修复：去 ?? [] 透传 undefined，让 resolveToolSet 走 `undefined → new Set(bound)`
//   全集分支（继承 subagent.yaml toolBound）。
//   三态语义：undefined=继承 bound / []=显式空 / 非空=与 bound 交集
//
// ★ mock 边界选择（review Major 修复）：spy rtc.store.createSession——这才是
//   createChildSessionImpl 内部真正落库的边界，bug 即在此处发生（?? [] 转换）。
//   旧版 spy deps.createChildSession 捕获的是 createChildSessionImpl 的【入参】
//   （eff.tools 原值），bug 在该函数内部转换 → 绕过 → UT 对 pre/post-fix 无区分能力。
//   参考范式：spawn-child-squad-inherit.test.ts（装配真实 agentTool + spy store.createSession）
// ============================================================
describe('v0.0.222: spawn tools 三态（store.createSession 落库 subAgentConfig.tools）', () => {
  /**
   * 构造 mock agentToolContext；spy store.createSession 捕获真正落库的 subAgentConfig。
   * 关键：createChildSessionImpl 是真实跑的（经 agentTool → runSpawn → executeSpawn
   *   → deps.createChildSession = createChildSessionImpl(rtc, ci) → rtc.store.createSession），
   *   所以 line 332 的 `tools: input.childConfig.tools`（或 buggy `?? []`）会被真实执行。
   */
  function makeMockCtx(captured: { createSessionArg: Record<string, unknown> | null }) {
    return {
      parentSessionId: 'PARENT-001',
      parentRunId: 'run-001',
      parentType: 'leader' as const,
      parentName: 'alice',
      parentScope: 'session' as const,
      selfSessionId: 'PARENT-001',
      selfType: 'leader' as const,
      selfName: 'alice',
      agentManager: {
        deliverTo: async () => {
          const result = {
            answer: 'inline done', usage: {}, stopReason: 'no_tool_call', rounds: 1,
          } as unknown as RunResult;
          return {
            sessionId: 'c', runId: 'r', state: 'running', promise: Promise.resolve(result),
          } as unknown as AgentRun;
        },
        // [v0.0.246] runSpawn 改走 resolveConfigBySid 取 parent resolved {modelId, providerId}。
        //   mock 返 resolved 具体 {modelId, client.getInfo().providerId}（非 raw 'default'/空）。
        resolveConfigBySid: async (_sid: string) => ({
          modelId: 'parent-resolved-model',
          client: { getInfo: () => ({ providerId: 'parent-resolved-provider', providerName: 'p', modelId: 'parent-resolved-model', capabilities: {}, maxOutputTokens: 4096 }) },
        }),
        children: { track: () => {}, untrack: () => {}, trackedOf: () => [], perParentCount: () => 0, globalSubCount: () => 0 },
      },
      store: {
        // getSession：返带 raw 'default'/空 hint 的 parent（证明 runSpawn 已不再消费 raw modelId）；
        //   createChildSessionImpl 仍读 parent 取 biz/role/squadId/workspaceDir（非 model 维度，保留）
        getSession: async () => ({ modelId: 'default', providerId: 'raw-provider', workspaceDir: '/tmp' }),
        // ★ spy 真正落库边界：createChildSessionImpl 内调此方法写 subAgentConfig
        createSession: async (input: Record<string, unknown>) => {
          captured.createSessionArg = input;
          return { id: 'child' } as never;
        },
      },
      sessionDeps: {} as never,
      // inline spawn（无 templateRef）resolveEffective 不调 loader
      loadTemplate: async () => null,
    };
  }

  /** 跑 agent.spawn(inline) 并捕获 store.createSession 落库参数 */
  async function runInlineSpawn(spawnInput: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const captured = { createSessionArg: null as Record<string, unknown> | null };
    const ctx = { config: { agentToolContext: makeMockCtx(captured) } } as never;
    await agentTool.run(
      { action: 'spawn', spawn: spawnInput } as never,
      ctx,
    );
    return captured.createSessionArg;
  }

  it('① 不传 tools（无 templateRef）→ subAgentConfig.tools === undefined（继承 bound，非 []）', async () => {
    const arg = await runInlineSpawn({
      systemPrompt: '你是 inline subagent',
      // ★ 不传 tools → eff.tools=undefined → childConfig.tools=undefined
      task: { content: [{ type: 'text', text: 'inline 任务' }] },
      mode: 'sync',
    });
    expect(arg).toBeTruthy();
    const sub = (arg as { subAgentConfig: { tools?: string[] } }).subAgentConfig;
    // ★ 核心断言：undefined（透传，下游 resolveToolSet 走 bound 全集分支）
    //   非 []（被 ?? [] 降级 → 走交集分支得空集 → subagent 零工具）
    //   buggy 版（tools: input.childConfig.tools ?? []）下此断言 FAIL（actual: []）
    expect(sub.tools).toBeUndefined();
    expect(sub.tools).not.toEqual([]);
  });

  it('② 传 tools 子集 → subAgentConfig.tools === 子集（原样落库，下游与 bound 取交集）', async () => {
    const arg = await runInlineSpawn({
      systemPrompt: '你是 inline subagent',
      tools: ['read', 'bash'], // ★ 子集
      task: { content: [{ type: 'text', text: '子集 spawn' }] },
      mode: 'sync',
    });
    const sub = (arg as { subAgentConfig: { tools?: string[] } }).subAgentConfig;
    expect(sub.tools).toEqual(['read', 'bash']);
  });

  it('③ 传 tools=[] → subAgentConfig.tools === []（显式空，保留 LLM 显式声明无工具能力）', async () => {
    const arg = await runInlineSpawn({
      systemPrompt: '你是 inline subagent',
      tools: [], // ★ 显式空（与 undefined 区分）
      task: { content: [{ type: 'text', text: '空工具 spawn' }] },
      mode: 'sync',
    });
    const sub = (arg as { subAgentConfig: { tools?: string[] } }).subAgentConfig;
    // [] 必须原样落库（不被特殊处理），下游 resolveToolSet 走交集分支得空集（LLM 显式意图）
    expect(sub.tools).toEqual([]);
  });
});

// ============================================================
// [v0.0.246] D8 modelId 解析：模板 modelId 优先，模板 modelId=null 走 parent resolved
// 背景：spawn 入参无 modelId（不可覆盖模板），eff.modelId = template?.modelId ?? parent.modelId。
//   parent.modelId 现为 resolved 具体值（runSpawn 改走 resolveConfigBySid），
//   template-loader.ts 不改——parentModelId 现已是 resolved，D8 自然成立。
// providerId 始终 inherit parent resolved（无模板覆盖语义）。
// ============================================================
describe('[v0.0.246] D8 modelId 解析：模板优先 vs inherit parent resolved', () => {
  /** 模板显式指定 modelId（不 inherit parent） */
  const pinnedTemplate: SubAgentTemplate = {
    name: 'pinned',
    description: '模板指定 model',
    systemPrompt: '你是 pinned subagent',
    tools: ['read'],
    skills: [],
    modelId: 'template-pinned-model',
    builtin: false,
  };
  const loadPinned: LoadTemplateFn = async (n) => (n === 'pinned' ? pinnedTemplate : null);

  it('① 模板 modelId 非空 → eff.modelId = template.modelId（D8 模板优先，不取 parent resolved）', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = {
      ctx: {
        parentSessionId: 'p', parentModelId: 'parent-resolved-model', parentProviderId: 'parent-resolved-provider',
        parentRef: { type: 'leader' as const, sessionId: 'p', name: 'p' },
        parentRunId: 'r', parentScope: 'session' as const,
      },
      createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
        createdConfig.value = input.childConfig;
        return { sessionId: input.childSid };
      },
      deliverTo: async () => makeMockRun('ok'),
      children,
      loadTemplate: loadPinned,
    };

    await executeSpawn(
      { templateRef: 'pinned', task: { content: [{ type: 'text', text: 'x' }] }, mode: 'sync' },
      deps as never, 'tc-d8-1',
    );

    const cfg = createdConfig.value as { modelId: string; providerId?: string };
    // ★ 模板优先：eff.modelId = template.modelId，不取 parent resolved
    expect(cfg.modelId).toBe('template-pinned-model');
    // providerId 无模板覆盖语义，仍 inherit parent resolved
    expect(cfg.providerId).toBe('parent-resolved-provider');
  });

  it('② 模板 modelId=null → eff.modelId = parent resolved（D8 inherit）', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = {
      ctx: {
        parentSessionId: 'p', parentModelId: 'parent-resolved-model', parentProviderId: 'parent-resolved-provider',
        parentRef: { type: 'leader' as const, sessionId: 'p', name: 'p' },
        parentRunId: 'r', parentScope: 'session' as const,
      },
      createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
        createdConfig.value = input.childConfig;
        return { sessionId: input.childSid };
      },
      deliverTo: async () => makeMockRun('ok'),
      children,
      loadTemplate: loadExplorer, // explorer.modelId=null
    };

    await executeSpawn(
      { templateRef: 'explorer', task: { content: [{ type: 'text', text: 'x' }] }, mode: 'sync' },
      deps as never, 'tc-d8-2',
    );

    const cfg = createdConfig.value as { modelId: string; providerId?: string };
    // ★ 模板 null → inherit parent resolved 具体 modelId
    expect(cfg.modelId).toBe('parent-resolved-model');
    expect(cfg.providerId).toBe('parent-resolved-provider');
  });

  it('③ 纯 inline（无 templateRef）→ eff.modelId = parent resolved', async () => {
    const children = new ChildrenTracker();
    const createdConfig = { value: null as unknown };
    const deps = {
      ctx: {
        parentSessionId: 'p', parentModelId: 'parent-resolved-model', parentProviderId: 'parent-resolved-provider',
        parentRef: { type: 'leader' as const, sessionId: 'p', name: 'p' },
        parentRunId: 'r', parentScope: 'session' as const,
      },
      createChildSession: async (input: { childSid: string; childConfig: unknown }) => {
        createdConfig.value = input.childConfig;
        return { sessionId: input.childSid };
      },
      deliverTo: async () => makeMockRun('ok'),
      children,
      // inline spawn 不调 loadTemplate
    };

    await executeSpawn(
      { systemPrompt: '你是 inline subagent', task: { content: [{ type: 'text', text: 'x' }] }, mode: 'sync' },
      deps as never, 'tc-d8-3',
    );

    const cfg = createdConfig.value as { modelId: string; providerId?: string };
    expect(cfg.modelId).toBe('parent-resolved-model');
    expect(cfg.providerId).toBe('parent-resolved-provider');
  });
});
