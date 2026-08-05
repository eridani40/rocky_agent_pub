/**
 * builtin rocky_context plugin — assemble_mapper: transcript_reader
 * 参考: specs/tech/agent/context_and_memory/[P0]context_assemble_detail.md §4
 *       specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.2/§4.3
 *
 * 职责：读最近 N 条 message（N=limit，默认 500），贡献 AssembleData.transcript。
 *   - 数据来源：SessionStore.getMessages(sessionId, { limit })
 *   - 返回 items 按时间升序（旧→新），直接放进 transcript 字段
 *
 * EP: context_assemble_mapper，priority 900（最高优先，最先贡献 transcript）。
 * configSchema: { limit: 500 }（最小 1）。
 */
import {
  AssembleData,
  AssembleCtx,
  AssembleMapper,
  ContextImplBase,
} from '../types';

/** 默认 limit（与 configSchema.default 一致） */
const DEFAULT_LIMIT = 500;

/**
 * transcript_reader mapper：读最近 N 条 message。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class TranscriptReaderMapper
  extends ContextImplBase
  implements AssembleMapper
{
  /** 取最近 N 条（cfg.limit 缺省 500） */
  private readonly limit: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.limit = this.getNumber('limit', DEFAULT_LIMIT);
  }

  /**
   * 读最近 N 条 message 贡献 transcript。
   * 通过 ctx.store 读 SessionStore；未注入 store → 贡献空（不阻塞链）。
   */
  async map(ctx: AssembleCtx): Promise<Partial<AssembleData>> {
    if (!ctx.store) return {};
    // [v0.0.83] ctx.opts 透传（runId 等）→ forked 按 runId 读桶 per-run 隔离；default opts 缺省按 sid
    const page = await ctx.store.getMessages(ctx.config.sessionId, {
      limit: this.limit,
    }, ctx.opts);
    return { transcript: page.items };
  }
}
