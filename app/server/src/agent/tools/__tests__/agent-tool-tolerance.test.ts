/**
 * agent 工具 runSpawn 入参容错 UT（v0.0.28 debug）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（spawn 契约）
 *
 * 验证 LLM 不严格守 schema 时的容错（减少无谓 error 重试，提升 spawn 成功率）：
 *   - task="字符串"（整个 task 当文本）→ 转 [{type:'text',text}]
 *   - task={content:"字符串"}（content 非数组）→ 转 [{type:'text',text}]
 *   - mode 缺失 → 默认 'sync'
 *   - task.content 合法数组 → 原样透传
 *
 * 白盒：mock agentToolContext（store/agentManager/loadTemplate）+ executeSpawn 依赖，
 *      spy createChildSession 捕获容错后的 spawnInput，验证 task/mode 正确。
 */
import { describe, it, expect } from 'vitest';
import { agentTool } from '../agent-tool';
import type { ToolCtx, ToolInput } from '../../../tools/types';
import type { AgentRun, RunResult } from '../../agent-interface';
import type { SpawnAgentInput } from '../types';

/** 构造 mock agentToolContext（readRuntimeContext 取出用） */
function makeMockCtx(captured: { spawnInput: SpawnAgentInput | null; deliveredMsg?: { sender?: { source?: string; agent?: { needReply?: boolean } } } }) {
  return {
    parentSessionId: 'PARENT-001',
    parentRunId: 'run-001',
    parentType: 'leader' as const,
    parentName: 'parent',
    parentScope: 'session' as const,
    // [BUG-032] caller self 字段（spawn 不用 self，但 ctx 类型必填）
    selfSessionId: 'PARENT-001',
    selfType: 'leader' as const,
    selfName: 'parent',
    agentManager: {
      // deliverTo：捕获 msg（验证 needReply）+ 返 mock run（sync 立即 resolve）
      deliverTo: async (_sid: string, msg: unknown) => {
        captured.deliveredMsg = msg as { sender?: { source?: string; agent?: { needReply?: boolean } } };
        const result: RunResult = {
          answer: 'ok', usage: {} as never, stopReason: 'no_tool_call', rounds: 1,
        };
        return { sessionId: 'c', runId: 'r', state: 'running', promise: Promise.resolve(result) } as unknown as AgentRun;
      },
      // [v0.0.246] runSpawn 改走 resolveConfigBySid 取 parent resolved {modelId, providerId}
      resolveConfigBySid: async (_sid: string) => ({
        modelId: 'parent-model',
        client: { getInfo: () => ({ providerId: 'prov', providerName: 'p', modelId: 'parent-model', capabilities: {}, maxOutputTokens: 4096 }) },
      }),
      children: { track: () => {}, untrack: () => {}, trackedOf: () => [], perParentCount: () => 0, globalSubCount: () => 0 },
    },
    store: {
      // getSession：parent modelId（D8 inherit）
      getSession: async () => ({ modelId: 'parent-model', providerId: 'prov', workspaceDir: '/tmp' }),
      // createSession：捕获 spawnInput（经 createChildSessionImpl 透传）
      createSession: async (input: { subAgentConfig?: unknown }) => {
        // subAgentConfig 含 systemPrompt，间接验证 spawnInput 透传；这里只验证调用
        captured.spawnInput = input as unknown as SpawnAgentInput;
        return { id: 'child' } as never;
      },
    },
    sessionDeps: {} as never,
    loadTemplate: async () => ({
      name: 'explorer', description: 'x', systemPrompt: 'explorer-prompt',
      tools: ['read', 'web_search', 'web_fetch', 'send_message'], skills: [], modelId: null, builtin: true,
    }),
  };
}

/** 调 agentTool.run({action:'spawn', spawn:...}) 并捕获 */
async function runSpawnAgent(spawnField: unknown): Promise<{ text: string; isError: boolean; captured: { spawnInput: SpawnAgentInput | null; deliveredMsg?: { sender?: { source?: string; agent?: { needReply?: boolean } } } } }> {
  const captured = { spawnInput: null as SpawnAgentInput | null, deliveredMsg: undefined as { sender?: { source?: string; agent?: { needReply?: boolean } } } | undefined };
  const ctx: ToolCtx = { config: { agentToolContext: makeMockCtx(captured) } } as unknown as ToolCtx;
  const input: ToolInput = { action: 'spawn', spawn: spawnField } as unknown as ToolInput;
  const res = await agentTool.run(input, ctx);
  // ToolRunResult.content 是 ContentBlock[]；提取首个 text block 的 text
  const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = blocks.map((b) => b?.text ?? '').join('');
  return { text, isError: res.isError, captured };
}

describe('agent.spawn 入参容错（LLM 不严格守 schema）', () => {
  it('task={content:[{type:text,text}]} 合法数组 → 原样透传 + child 创建', async () => {
    const { text } = await runSpawnAgent({
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查目录' }] },
      mode: 'sync',
    });
    // 成功返 sync result（非 error）
    expect(text).not.toMatch(/error/i);
    expect(text).toContain('"mode":"sync"');
  });

  it('task={content:"字符串"} → 容错转 [{type:text,text}] + child 创建', async () => {
    const { text } = await runSpawnAgent({
      templateRef: 'explorer',
      task: { content: '探查目录' }, // ← content 是字符串非数组
      mode: 'sync',
    });
    expect(text).not.toMatch(/task\.content is required/i);
    expect(text).toContain('"mode":"sync"'); // 成功
  });

  it('task="字符串"（整个 task 当文本）→ 容错转 text block + child 创建', async () => {
    const { text } = await runSpawnAgent({
      templateRef: 'explorer',
      task: '探查当前目录文件', // ← task 直接是字符串
      mode: 'sync',
    });
    expect(text).not.toMatch(/task\.content is required/i);
    expect(text).toContain('"mode":"sync"');
  });

  it('mode 缺失 → 默认 sync（不报 mode must be）', async () => {
    const { text } = await runSpawnAgent({
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查' }] },
      // mode 缺失
    });
    expect(text).not.toMatch(/mode must be/i);
    expect(text).toContain('"mode":"sync"'); // 默认 sync
  });

  it('task 完全缺失 → 仍报 task is required（真错误不容错）', async () => {
    const { text } = await runSpawnAgent({
      templateRef: 'explorer',
      // task 缺失
      mode: 'sync',
    });
    expect(text).toMatch(/task is required/i);
  });
});

/**
 * [BUG-033] spawn mode 嵌套在 task 对象里的容错提取。
 *
 * 真实 LLM 实测形态（a2a_reply_render_tc1 langfuse trace）：
 *   arguments.spawn = {templateRef, task:{content:[...], mode:'async'}}
 * LLM 把 mode 嵌进 task 而非顶层 spawn.mode。旧实现 spawnInput.mode 为 undefined →
 * 默认 sync → 首任务 needReply=false（async 语义断裂：async spawn 期待 child 回报，
 * needReply 应 true）。修复：从 task.mode 提取到顶层 spawnInput.mode。
 *
 * 影响：a2a_protocol §4.2 needReply 语义；async spawn 首任务 needReply=true 是 child
 * 完成后主动 send_message 回报的协议前提。
 */
describe('[BUG-033] spawn mode 嵌套在 task 里的容错提取', () => {
  it('task.mode=async + 顶层 spawn.mode 缺失 → 提取为 async（needReply=true）', async () => {
    const { text, captured } = await runSpawnAgent({
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查' }], mode: 'async' }, // ← mode 嵌在 task
      // 顶层 mode 缺失
    });
    expect(text).not.toMatch(/error/i);
    expect(text).toContain('"mode":"async"');
    // needReply=true（async 首任务：child 完成主动 send_message 回报）
    expect(captured.deliveredMsg?.sender?.agent?.needReply).toBe(true);
  });

  it('task.mode=sync + 顶层 spawn.mode 缺失 → 提取为 sync（needReply=false）', async () => {
    const { text, captured } = await runSpawnAgent({
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查' }], mode: 'sync' },
    });
    expect(text).toContain('"mode":"sync"');
    expect(captured.deliveredMsg?.sender?.agent?.needReply).toBe(false);
  });

  it('顶层 spawn.mode 优先于 task.mode（顶层显式 > 嵌套容错）', async () => {
    const { text, captured } = await runSpawnAgent({
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查' }], mode: 'sync' },
      mode: 'async', // ← 顶层显式 async
    });
    expect(text).toContain('"mode":"async"');
    expect(captured.deliveredMsg?.sender?.agent?.needReply).toBe(true);
  });

  it('task.mode 非法值（非 sync/async）→ 不提取，走默认 sync', async () => {
    const { text, captured } = await runSpawnAgent({
      templateRef: 'explorer',
      task: { content: [{ type: 'text', text: '探查' }], mode: 'concurrent' }, // ← 非法
    });
    expect(text).toContain('"mode":"sync"');
    expect(captured.deliveredMsg?.sender?.agent?.needReply).toBe(false);
  });
});
