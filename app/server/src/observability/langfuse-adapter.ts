/**
 * LangfuseAdapter — ObservabilityAdapter 首个真实 backend 实现。
 * 参考: specs/tech/agent/observability/[P0]langfuse_adapter.md §2-§6
 *       specs/tech/agent/observability/[P0]overall.md §6（接口）
 *
 * 设计（langfuse_adapter §2-§4）：
 *   - 用 langfuse TS SDK（npm `langfuse`），异步 batch 上报
 *   - 嵌套靠 SDK：trace.span() / span.span() / span.generation()（SDK 自动 parentObservationId）
 *   - handle.id → SDK observation 对象（Map 维护，在 LangfuseEventQueue 内），endXxx 入队 update
 *   - usage 映射（§6 mapUsageDetails）：互斥拆分防双计
 *
 * 重构：SDK 调用全部经 LangfuseEventQueue（500MB 有界队列 + 单 consumer async loop）。
 *   - start*：同步生成 handle.id + enqueue create-op（caller 立即可用，consumer FIFO 保 parent 命中）
 *   - end 方法和 setLevel：enqueue update-op（args 组装保留含 §6 usage 映射）
 *   - shutdown：queue.drainAndShutdown（drain 先于 shutdownAsync）
 *
 * 核心红线（用户明确）：**绝不影响主流程**。
 *   - 所有 op 构造 + enqueue 包 try/catch，任何 langfuse 错误静默吞掉（console.warn debug 级）
 *   - SDK 调用错误在 queue consumer _apply try/catch 内吞（queue 负责）
 *   - start/end 方法同步返回 Handle（loop 不 await enqueue）；仅 shutdown() await（drain+flush）
 */
import { Langfuse } from 'langfuse';
import type { ObservabilityAdapter } from './adapter';
import type {
  GenEnd,
  GenHandle,
  GenStart,
  ObservabilityLevel,
  SpanEnd,
  SpanHandle,
  SpanStart,
  StepSpanStart,
  TraceEnd,
  TraceHandle,
  TraceStart,
  ToolSpanEnd,
  ToolSpanStart,
} from './types';
import type { Usage } from '../message/types';
import { ulid } from '../config/ulid';
export { mapGenMetadata, mapUsageDetails } from './langfuse-metadata';
import { mapGenMetadata, mapUsageDetails } from './langfuse-metadata';
import { LangfuseEventQueue } from './langfuse-event-queue';

/** LangfuseAdapter 构造参数（凭证 + baseUrl） */
export interface LangfuseAdapterOptions {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** debug 级日志（核心红线：observability 失败仅 console.warn，不向 loop 抛） */
const warnSuppressed = (method: string, e: unknown): void => {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn(`[observability:langfuse] ${method} failed (suppressed): ${msg}`);
};

/**
 * LangfuseAdapter — 用 langfuse SDK 上报 trace/generation/span。
 * 所有 SDK 调用经 LangfuseEventQueue 异步批处理；op 构造包 try/catch，错误静默吞（不影响 agent loop）。
 */
export class LangfuseAdapter implements ObservabilityAdapter {
  private readonly queue: LangfuseEventQueue;

  constructor(opts: LangfuseAdapterOptions) {
    // SDK 构造可能因凭证非法抛错——抛在构造期（激活前）比运行中静默更清晰。
    // 由 factory（createObservabilityAdapter）决定是否吞掉。
    this.queue = new LangfuseEventQueue(
      new Langfuse({
        publicKey: opts.publicKey,
        secretKey: opts.secretKey,
        baseUrl: opts.baseUrl,
      }),
    );
  }

  /** run_start：enqueue create-trace({id, sessionId, name?, input?, metadata}) */
  startTrace(p: TraceStart): TraceHandle {
    try {
      this.queue.enqueue({
        kind: 'create-trace',
        id: p.id,
        args: {
          id: p.id,
          sessionId: p.sessionId,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.input !== undefined ? { input: p.input } : {}),
          metadata: p.metadata,
        },
      });
    } catch (e) {
      warnSuppressed('startTrace', e);
    }
    return { kind: 'trace', id: p.id };
  }

  /** run_end：enqueue update({output?, metadata?}) */
  endTrace(h: TraceHandle, p?: TraceEnd): void {
    try {
      const upd: Record<string, unknown> = {};
      if (p?.output !== undefined) upd.output = p.output;
      if (p?.metadata !== undefined) upd.metadata = p.metadata;
      this.queue.enqueue({ kind: 'update', id: h.id, args: upd });
    } catch (e) {
      warnSuppressed('endTrace', e);
    }
  }

  /** iteration 起 / tool 跑前：enqueue create-span（isTool/isStep 分支 + spanArgs 组装保留） */
  startSpan(p: SpanStart): SpanHandle {
    const id = ulid();
    const handle: SpanHandle = { kind: 'span', id, parent: p.parent };
    try {
      const isTool = (sp: SpanStart): sp is ToolSpanStart =>
        (sp as ToolSpanStart).input !== undefined &&
        typeof (sp.input as { toolCallId?: unknown }).toolCallId === 'string';
      const isStep = (sp: SpanStart): sp is StepSpanStart => !isTool(sp);
      const spanArgs: Record<string, unknown> = {
        name: p.name,
        startTime: (p as { startTime?: Date }).startTime ?? new Date(),
      };
      if (isStep(p)) {
        const step = p as StepSpanStart;
        if (step.input !== undefined) spanArgs.input = step.input;
        spanArgs.metadata = step.metadata;
      } else {
        const tool = p as ToolSpanStart;
        spanArgs.input = tool.input;
        spanArgs.metadata = tool.metadata;
      }
      this.queue.enqueue({ kind: 'create-span', id, parentId: p.parent.id, args: spanArgs });
    } catch (e) {
      warnSuppressed('startSpan', e);
    }
    return handle;
  }

  /** iteration 末 / tool 跑完：enqueue update（endTime + output/level/metadata 组装保留） */
  endSpan(h: SpanHandle, p?: SpanEnd): void {
    try {
      const upd: Record<string, unknown> = {
        endTime: (p as { endTime?: Date })?.endTime ?? new Date(),
      };
      const toolEnd = p as ToolSpanEnd | undefined;
      if (toolEnd && toolEnd.output !== undefined) {
        upd.output = toolEnd.output.result;
        if (toolEnd.output.isError) upd.level = 'ERROR';
      }
      if (p?.metadata !== undefined) upd.metadata = p.metadata;
      this.queue.enqueue({ kind: 'update', id: h.id, args: upd });
    } catch (e) {
      warnSuppressed('endSpan', e);
    }
  }

  /**
   * LLM 前：enqueue create-gen（genKind 分支 + genArgs 组装保留）。
   * logical（默认）：name=`llm`/caller name，input=GenInput；physical：name=`llm-physical`，input=wire body，metadata.physicalWire=true。
   * [v0.0.353 T2] providerId/providerName 写入 metadata（不污染 SDK model/name 字段，避免中文问题）；model 字段 = GenStart.model（真实 target modelId）。
   */
  startGeneration(p: GenStart): GenHandle {
    const id = ulid();
    const handle: GenHandle = { kind: 'gen', id, parent: p.parent };
    try {
      const genKind: 'logical' | 'physical' = p.kind ?? 'logical';
      const fallbackName = genKind === 'physical' ? 'llm-physical' : 'llm';
      const genArgs: Record<string, unknown> = {
        name: p.name ?? fallbackName,
        model: p.model,
        input: genKind === 'physical' ? p.physicalInput : p.input,
        startTime: p.startTime ?? new Date(),
      };
      const meta: Record<string, unknown> = {};
      if (p.providerId !== undefined) meta.providerId = p.providerId;
      if (p.providerName !== undefined) meta.providerName = p.providerName;
      // [v0.0.353 T3 A1] logical view 标识透传（true = 业务视图，真实 provider/model 在 physical 子 span）
      if (p.logicalView !== undefined) meta.logicalView = p.logicalView;
      // [v0.0.353 T5 D8] 生效路由方案透传（logical generation；有方案才带）
      if (p.routingPlan !== undefined) meta.routingPlan = p.routingPlan;
      // [v0.0.353 T5 D9] 额外 metadata（skipped gen 的 skipped/reason/provider 等；adapter 合并）
      if (p.metadata !== undefined) Object.assign(meta, p.metadata);
      if (genKind === 'physical') meta.physicalWire = true;
      if (Object.keys(meta).length > 0) genArgs.metadata = meta;
      this.queue.enqueue({ kind: 'create-gen', id, parentId: p.parent.id, args: genArgs, genKind });
    } catch (e) {
      warnSuppressed('startGeneration', e);
    }
    return handle;
  }

  /**
   * LLM 后：enqueue update（mapUsageDetails/mapGenMetadata 调用保留 + physical 分支保留）。
   * physical：mapUsageDetails({})→全 0、不传 output、metadata 追加 physicalWire=true；
   * logical：全量 usage 拆分映射（§6 互斥拆分防双计）+ output + error 路径 level/status。
   */
  endGeneration(e: GenEnd): void {
    try {
      const genKind = this.queue.getGenKind(e.gen.id);
      const upd: Record<string, unknown> = {
        endTime: e.endTime ?? new Date(),
      };
      const mapped = mapUsageDetails(genKind === 'physical' ? ({} as Usage) : e.usage);
      upd.usageDetails = mapped.usageDetails;
      upd.costDetails = mapped.costDetails;
      if (genKind !== 'physical') {
        if (e.output !== undefined) upd.output = e.output;
        if (e.status === 'error') {
          upd.level = 'ERROR';
          upd.status = 'ERROR';
        }
      }
      const meta = mapGenMetadata(e.metadata, e.errorCategory);
      upd.metadata = genKind === 'physical' ? { ...meta, physicalWire: true } : meta;
      this.queue.enqueue({ kind: 'update', id: e.gen.id, args: upd });
    } catch (err) {
      warnSuppressed('endGeneration', err);
    }
  }

  /** electron 关闭前：queue.drainAndShutdown（drain 先于 shutdownAsync，防丢事件） */
  async shutdown(): Promise<void> {
    try {
      await this.queue.drainAndShutdown();
    } catch (e) {
      warnSuppressed('shutdown', e);
    }
  }

  /**
   * 设置 observation 的 level（trace / span / generation）。
   * trace 顶层无 level 字段（ApiTraceBody）→ metadata.errorLevel 等价表达（spec R7）。
   * span/generation：observation schema 支持 level。
   */
  setLevel(h: TraceHandle | SpanHandle | GenHandle, level: ObservabilityLevel): void {
    try {
      const args: Record<string, unknown> =
        h.kind === 'trace' ? { metadata: { errorLevel: level } } : { level };
      this.queue.enqueue({ kind: 'update', id: h.id, args });
    } catch (e) {
      warnSuppressed('setLevel', e);
    }
  }
}
