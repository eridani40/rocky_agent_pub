/**
 * langfuse generation metadata + usage 映射（v0.0.25 BUG-001 §3 补全 + v0.0.61 迁入）。
 * 参考: specs/api/version_logs/v0.0.25/change_log.md §3
 *       specs/tech/agent/observability/[P0]langfuse_adapter.md §6
 *
 * 设计：从 langfuse-adapter.ts 拆出（v0.0.25 加 physical_wire_body / errorCategory /
 * retry_chain 字段后主文件超 300 行；v0.0.61 mapUsageDetails 同因迁入）。
 * 本文件只做纯数据映射，无 SDK 依赖。
 */
import type { GenMetadata } from './types';
import type { Usage } from '../message/types';

/**
 * GenMetadata → langfuse generation.metadata 映射。
 *
 * 在原字段（iteration/step/cache/duration）基础上补全物理层 / 错误分类 / 重试链：
 *   - `physical_wire_body`（onWire 钩子记录的 protocol.encode 产出，与逻辑层 input diff）
 *   - `errorCategory`（仅 error 路径，LlmErrorCategory 字符串值）
 *   - `retry_chain`（attemptLoop 每次 attempt 记录）
 *
 * @param m        GenMetadata 全量字段
 * @param category endGeneration 入参里的 errorCategory（与 m.errorCategory 同源，
 *                 task 5 接线时优先 endGeneration.errorCategory）
 * @returns langfuse generation.metadata 形状（snake_case 匹配 langfuse SDK 约定）
 */
export function mapGenMetadata(
  m: GenMetadata,
  category?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    iteration: m.iteration,
    step: m.step,
    cacheReadTokens: m.cacheReadTokens,
    cacheWriteTokens: m.cacheWriteTokens,
  };
  if (m.durationMs !== undefined) out.durationMs = m.durationMs;
  // 物理层 wire body（可选，onWire 未注入时 undefined → 不写入）
  if (m.physicalWireBody !== undefined) {
    out.physical_wire_body = m.physicalWireBody;
  }
  // errorCategory：endGeneration 入参优先，其次 metadata 自身字段
  const ec = category ?? m.errorCategory;
  if (ec !== undefined) out.errorCategory = ec;
  // retry_chain（attemptLoop 记录，可选；空数组不写入）
  if (m.retryChain !== undefined && m.retryChain.length > 0) {
    out.retry_chain = m.retryChain;
  }
  return out;
}

/**
 * Usage → langfuse usageDetails/costDetails 映射（langfuse_adapter §6）。
 *
 * [v0.0.61 防双计] langfuse UI 求和含 "input" 子串的 key；anthropic `input_tokens` **不含** cache
 * （实测 input_tokens=1123 + cache_read=128 = total=1251）→ 必须互斥拆分，绝不能 input=grand total
 * 又加 cache key（双计）：
 *   - 拆分路径（input_no_cache / input_cache_read / input_cache_write 任一非 null）→ 拆分写；
 *     值为 0 的 cache key 跳过（不写入 map，避免 langfuse UI 显示 0 项）。
 *   - 三者全缺 → input_total_tokens 兜底，**不**传 cache key（防双计）。
 * 输出同理（output_response / output_reasoning vs output_total_tokens）。
 *
 * [v0.0.61 key 名对齐协议] cache/reasoning key 用 langfuse Anthropic 原生 snake_case（对齐
 * `reqs/v0.0.61.langfuse_opt_v1/langfuse-usage-protocol.md` §二/§四 + 匹配 langfuse 内置 model pricing）：
 *   - cache_read  → `cache_read_input_tokens`（Anthropic 原生名）
 *   - cache_write → `cache_creation_input_tokens`（Anthropic 原生名）
 *   - reasoning   → `output_reasoning_tokens`（OpenAI flatten 名，§四.2）
 * costDetails = cost!=null ? {total:cost} : {}（保留 LlmClient.computeCost 应用定价权威）。
 *
 * @param u LLM 调用用量（session_usage §1，全字段 optional）
 * @returns {usageDetails, costDetails}（langfuse generation.update 字段形状）
 */
export function mapUsageDetails(u: Usage): {
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
} {
  const num = (v: number | undefined): number => (typeof v === 'number' ? v : 0);
  const usageDetails: Record<string, number> = {};
  // 输入拆分（优先用拆分字段；缺失才用 total 且不传 cache key，防双计）
  const hasInputBreakdown =
    u.input_no_cache != null || u.input_cache_read != null || u.input_cache_write != null;
  if (hasInputBreakdown) {
    usageDetails.input = num(u.input_no_cache);
    // cache key 用 langfuse Anthropic 原生 snake_case（对齐 langfuse-usage-protocol §二）
    if (num(u.input_cache_read)) usageDetails.cache_read_input_tokens = num(u.input_cache_read);
    if (num(u.input_cache_write)) usageDetails.cache_creation_input_tokens = num(u.input_cache_write);
  } else {
    usageDetails.input = num(u.input_total_tokens);
  }
  // 输出拆分（同理）
  const hasOutputBreakdown = u.output_response != null || u.output_reasoning != null;
  if (hasOutputBreakdown) {
    usageDetails.output = num(u.output_response);
    // reasoning key 用 OpenAI flatten 名（langfuse-usage-protocol §四.2）
    if (num(u.output_reasoning)) usageDetails.output_reasoning_tokens = num(u.output_reasoning);
  } else {
    usageDetails.output = num(u.output_total_tokens);
  }
  // costDetails：保留应用定价权威（Usage.cost = LlmClient.computeCost 算）
  const costDetails: Record<string, number> = u.cost != null ? { total: num(u.cost) } : {};
  return { usageDetails, costDetails };
}
