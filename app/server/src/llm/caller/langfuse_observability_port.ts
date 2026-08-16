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
   * 主路径由 stage-llm / call-main 从 config.modelId 传入；T2 起 physical 用真实 target modelId
   * （recordAttemptTarget 覆盖），本字段作为 fallback（无 target 时保持旧行为）。
   */
  model: string;
  /**
   * [v0.0.353 T5 D8] 生效路由方案（= config.modelRoutingPlan；有方案才传）。
   * buildMetadata（logical end）对称携带——与 start 侧 LoopObservability.startGeneration 同源。
   */
  routingPlan?: { planId: string; planName?: string };
}

/** [v0.0.353 T2] 最近一次 recordAttemptTarget 的真实 target（供 physical generation 用）。 */
export interface AttemptTargetInfo {
  providerId: string;
  providerName: string;
  modelId: string;
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
  // [v0.0.353 T2] 最近一次 recordAttemptTarget 的真实 target（供 physical generation 用）。
  // 每次 wire attempt 前确定 target 并记录；physical gen 用真实 provider/model 替代 opts.model。
  let lastTarget: AttemptTargetInfo | undefined;
  // [v0.0.353 T5 D9] 本 iteration 内 skipped 候选序号（name `llm-{N}-skip-{M}` 的 M，从 1 递增）。
  let skippedCount = 0;

  const buildMetadata = (retryChain?: RetryAttempt[]): GenMetadata => {
    const metadata: GenMetadata = {
      iteration: opts.iteration,
      step: opts.step,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // [v0.0.353 T3 A1] logical view 标记：providerId/providerName 显式置 null +
      // logicalView: true（end 事件 metadata 全量重建，与 start 侧 LoopObservability 对称）。
      // 真实 provider/model 信息由 physical 子 span 记录（endPhysicalGeneration metadata）。
      providerId: null,
      providerName: null,
      logicalView: true,
      // [v0.0.353 T5 D8] routingPlan 对称携带（与 start 侧 LoopObservability.startGeneration 同源；
      // 有方案才带；无方案零行为变化）。
      ...(opts.routingPlan !== undefined ? { routingPlan: opts.routingPlan } : {}),
    };
    // 不在 logical.metadata 中填物理层信息（A1 治理，D5）：logical view 不填 provider/model，
    // 真实信息下沉 physical 子 span（T3 会在 logical metadata 标 logicalView: true + provider 置 null）。
    // 也不填 physicalWireBody：
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
      void lastWireBody;
      void lastWireUrl;
      void lastWireAttempt;
    },
    // [v0.0.353 T2] 记录真实 target（调用谁记录谁）。每次确定 target 后调用。
    recordAttemptTarget(target: { providerId: string; providerName: string; modelId: string }): void {
      lastTarget = {
        providerId: target.providerId,
        providerName: target.providerName,
        modelId: target.modelId,
      };
    },
    // [v0.0.353 T5 D9] 被跳过候选逐条记录（成对 gen：start + 立即 end，无 attempt 语义）。
    // 与 physical 同 parent（= logical genHandle.parent）、同 N 前缀成组（`llm-{N}-skip-{M}`，
    // M = 本 iteration 内跳过序号，从 1 递增），Langfuse 树上一眼区分「被跳 vs 真调」。
    // safe 包裹：observability 失败绝不影响路由主流程（skip 语义不变）。
    recordSkippedCandidate(cand: {
      providerId: string;
      providerName?: string;
      modelId: string;
      reason: 'time_window' | 'disabled' | 'circuit_open' | 'banned' | 'resolve_failed' | 'probe_inflight';
    }): void {
      try {
        const idx = ++skippedCount;
        const handle = opts.adapter.startGeneration({
          parent: opts.genHandle.parent,
          model: cand.modelId,
          name: `llm-${opts.iteration}-skip-${idx}`,
          kind: 'physical',
          physicalInput: { skippedCandidate: cand },
          providerId: cand.providerId,
          ...(cand.providerName !== undefined ? { providerName: cand.providerName } : {}),
          metadata: { skipped: true, reason: cand.reason, providerId: cand.providerId, ...(cand.providerName !== undefined ? { providerName: cand.providerName } : {}) },
        });
        opts.adapter.endGeneration({
          gen: handle,
          usage: {} as Usage,
          metadata: {
            iteration: opts.iteration,
            step: opts.step,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            skipped: true,
            skipReason: cand.reason,
            providerId: cand.providerId,
            ...(cand.providerName !== undefined ? { providerName: cand.providerName } : {}),
            modelId: cand.modelId,
          },
          endTime: new Date(),
        });
      } catch {
        // safe：observability 失败不影响路由主流程
      }
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
      // [v0.0.353 T2] model 用真实 target modelId（recordAttemptTarget 已记录；无 target 时回退 opts.model）
      //   providerId/providerName 由 adapter 写入 metadata（不污染 SDK name/model 字段）。
      return opts.adapter.startGeneration({
        parent: opts.genHandle.parent,
        model: lastTarget?.modelId ?? opts.model,
        name: `llm-${opts.iteration}-physical`,
        kind: 'physical',
        physicalInput: wireBody,
        startTime,
        ...(lastTarget
          ? { providerId: lastTarget.providerId, providerName: lastTarget.providerName }
          : {}),
      });
    },
    endPhysicalGeneration(handle: GenHandle, endTime: Date): void {
      // 物理层不带 usage（mapUsageDetails({}) → usageDetails/costDetails 全 0，不污染 cost dashboard）、不传 output；
      // metadata 标识 physicalWire=true（与 startGeneration 的 metadata.physicalWire 对齐，由 adapter 处理）
      // [v0.0.353 T2] metadata 补真实 provider/model（logical end 的 buildMetadata 同样回填——见 adapter 侧）。
      const metadata: GenMetadata = {
        iteration: opts.iteration,
        step: opts.step,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      if (lastTarget) {
        metadata.providerId = lastTarget.providerId;
        metadata.providerName = lastTarget.providerName;
        metadata.modelId = lastTarget.modelId;
      }
      opts.adapter.endGeneration({
        gen: handle,
        usage: {} as Usage,
        metadata,
        endTime,
      });
    },
  };
}
