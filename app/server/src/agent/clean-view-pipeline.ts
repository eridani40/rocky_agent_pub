/**
 * clean-view-pipeline — 喂 LLM 前的「清理视图」reducer 链（v0.0.173 新增）
 * 参考: specs/tech/version_logs/v0.0.173/change_plan.md §三
 *       specs/tech/agent/context/[P0]context_assemble_detail.md §1（reducer 链示意）
 *       app/server/src/agent/assemble-pipeline.ts L98-127（reducer 链结构参考）
 *
 * 把原挂在 assemble_reducer 链尾的 6 个清理类 reducer（snip_handler / orphan_tool_call /
 * think_remove / fill_empty_text / empty_message / role_merge）剥到独立 EP，由
 * ContextEngine.getCleanSnapshot 在 structuredClone 后的 messages 副本上跑——snapshot 自身
 * 保持 rebuild 确定性纯函数（f(summary, transcript)），不被清理污染。
 *
 * 链结构同构 assemble-pipeline reducer 段：单 reducer 失败降级（catch + 保留上一步 acc）；
 * 链空 → 返 null（caller fallback 用原 messages，不阻塞 LLM 调用）。caller（getCleanSnapshot）
 * 必须先 structuredClone 再传入——本 pipeline 不再做克隆。
 */
import type { Message } from '../message/types';
import type { PluginManager } from '../plugin/plugin-manager';
import { ContextCleanViewReducerPoint } from '../plugin/extension-point';
import type { SessionConfig } from './context-types';

/**
 * reducer 契约（与 assemble-pipeline AssembleReducer 鸭子兼容，本地声明避免反向依赖 server → plugins）。
 * 6 个 clean reducer 都实现 AssembleReducer.reduce，input 永远非 null（= 上一步输出或起步 messages），
 * data 不读（用 EMPTY_DATA 占位满足签名）。
 */
interface CleanViewReducer {
  reduce(
    data: { transcript: Message[]; summary: null },
    input: Message[] | null,
    ctx: { config: SessionConfig },
  ): Message[];
}

/** 占位空壳 data（clean reducer 都不读 data 字段，仅作 reduce 签名兼容） */
const EMPTY_DATA: { transcript: Message[]; summary: null } = {
  transcript: [],
  summary: null,
};

/**
 * 跑 clean view reducer 链：snip_handler → orphan_tool_call → think_remove →
 * fill_empty_text → empty_message → role_merge（顺序由 scopes/{default,forked}.yaml 固化）。
 *
 * 衔接链（change_plan 开放点 A3）：
 *   ContextEngine.assemble → state.snapshot（稳定 rebuild）
 *     → getCleanSnapshot（深克隆 + 跑本 pipeline）
 *     → callLLMForSpec 取 messages
 *     → toLogicalMessages → protocol.encode（wire: tool→user 映射 + mergeAdjacentSameRole + reminder 过滤）
 *
 * @param pluginManager null → 返 null（caller fallback 用原 messages；UT fixture 兼容）
 * @param messages      深克隆后的 messages 副本（caller 必须 structuredClone 后传入；
 *                      本 pipeline 不重复克隆，reducer 内部各自不可变处理）
 * @param scopeId       EP per-scope 回退（'default' / 'forked'）；forked 与 default 同构激活
 * @param config        session config 占位（仅 fill_empty_text 读 ctx.config.sessionId 写 error 级日志；
 *                      logWriter 未注入则 fail-silent）
 * @returns 清理后的 Message[]；无 pluginManager 或链空 → null（caller fallback）
 */
export function runCleanViewPipeline(
  pluginManager: PluginManager | null,
  messages: Message[],
  scopeId: string = 'default',
  config: SessionConfig,
): Message[] | null {
  // 无 pluginManager（UT fixture / 未注入）→ null，caller fallback 用原 messages
  if (!pluginManager) return null;

  const reducers = pluginManager.getExtensionImpls<CleanViewReducer>(
    ContextCleanViewReducerPoint,
    scopeId,
  );
  // 链空（production misconfig / EP 未激活）→ null，caller fallback
  if (reducers.length === 0) return null;

  const ctx = { config };

  // 链式 reduce：input=messages 起步（非 null），base_builder 不参与
  let acc: Message[] | null = messages;
  for (const r of reducers) {
    try {
      acc = r.reduce(EMPTY_DATA, acc, ctx);
    } catch {
      // 单 reducer 失败降级：保留上一步 acc，不中断链（同 assemble-pipeline 策略）
    }
  }
  return acc;
}
