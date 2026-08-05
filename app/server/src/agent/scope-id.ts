/**
 * scope-id — scopeIdOf(kind) = canonicalId 纯拼接
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §2
 *
 * 单行纯拼接零逻辑零分支零路由表（用户裁决：scopeId 不进 policy 层）。
 * 替代原 AgentScopeRouter（已删）：所有 scope 选择逻辑都收敛到「文件存在性 + extends 链」。
 */
import type { SessionKind } from '@app/shared';

/**
 * scopeIdOf — 从 SessionKind 派生 scopeId（= canonicalId 纯拼接）。
 *
 * @param kind SessionKind（身份维度对象）
 * @returns scopeId 字符串（4 段 `${biz}-${role}:${derivation}:${runKind}`）
 */
export function scopeIdOf(kind: SessionKind): string {
  return kind.canonicalId();
}
