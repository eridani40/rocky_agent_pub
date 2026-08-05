/**
 * squad-model-helpers —— squad handler 内部共享 helper（v0.0.156 A2 从 handlers/squad.ts 拆出）。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §2（A2 squad helper 抽取 + INV-A2-1/2）
 *
 * 仅 squad handler 内部消费（4 处 checkModel 调用 + 多处 json）；不外泄到 utils。
 * 实现等价：从 squad.ts move，签名 / 逻辑 / 错误码 100% 不变（INV-G1 纯 move）。
 */
import type { AppConfigService } from '../config/app-config-service';
import { validateModelId } from '../services/model-validation';

/** JSON Response 构造（与现有 handler 一致） */
export function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * modelDefault 校验 helper（squad 主 modelDefault 单路，v0.0.158 起）。
 *
 * v0.0.155 曾有 summaryModelDefault 双路（INV-C1）；v0.0.158 删「独立 summary 模型」层，
 * summary 走 squad.modelDefault → default_models.chat 唯一 fallback 链（
 * ../services/model-resolver §5.1），本 helper 只留 modelDefault 单路校验。
 *
 * 签名 `(svc, modelId, providerIdHint?)`：
 *   - providerIdHint 非空 → 精确校验该 provider（命中 = providerId 启用 + 该 provider models 含 modelId）
 *   - providerIdHint 空 → 跨 provider 反查（back-compat：旧 squad 无 providerId，按 modelId 反查首个命中）
 *
 * 空 appConfig → null（旧测试省略不回归）；失败 → 400。
 */
export function checkModel(
  appConfig: AppConfigService | undefined,
  mid: string,
  providerIdHint?: string,
): Response | null {
  if (!appConfig) return null;
  const v = validateModelId(appConfig, mid, providerIdHint);
  return v.ok ? null : json(400, { error: v.error });
}
