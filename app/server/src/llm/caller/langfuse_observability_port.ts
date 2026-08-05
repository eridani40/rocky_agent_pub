/**
 * LangfuseObservabilityPort —— ObservabilityPort 桥接到真 langfuse
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §2.1（InvokeContext.observability）
 *       specs/tech/agent/observability/[P0]langfuse_adapter.md §3-§4
 *       specs/tech/agent/observability/[P0]overall.md §5.2（GenMetadata physical_wire_body/errorCategory/retry_chain）
 *
 * 本文件把 LlmCaller 的 ObservabilityPort 桥接到真 langfuse：
 *   - recordWireBody(attempt, body, url) → 缓存到本次 generation 的 physicalWireBody（供 endGeneration 写入）
 *   - endGenerationOk(message, usage) → adapter.endGeneration({status:'success', output, usage, metadata})
 *   - endGenerationError(category, reason, {retryChain}) → adapter.endGeneration({status:'error', errorCategory, metadata:{retry_chain}})
 *
 * 设计：stateless 适配器（每次 invoke 新建一个，捕获本次 generation 的 genHandle + iteration）。
 *   - genHandle：由 agent loop 的 LoopObservability.startGeneration 产出，传入本 port 复用。
 *   - wire body：缓存最新一次 attempt 的 body（multi-attempt 时后写覆盖，符合「最后物理态」语义）。
 *
 * 边界：本 port 只翻译字段，不重做 try/catch（adapter 自身已 safe 包裹，loop 侧再防御一层）。
 */
import type { ObservabilityPort } from './llm_caller';
import type { ObservabilityAdapter, GenHandle } from '../../observability/adapter';
import type { GenMetadata, RetryAttempt } from '../../observability/types';
import type { Message as ProtocolMessage } from '../protocol-types';
import type { Usage } from '../../message/types';
import type { LlmErrorCategory } from './error_types';

/** LangfuseObservabilityPort 构造参数。 */
export interface LangfuseObservabilityPortOpts {
  /** 真 observability adapter（LangfuseAdapter / NoopAdapter 均可） */
  adapter: ObservabilityAdapter;
  /** 本次 generation 句柄（agent loop 的 LoopObservability.startGeneration 产出） */
  genHandle: GenHandle;
  /** iteration 序号（GenMetadata.iteration + physical name `llm-N-physical` 的 N） */
  iteration: number;
  /** step 序号（GenMetadata.step） */
  step: number;
  /**
   * modelId（physical generation.model）。
   * 主路径由 stage-llm / call-main 从 config.modelId 传入。
   */
  model: string;
}

/**
 * 创建一个 ObservabilityPort，桥接到真 langfuse generation。
 *
 * 行为：
 *   - recordWireBody：缓存最新 attempt 的 wire body（attempt 序号记入 metadata）。
 *   - endGenerationOk：调 adapter.endGeneration（status:success，output=message，usage，metadata.physical_wire_body）。
 *   - endGenerationError：调 adapter.endGeneration（status:error，errorCategory，metadata.{physical_wire_body, errorCategory, retry_chain}）。
 *
 * 零泄漏保证：错误路径必调 endGenerationError（invoke 在每个 throw 前都调过本 port）。
 */
export function createLangfuseObservabilityPort(
  opts: LangfuseObservabilityPortOpts,
): ObservabilityPort {
  let lastWireBody: unknown;
  let lastWireUrl: string | undefined;
  let lastWireAttempt: number | undefined;

  const buildMetadata = (retryChain?: RetryAttempt[]): GenMetadata => {
    const metadata: GenMetadata = {
      iteration: opts.iteration,
      step: opts.step,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    // 不在 logical.metadata 中填 physicalWireBody：
    //   - wire body 走独立 physical generation（kind='physical'，input=wireBody）。
    //   - 若塞 logical.metadata 会让 logical endGeneration update event 重复携带整个 wire body
    //     （与 physical gen input 同源），logPhysical=true 时双倍 payload 触发 SDK batch 问题、
    //     update 事件丢失（logical endTime/usage 全空）。
    //   - GenMetadata.physicalWireBody 字段声明保留（兼容旧 trace 读取），写路径移除。
    if (retryChain && retryChain.length > 0) {
      metadata.retryChain = retryChain;
    }
    return metadata;
  };

  return {
    recordWireBody(attempt: number, body: unknown, url: string): void {
      // 缓存最新 attempt（multi-attempt invoke 时后写覆盖）
      lastWireBody = body;
      lastWireUrl = url;
      lastWireAttempt = attempt;
      // debug only：url / attempt 不进 langfuse metadata（避免冗余字段）
      void lastWireUrl;
      void lastWireAttempt;
    },
    endGenerationOk(message: ProtocolMessage, usage: Usage | null): void {
      const u = usage ?? ({} as Usage);
      opts.adapter.endGeneration({
        gen: opts.genHandle,
        output: {
          // protocol-types Message → message/types Message（结构兼容；observability 仅记录不消费 sessionId）
          message: message as unknown as import('../../message/types').Message,
          stopReason: (message as unknown as { stopReason?: string }).stopReason ?? 'stop',
        },
        usage: u,
        metadata: buildMetadata(),
        endTime: new Date(),
        status: 'success',
      });
    },
    endGenerationError(
      errorCategory: LlmErrorCategory,
      reason: string,
      extra?: { retryChain?: RetryAttempt[] },
    ): void {
      // 错误路径：status:error + errorCategory + metadata 含 retry_chain
      // output 可省（langfuse_adapter §3：error 路径 output 可省）
      const metadata = buildMetadata(extra?.retryChain);
      // reason 字符串进 metadata.note（不占主 output 字段）
      // 注：GenMetadata 无 note 字段，作为 Record 透传（langfuse SDK 接受任意 metadata 键）
      (metadata as unknown as Record<string, unknown>).note = reason;
      opts.adapter.endGeneration({
        gen: opts.genHandle,
        usage: {} as Usage,
        metadata,
        endTime: new Date(),
        status: 'error',
        errorCategory: String(errorCategory),
      });
    },
    // physical generation（物理层 wire body 载荷，与同 iteration 的 logical 成对）
    hasPhysicalChild(): boolean {
      // 能力探测：ObservabilityManager 暴露 hasPhysicalChild（NoopAdapter / 裸 LangfuseAdapter 无 → false）
      const m = opts.adapter as unknown as { hasPhysicalChild?: () => boolean };
      return typeof m.hasPhysicalChild === 'function' ? m.hasPhysicalChild() : false;
    },
    startPhysicalGeneration(wireBody: unknown, startTime: Date): GenHandle {
      // physical 与 logical 同 parent（step span，= logical genHandle.parent）、同 iteration（name N 一致）
      // kind=physical + name=`llm-N-physical`；无 usage/output（endGeneration 时传空 usage）
      return opts.adapter.startGeneration({
        parent: opts.genHandle.parent,
        model: opts.model,
        name: `llm-${opts.iteration}-physical`,
        kind: 'physical',
        physicalInput: wireBody,
        startTime,
      });
    },
    endPhysicalGeneration(handle: GenHandle, endTime: Date): void {
      // 物理层不带 usage（mapUsageDetails({}) → usageDetails/costDetails 全 0，不污染 cost dashboard）、不传 output；
      // metadata 标识 physicalWire=true（与 startGeneration 的 metadata.physicalWire 对齐，由 adapter 处理）
      opts.adapter.endGeneration({
        gen: handle,
        usage: {} as Usage,
        metadata: {
          iteration: opts.iteration,
          step: opts.step,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        endTime,
      });
    },
  };
}
