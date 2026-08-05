/**
 * assemble pipeline —— mapper + assemble_reducer 双 ordered EP 链（v0.0.13 S1b/T5；v0.0.173 起只剩 base_builder）
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §2/§3/§5
 *       specs/tech/agent/context/[P0]context_engine.md §3.5
 *
 * 从 context-engine.ts 拆出（≤300 行约束）。本模块提供纯函数：
 *   pluginManager + store + config + prevSnapshot → Message[]（picked）
 *
 * [v0.0.173] snapshot 永远 rebuild：
 *   - assemble_reducer 链只剩 base_builder（6 个清理 reducer 迁到 context_clean_view_reducer EP，
 *     由 ContextEngine.getCleanSnapshot 在喂 LLM 前跑）。
 *   - base_builder 不再读 prevSnapshot（rebuild 是确定性纯函数 f(summary,transcript)）；
 *     prevSnapshot 字段保留供 system 复用规则读（context-engine.assemble 用）+ 历史 fixture 兼容。
 *
 * 流程（context_assemble_detail.md §1）：
 *   ① mapper 链（context_assemble_mapper, ordered）各贡献 Partial<AssembleData> → deepMerge
 *   ② assemble_reducer 链（context_assemble_reducer, ordered）链式 reduce：
 *      base_builder(input=null) 永远 rebuild → 输出 Message[]（§6 产出结构）
 *
 * 单 mapper/reducer 失败降级为「不贡献」（同 system_prompt §9.4 策略）。
 * 无 pluginManager 或两链皆空 → 返回 null（ContextEngine fallback v0.0.8 head3+tail3）。
 *
 * 注意：本模块的类型定义（AssembleData 等）来自 rocky_context plugin types。
 * 为避免 server → plugins 反向依赖，此处本地定义等价契约（结构兼容，duck typing）。
 */
import type { Message } from '../message/types';
import type { PluginManager } from '../plugin/plugin-manager';
import { ContextAssembleMapperPoint, ContextAssembleReducerPoint } from '../plugin/extension-point';
import type { SessionStore } from './session-store';
import type { ContextSnapshot, SessionConfig } from './context-types';
import type { SummaryInfo, StoreCallOpts } from './session-store-types';
// [v0.0.66] system prompt 不再走 assemble 链（system_prompt impl 删除，design §2.4）。
//   buildSystemPrompt 由 context-engine.assemble 独立调（design §1.3），本 pipeline 不再注入 systemPromptRunner。

/** mapper 贡献集合（对齐 rocky_context/types.ts AssembleData；本地声明避免反向依赖） */
interface AssembleData {
  transcript: Message[];
  summary: SummaryInfo | null;
  /** [v0.0.185] summary_reader 贡献：head 候选（会话真第一条起锚定） */
  headCandidates?: Message[];
  /** [v0.0.185] summary_reader 贡献：tail 候选（summaryUpTo 结尾锚定） */
  tailCandidates?: Message[];
}

/** assemble 上下文（对齐 rocky_context AssembleCtx；store 由本 pipeline 注入） */
interface AssembleCtx {
  config: SessionConfig;
  prevSnapshot: ContextSnapshot | null;
  store: SessionStore;
  /**
   * [v0.0.52 P2-3] token/char 估算 ratio（session 维度，冷启动 1.0）。
   * ContextEngine.assemble 读 store.getRatio 注入；base_builder head/tail 选取用 char×ratio 累加。
   * 与 computeContextWindowUsage 同源（口径一致）。
   */
  ratio: number;
  /**
   * [v0.0.173] scopeId（'default' / 'forked'）—— base_builder 永远 rebuild，不再读 scopeId 作增量判定；
   *   forked 与 default 的清理 reducer 已迁至 context_clean_view_reducer EP（active 一致）。
   */
  scopeId?: string;
  /** [v0.0.83] store 调用 opts（runId 等）；transcript_reader 透传到 getMessages */
  opts?: StoreCallOpts;
}

/** mapper 契约（对齐 rocky_context AssembleMapper） */
interface AssembleMapper {
  map(ctx: AssembleCtx): Partial<AssembleData> | Promise<Partial<AssembleData>>;
}

/** reducer 契约（对齐 rocky_context AssembleReducer） */
interface AssembleReducer {
  reduce(
    data: AssembleData,
    input: Message[] | null,
    ctx: AssembleCtx,
  ): Message[];
}

/**
 * 跑 assemble mapper/reducer 双链产出 picked Message[]。
 *
 * [v0.0.40 D1=B] scopeId 透传到 getExtensionImpls（per-EP 回退：default→default 配置；
 *   forked→forked 配置）。
 * [v0.0.173] base_builder 永远 rebuild，不再读 prevSnapshot 判 append vs rebuild（确定性纯函数 f(summary,transcript)）；
 *   prevSnapshot 仍透传供 system 复用规则（context-engine.assemble 用）+ fixture 兼容。
 * [v0.0.52 P2-3] ratio 透传到 ctx：base_builder head/tail 选取用 char×ratio 累加（[v0.0.185] tokenCap 算法）。
 * [v0.0.66 §2.6] 删 buffer 参数——buffer_reader impl 已删，store 扩展点取代（forked 走 in_memory）。
 *
 * @returns Message[]（picked）；无 pluginManager 或链空 → null（调用方 fallback v0.0.8）
 */
export async function runAssemblePipeline(
  pluginManager: PluginManager | null,
  store: SessionStore,
  config: SessionConfig,
  prevSnapshot: ContextSnapshot | null,
  scopeId: string = 'default',
  ratio: number = 1.0,
  opts?: StoreCallOpts,
): Promise<Message[] | null> {
  if (!pluginManager) return null;

  const mappers = pluginManager.getExtensionImpls<AssembleMapper>(
    ContextAssembleMapperPoint,
    scopeId,
  );
  const reducers = pluginManager.getExtensionImpls<AssembleReducer>(
    ContextAssembleReducerPoint,
    scopeId,
  );
  // 两链皆空 → 走 fallback（链不完整时不在本 pipeline 拼 v0.0.8 head/tail）
  if (mappers.length === 0 || reducers.length === 0) return null;

  const ctx: AssembleCtx = {
    config,
    prevSnapshot,
    store,
    ratio,
    scopeId,
    opts,
  };

  // ① mapper 链：各贡献 Partial<AssembleData>，deepMerge 合并（单 mapper 失败降级跳过）
  const merged = await deepMergeAssembleData(mappers, ctx);

  // ② reducer 链：链式 reduce（input=null 起步，base_builder 构框架）
  let acc: Message[] | null = null;
  for (const r of reducers) {
    try {
      acc = r.reduce(merged, acc, ctx);
    } catch {
      // 单 reducer 失败降级：保留上一步 acc，不中断链
    }
  }
  return acc;
}

/**
 * v0.0.8 fallback 选取（head3+summaryMsg+tail3，change_log §5）。
 * assemble pipeline 不可用时走此路径（保既有 13 个 context-engine UT 兼容）。
 */
export function pickFallback(
  all: Message[],
  summary: SummaryInfo | null,
  sessionId: string,
): Message[] {
  if (summary && summary.content && all.length > 6) {
    const head = all.slice(0, 3);
    const tail = all.slice(-3);
    // [v0.0.81.compaction_bug] summary role 改 user（与 base_builder production 路径一致；
    //   summary 是对话 recap，作 user 上下文，非 system 指令）。
    const summaryMsg: Message = {
      id: `summary:${summary.version}`,
      sessionId,
      role: 'user',
      content: [{ type: 'text', text: summary.content }],
    };
    return [...head, summaryMsg, ...tail];
  }
  return all;
}

/** 取 message 第一个 text block 的 text（system msg content 取首条 text） */
export function firstText(m: Message): string {
  for (const b of m.content) {
    if (b.type === 'text') return b.text;
  }
  return '';
}

/**
 * 跑 mapper 链合并 Partial<AssembleData>。
 * 同字段后者覆盖（deepMerge 语义）；transcript 后者覆盖前者；summary 后者覆盖前者。
 *
 * [v0.0.66] system 字段已删（system_prompt impl 删除，design §2.4）—— deepMerge 不再合并 system。
 * [v0.0.173] prevMessages 字段已删（prev_snapshot mapper 删除，snapshot 永远 rebuild 不再需要增量基础）。
 */
async function deepMergeAssembleData(
  mappers: AssembleMapper[],
  ctx: AssembleCtx,
): Promise<AssembleData> {
  const acc: AssembleData = {
    transcript: [],
    summary: null,
  };
  for (const m of mappers) {
    let partial: Partial<AssembleData> | null = null;
    try {
      partial = await m.map(ctx);
    } catch {
      continue; // 单 mapper 失败降级
    }
    if (partial.transcript) acc.transcript = partial.transcript;
    if (partial.summary !== undefined) acc.summary = partial.summary;
    // [v0.0.185] head/tail 锚定候选（summary_reader 贡献，后者覆盖前者）
    if (partial.headCandidates) acc.headCandidates = partial.headCandidates;
    if (partial.tailCandidates) acc.tailCandidates = partial.tailCandidates;
  }
  return acc;
}
