/**
 * academy-session-model — academy session/版本 持久化 model 解析 helper
 *
 * 参考:
 *   - specs/tech/academy/[P0]data_model.md §2.1（教室 defaultModel fallback 链）
 *   - specs/tech/agent/providers_and_models/[P0]model_resolve.md §3（chat 单链 fallback）
 *   - services/model-resolver.ts（resolveModel + ModelNotConfiguredError 权威实现）
 *
 * 职责：给 academy 三种 session/版本创建路径（head/coach/student 版本目录）统一解析
 *   持久化 model，薄委托 services/model-resolver.ts 的 resolveModel academy 两档链，
 *   避免建教室/建学生/建任务三处复制 fallback 逻辑（DRY）。
 *
 * Fallback 优先级（resolver academy 链原生实现，与运行时 resolveConfig 同链）：
 *   a) explicitModel（body 显式传）
 *   b) classroomDefaultModel（教室级默认）
 *   （v0.0.230 收窄：无 app 默认兜底档——群体级无应用层默认概念，跑空由 resolver 抛 ModelNotConfiguredError）
 *
 * 保留字（'default'/'none'/空）或不可用（disabled/not found）= 继续下探。
 *
 * 不变量：返回的 {providerId, modelId} 一定是 resolveModel 命中的真实组合（非保留字）。
 *
 * 调用方：handlers/academy-classroom.ts（head session + student 版本播种） +
 *         handlers/academy-training-task-create.ts（coach session）。
 */
import type { AppConfigService } from '../config/app-config-service';
import {
  resolveModel,
  ModelNotConfiguredError,
  type ResolvedModel,
} from '../services/model-resolver';

/** model 复合候选（providerId optional，对齐 squad.modelDefault + session.ModelRef） */
export type AcademyModelRef = { providerId?: string; modelId: string };

// 便于 caller 区分错误类型（避免重复 import model-resolver）
export { ModelNotConfiguredError };

/**
 * 解析 academy session 持久化 model（head/coach/session 共用）。
 *
 * 直接委托 resolveModel 的 academy 两档链（v0.0.230 收窄：去 app 默认档）：
 *   1. explicitModel（body 显式，作 session 候选，最高优先级）
 *   2. classroomDefaultModel（教室级默认，classroom.defaultModel 档）
 *
 * 任一候选保留字（'default'/'none'/空）或不可用（disabled/not found）→ 继续下探；
 * 两档跑空 → resolveModel 抛 ModelNotConfiguredError（无 app 默认兜底）。
 *
 * @param appConfig              AppConfigService（resolveModel 数据源）
 * @param explicitModel          最高优先级候选（body 显式传；可空）
 * @param classroomDefaultModel  教室级默认候选（次优先级；可空）
 * @returns ResolvedModel {providerId, modelId} 持久化用（已命中真实 provider+model）
 *
 * @throws ModelNotConfiguredError 若两档全不可用（caller 转 HTTP 400 actionable 提示）
 */
export function resolveAcademySessionModel(
  appConfig: AppConfigService,
  explicitModel: AcademyModelRef | undefined,
  classroomDefaultModel: AcademyModelRef | undefined,
): ResolvedModel {
  return resolveModel({
    appConfigService: appConfig,
    sessionType: 'academy',
    sessionModelId: explicitModel?.modelId,
    sessionProviderId: explicitModel?.providerId,
    classroom: { defaultModel: classroomDefaultModel },
  });
}
