/**
 * Mention Resolver —— 按 session kind 派生 mention provider 集合（v0.0.68 D8）
 * 参考: specs/tech/mention/resolver.md §2/§3/§4
 *
 * 设计：
 *   - 给定 session 的 biz/role/derivation，返回该 session 可见的 provider name 列表。
 *   - **纯函数**（不查 store、无 IO），便于 client+server 共用、可单测。
 *   - client（web ChatComposer / MentionPopover）+ server（search-service 校验）双侧共用同一张映射表，
 *     避免硬编码到各调用点导致 client 显示 tab 但 server 拒绝（或反之）的漂移。
 *
 * 不依赖 server/web 包，仅依赖 shared 内的 BizType/Role/Derivation 类型。
 */
import type { BizType, Role, Derivation } from './types/session-kind';

/**
 * mention provider 唯一标识枚举（开放，未来可扩展）。
 * 顺序影响 popover tab 排列：file → skill → workitem → member（resolver.md §3 矩阵顺序）。
 */
export type MentionProviderName = 'file' | 'skill' | 'workitem' | 'member';

/**
 * SessionKind 输入（resolver 不查 store，只看 kind 字段）。
 * 结构化接口——可接受任何含 biz/role/derivation 三字段的对象（含 SessionKind class 实例）。
 */
export interface ResolverSessionKind {
  /** 业务分区（playground | studio） */
  biz: BizType;
  /** 会话角色（subagent 存 parent.role bloodline） */
  role: Role;
  /** 派生层级（parent=非派生顶级；subagent=派生子 agent；v0.0.204 main→parent 改名） */
  derivation: Derivation;
}

/**
 * Provider 映射表（resolver.md §3，用户 v0.0.68 确认；v0.0.204 derivation main→parent 改名）。
 *
 * 6 个 key + default 兜底（不在表内 → [file, skill]）：
 *   - playground/rocky/parent：playground 主聊，仅 file+skill
 *   - playground/subagent/subagent：playground 派生 subagent，仅 file+skill
 *   - studio/squad/parent：squad 群聊，全 4 项（含 workitem+member）
 *   - studio/leader/parent：leader 单聊，3 项（无 member——对端就是 leader 自己）
 *   - studio/mate/parent：mate 单聊，3 项（同上）
 *   - studio/subagent/subagent：studio 派生 subagent，仅 file+skill
 *
 * @member 仅 squad 群聊可用——单聊对端就是该 member，@它无意义；
 * playground/subagent 不接 squad 上下文。
 */
const PROVIDER_MATRIX: Record<string, MentionProviderName[]> = {
  'playground/rocky/parent': ['file', 'skill'],
  'playground/subagent/subagent': ['file', 'skill'],
  'studio/squad/parent': ['file', 'skill', 'workitem', 'member'],
  'studio/leader/parent': ['file', 'skill', 'workitem'],
  'studio/mate/parent': ['file', 'skill', 'workitem'],
  'studio/subagent/subagent': ['file', 'skill'],
};

/** 不在矩阵内的 kind 兜底集合（resolver.md §3 表末「其他/兜底」行）。 */
const DEFAULT_PROVIDERS: MentionProviderName[] = ['file', 'skill'];

/**
 * 按 session kind 派生 mention provider 集合。
 *
 * @param kind session 身份维度（biz/role/derivation）
 * @returns 该 session 可用的 provider name 列表（顺序稳定，影响 popover tab 排列）
 */
export function resolveMentionProviders(
  kind: ResolverSessionKind,
): MentionProviderName[] {
  const key = `${kind.biz}/${kind.role}/${kind.derivation}`;
  const list = PROVIDER_MATRIX[key];
  // 返回副本避免 caller mutate 内部矩阵（纯函数契约）
  return list ? [...list] : [...DEFAULT_PROVIDERS];
}
