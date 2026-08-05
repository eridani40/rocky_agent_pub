/**
 * agent.spawn action —— 派生 subagent
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（spawn 契约 + 执行流程）
 *       specs/tech/multi_agent/[P1]subagent_templates.md §4（D8 resolution）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §4（首任务 sender.agent.needReply 语义）
 *
 * 执行流程（derivation §4）：
 *   1. resolve effective（eff.systemPrompt/tools/skills = input.X ?? template.X；
 *      D8: eff.modelId = template?.modelId ?? parent.modelId；spawn 入参无 modelId）
 *   2. createSession({ type:'subagent', parentSessionId, scope:'subagent', subAgentTemplateType, origin })
 *   3. 构造首任务 message（sender.source='agent', sender.agent.ref=parent.ref, needReply = mode==='sync' ? false : true）
 *   4. manager.children.track(parentSid, childSid) + checkRunningLimit('subagent', parentSid)
 *   5. deliverTo(childSid, firstMsg) → AgentRun
 *   6. sync: await run.promise 返 { childSessionId, answer, usage, stopReason }；
 *      async: run.promise.finally(untrack) 返 { childSessionId, runId, status:'running' }
 *
 * 关键不变量：
 *   - sync 首任务 needReply=false（subagent 完成不 send_message 回，靠 await run.promise 取 answer）
 *   - async needReply=true（subagent 完成主动 send_message 回 parent）
 *   - D8 model 解析式精确（spawn 入参无 modelId 字段）
 *
 * 单文件 ≤300 行（spawn 编排逻辑；config 构造注入）。
 */
import { ulid } from '../../config/ulid';
import type { Message, ContentBlock } from '../../message/types';
import type { AgentRun } from '../agent-interface';
import type { SpawnAgentInput, SpawnAgentResult, AgentSpawnContext, SubAgentTemplate } from './types';
import { resolveEffective, type LoadTemplateFn } from './template-loader';
import { ChildrenTracker, checkRunningLimit, ConcurrencyLimitError } from '../agent-manager-children';

/**
 * spawn 依赖注入接口（从 ToolCtx.config.agentSpawnContext + ctx 读）。
 * 这些依赖由 bootstrap 构造 agentTool 时注入（避免 agent-tool.ts 直接耦合 SessionHandlerDeps）。
 */
export interface SpawnDeps {
  /** spawn 上下文（parentSessionId / parentModelId / parentRef / parentRunId 等） */
  ctx: AgentSpawnContext;
  /** createSession + 构造 child SessionConfig 并落库（注入实现） */
  createChildSession(input: {
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
      role?: import('@app/shared').Role;
      derivation: import('@app/shared').Derivation;
      /** caller-provided child 工作目录（透传；缺省=继承 parent） */
      workspaceDir?: string;
    };
  }): Promise<{ sessionId: string }>;
  /** deliverTo(childSid, firstMsg) → AgentRun（注入实现：调 manager.deliverTo） */
  deliverTo(sessionId: string, message: Message): Promise<AgentRun>;
  /** children 追踪容器（注入 manager.children） */
  children: ChildrenTracker;
  /** loadTemplate（task-3 完成后注入真实实现；默认 fallback null） */
  loadTemplate?: LoadTemplateFn;
  /**
   * 从 childSid transcript 提取最终 answer（最后一条 assistant message 的 text block 聚合）。
   *
   * 背景：eager run（runKind='current'）settle 时 agent-run-registry.attachRunPromise
   * 硬填 `{ answer: '', ... }`（run_stop 事件无 answer payload，eager-drain-agent 不提取 answer）。
   * → sync spawn 走 `await run.promise` 拿到的 r.answer 永远空字符串，但 transcript 最后一条
   * assistant message 有真实 final text。修复：sync 分支 await run.promise 后调本 dep 从 store
   * 读 transcript 提取，不依赖 eager run.promise.answer（它空）。
   *
   * 实现注入（agent-tool.ts runSpawn）：rtc.store.getMessages(childSid) → 取最后 assistant text。
   */
  getFinalAnswer?(childSid: string): Promise<string>;
}

/**
 * 执行 agent.spawn action（derivation §4 完整流程）。
 *
 * @param input        SpawnAgentInput
 * @param deps         注入依赖（ctx / createChildSession / deliverTo / children / loadTemplate）
 * @param toolCallId   本次 tool_call id（origin.toolCallId 审计用）
 * @returns SpawnAgentResult（sync 返 answer/usage/stopReason；async 返 runId/status）
 */
export async function executeSpawn(
  input: SpawnAgentInput,
  deps: SpawnDeps,
  toolCallId: string,
): Promise<SpawnAgentResult> {
  const { ctx } = deps;

  // 1. resolve effective（D8 model 解析：template?.modelId ?? parent.modelId）
  const eff = await resolveEffective(
    input,
    ctx.parentModelId,
    deps.loadTemplate,
  );

  // tools：buildSessionConfigFromDeps 已按 subAgentConfig.tools 白名单过滤。
  // 模板白名单本身定义 subagent 可用工具（explorer=[read,web_search,web_fetch,send_message]
  // 只读 + a2a 回报），不再在此处强制追加 send_message（白名单已含 → Bug #3 不回退）。
  // ensureSendMessage 纯函数保留（UT 引用），仅不再在 executeSpawn 调用。

  // 2. createSession + 构造 child config（origin 审计）
  //    身份维度（role/derivation）从 eff 读
  const childSid = ulid();
  await deps.createChildSession({
    childSid,
    childConfig: {
      systemPrompt: eff.systemPrompt,
      modelId: eff.modelId,
      // [v0.0.246] resolved providerId 透传（与 modelId 同源 parent resolved，非 raw hint）
      providerId: ctx.parentProviderId,
      tools: eff.tools,
      skills: eff.skills,
      maxIter: input.maxIter ?? 25,
      scope: 'subagent',
      parentSessionId: ctx.parentSessionId,
      subAgentTemplateType: eff.subAgentTemplateType,
      origin: { spawnRunId: ctx.parentRunId, toolCallId },
      // role/derivation 从 eff 透传
      ...(eff.role !== undefined ? { role: eff.role } : {}),
      derivation: eff.derivation,
      // caller-provided workspaceDir 透传（仅 input 提供时传；undefined 不影响默认继承）
      ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
    },
  });

  // 3. 构造首任务 message（sender.source='agent' + a2a 信封，derivation §4）
  const firstMsg = buildFirstTaskMessage(childSid, input.task.content, ctx, input.mode);

  // 4. children 追踪 + running 并发上限 check（derivation §3.1 + §4）
  checkRunningLimit(deps.children, 'subagent', ctx.parentSessionId);
  deps.children.track(ctx.parentSessionId, childSid);

  // 5. deliverTo（inbox.append + activate）
  const run = await deps.deliverTo(childSid, firstMsg);

  // 6. mode 分支：sync await / async handle
  if (input.mode === 'sync') {
    try {
      const r = await run.promise;
      // eager run.promise settle 时 answer 恒空（run_stop 无 answer payload，
      // attachRunPromise 不提取 answer）。此处 run 已 settle，child transcript
      // 完整落盘——调 getFinalAnswer 从 store 读最后一条 assistant message text 聚合。
      // getFinalAnswer 未注入（测试）→ fallback r.answer（保持兼容，虽空）。
      let answer = r.answer;
      if (deps.getFinalAnswer) {
        try {
          answer = await deps.getFinalAnswer(childSid);
        } catch {
          // transcript 读失败不阻断 spawn 返回（fallback r.answer，记录在 stopReason 不变）
        }
      }
      return {
        mode: 'sync',
        childSessionId: childSid,
        answer,
        usage: r.usage,
        stopReason: r.stopReason,
      };
    } finally {
      // 成功/出错/被中断都清理 children 追踪（避免 map 泄漏，derivation §4）
      deps.children.untrack(ctx.parentSessionId, childSid);
    }
  }
  // async：返 handle，run settle 时清追踪
  void run.promise.finally(() => deps.children.untrack(ctx.parentSessionId, childSid));
  return { mode: 'async', childSessionId: childSid, runId: run.runId, status: 'running' };
}

/**
 * 构造 spawn 首任务 message（derivation §4 firstMessage 字段）。
 * - sender.source='agent'
 * - sender.agent.ref = parent.ref（a2a 信封，canonical struct 存储）
 * - sender.agent.needReply: sync=false（subagent 完成不 send_message 回）；async=true（必回）
 * - inReplyTo 不填（首任务无 parent message 可引用）
 */
function buildFirstTaskMessage(
  childSid: string,
  content: ContentBlock[],
  ctx: AgentSpawnContext,
  mode: 'sync' | 'async',
): Message {
  return {
    id: ulid(),
    sessionId: childSid,
    role: 'user',
    content,
    sender: {
      source: 'agent',
      agent: {
        ref: ctx.parentRef,
        // sync 硬填 false（subagent 完成 → final answer → spawn await run.promise 取回，不 send_message 回）
        // async 默认 true（subagent 完成 → 主动 send_message(to=parent) 回报）
        needReply: mode !== 'sync',
      },
    },
  };
}

/** 导出 ConcurrencyLimitError 供 agent-tool.ts 捕获转 tool error */
export { ConcurrencyLimitError };
/** 导出 SubAgentTemplate 类型供 bootstrap 注入 loader 时引用 */
export type { SubAgentTemplate };

/**
 * 确保 tools 白名单含 'send_message'（async spawn needReply=true 要求 subagent 能 a2a 回报）。
 *
 * - tools undefined → ['send_message']（async 至少有回报工具）
 * - tools 不含 'send_message' → 追加
 * - tools 已含 → 原样返回
 *
 * 单独导出便于 UT 直接验证纯函数语义。
 */
export function ensureSendMessage(tools: string[] | undefined): string[] {
  if (!tools) return ['send_message'];
  if (tools.includes('send_message')) return tools;
  return [...tools, 'send_message'];
}

/**
 * 从 store 读 childSid transcript，提取最后一条 assistant message 的 text block 聚合。
 *
 * 语义与 run-react-loop.ts extractFinalText 对齐（最后一条 assistant message 的 text blocks
 * 用 \n 聚合）；区别：本函数从 store 分页读 messages（旁路 run 是内存 state 不走 store）。
 *
 * 不直接复用 extractFinalText（避免 agent/tools → agent 主层模块反向依赖；tools 子层
 * 不应依赖 agent 主层模块）。语义对齐即可。
 *
 * @param store    SessionStore（rtc.store 注入；调 getMessages 读 child transcript）
 * @param childSid 子 session id
 * @returns 最后一条 assistant message 的 text 聚合；无 assistant message → ''
 */
export async function getFinalAnswerFromStore(
  store: { getMessages(sessionId: string, range?: { limit?: number }): Promise<{ items: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }> },
  childSid: string,
): Promise<string> {
  // 取末尾一批 messages（默认 limit=50；足够覆盖最后一条 assistant）
  const page = await store.getMessages(childSid);
  const items = page.items ?? [];
  // 从后往前找最后一条 assistant message
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]!;
    if (m.role !== 'assistant') continue;
    return m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}
