/**
 * llm-log-helper —— llm hook 日志字段组装（spec dev-logs §3.1 字段契约）
 * 参考: specs/tech/app/dev-logs/[P0]overall.md §3.1
 *
 * 从 invoke 内提取供 LogWriter.write('llm', ...) 用的字段：
 *   - provider/model：最近一次 resolveTarget 成功的 target（最终成功或最后失败的 provider）
 *   - request：baseReq（canonical 请求）
 *   - response：成功 → InvokeResponse；失败 → { category, message }
 *
 * 抽到独立文件让 llm_caller.ts 行数可控（hook 字段组装与 invoke 主逻辑分离）。
 */
import type { InvokeBaseReq } from '../llm/caller/llm_caller';
import type { InvokeResponse } from '../llm/caller/llm_caller';
import type { ResolvedTarget } from '../llm/caller/resolve_target';
import type { LogWriter } from './log-writer';

/** resolveTarget 返回的联合类型（成功 / 全 dead） */
export type ResolvedResult =
  | { kind: 'target'; target: ResolvedTarget }
  | { kind: 'all_dead'; reason: string };

/**
 * 组装 llm.log 一条记录的字段（spec dev-logs §3.1）。
 *
 * @param resolved 最近一次 resolveTarget 结果（target 拿 provider/model；all_dead → undefined）
 * @param baseReq  canonical 请求（agent loop 组装的入参，含 messages + params）
 * @param tail     成功路径传 { response }；失败路径传 { error: { category, message } }
 * @returns LogWriter.write 的 record 参数
 */
export function extractLlmLogFields(
  resolved: ResolvedResult | null,
  baseReq: InvokeBaseReq,
  tail: { response: InvokeResponse } | { error: { category?: unknown; message?: string } },
): Record<string, unknown> {
  const provider = resolved && resolved.kind === 'target' ? resolved.target.providerId : undefined;
  const model = resolved && resolved.kind === 'target' ? resolved.target.model.modelId : undefined;
  return { provider, model, request: baseReq, ...tail };
}

/**
 * fail-silent 写 llm 日志（spec dev-logs §3.1）。字段组装 + write 整体包 try/catch：
 * 日志任何异常（提取字段 / write）绝不冒泡进 invoke 主流程——成功路径不变成功，
 * 错误路径不掩盖/替换原错误。logWriter 缺省 → no-op。开关 false → LogWriter.write 内部早 return。
 */
export function safeWriteLlm(
  logWriter: LogWriter | undefined,
  resolved: ResolvedResult | null,
  baseReq: InvokeBaseReq,
  tail: { response: InvokeResponse } | { error: { category?: unknown; message?: string } },
): void {
  if (!logWriter) return;
  try {
    logWriter.write('llm', extractLlmLogFields(resolved, baseReq, tail));
  } catch {
    // 日志失败绝不影响 LLM 调用主流程
  }
}
