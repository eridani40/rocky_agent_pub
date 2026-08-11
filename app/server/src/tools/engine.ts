/**
 * 工具执行引擎（串行）
 * 参考: specs/tech/agent/tools/[P0]tool_execution_engine.md §3 §4 §5（HITL 钩子）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §2.2（allowedTools 门控 + 中文文案）
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 A（HITL pending 机制）
 *       specs/tech/agent/tools/[P0]tool_permission.md §4（策略门集成，v0.0.122）
 *
 * 核心：execute(config, toolCalls, allowedTools?, opts?) 串行（for...of + await，不并发）逐个执行，
 * 每个产出对应 ToolResultBlock（toolCallId 绑定、content、isError、status）。
 * results[i] 对应 toolCalls[i]，顺序保证。
 *
 * [v0.0.101] HITL 钩子（interaction）：
 *   - tool.interaction?.(input, ctx) 返非 null → 不调 run，构造 pending ToolResultBlock（status='pending'）
 *     + PendingToolCall wrapper，收集到返回值 pending 数组交给 caller（runReActLoop ③ 段）
 *   - 返 null / undefined → 普通 tool，立即调 run（向后兼容）
 *   - pending 一次性收集（不逐个退出），保持串行 + 顺序对应（INV-1：占位 block 是合法 pair）
 *
 * [v0.0.122] 策略门（checkPermission）：
 *   - 位于 allowedTools 白名单门后、interaction 分流前（INV-P1 两门正交）
 *   - tool.checkPermission? 可选（INV-P2 缺省=allow，其他工具行为不变）
 *   - deny→isError 结果不悬挂（INV-P4）；ask 未批准→pending（INV-P5 复用 buildPendingResult）
 *   - checkPermission 抛错 → safeCheckPermission fail-open 返 allow（§3 安全兜底交执行层）
 *
 * allowedTools 门控（agent_loop_base §2.2）：
 *   - allowedTools 未传（undefined）→ 全集（等价不过滤，向后兼容 eager）
 *   - allowedTools=[]→ 全拦（NO_TOOLS，forked summary）
 *   - toolCall.name ∉ allowedTools → 不执行，返 not-allowed tool_result（中文文案 + isError=true）
 *
 * 简化：
 *   - 轻量 schema 校验：必填 + primitive 类型（不引 ajv）
 *   - 失败不中断：单个工具 isError 仍产出 ToolResultBlock，继续下一个
 *
 * [v0.0.130.hang] 三层超时体系（模块 A，详见 tools/engine-timeout.ts）：
 *   - runTool() 为每次真实 tool.run 调用建 per-call AbortController → ctx.signal，
 *     Promise.race([tool.run, backstop timer]) 兜底；超时 → controller.abort() 触发工具真实清理
 *     + 产 `[timeout]` 前缀 isError result，不留 dangling tool_use。
 *   - HITL（checkPermission=ask / interaction 悬挂）分支在 runTool 之前就 continue，
 *     结构性不进超时 race（永不误杀悬挂等待）。
 */
import type { ToolCallBlock, ToolResultBlock } from '../message/types';
import type {
  ApprovalData,
  JSONSchemaLike,
  PermissionDecision,
  PendingToolCall,
  Tool,
  ToolCtx,
  ToolInput,
  ToolInteraction,
  ToolSessionConfigLike,
} from './types';
import { errorResult, ToolErrorCode } from './types';
import { type ApprovalManager, approvalManager as defaultApprovalManager } from './approval-manager';
import type { ChildProcessRegistry } from './child-process-registry';
// worker pool 分流辅助（isWorkerableTool + runViaWorker + runViaTool + ToolRunResultLike）
import {
  isWorkerableTool,
  runViaWorker,
  runViaTool,
  type ToolRunResultLike,
} from './engine-worker-dispatch';
export { isWorkerableTool } from './engine-worker-dispatch';
import type { ToolWorkerPool } from './worker-pool/pool';
// [v0.0.130.hang] 超时常量 + resolveEffectiveTimeout + formatTimeoutText 拆到 engine-timeout.ts
// （避免本文件继续膨胀）；re-export 保持对外符号位置不变（caller 仍从 '../engine' 引用）。
import { TIMEOUT_GRACE_MS, TOOL_TIMEOUT_CEILING_MS, formatTimeoutText, resolveEffectiveTimeout } from './engine-timeout';
export { TOOL_TIMEOUT_CEILING_MS, DEFAULT_TOOL_TIMEOUT_MS, TIMEOUT_GRACE_MS, resolveEffectiveTimeout, formatTimeoutText } from './engine-timeout';
// tool hook 写日志走鸭子类型（config.logWriter: unknown），无需直接 import LogWriter
// （spec dev-logs §3.2，能力探测在 writeToolLog 内做）

/**
 * [v0.0.101] execute 入口的 run 上下文（构造 PendingToolCall 必填字段用）。
 * engine 自身不知 runId（loop 级概念），由 caller（runReActLoop ③）通过 opts 注入；
 * sessionId 从 config.sessionId 取，runId 必须由 caller 提供（缺省则 pending.runId 为空字符串）。
 */
export interface ExecuteRunCtx {
  /** 当前 run id（落 PendingToolCall.runId，恢复时校验归属） */
  runId?: string;
  /**
   * [v0.0.130.hang] run 级子进程注册表（沿 opts 透传链从 AbortControllerHandle.childRegistry 下沉，
   * caller=runReActLoop.executeToolsForSpec 经 spec.controller.childRegistry 传入）。
   * execute() 装配进每个 tool 调用的 ctx.childRegistry；缺省 undefined → 工具不注册子进程。
   */
  childRegistry?: ChildProcessRegistry;
}

/**
 * [v0.0.101] execute 返回值：results（同长度同序 ToolResultBlock[]）+ pending（悬挂队列）。
 * pending 数组顺序对应「成为 pending 的 toolCall 在 toolCalls 中的相对顺序」（不交错 results）。
 * caller（runReActLoop ③）一次性收集 → 落 SessionStore.pendingToolCalls + emit require_human_input（队首）。
 */
export interface ExecuteResult {
  /** ToolResultBlock[]（与 toolCalls 等长同序；含 pending 占位 block） */
  results: ToolResultBlock[];
  /** 悬挂队列（可能为空；caller 决定 stopReason / state.done） */
  pending: PendingToolCall[];
}

/**
 * [v0.0.130.hang] runTool 内 Promise.race 的超时哨兵值（区别于工具正常 resolve 出的 ToolRunResult）。
 * 用 Symbol 而非字符串/对象字面量，保证与任何工具真实返回值都不会意外相等。
 */
const TIMEOUT_SENTINEL = Symbol('tool-timeout');

/**
 * 工具执行引擎（对齐 tool_execution_engine §3）。
 * 持 ApprovalManager 引用（用于策略门 ask 分支记忆查询，v0.0.122）。
 */
export class ToolExecutionEngine {
  /** 审批层记忆（默认注入进程级单例，UT 可注入 fresh 实例） */
  private readonly approvalManager: ApprovalManager;

  /**
   * [v0.0.307] worker 线程池（可选注入）。
   * 注入后白名单纯 IO 工具（read/write/edit/glob/grep/skill）执行挪线程，
   * 避免大 grep/read 阻塞 event loop。缺省 undefined → 全部走主线程原路径（向后兼容）。
   */
  private readonly _workerPool: ToolWorkerPool | undefined;

  /** [v0.0.307] 只读访问 workerPool（UT 验证注入用） */
  get workerPool(): ToolWorkerPool | undefined {
    return this._workerPool;
  }

  /**
   * 构造引擎。
   *
   * @param approvalManager 可选，默认使用进程级单例（bootstrap 零参构造仍可用）；
   *                        UT 可注入 fresh ApprovalManager 保证隔离。
   * @param workerPool      [v0.0.307] 可选 worker 线程池。注入后白名单工具走 pool.submit，
   *                        缺省 undefined → 全部走主线程原路径（向后兼容）。
   */
  constructor(approvalManager?: ApprovalManager, workerPool?: ToolWorkerPool) {
    this.approvalManager = approvalManager ?? defaultApprovalManager;
    this._workerPool = workerPool;
  }

  /**
   * 串行执行一批 tool_call，产出对应 tool_result + 悬挂队列。
   * - 逐个执行（for...of + await），顺序与 toolCalls 一致
   * - results 顺序对应 toolCalls[i]（按 toolCallId 关联）
   * - 失败不中断：单个 isError 继续下一个
   * - HITL 钩子：tool.interaction 返非 null → 不调 run，构造 pending result + PendingToolCall
   *
   * allowedTools 门控（agent_loop_base §2.2）：
   *   - allowedTools 未传（undefined）→ 全集（向后兼容 eager，等价不过滤）
   *   - toolCall.name ∉ allowedTools → 不执行，返 not-allowed tool_result（中文文案，isError=true）
   *   - 多轮 loop 下 LLM 看到中文 not-allowed 文案可自修正换思路（forked agent 场景）
   *
   * @param config session 配置（含 tools 数组）
   * @param toolCalls 待执行的工具调用块
   * @param allowedTools 可选白名单（undefined=不过滤；[]=NO_TOOLS 全拦）
   * @param opts     可选运行上下文（runId 用于构造 PendingToolCall）
   * @returns {results, pending}（results 与 toolCalls 等长同序；pending 顺序对应悬挂 toolCalls 相对顺序）
   */
  async execute(
    config: ToolSessionConfigLike,
    toolCalls: ToolCallBlock[],
    allowedTools?: string[],
    opts?: ExecuteRunCtx,
  ): Promise<ExecuteResult> {
    const results: ToolResultBlock[] = [];
    const pending: PendingToolCall[] = [];
    // 同一批 execute 内共享一个 readSet，让 read→write/edit 跨工具链生效。
    // 复用 config 上已有的（跨 execute 调用持续），否则新建（见 types.ts ToolSessionConfigLike._readSet）。
    if (!config._readSet) config._readSet = new Set<string>();
    const sharedReadSet = config._readSet;

    // allowedTools 白名单集合（undefined=不过滤；非 undefined 转成 Set O(1) 查询）
    const allowedSet = allowedTools === undefined ? undefined : new Set(allowedTools);

    // runId（落 PendingToolCall 用）；caller 未传则空串（悬挂队列字段完整性靠 caller）
    const runId = opts?.runId ?? '';

    // 串行：for...of + await，不并发（避免文件竞争/顺序依赖问题）
    for (const call of toolCalls) {
      // Layer C：allowedTools 白名单门控（agent_loop_base §2.2 + tool_execution_engine §3.1）。
      // allowedSet=undefined 表示全集（eager 默认）；非 undefined 时按白名单过滤。
      // 拒绝路径统一走 rejectToolCall，产 `[tool_not_allowed]` 文本（与未注册路径同 code）。
      if (allowedSet !== undefined && !allowedSet.has(call.name)) {
        results.push(rejectToolCall(call, 'not in whitelist'));
        continue;
      }
      // resolve + validate 一次（HITL 钩子只在通过后才考虑：拒绝 / 未注册 / 参数错不进 HITL）。
      // 失败路径统一拒绝 result（不悬挂，避免无法拒绝）。
      const tool = this.resolveTool(config.tools, call.name);
      if (!tool) {
        // 未注册路径统一拒绝 code（与白名单外路径同 `[tool_not_allowed]`，仅 reason 短语区分）
        results.push(rejectToolCall(call, 'not registered'));
        continue;
      }
      const validateErr = validateInput(tool.definition.inputSchema, call.arguments);
      if (validateErr) {
        results.push(this.wrap(call, errorResult(`[${ToolErrorCode.INVALID_INPUT}] ${validateErr}`)));
        continue;
      }
      // 构造 ctx（在策略门和 HITL 钩子之前，两者都需要 ctx）
      // [v0.0.130.hang] childRegistry 从 opts 透传（run 级唯一源，HITL 分支不消费，仅 runTool 真实
      // 执行路径需要——bash 等 spawn 型工具据此注册子进程供 run 终止级 sweep）
      // toolCallId 从 call.id 注入（唯一源），snapshot-store.saveSnapshot 落盘命名用
      const ctx: ToolCtx = {
        config,
        workdir: config.workdir ?? process.cwd(),
        readSet: sharedReadSet,
        childRegistry: opts?.childRegistry,
        toolCallId: call.id,
      };

      // [v0.0.122] 策略门（INV-P1：位于白名单门后、interaction 前；INV-P2：checkPermission 可选）
      // 顺序：deny → isError 不悬挂（INV-P4）；ask 未批准 → pending（INV-P5）；ask 已批准/绿灯 → fall through
      // [v0.0.148] 绿灯短路（approvalMode=greenlight）在 ask 分支内：deny（L187）在其之前不被绕过。
      //   绿灯只动审批层；执行层沙箱（SecureBashEngine）不受影响（安全 invariant）。
      if (tool.checkPermission) {
        const decision = safeCheckPermission(tool, call.arguments as ToolInput, ctx);
        if (decision.behavior === 'deny') {
          results.push(this.wrap(call, errorResult(decision.reason)));
          continue;
        }
        if (decision.behavior === 'ask') {
          const sessionId = config.sessionId ?? '';
          // [v0.0.148] 绿灯 → ask 视同 allow（fall through，不构造 pending）
          const isGreenlight = config.approvalMode === 'greenlight';
          // isApproved async（v0.0.148 cache-through）：cache miss 读 store
          if (!isGreenlight && !await this.approvalManager.isApproved(sessionId, decision.approvalKey)) {
            // ask 且未批准 + 非绿灯：构造 need_approval interaction，复用现有 pending 路径（INV-P5）
            const interaction = buildApprovalInteraction(call, decision);
            const { resultBlock, pendingCall } = buildPendingResult(call, interaction, config.sessionId, runId);
            results.push(resultBlock);
            pending.push(pendingCall);
            continue;
          }
          // ask + (绿灯 | 已 isApproved) → fall through，视同 allow
        }
      }

      // HITL 钩子：tool.interaction 返非 null → 悬挂（不调 run，构造 pending result + wrapper）
      let interactionResult: ToolInteraction | null = null;
      if (tool.interaction) {
        try {
          interactionResult = tool.interaction(call.arguments as ToolInput, ctx);
        } catch {
          // interaction 抛错视作「不悬挂」，降级走 run 路径（fail-open，避免悬挂死锁）
          interactionResult = null;
        }
      }
      if (interactionResult) {
        const { resultBlock, pendingCall } = buildPendingResult(
          call,
          interactionResult,
          config.sessionId,
          runId,
        );
        results.push(resultBlock);
        pending.push(pendingCall);
        continue;
      }
      // 普通 tool：调 run 产 result（含失败不中断）
      // [v0.0.130.hang] 三层超时解析（per-call > per-tool > engine 默认 30s，封顶 600s），
      // 只在真实 run 路径生效——HITL/deny/reject 均已在此行之前 continue，不受超时影响。
      const effectiveTimeoutMs = resolveEffectiveTimeout(call.arguments?.timeout, tool);
      results.push(await this.runTool(call, tool, ctx, effectiveTimeoutMs));
    }
    return { results, pending };
  }

  /**
   * 调 tool.run + 写 tool log（resolve/validate 已在 caller 完成，对齐 §4）。
   * try/catch 抛错转 isError（RUNTIME_ERROR），异常路径也写一条 log 便于排障。
   *
   * [v0.0.130.hang] 超时兜底（模块 A）：为本次调用建 per-call AbortController → ctx.signal，
   * Promise.race([tool.run, backstop timer])。timer 时长 = min(effectiveTimeoutMs + GRACE, 硬天花板)——
   * GRACE 是给工具自身超时机制（如 bash 内部 timeout）优先触发的余量，engine 只在其失效时补刀。
   * 超时命中 → controller.abort()（触发工具真实清理，如 bash wireChildLifecycle 组杀）+ 产
   * formatTimeoutText 文案的 isError result；未超时的正常路径（含工具自身返回的 isError）原样透传，
   * 且无论哪条路径都在 finally 清 timer，不留悬挂定时器。
   * 仅此方法内建超时 race——HITL/deny/reject 分支在 execute() 内 continue，永不到达本方法（硬门禁）。
   */
  private async runTool(
    call: ToolCallBlock,
    tool: Tool,
    ctx: ToolCtx,
    effectiveTimeoutMs: number,
  ): Promise<ToolResultBlock> {
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const backstopMs = Math.min(effectiveTimeoutMs + TIMEOUT_GRACE_MS, TOOL_TIMEOUT_CEILING_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 分流：白名单纯 IO 工具 + workerPool 注入 → 走 worker 线程池
      // worker 侧无独立 timer，超时仍由主线程 backstop race 控制（D5 约束）
      const useWorker = this._workerPool && isWorkerableTool(call.name);
      // runPromise 在 try 内创建：工具 run 若同步抛错也被 catch 转 RUNTIME_ERROR
      const runPromise = useWorker
        ? runViaWorker(this._workerPool!, call, ctx)
        : runViaTool(tool, call, ctx);
      const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), backstopMs);
      });
      const raced = await Promise.race([runPromise, timeoutPromise]);
      if (raced === TIMEOUT_SENTINEL) {
        // 真超时：abort 通知工具做真实清理（非仅丢弃 promise）；已弃用的 runPromise 后续若 reject
        // 不应冒泡成 unhandled rejection（工具已被判超时，其后续结果不再消费）
        controller.abort();
        runPromise.catch(() => {});
        const text = formatTimeoutText(tool.definition.name, effectiveTimeoutMs, '(engine backstop)');
        const result = this.wrap(call, errorResult(text));
        writeToolLog(ctx.config.logWriter, { tool: call.name, input: call.arguments, output: result.content, isError: true });
        return result;
      }
      // 正常 resolve（含工具自身产的 isError=true 结果）：原样透传，不吞
      const { content, isError } = raced;
      const result = this.wrap(call, { content, isError });
      // tool hook（spec dev-logs §3.2）：每次真实工具调用写一条 logs/tool.log
      writeToolLog(ctx.config.logWriter, { tool: call.name, input: call.arguments, output: result.content, isError: result.isError });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const result = this.wrap(call, errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] ${msg}`));
      // 异常路径也写一条（isError=true，便于排障看失败原因）
      writeToolLog(ctx.config.logWriter, { tool: call.name, input: call.arguments, output: result.content, isError: true });
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 按 name 查找工具（引擎从 config.tools 路由） */
  private resolveTool(tools: Tool[], name: string): Tool | undefined {
    return tools.find((t) => t.definition.name === name);
  }

  /** 包装成 ToolResultBlock（绑定 toolCallId，对齐 message interface §4.7） */
  private wrap(call: ToolCallBlock, run: { content: ToolResultBlock['content']; isError: boolean }): ToolResultBlock {
    return {
      type: 'tool_result',
      toolCallId: call.id,
      content: run.content,
      isError: run.isError,
    };
  }
}

/**
 * [v0.0.122] 安全包装 checkPermission 调用（fail-open）。
 * 参考: specs/tech/agent/tools/[P0]tool_permission.md §3
 *
 * checkPermission 抛错时视作 allow（INV-P3 安全兜底交执行层沙箱）。
 * 避免权限检查异常阻断正常工具执行（与 interaction 抛错降级 run 同风格）。
 *
 * @param tool 已知 checkPermission 存在的工具
 * @param input 工具入参（来自 call.arguments）
 * @param ctx 执行上下文
 * @returns PermissionDecision（异常时 {behavior:'allow'}）
 */
export function safeCheckPermission(tool: Tool, input: ToolInput, ctx: ToolCtx): PermissionDecision {
  try {
    return tool.checkPermission!(input, ctx);
  } catch {
    // fail-open：checkPermission 异常 → 视作 allow，安全兜底由执行层沙箱承接
    return { behavior: 'allow' };
  }
}

/**
 * [v0.0.122] 把 PermissionDecision.ask + call 翻译成 ToolInteraction（need_approval/approval/ApprovalData）。
 * 参考: specs/tech/agent/tools/[P0]tool_permission.md §4
 *       specs/tech/version_logs/v0.0.122/change_plan.md 模块 B buildApprovalInteraction 行
 *
 * 产出的 ToolInteraction 传给 buildPendingResult（现有函数），不直接构造 pending（INV-P5）。
 * ApprovalData 携带 toolName/arguments/reason/approvalKey 四字段，审批卡按此渲染。
 *
 * @param call 当前工具调用块（取 name/arguments）
 * @param decision ask 类型的权限决策（携带 reason 和 approvalKey）
 * @returns ToolInteraction{subType:'need_approval', handleType:'approval', data:ApprovalData}
 */
export function buildApprovalInteraction(
  call: { name: string; arguments: unknown },
  decision: { reason: string; approvalKey: string },
): ToolInteraction {
  const data: ApprovalData = {
    toolName: call.name,
    arguments: call.arguments,
    reason: decision.reason,
    approvalKey: decision.approvalKey,
  };
  return {
    subType: 'need_approval',
    handleType: 'approval',
    data,
  };
}

/**
 * [v0.0.101] 构造悬挂型 tool 的占位 ToolResultBlock + PendingToolCall wrapper。
 * 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §1/§4/§7
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 A buildPendingResult 行
 *
 * 设计：
 *   - 占位 ToolResultBlock：status='pending' + subState + data（前端据此渲染提问卡 / 审批卡）；
 *     content 是人话占位「用户回答中…」（LLM 首次消费前可被回填编辑，INV-6）；isError=false（pending 非错误）
 *   - PendingToolCall wrapper：定位/策略/载荷/编辑目标占位；
 *     resultMessageId/resultBlockIndex 引擎不知（ingest 后才有 message id），留 undefined 由 caller 回填
 *
 * @param call        配对的 ToolCallBlock（取 id / name）
 * @param interaction tool.interaction 返回的悬挂描述（含 subState/handleType/data）
 * @param sessionId   所属 session（落盘归属；config.sessionId 透传）
 * @param runId       所属 run（恢复时校验归属；caller 通过 opts.runId 透传）
 * @returns {resultBlock, pendingCall}（caller push 进 results + pending 数组）
 */
export function buildPendingResult(
  call: ToolCallBlock,
  interaction: ToolInteraction,
  sessionId: string | undefined,
  runId: string,
): { resultBlock: ToolResultBlock; pendingCall: PendingToolCall } {
  const placeholder: ToolResultBlock = {
    type: 'tool_result',
    toolCallId: call.id,
    content: [{ type: 'text', text: '用户回答中…' }],
    isError: false,
    status: 'pending',
    subState: interaction.subType,
    data: interaction.data,
  };
  const pendingCall: PendingToolCall = {
    sessionId: sessionId ?? '',
    runId,
    toolCallId: call.id,
    toolName: call.name,
    handleType: interaction.handleType,
    subState: interaction.subType,
    data: interaction.data,
    // resultMessageId / resultBlockIndex 由 caller（runReActLoop ③ ingest 后）回填
    status: 'pending',
  };
  return { resultBlock: placeholder, pendingCall };
}

/**
 * 统一拒绝 helper。
 * 参考: specs/tech/agent/tools/[P0]tool_execution_engine.md §3.1（统一拒绝错误 code）。
 *
 * 两条拒绝路径合并到本 helper（同 `tool_not_allowed` code）：
 *   - 白名单外（Layer C 拒绝）→ reason='not in whitelist'
 *   - 未注册（Layer B 拒绝）→ reason='not registered'
 *   - forked 零工具场景 → reason='not in forked whitelist'（caller 透传）
 *
 * 文案模板：`[tool_not_allowed] Tool '<name>' is not allowed in this session (<reason>).`
 * isError=true 让 LLM 重视；多轮 loop 下 LLM 下一轮看到此结果可自我修正换思路。
 * 不进 errorInfo——content[0].text 已含 `[tool_not_allowed]` 前缀（机读 + 人读兼容）。
 */
function rejectToolCall(call: ToolCallBlock, reason: string): ToolResultBlock {
  return {
    type: 'tool_result',
    toolCallId: call.id,
    content: [
      {
        type: 'text',
        text: `[tool_not_allowed] Tool '${call.name}' is not allowed in this session (${reason}).`,
      },
    ],
    isError: true,
  };
}

/**
 * 轻量 input schema 校验（不引 ajv，简化版）。
 * 校验：
 *   - required 中每个字段必须存在
 *   - properties 中声明 type 的字段，若存在则做 primitive 类型检查
 *   - default-fill：properties[k].default → obj[k] 注入（通用机制，所有工具受益）
 * 返回错误描述字符串（首个错误），通过返回 null。
 *
 * default-fill 时机：
 *   放 required + 类型校验**之后**——default 不绕过必填/类型约束；只填「真正缺失」的字段。
 *   判定用 `obj[k] === undefined && sub.default !== undefined`（不是 truthy 判定），
 *   所以 `default: false` / `default: 0` / `default: ''` 等 false-y 值也会被注入。
 *   mutate input 对象（reference 透传到 tool.run，让工具拿到 default-filled 入参）。
 *
 * @param schema 工具的 inputSchema
 * @param input 实际入参（mutate：缺字段补 default）
 */
export function validateInput(schema: JSONSchemaLike | undefined, input: unknown): string | null {
  if (!schema) return null;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'arguments must be a JSON object';
  }
  const obj = input as Record<string, unknown>;
  // 必填校验
  if (schema.required) {
    for (const key of schema.required) {
      if (obj[key] === undefined || obj[key] === null) {
        return `missing required field: ${key}`;
      }
    }
  }
  // primitive 类型校验（仅对声明了 type 的字段）
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      const val = obj[key];
      if (val === undefined || val === null || !sub.type) continue;
      const err = checkPrimitive(sub.type, val, key);
      if (err) return err;
    }
  }
  // default-fill（通用机制）：放 required + 类型校验之后
  // 用 !== undefined 判定（非 truthy），default:false/0/'' 等 false-y 值也注入
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (obj[key] === undefined && sub.default !== undefined) {
        obj[key] = sub.default;
      }
    }
  }
  return null;
}

/** primitive 类型检查（覆盖 string/number/boolean/array/integer/object） */
function checkPrimitive(type: string, val: unknown, key: string): string | null {
  switch (type) {
    case 'string':
      if (typeof val !== 'string') return `field ${key} must be string`;
      break;
    case 'number':
      if (typeof val !== 'number') return `field ${key} must be number`;
      break;
    case 'integer':
      if (typeof val !== 'number' || !Number.isInteger(val)) return `field ${key} must be integer`;
      break;
    case 'boolean':
      if (typeof val !== 'boolean') return `field ${key} must be boolean`;
      break;
    case 'array':
      if (!Array.isArray(val)) return `field ${key} must be array`;
      break;
    case 'object':
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        return `field ${key} must be object`;
      }
      break;
  }
  return null;
}

/**
 * tool hook 写日志 helper（spec dev-logs §3.2）。
 * config.logWriter 鸭子类型（unknown），能力探测有 write 方法才调（防 type 不匹配抛错）。
 * 开关 false 时 LogWriter.write 内部早 return 零开销；缺省 → no-op。
 */
function writeToolLog(
  logWriter: unknown,
  record: { tool: string; input: unknown; output: unknown; isError: boolean },
): void {
  // 整体 try/catch fail-silent：日志任何异常绝不冒泡进工具执行主流程
  try {
    if (!logWriter || typeof logWriter !== 'object') return;
    const w = logWriter as { write?: (type: string, rec: Record<string, unknown>) => void };
    if (typeof w.write !== 'function') return;
    w.write('tool', record);
  } catch {
    // 日志失败绝不影响工具执行主流程
  }
}
