/**
 * spawn child squad 字段继承 UT（v0.0.33.2 round-3 BUG-2 修复验证 + v0.0.56 字段名迁移）
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.F（spawn biz/squadId 继承）
 *       specs/api/version_logs/v0.0.33.2/change_log.md §3.3（agent(spawn) in squad）
 *
 * 验证 createChildSessionImpl 从 parent session 继承 biz/squadId（arch §3.3：
 *   squad 内 spawn 的 subagent child 落 studio + parent.squadId）。
 *   修前 child biz=None squadId=None → mate_spawn_subagent_tc1 fail。
 *
 * 白盒：mock agentToolContext（store.getSession 返带 biz/squadId 的 parent +
 *   spy createSession 捕获 child 入参），跑 agentTool.run({action:'spawn'}) 验证继承。
 */
import { describe, it, expect } from 'vitest';
import { agentTool } from '../agent-tool';
import type { ToolCtx, ToolInput } from '../../../tools/types';
import type { AgentRun, RunResult } from '../../agent-interface';

/** mock parent session record（caller 自定义 biz/squadId） */
interface ParentRow {
  modelId?: string;
  providerId?: string;
  workspaceDir?: string;
  biz?: string;
  squadId?: string;
}

/** 构造 mock agentToolContext；spy createSession 捕获 child 入参 */
function makeMockCtx(parent: ParentRow, captured: { childInput: Record<string, unknown> | null }) {
  return {
    parentSessionId: 'PARENT-001',
    parentRunId: 'run-001',
    parentType: 'mate' as const,
    parentName: 'alice',
    parentScope: 'session' as const,
    selfSessionId: 'PARENT-001',
    selfType: 'mate' as const,
    selfName: 'alice',
    agentManager: {
      deliverTo: async () => {
        const result: RunResult = {
          answer: 'ok', usage: {} as never, stopReason: 'no_tool_call', rounds: 1,
        };
        return { sessionId: 'c', runId: 'r', state: 'running', promise: Promise.resolve(result) } as unknown as AgentRun;
      },
      // [v0.0.246] runSpawn 改走 resolveConfigBySid 取 parent resolved {modelId, providerId}。
      //   mock 返 resolved 具体 {modelId, client.getInfo().providerId}（非 raw 'default'/空）。
      //   explorer 模板 modelId=null → eff.modelId = parent resolved（D8 inherit）。
      resolveConfigBySid: async (_sid: string) => ({
        modelId: 'parent-resolved-model',
        client: {
          getInfo: () => ({
            providerId: 'parent-resolved-provider',
            providerName: 'p',
            modelId: 'parent-resolved-model',
            capabilities: {},
            maxOutputTokens: 4096,
          }),
        },
      }),
      children: { track: () => {}, untrack: () => {}, trackedOf: () => [], perParentCount: () => 0, globalSubCount: () => 0 },
    },
    store: {
      // getSession：返带 raw 'default'/'raw-provider' 的 parent（证明 runSpawn 已不再消费 raw modelId/providerId）。
      //   createChildSessionImpl 仍读 parent 取 biz/role/squadId/workspaceDir（非 model 维度，保留）。
      getSession: async () => ({ modelId: 'default', providerId: 'raw-provider', workspaceDir: '/tmp', ...parent }),
      // createSession：捕获 child 入参（验证 biz/squadId 落库 + resolved modelId/providerId 落库）
      createSession: async (input: Record<string, unknown>) => {
        captured.childInput = input;
        return { id: 'child' } as never;
      },
    },
    sessionDeps: {} as never,
    loadTemplate: async () => ({
      name: 'explorer', description: 'x', systemPrompt: 'explorer-prompt',
      tools: ['read', 'send_message'], skills: [], modelId: null, builtin: true,
    }),
  };
}

/** 跑 agent.spawn 并捕获 child createSession 入参 */
async function runSpawn(parent: ParentRow): Promise<Record<string, unknown> | null> {
  const captured = { childInput: null as Record<string, unknown> | null };
  const ctx: ToolCtx = { config: { agentToolContext: makeMockCtx(parent, captured) } } as unknown as ToolCtx;
  const input: ToolInput = {
    action: 'spawn',
    spawn: { templateRef: 'explorer', mode: 'sync', task: { content: [{ type: 'text', text: 'explore' }] } },
  } as unknown as ToolInput;
  await agentTool.run(input, ctx);
  return captured.childInput;
}

describe('[round-3 BUG-2] spawn child 继承 parent biz/squadId', () => {
  it('studio mate spawn → child biz=studio + squadId=parent.squadId', async () => {
    const child = await runSpawn({ biz: 'studio', squadId: 'squad-001' });
    expect(child).toBeTruthy();
    expect(child!.biz).toBe('studio');
    expect(child!.squadId).toBe('squad-001');
    // [v0.0.56] derivation='subagent'；scope 字段已删除（SessionKind 迁移）
    expect(child!.derivation).toBe('subagent');
  });

  it('studio leader spawn → child 继承 leader 的 squadId', async () => {
    const child = await runSpawn({ biz: 'studio', squadId: 'squad-002' });
    expect(child!.biz).toBe('studio');
    expect(child!.squadId).toBe('squad-002');
  });

  it('playground 顶层 spawn（无 biz/squadId）→ child biz=playground（默认）+ squadId 不继承', async () => {
    const child = await runSpawn({});
    expect(child).toBeTruthy();
    // [v0.0.56] biz 始终有默认值（parent.biz ?? parent.bizType ?? 'playground'），不会是 undefined
    expect(child!.biz).toBe('playground');
    expect(child!.squadId).toBeUndefined();
    // playground spawn 仍是 subagent
    expect(child!.derivation).toBe('subagent');
  });

  it('studio mate spawn 但 parent 无 squadId（异常态）→ child 仅继承 biz', async () => {
    // 边界：biz=studio 但 squadId 缺（数据不一致态），只继承存在的字段，不伪造
    const child = await runSpawn({ biz: 'studio' });
    expect(child!.biz).toBe('studio');
    expect(child!.squadId).toBeUndefined();
  });
});

// ============================================================
// [v0.0.246] runSpawn resolved inherit 全链
// 核心：runSpawn 调 rtc.agentManager.resolveConfigBySid(parentSid) 取 parent resolved
//   具体 {modelId, providerId}，createChildSessionImpl 落库的 modelId/providerId = resolved
//   （非 store.getSession 返的 raw 'default'/'raw-provider' hint）。
// 背景：subagent 被 isStudioMainSession 切断 squad/classroom default 链，raw 'default' hint
//   会让子自己 fallback 跑空 → ModelNotConfiguredError。改让 child 候选为具体值绕开。
// explorer 模板 modelId=null → eff.modelId = parent resolved（D8 inherit 语义保留）。
// ============================================================
describe('[v0.0.246] runSpawn resolved inherit：child modelId/providerId 落 parent resolved 具体值', () => {
  it('explorer 模板（modelId=null）→ child modelId/providerId = parent resolved（非 raw hint）', async () => {
    // store.getSession 返 raw modelId='default'/providerId='raw-provider'（旧 hint，本版本起不再消费）
    const child = await runSpawn({ biz: 'studio', squadId: 'squad-001' });
    expect(child).toBeTruthy();
    // ★ 核心断言：child 落 parent resolved 具体 modelId（非 raw 'default'）
    expect(child!.modelId).toBe('parent-resolved-model');
    // ★ providerId 同样落 resolved（非 raw 'raw-provider'）
    expect(child!.providerId).toBe('parent-resolved-provider');
    // 兼容断言：biz/squadId 仍继承 parent（本改动只换 model 维度来源）
    expect(child!.biz).toBe('studio');
    expect(child!.squadId).toBe('squad-001');
  });
});
