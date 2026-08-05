/**
 * @app/shared 入口 — 兜底跨进程但非契约的纯函数/常量
 * 参考: specs/tech/app/package/[P0]package_structure.md §3.5
 *
 * 默认不开内容；新增需说明为何不归 protocols。
 * [v0.0.45] 新增 session 类型 alias（BizType / SessionType），供 server + web 共享。
 * [v0.0.56] 新增 SessionKind + Role + Derivation + 校验/helper。
 * [v0.0.204] 瘦身：SessionKind 只留身份 4 字段；新增 RunKind + SessionContext；
 *   validateSessionKindInput 拆 validateSessionKind + validateSessionContext 两层；
 *   T2-B2：ToolPolicyRole 类型 + deriveToolPolicyRole helper 整删（消费方迁完走 profile）。
 */

export type { BizType, Role, SessionType } from './types/session-types';
export {
  SessionKind,
  SessionKindValidationError,
  isStudioMainSession,
  validateSessionKind,
  validateSessionContext,
} from './types/session-kind.js';
export type {
  Derivation,
  RunKind,
  SessionKindInput,
  SessionContext,
} from './types/session-kind.js';

// [v0.0.68 D8] Mention Resolver —— client+server 共用 provider 派生映射表
// 参考: specs/tech/mention/resolver.md
export { resolveMentionProviders } from './mention-resolver.js';
export type {
  MentionProviderName,
  ResolverSessionKind,
} from './mention-resolver.js';
