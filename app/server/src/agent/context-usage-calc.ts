/**
 * ContextWindowUsage 估算（v0.0.16 从 context-engine.ts 拆出，满足 ≤300 行约束）
 * 参考: specs/tech/agent/context/[P0]context_usage_detail.md §3（char × ratio 估算 + 7 字段公式）
 *       specs/tech/agent/context/[P0]context_snapshot_interface.md §2（7 字段定义）
 *
 * 职责：assemble 内的 ContextWindowUsage 计算逻辑——char 估算 + 读 ratio + 组装 7 字段。
 * 纯函数 + 注入（store 读 ratio、appConfig 读 maxOutputTokens）。
 */
import type { Message, ContextWindowUsage } from '../message/types';
import type { SessionStore } from './session-store';
import type { AppConfigLike } from './context-types';
import { blockCharCount } from './context-compact-helpers';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './session-usage-helper';

/** 估算字符串 char 数（system prompt / text block） */
export function estimateChars(text: string): number {
  return text.length;
}

/** 估算单条 Message 的 char 数（Σ 各 content block 字符数） */
export function estimateMessageChars(m: Message): number {
  return m.content.reduce((n, b) => n + blockCharCount(b), 0);
}

/**
 * 估算 tools 序列化 char 数（用于 toolTokens = char × ratio）。
 * spec context_usage_detail §3：toolTokens = estimateTokens(tools 序列化)。
 * 简化：JSON.stringify 每个工具定义累加长度（与序列化发送 LLM 的形态近似）。
 */
export function estimateToolChars(tools: unknown[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  let total = 0;
  for (const t of tools) {
    try {
      total += JSON.stringify(t).length;
    } catch {
      // 序列化失败（circular 等）→ 跳过此工具不计
    }
  }
  return total;
}

/**
 * 读 AppConfig `context.maxOutputTokens`（输出预算，spec context_usage_detail §3）。
 * 缺省 / 非数字 / appConfig 未注入 → 回退代码默认 20000。
 *
 * 历史：v0.0.89 dev_config 废弃前参数名为 devConfig（读 dev_config.context.maxOutputTokens）；
 * 迁移后 group/key 名零变更直迁 app_config，参数改名 appConfig。
 */
export function getMaxOutputTokens(appConfig: AppConfigLike | null): number {
  if (!appConfig) return DEFAULT_MAX_OUTPUT_TOKENS;
  const raw = appConfig.get('context', 'maxOutputTokens');
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * [v0.0.16] assemble 内的 ContextWindowUsage 计算（7 字段全激活）。
 *
 * spec context_usage_detail.md §3 算式：
 *   ratio          = session.getRatio(sessionId)   // 不再硬编码 1.0
 *   systemTokens   = round(systemChars × ratio)
 *   messageTokens  = round(messageChars × ratio)
 *   toolTokens     = round(toolChars × ratio)
 *   totalTokens    = system + message + tool        // input 侧，不含 maxOutput
 *   maxOutputTokens = appConfig.context.maxOutputTokens ?? 20000
 *   tokenLimit     = config.client.contextWindow
 *   remainingTokens = tokenLimit − totalTokens − maxOutputTokens
 *
 * @param store 用于读 getRatio
 * @param sessionId session 维度 ratio 作用域
 * @param tokenLimit 模型 context window（config.client.contextWindow）
 * @param charCounts 三分项 char 数（system/message/tool）
 * @param appConfig 读 maxOutputTokens（可空）
 */
export async function computeContextWindowUsage(
  store: SessionStore,
  sessionId: string,
  tokenLimit: number,
  charCounts: { system: number; message: number; tool: number },
  appConfig: AppConfigLike | null,
): Promise<ContextWindowUsage> {
  // [v0.0.16] 读真值 ratio（冷启动 session 无 sample 时 store.getRatio 返 1.0）
  const ratio = await store.getRatio(sessionId);
  const maxOutputTokens = getMaxOutputTokens(appConfig);
  const systemTokens = Math.round(charCounts.system * ratio);
  const messageTokens = Math.round(charCounts.message * ratio);
  const toolTokens = Math.round(charCounts.tool * ratio);
  const totalTokens = systemTokens + messageTokens + toolTokens;
  return {
    systemTokens,
    messageTokens,
    toolTokens,
    totalTokens,
    maxOutputTokens,
    tokenLimit,
    remainingTokens: tokenLimit - totalTokens - maxOutputTokens,
  };
}
