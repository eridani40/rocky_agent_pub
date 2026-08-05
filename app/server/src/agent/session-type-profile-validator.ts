/**
 * SessionTypeProfileValidator — 启动校验：profile yaml vs registry 一致性
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §6
 *
 * 从 session-type-profile-loader.ts 拆出（≤300 行约束）。
 * Loader 做加载 + extends 链合并 + 缓存（形状正确性）；Validator 做语义校验（与 registry 一致）。
 *
 * 校验项（任一失败硬 throw）：
 *   - 基座必在（default / summary / consolidate / subagent）—— Loader.loadAll 已检
 *   - extends 链：父存在 + 无环（Loader.profile 内部 resolveChain 已检）
 *   - 禁跨 biz extends：业务 profile（${biz}-${role}:... 形态）的父必须同 biz；
 *     例外 = 父为系统基座（default/summary/consolidate/subagent，无冒号 id）
 *   - toolBound 引用已注册工具（幽灵名硬失败）
 *   - 矩阵完整性：每个 enabled 的 <prefix>:main profile 必须有对应的 <prefix>:summary +
 *     <prefix>:consolidate profile（防 default 继承触发 compact → 缺旁路 scope → 落 default 递归爆炸）
 */
import type { SessionTypeProfileLoader, RegisteredToolsIndex } from './session-type-profile-loader';

/** Validator 构造参数 */
export interface SessionTypeProfileValidatorOptions {
  /** 已 loadAll 的 loader（profile(id) 内部会跑链解析 + 环检测） */
  loader: SessionTypeProfileLoader;
  /** registry 产出的工具名集合（validateToolBound 用） */
  registered: RegisteredToolsIndex;
}

/**
 * 校验器：依赖 loader + registry 上下文做语义校验。所有错误 throw。
 *
 * 启动期（bootstrap）：loader.loadAll() → validator.validateAll() → policy 构造。
 */
export class SessionTypeProfileValidator {
  private readonly loader: SessionTypeProfileLoader;
  private readonly registered: RegisteredToolsIndex;

  constructor(opts: SessionTypeProfileValidatorOptions) {
    this.loader = opts.loader;
    this.registered = opts.registered;
  }

  /**
   * 批量校验：遍历 loader.listIds() 逐个跑 validateOne，再跑矩阵完整性校验。
   * 第一个错即 throw（启动硬失败）。
   */
  validateAll(): void {
    for (const id of this.loader.listIds()) {
      this.validateOne(id);
    }
    this.validateMainMatrix();
  }

  /**
   * 校验单个 profile：profile(id) 跑链解析（内部含环检测 + 父存在校验）+ toolBound 幽灵名校验。
   *
   * @throws toolBound 含未注册工具时抛错（消息含 profile id + 工具名便于定位）
   */
  validateOne(id: string): void {
    // profile(id) 内部跑 resolveChain（链解析 + 环检测 + 父存在校验）；抛即校验失败
    const resolved = this.loader.profile(id);
    // 禁跨 biz extends（STP §4）：业务 profile 的父必须同 biz；系统基座父豁免
    validateNoCrossBizExtends(id, resolved.extends);
    // toolBound 引用必须全部在 registry 注册（幽灵名硬失败）
    for (const name of resolved.toolBound) {
      if (!this.registered.names.has(name)) {
        throw new Error(
          `SessionTypeProfileValidator: profile "${id}" toolBound 含未注册工具 "${name}"`,
        );
      }
    }
  }

  /**
   * 矩阵完整性校验：每个 enabled 的 <prefix>:main profile 必须有对应 <prefix>:summary +
   * <prefix>:consolidate profile。
   *
   * 背景：main profile 通常 extends default（继承 threshold_should_compact 0.6 + post_compact 的
   * memory_skill_consolidation）。run 跑长触发 compact → 产 summary run + consolidate run。
   * 若缺对应旁路 profile/scope，scopeIdOf 落 default（真 compact）→ 递归爆炸。
   * 启动期硬失败防这类漏配（v0.0.204 bug：subagent.main 缺 summary/consolidate）。
   */
  private validateMainMatrix(): void {
    for (const id of this.loader.listIds()) {
      const prefix = mainPrefixOf(id);
      if (prefix === null) continue;
      // enabled!==false 才校验（disabled 的 main 不触发 compact 链路）
      const resolved = this.loader.profile(id);
      if (resolved.enabled === false) continue;
      const summaryId = `${prefix}:summary`;
      const consolidateId = `${prefix}:consolidate`;
      if (!this.loader.has(summaryId)) {
        throw new Error(
          `SessionTypeProfileValidator: main profile "${id}" 缺对应 summary profile "${summaryId}"（矩阵完整性：extends default 的 main 触发 compact 后必须有 summary 旁路，否则递归爆炸）`,
        );
      }
      if (!this.loader.has(consolidateId)) {
        throw new Error(
          `SessionTypeProfileValidator: main profile "${id}" 缺对应 consolidate profile "${consolidateId}"（矩阵完整性：post_compact memory_skill_consolidation 触发后必须有 consolidate 旁路）`,
        );
      }
    }
  }
}

/**
 * 解析 profile id 是否为 `<prefix>:main` 形态；是则返回 prefix（biz-role:derivation），否则 null。
 * id 结构 = `{biz}-{role}:{derivation}:{runKind}`（3 段冒号分隔），runKind=main 才触发矩阵校验。
 * 基座（default/summary/consolidate，无冒号）返回 null。
 */
function mainPrefixOf(id: string): string | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[2] !== 'main') return null;
  return `${parts[0]}:${parts[1]}`;
}

/**
 * 禁跨 biz extends（STP §4）：业务 profile（`${biz}-${role}:${derivation}:${runKind}` 形态）的
 * extends 父若也是业务 profile，则两者 biz 段必须相同。
 * 系统基座（default/summary/consolidate/subagent，无冒号 id）可被任意 biz 继承，不参与校验。
 *
 * @throws 跨 biz extends 时抛错（消息含父子 id + 各自 biz 段便于定位）
 */
function validateNoCrossBizExtends(id: string, parentId: string | undefined): void {
  if (!parentId) return;
  const childBiz = bizSegmentOf(id);
  const parentBiz = bizSegmentOf(parentId);
  if (childBiz === null || parentBiz === null) return; // 任一为基座 → 豁免
  if (childBiz !== parentBiz) {
    throw new Error(
      `SessionTypeProfileValidator: 禁跨 biz extends——profile "${id}"（biz=${childBiz}）extends "${parentId}"（biz=${parentBiz}）；跨 biz 共性请下沉系统基座（default/summary/consolidate/subagent）`,
    );
  }
}

/**
 * 取 profile id 的 biz 段（`${biz}-${role}:...` 第一个 `-` 之前）。
 * 基座 id（无冒号，如 default/subagent）返回 null。
 */
function bizSegmentOf(id: string): string | null {
  if (!id.includes(':')) return null;
  const first = id.split(':')[0]!;
  const dash = first.indexOf('-');
  return dash > 0 ? first.slice(0, dash) : null;
}
