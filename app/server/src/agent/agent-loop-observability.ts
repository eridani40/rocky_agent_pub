/**
 * LoopObservability — agent loop 的 observability 埋点协调器（v0.0.10）。
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop.md §6.1
 *       specs/tech/agent/observability/[P0]overall.md §4/§5（埋点契约 + 全量字段）
 *
 * 职责：
 *   - 持有 adapter（缺省 NoopAdapter）+ handle 链（traceHandle/stepSpanHandle/genIteration）
 *   - 提供 7 个埋点方法（startTrace/endTrace/startStepSpan/endStepSpan/startGen/endGen/startToolSpan/endToolSpan）
 *   - **核心红线**：所有 adapter 调用经 safe() 包裹，任何 observability 错误**绝不向 agent loop 抛**
 *     （无论 adapter 内部是否自吞，loop 侧再防御一层；debug 级 console.warn）
 *
 * 从 agent-loop.ts 抽离（≤300 行约束）。loop 调本类方法，不直接碰 adapter。
 */
import type { RunKind } from '../../../shared/src/types/session-kind';
import { createHash } from 'node:crypto';
import type { ObservabilityAdapter } from '../observability/adapter';
import { noopAdapter } from '../observability/noop-adapter';
import type {
  GenHandle,
  GenInput,
  GenMetadata,
  GenOutput,
  SpanHandle,
  StepSpanMetadata,
  ToolSpanStart,
  TraceHandle,
  TraceMetadata,
} from '../observability/types';
import type { Message, ToolCallBlock, ToolResultBlock, Usage, ContextWindowUsage } from '../message/types';
import type { ToolDefinition } from '../tools/types';
import type { RunState } from './agent-loop-helpers';
import { buildTraceName } from './agent-loop-helpers';

/** LoopObservability 构造参数（loop 派生） */
export interface LoopObservabilityOpts {
  adapter?: ObservabilityAdapter;
  runId: string;
  sessionId: string;
  modelId: string;
  /**
   * [v0.0.61] SessionKind 可读标签（= SessionKind.toolPolicyRole，如 'studio-leader' / 'playground-rocky'）。
   * 用于 startTrace 拼 trace name；缺省兜底 'session'（避免 langfuse UI 显示 unnamed-trace）。
   */
  sessionKind?: string;
  /**
   * [v0.0.78.bug] 用途标识段（拼到 trace name 第一段 kind 后）：
   *   - main loop = 'current' 或 undefined（退原格式，零回归）
   *   - forked summary（compaction）= 'summary'
   *   - forked tier1 consolidate（memory_extract）= 'consolidate'
   * 来源：build-forked-deps.ts 读 opts.runKind；build-deps.ts 显式 'current'。
   */
  runKind?: RunKind;
  /**
   * 静态 system prompt 兜底（= config.systemPrompt）。
   * [v0.0.13 M1] trace 级 startTrace 时 snapshot 可能未首次 assemble，用 config.systemPrompt 兜底；
   * 每次 assemble 后 agent-loop 调 setSystem() 更新为实际 system。
   */
  fallbackSystemPrompt: string;
  toolDefinitions: ToolDefinition[];
  /**
   * [v0.0.80.t1] 触发时 context window 用量（来源：sideRun opts.triggerUsage → buildForkedDeps）。
   * 用于 forked trace metadata.triggerUsage（反查触发时上下文规模，change_plan §2.6 改进#1）。
   * 缺省（main loop / UT fixture）→ metadata 跳过该字段（optional 向后兼容）。
   */
  triggerUsage?: ContextWindowUsage;
}

/**
 * LoopObservability — 把 agent loop 的边界事件翻译成 adapter 调用。
 * 所有方法 safe 包裹（核心红线：observability 失败不影响主流程）。
 *
 * [v0.0.13 M1 修复] system 来源切到**实际喂 LLM 的 system**（snapshot.system.content[0].text，
 * 由 mapper/reducer 构建），而非静态 config.systemPrompt。每次 ContextEngine.assemble 后
 * agent-loop 调 setSystem() 推送当前 system，保证 systemPromptHash/systemCharCount 追踪
 * workdir/tool 集等导致的 system 变更。
 */
export class LoopObservability {
  private readonly adapter: ObservabilityAdapter;
  private readonly opts: LoopObservabilityOpts;
  private traceHandle: TraceHandle | null = null;
  private stepSpanHandle: SpanHandle | null = null;
  /** 全局 LLM 调用计数（GenMetadata.iteration） */
  private genIteration = 0;
  /** 最后一条 assistant 回答（endTrace 时作为 trace output 落库） */
  private lastAssistantMsg: Message | null = null;
  /**
   * [v0.0.13 M1] 当前实际喂 LLM 的 system 文本（snapshot.system.content[0].text）。
   * 初始化为 config.systemPrompt 兜底；每次 assemble 后 agent-loop.setSystem() 推送更新。
   */
  private currentSystemText: string;

  constructor(opts: LoopObservabilityOpts) {
    this.adapter = opts.adapter ?? noopAdapter;
    this.opts = opts;
    this.currentSystemText = opts.fallbackSystemPrompt;
  }

  /** 重置 handle 状态（每次 runLoop 开始） */
  reset(): void {
    this.traceHandle = null;
    this.stepSpanHandle = null;
    this.genIteration = 0;
    this.lastAssistantMsg = null;
    // system 不重置：跨 run 复用同一实例时 config.systemPrompt 不变，setSystem 后会覆盖
  }

  /**
   * [v0.0.25 task 5 gap 3] 暴露底层 adapter（只读）。
   * 用途：LlmCaller.invoke 需直接调 adapter.endGeneration({status:'error', errorCategory, ...})，
   * 本类 endGeneration 签名只支持 success；port 通过 getAdapter 直调。
   */
  getAdapter(): ObservabilityAdapter {
    return this.adapter;
  }

  /**
   * [v0.0.13 M1] 推送当前实际喂 LLM 的 system 文本。
   * agent-loop 每次 ContextEngine.assemble 后调用（ingest / LLM 请求前后 / compact）。
   * 后续 startGeneration / systemPromptHash 均以此为准。
   */
  setSystem(text: string): void {
    this.currentSystemText = text;
  }

  /**
   * [v0.0.25 task 5 gap 3] 仅更新 lastAssistantMsg（不调 adapter.endGeneration）。
   * invoke 路径下 adapter.endGeneration 由 LangfuseObservabilityPort 内部调（携带 status/errorCategory），
   * 本类仍需追踪 lastAssistantMsg 以便 endTrace 时填 trace output。LLM invoke 成功后由 call-main 调本方法。
   */
  recordLastAssistant(msg: Message): void {
    this.lastAssistantMsg = msg;
  }

  /**
   * run_start：startTrace（TraceMetadata 全量，overall §5.1）。
   * trace input = 触发本轮的 user 消息；generation 级 input 仍用 snapshot（见 startGeneration）。
   *
   * [v0.0.80.t1] metadata 含 triggerUsage（来源：LoopObservabilityOpts.triggerUsage，
   *   sideRun opts 透传）。undefined 时跳过该字段（保持现有 inputMessageIds 行为不变）。
   *   change_plan §2.6 改进#1。
   */
  startTrace(triggerMessages: Message[]): void {
    const inputMessageIds = triggerMessages.map((m) => m.id);
    // [v0.0.80.t1] triggerUsage undefined 时跳过该字段（保持 metadata 简洁）。
    //   用 spread 条件注入（避免 TraceMetadata 强类型上赋未知字段）。
    const baseMetadata: TraceMetadata = {
      runId: this.opts.runId,
      sessionId: this.opts.sessionId,
      inputMessageIds,
      modelId: this.opts.modelId,
      toolNames: this.opts.toolDefinitions.map((t) => t.name),
      systemPromptHash: this.systemPromptHash(),
    };
    const metadata = this.opts.triggerUsage !== undefined
      ? { ...baseMetadata, triggerUsage: this.opts.triggerUsage }
      : baseMetadata;
    this.traceHandle = this.safe('startTrace', () =>
      this.adapter.startTrace({
        id: this.opts.runId,
        sessionId: this.opts.sessionId,
        name: buildTraceName(this.opts.sessionKind, this.opts.sessionId, triggerMessages, this.opts.runKind),
        input: triggerMessages,
        metadata,
      }),
    );
  }

  /** iteration 起：startSpan(step)（parent=trace，StepSpanMetadata 游标/新消息数/hasToolCall） */
  startStepSpan(state: RunState): void {
    if (!this.traceHandle) return;
    const step = state.step + 1; // 人类序（第 N 轮）
    const metadata: StepSpanMetadata = {
      step,
      ingestUpTo: state.ingestUpTo,
      llmUpTo: state.llmUpTo,
      newMessageCount: 0, // ① drain 后精确计数困难，留 0
      hasToolCall: false, // ③ 后置真；起始未知置 false（endSpan 覆盖）
    };
    this.stepSpanHandle = this.safe('startSpan(step)', () =>
      this.adapter.startSpan({ parent: this.traceHandle!, name: `step ${step}`, input: { step }, metadata }),
    );
  }

  /** iteration 末：endSpan(step)（hasToolCall 由入参决定，覆盖 startStepSpan 的 false） */
  endStepSpan(state: RunState, hasTool: boolean): void {
    if (!this.stepSpanHandle) return;
    const step = state.step + 1;
    this.safe('endSpan(step)', () =>
      this.adapter.endSpan(this.stepSpanHandle!, {
        metadata: {
          step,
          hasToolCall: hasTool,
          ingestUpTo: state.ingestUpTo,
          llmUpTo: state.llmUpTo,
          newMessageCount: 0,
        },
      }),
    );
    this.stepSpanHandle = null;
  }

  /**
   * ② 前：startGeneration（parent=step span，GenInput.messages = 完整 snapshot，overall §5.2）。
   * [v0.0.13 M1] system 取实际 snapshot.system.content[0].text（mapper/reducer 构建），非静态 config。
   *
   * [v0.0.80.t1] 第 5 参数 contextWindowUsage（来源：snapshot.contextWindowUsage，stage-llm 注入）。
   *   写入 GenInput.contextWindowUsage → langfuse 接受任意 metadata，adapter.safe 包裹。
   *   optional（旧调用点不传 → undefined，向后兼容）。change_plan §2.5 改进#2。
   */
  startGeneration(
    snapshotMessages: Message[],
    snapshotInputCharCount: number,
    startTime: Date,
    snapshotSystem: string,
    contextWindowUsage?: ContextWindowUsage,
  ): GenHandle {
    const parent: SpanHandle | TraceHandle = this.stepSpanHandle ?? this.traceHandle!;
    const iteration = ++this.genIteration;
    // 同步 currentSystemText：本轮 system 即实际 system，hash/后续读取一致
    this.currentSystemText = snapshotSystem;
    const input: GenInput = {
      system: snapshotSystem,
      systemCharCount: snapshotSystem.length,
      messages: snapshotMessages,
      messagesCharCount: snapshotInputCharCount,
      tools: this.opts.toolDefinitions,
      params: { stream: true },
      modelId: this.opts.modelId,
      iteration,
      contextWindowUsage,
    };
    // [v0.0.50 §4.3] logical generation name 带 iteration 后缀（`llm-N-logical`），
    // 与同 iteration 的 physical（`llm-N-physical`）成对，AT 断言 name 匹配 `llm-*-logical`。
    return this.safe('startGeneration', () =>
      this.adapter.startGeneration({
        parent,
        model: this.opts.modelId,
        name: `llm-${iteration}-logical`,
        input,
        startTime,
      }),
    );
  }

  /**
   * [v0.0.50 §4.3] 当前 logical generation 的 iteration（= genIteration，每轮 LLM 递增）。
   * LangfuseObservabilityPort 据此构造 physical name `llm-${N}-physical`（同 N，成对）。
   * stage-llm / call-main 在 startGeneration 后读取，传给 createLangfuseObservabilityPort。
   */
  currentGenIteration(): number {
    return this.genIteration;
  }

  /**
   * [v0.0.50 §4.3] logical generation name 带 iteration 后缀（`llm-N-logical`），供 caller（stage-llm /
   * call-main / call-forked）拼接 physical name `llm-N-physical`（同 N，由 LangfuseObservabilityPort
   * 在 llm_caller.invoke 的 onWire 回调里触发，与本类无关——物理层埋点不在 agent 层，避免 llm/caller→agent 依赖）。
   */

  /** ② 后：endGeneration（output=完整 message + usage 全字段 + GenMetadata，overall §5.2） */
  endGeneration(gen: GenHandle, assistantMsg: Message, usage: Usage | null, startTime: Date): void {
    const u = usage ?? {};
    const metadata: GenMetadata = {
      iteration: this.genIteration,
      step: this.genIteration, // 近似：与 step 同步递增（每轮 1 LLM）
      cacheReadTokens: numOrZero(u.input_cache_read),
      cacheWriteTokens: numOrZero(u.input_cache_write),
      durationMs: Date.now() - startTime.getTime(),
    };
    const output: GenOutput = {
      message: assistantMsg,
      stopReason: (assistantMsg as unknown as { stopReason?: string }).stopReason ?? 'stop',
    };
    this.safe('endGeneration', () =>
      this.adapter.endGeneration({ gen, output, usage: u, metadata, endTime: new Date() }),
    );
    // 记录最后一个 assistant 回答（多轮 LLM 时最终回答作为 trace output）
    this.lastAssistantMsg = assistantMsg;
  }

  /** ③ 前：startSpan(tool)（parent=step span，完整 arguments，overall §5.4） */
  startToolSpan(call: ToolCallBlock): SpanHandle {
    const parent: SpanHandle =
      this.stepSpanHandle ?? { kind: 'span', id: 'noop', parent: this.traceHandle! };
    const toolSpan: ToolSpanStart = {
      parent,
      name: `tool:${call.name}`,
      input: {
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments,
      },
      metadata: {
        step: this.genIteration,
        toolCallId: call.id,
        // [v0.0.101] needsApproval boolean 退役（O7）；改用 hitlState（'pending'/'resolved'）按需填
      },
    };
    return this.safe('startSpan(tool)', () => this.adapter.startSpan(toolSpan));
  }

  /** ③ 后：endSpan(tool)（完整 result + isError，overall §5.4） */
  endToolSpan(handle: SpanHandle, result: ToolResultBlock, startTime: Date): void {
    this.safe('endSpan(tool)', () =>
      this.adapter.endSpan(handle, {
        output: { result, isError: result.isError },
        metadata: {
          step: this.genIteration,
          toolCallId: result.toolCallId,
          // [v0.0.101] HITL 悬挂 tool 的占位 block status='pending' → 标 hitlState='pending'
          //   （非 HITL tool result.status='success'/缺省 → 不填本字段）
          ...(result.status === 'pending' ? { hitlState: 'pending' as const } : {}),
          durationMs: Date.now() - startTime.getTime(),
        },
      }),
    );
  }

  /** run_end：endTrace（output=最终回答 + metadata.stopReason，overall §4/§5.1） */
  endTrace(stopReason: string): void {
    if (!this.traceHandle) return;
    this.safe('endTrace', () =>
      this.adapter.endTrace(this.traceHandle!, {
        output: this.lastAssistantMsg ? [this.lastAssistantMsg] : undefined,
        metadata: { stopReason },
      }),
    );
    this.traceHandle = null;
  }

  /**
   * [v0.0.68 R7] 把 trace level 标 ERROR（run 失败时调用，在 endTrace 前）。
   *
   * 行为：
   *   - 能力探测 adapter.setLevel —— 不支持时 safe 吞 + warning（不阻塞 run）。
   *   - traceHandle 已 reset（endTrace 后调）→ no-op（防御 race）。
   *
   * 不改 endTrace 签名（避免破坏 4+ 调用点）；markTraceError 与 endTrace 是正交的两个方法。
   * 参考: specs/tech/version_logs/v0.0.68/change_plan.md R7 markTraceError 行。
   */
  markTraceError(reason: string): void {
    if (!this.traceHandle) return;
    this.safe('markTraceError', () => {
      const a = this.adapter as ObservabilityAdapter & {
        setLevel?: (h: TraceHandle, level: 'ERROR') => void;
      };
      if (typeof a.setLevel === 'function') {
        a.setLevel(this.traceHandle!, 'ERROR');
      } else {
        // adapter 不支持 setLevel —— safe 吞，仅 warning（不阻塞 run）
        console.warn(
          `[observability:loop] markTraceError: adapter.setLevel not supported (reason: ${reason}); trace level remains unset`,
        );
      }
    });
  }

  // ── 内部工具 ──

  /**
   * system prompt 内容 hash（追踪 prompt 变更影响，overall §5.1）。
   * 基于 currentSystemText（实际喂 LLM 的 system）算。首次 startTrace 时可能仍是 config 兜底，
   * assemble 后 setSystem 更新，后续 trace hash 准确。
   */
  private systemPromptHash(): string {
    return createHash('sha256').update(this.currentSystemText).digest('hex').slice(0, 16);
  }

  /**
   * 安全执行 adapter 方法 —— **核心红线**：
   * 任何 observability 错误（adapter 内部未自吞 / bug）静默吞掉，绝不向 loop 抛。
   * 失败时 console.warn（debug 级），返回 fallback（undefined/handle 兜底）。
   */
  private safe<T>(method: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[observability:loop] ${method} failed (suppressed): ${msg}`);
      // 返回类型兜底：handle 方法返 dummy（trace/span/gen kind），void 方法返 undefined
      return undefined as unknown as T;
    }
  }
}

/** 安全数字提取（undefined/NaN → 0，避免 metadata 出 NaN） */
function numOrZero(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
