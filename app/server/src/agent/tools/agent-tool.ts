/**
 * agent 工具 —— parent 派生/管理 subagent（v0.0.28 task-2）
 * 参考: specs/tech/agent/tools/[P1]agent_tools.md §1（agent 单工具 3 action）
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §4/§6/§7（spawn/abort/query 契约）
 *
 * 一个工具，三 action：spawn / query / abort（agent_tools §1 收敛原则）。
 * scope='session' 才注册（subagent scope 不注册——agent-loop allowedTools 已过滤，engine 门控）。
 *
 * 分发：LLM 调 agent({ action, ... }) → 按 action 路由到 executeSpawn/Query/Abort。
 * 依赖：从 ctx.config.agentToolContext 读 runtime context（manager/store/sessionDeps/loadTemplate）。
 *
 * 单文件 ≤300 行（工具壳 + action 分发；action 逻辑拆 spawn/query/abort-action.ts）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import { ulid } from '../../config/ulid';
import type { Role, Derivation, BizType } from '@app/shared';
import { executeSpawn, ConcurrencyLimitError, getFinalAnswerFromStore } from './spawn-action';
import { executeQuery } from './query-action';
import { executeAbort } from './abort-action';
import {
  readRuntimeContext, parentAgentRef, resolveAgentRef,
} from './runtime-context';
import type { SpawnAgentInput } from './types';

/**
 * 构造 agent 工具的单例工厂（registry defaultTools 引用）。
 * 工具 run 时从 ctx.config.agentToolContext 读 runtime context（不持依赖，纯函数式分发）。
 */
export const agentTool: Tool = {
  definition: {
    name: 'agent',
    description:
      'Spawn / query / abort a sub-agent (isolated session, usage reports to parent as "sub"). ' +
      'action="spawn" creates a sub-agent + first task (sync awaits final answer / async returns handle). ' +
      'action="query" lists children (running/terminated groups) or single detail by ref. ' +
      'action="abort" interrupts an in-flight child by ref. Only available in session scope.',
    intro: 'Spawn, query, or abort a sub-agent.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          description: 'spawn | query | abort',
        },
        spawn: {
          type: 'object',
          description:
            'SpawnAgentInput (when action=spawn). Required: task, mode. ' +
            'task.content is an array of content blocks (e.g. [{type:"text",text:"..."}]).',
          required: ['task', 'mode'],
          properties: {
            templateRef: {
              type: 'string',
              description: '引用模板名（如 "explorer"）；载入 systemPrompt/tools/skills/modelId',
            },
            systemPrompt: {
              type: 'string',
              description: '覆盖模板 systemPrompt（无 templateRef 时必填）',
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: '覆盖模板 tools 白名单（如 ["read","web_search","send_message"]）',
            },
            skills: {
              type: 'array',
              items: { type: 'string' },
              description: '覆盖模板 skills',
            },
            task: {
              type: 'object',
              description: '首任务（语义同 send_message：内部构造 sender.agent 子结构）',
              required: ['content'],
              properties: {
                content: {
                  type: 'array',
                  description: '内容块数组（如 [{type:"text",text:"探查当前目录"}]）',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: '"text"' },
                      text: { type: 'string' },
                    },
                  },
                },
              },
            },
            mode: {
              type: 'string',
              enum: ['sync', 'async'],
              description: 'sync=阻塞等 final answer；async=立即返 handle',
            },
            maxIter: {
              type: 'number',
              description: 'subagent maxIter（缺省 25）',
            },
          },
        },
        query: {
          type: 'object',
          description: 'QueryAgentInput (when action=query): ref（单查）或 filter（列表）',
          properties: {
            ref: {
              type: 'string',
              description: '单查目标 sessionId 或 "parent" 别名',
            },
            filter: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['running', 'terminated'] },
                templateType: { type: 'string' },
                limit: { type: 'number' },
              },
            },
          },
        },
        abort: {
          type: 'object',
          description: 'AbortInput (when action=abort)',
          required: ['ref'],
          properties: {
            ref: {
              type: 'string',
              description: '要中断的 child sessionId 或 "parent" 别名',
            },
          },
        },
      },
    },
  },
  // [v0.0.130.hang] per-tool 默认超时：spawn(sync) follow-child 语义，600s（engine 硬天花板同值，见 change_plan.md 模块 A）
  defaultTimeoutMs: 600000,

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const action = String(input.action ?? '').trim();
    if (action !== 'spawn' && action !== 'query' && action !== 'abort') {
      return errorResult(`agent: invalid action "${action}" (expected spawn|query|abort)`);
    }
    let rtc;
    try {
      rtc = readRuntimeContext(ctx.config);
    } catch (e) {
      return errorResult(`agent: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      if (action === 'spawn') {
        return await runSpawn(input, rtc);
      }
      if (action === 'query') {
        return await runQuery(input, rtc);
      }
      return await runAbort(input, rtc);
    } catch (e) {
      if (e instanceof ConcurrencyLimitError) {
        return errorResult(`agent.${action}: running limit reached (${e.which})`);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`agent.${action}: ${msg}`);
    }
  },
};

/** 执行 spawn action（从 input.spawn 取 SpawnAgentInput，注入 SpawnDeps） */
async function runSpawn(
  input: ToolInput,
  rtc: ReturnType<typeof readRuntimeContext>,
): Promise<ToolRunResult> {
  const spawnInput = (input.spawn ?? {}) as Partial<SpawnAgentInput>;
  // 必填校验 + 容错：task.content（LLM 常不严格守 schema，传字符串/非数组 → 容错转 text block）
  // 容错场景：task="字符串" / task={content:"字符串"} / task={content:[{type:'text',text:'...'}]}
  if (!spawnInput.task) {
    return errorResult('agent.spawn: task is required');
  }
  const rawContent = (spawnInput.task as { content?: unknown }).content;
  let contentBlocks: unknown[];
  if (Array.isArray(rawContent)) {
    contentBlocks = rawContent;
  } else if (typeof rawContent === 'string') {
    // LLM 传 task.content="字符串" → 容错转 [{type:'text',text}]
    contentBlocks = [{ type: 'text', text: rawContent }];
  } else if (typeof spawnInput.task === 'string') {
    // LLM 传 task="字符串"（整个 task 当文本）→ 容错转 [{type:'text',text}]
    contentBlocks = [{ type: 'text', text: spawnInput.task }];
  } else {
    return errorResult('agent.spawn: task.content is required (array of content blocks)');
  }
  // [BUG-033] mode 容错提取：LLM 常把 mode 嵌进 task 对象（{task:{content:[...], mode:'async'}}）
  // 而非顶层 spawn.mode。必须在 task 重写前读取（spawnInput 是 input.spawn 的引用，重写 task
  // 后原始 task.mode 丢失）。提取 task.mode 到顶层 spawnInput.mode，避免被默认 sync 覆盖。
  // async 首任务 needReply=true 是 a2a_protocol §4.2 语义：async spawn 期待 child 完成后
  // send_message 回报。形态（真 LLM 实测）：arguments.spawn = {templateRef, task:{content:[...], mode:'async'}}
  // 顶层 spawn.mode 缺失 → 旧实现默认 sync → needReply=false（BUG-033：async 变 sync，语义断裂）。
  if (spawnInput.mode !== 'sync' && spawnInput.mode !== 'async') {
    const taskObj = (input.spawn as { task?: { mode?: unknown } } | undefined)?.task;
    const taskMode = taskObj?.mode;
    if (taskMode === 'sync' || taskMode === 'async') {
      spawnInput.mode = taskMode;
    }
  }
  spawnInput.task = { content: contentBlocks as SpawnAgentInput['task']['content'] };
  // mode 容错：缺失默认 'sync'（spawn 最常用场景；LLM 常漏传 mode 导致无谓 error 重试）
  if (spawnInput.mode !== 'sync' && spawnInput.mode !== 'async') {
    spawnInput.mode = 'sync';
  }
  // origin.toolCallId 审计用：Tool 接口无法直接取 toolCall.id（engine 不透传），用 ULID 占位
  // （真实 toolCallId 在 ToolResultBlock 绑定；origin 此处仅审计，不强求精确）
  const toolCallId = ulid();
  // [v0.0.246] D8 inherit 改用 parent resolved：调 resolveConfigBySid 取 parent 这次 run 解析出的
  //   具体 {modelId, providerId}（不读 session.modelId raw hint 'default'/空，subagent 切断 default 链会跑空）。
  //   providerId 不在 SessionConfig 顶层（resolver 局部变量），从 client.getInfo() 取。
  const parentConfig = await rtc.agentManager.resolveConfigBySid(rtc.parentSessionId);
  const parentModelId = parentConfig.modelId;
  const parentProviderId = parentConfig.client.getInfo().providerId;
  const result = await executeSpawn(
    spawnInput as SpawnAgentInput,
    {
      ctx: {
        parentSessionId: rtc.parentSessionId,
        parentModelId,
        parentProviderId,
        parentRef: parentAgentRef(rtc),
        parentRunId: rtc.parentRunId,
        parentScope: rtc.parentScope,
      },
      createChildSession: (ci) => createChildSessionImpl(rtc, ci),
      deliverTo: (sid, msg) => rtc.agentManager.deliverTo(sid, msg),
      children: rtc.agentManager.children,
      // [Bug5 修复] sync spawn 从 child transcript 提取最终 answer（eager run.promise.answer 永远空）
      getFinalAnswer: (childSid) => getFinalAnswerFromStore(rtc.store, childSid),
      ...(rtc.loadTemplate ? { loadTemplate: rtc.loadTemplate } : {}),
    },
    toolCallId,
  );
  return textResult(JSON.stringify(result));
}

/** 执行 query action（注入 QueryDeps） */
async function runQuery(
  input: ToolInput,
  rtc: ReturnType<typeof readRuntimeContext>,
): Promise<ToolRunResult> {
  const qInput = (input.query ?? {}) as { ref?: unknown; filter?: { status?: 'running' | 'terminated'; templateType?: string; limit?: number } };
  const result = await executeQuery(qInput, {
    parentSessionId: rtc.parentSessionId,
    listChildren: (sid, filter) => rtc.store.listChildren(sid, filter),
    getChildDetail: async (childSid) => {
      const s = await rtc.store.getSession(childSid);
      if (!s) return null;
      const usage = await rtc.store.getUsageView(childSid);
      return {
        state: s.state,
        usage,
        updatedAt: s.updatedAt,
        subAgentTemplateType: s.subAgentTemplateType ?? null,
      };
    },
    resolveRef: (ref) => resolveAgentRef(ref, rtc.parentSessionId),
  });
  return textResult(JSON.stringify(result));
}

/** 执行 abort action（注入 AbortDeps） */
async function runAbort(
  input: ToolInput,
  rtc: ReturnType<typeof readRuntimeContext>,
): Promise<ToolRunResult> {
  const aInput = (input.abort ?? {}) as { ref?: unknown };
  if (!aInput.ref) {
    return errorResult('agent.abort: ref is required');
  }
  const result = await executeAbort(aInput.ref, {
    parentSessionId: rtc.parentSessionId,
    resolveRef: (ref) => resolveAgentRef(ref, rtc.parentSessionId),
    getChildRunId: async (childSid) => (await rtc.store.getSession(childSid))?.currentRunId ?? null,
    abortRun: (sid, runId) => rtc.agentManager.abort(sid, runId, 'main'),
  });
  return textResult(JSON.stringify(result));
}

/**
 * createChildSession 注入实现：createSession + 构造 child SessionConfig 落库。
 * 注：child config 的 client/tools 组装由 buildSessionConfigFromDeps（session-config.ts）负责；
 * deliverTo(childSid) 时 resolveConfig 会按 childSid 取 config 激活。本函数只落 session record。
 *
 * derivation/role/biz 全部从 eff 读：derivation 恒 'subagent'（resolveEffective gate），
 * role 缺省 parent.role bloodline；parentSessionId 必填（subagent 派生拓扑）。
 */
async function createChildSessionImpl(
  rtc: ReturnType<typeof readRuntimeContext>,
  input: {
    childSid: string;
    childConfig: {
      systemPrompt: string;
      modelId: string;
      /** [v0.0.246] resolved providerId 透传（替代旧 parent?.providerId raw hint） */
      providerId?: string;
      tools?: string[];
      skills?: string[];
      maxIter: number;
      scope: 'subagent';
      parentSessionId: string;
      subAgentTemplateType: string | null;
      origin: { spawnRunId: string; toolCallId: string };
      /** spawn 泛化字段：身份维度从 eff 读 */
      role?: Role;
      derivation: Derivation;
      /** [v0.0.203] caller-provided child 工作目录（透传；缺省=继承 parent） */
      workspaceDir?: string;
    };
  },
): Promise<{ sessionId: string }> {
  // [v0.0.246] getSession 仍读 parent 取 biz/role/squadId/workspaceDir（非 model 维度，保留）；
  //   model 维度（modelId/providerId）由 executeSpawn 从 ctx.parentModelId/parentProviderId 透传。
  const parent = await rtc.store.getSession(rtc.parentSessionId);
  const childBiz: BizType = (parent?.biz ?? 'playground') as BizType;
  const childRole: Role = input.childConfig.role ?? parent?.role ?? 'rocky';
  await rtc.store.createSession({
    id: input.childSid,
    title: input.childConfig.subAgentTemplateType ?? 'subagent',
    role: childRole,
    derivation: 'subagent',
    biz: childBiz,
    parentSessionId: input.childConfig.parentSessionId,
    subAgentTemplateType: input.childConfig.subAgentTemplateType ?? undefined,
    origin: input.childConfig.origin,
    providerId: input.childConfig.providerId,
    modelId: input.childConfig.modelId,
    // [v0.0.203] caller-provided workspaceDir 优先；缺省继承 parent（既有行为不破）
    workspaceDir: input.childConfig.workspaceDir ?? parent?.workspaceDir,
    // studio squadId 跟 parent（studio spawn → studio+squadId；subagent 才有意义）
    ...(parent?.squadId !== undefined ? { squadId: parent.squadId } : {}),
    // subagent 派生配置（eff 持久化；buildSessionConfigFromDeps 覆盖默认）
    // [v0.0.222] tools 透传 undefined（不降级 []）：让 resolveToolSet 走 bound 全集分支
    //   三态：undefined=继承 subagent profile toolBound / []=显式空 / 非空=与 bound 交集
    subAgentConfig: {
      systemPrompt: input.childConfig.systemPrompt,
      tools: input.childConfig.tools,
      ...(input.childConfig.skills ? { skills: input.childConfig.skills } : {}),
      maxIter: input.childConfig.maxIter,
    },
  });
  return { sessionId: input.childSid };
}
