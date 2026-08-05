/**
 * ScopeConfigValidator — 启动校验：代码声明配置 vs registry 一致性
 * 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §2.3（启动校验）
 *                              §3 D3（硬失败：throw，不静默 fallback）
 *       specs/tech/plugin_system/[P0]extension_point_interface.md §3.1（cardinality 语义）
 *       specs/tech/plugin_system/[P1]scopes_config_decl.md §3.2（校验不变量）
 *
 * v0.0.179 模型简化（废 selected/enabled/exclusivePicks）后校验三类不变量：
 *   1. pointId 存在：activatedPoints 中每个 pointId 必须在 registry 已登记
 *   2. implId 存在：impls.keys 必须在 registry 已登记
 *   3. exclusive EP active 数恰好 1：activatedPoints 中每个 cardinality=exclusive 的 EP，
 *      其 impls 字典中 active impl（key 存在 = active）的数量必须恰好 1（0 或 >1 throw）
 *      同时校验：impls 中某 implId 实际归属的 point（manifest.point）必须在 activatedPoints 中
 *      （防跨 point 误列）
 *
 * 启动期调（bootstrap），校验失败 throw（D3：硬失败暴露 misconfig）。
 *
 * 与 Loader 协作：Loader 做形状校验（YAML 结构对），Validator 做语义校验（结构对得上 registry）。
 * LoadedGroupMetaProvider 构建期校验 groups.json 内部一致性（重复 pointId/groupId），
 * Validator.validateGroups 仅做「registry ↔ groups.json」覆盖率比对。
 */
import type { Registry } from './registry';
import type { ScopeConfig } from './scope-config-loader';
import type { GroupMeta } from './group-meta-loader';

/**
 * 解析 scopeId 是否为 `<prefix>:main` 形态；是则返回 prefix（biz-role:derivation），否则 null。
 * scopeId 结构 = `{biz}-{role}:{derivation}:{runKind}`（3 段冒号分隔），runKind=main 才触发矩阵校验。
 * 基座（default/summary/consolidate，无冒号）返回 null。
 */
function mainScopePrefixOf(id: string): string | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[2] !== 'main') return null;
  return `${parts[0]}:${parts[1]}`;
}

/** Validator 构造参数 */
export interface ScopeConfigValidatorOptions {
  /** 已加载完成的 registry（包含 EP 登记 + manifest 注册的 impl） */
  registry: Registry;
  /**
   * v0.0.71 D6 第 5 条：groups.json 加载的 group 元数据（必填，校验 registry ↔ groups 双向一致）。
   * 由 LoadedGroupMetaProvider.listGroups() 注入（bootstrap 阶段）。
   */
  groups: GroupMeta[];
  /**
   * v0.0.204 T2-B3：所有已加载的 ScopeConfig（validateOne extends 链校验用，查父 scope）。
   * 缺省 undefined → extends 链校验降级（仅本 scope，不查父），向后兼容旧调用方。
   */
  allConfigs?: ScopeConfig[];
}

/**
 * 校验器：依赖 registry 上下文做语义校验。所有错误 throw（消息带 scope/ep/impl 便于定位）。
 */
export class ScopeConfigValidator {
  private readonly registry: Registry;
  /** group 元数据（用于 validateGroups 双向一致校验） */
  private readonly groups: readonly GroupMeta[];
  /** pointId → 所属 group（构建期索引，validateGroups 用） */
  private readonly pointToGroup: Map<string, GroupMeta>;
  /** v0.0.204 T2-B3：scopeId → ScopeConfig（extends 链校验查父用）；null = allConfigs 未注入（降级跳过链校验） */
  private readonly scopeById: ((id: string) => ScopeConfig | undefined) | null;

  constructor(opts: ScopeConfigValidatorOptions) {
    this.registry = opts.registry;
    this.groups = opts.groups.slice();
    if (opts.allConfigs !== undefined && opts.allConfigs.length > 0) {
      const allMap = new Map(opts.allConfigs.map((c) => [c.scopeId, c]));
      this.scopeById = (id: string) => allMap.get(id);
    } else {
      this.scopeById = null; // 旧调用方未注入 → extends 链校验降级跳过
    }
    // 构建期校验 group id 唯一 + extPoints 项唯一（防御性：与 LoadedGroupMetaProvider 同型校验，
    // 但本 Validator 不假设调用方一定先过 Provider；保持独立可测）。
    this.pointToGroup = new Map();
    const groupIdSeen = new Set<string>();
    for (const g of this.groups) {
      if (groupIdSeen.has(g.id)) {
        throw new Error(
          `ScopeConfigValidator: 重复 group id "${g.id}"（groups.json group 元数据必须唯一，D6）`,
        );
      }
      groupIdSeen.add(g.id);
      for (const p of g.extPoints) {
        const prev = this.pointToGroup.get(p);
        if (prev) {
          throw new Error(
            `ScopeConfigValidator: pointId "${p}" 在 group "${prev.id}" 和 "${g.id}" 重复登记（每个 EP 必须只归属一个 group，D6）`,
          );
        }
        this.pointToGroup.set(p, g);
      }
    }
  }

  /**
   * 批量校验：先跑 validateGroups（独立校验 registry ↔ groups 双向一致），再对每个 ScopeConfig 跑 validateOne，
   * 最后跑 scope 矩阵对称校验。第一个错即 throw（启动硬失败）。
   */
  validateAll(configs: ScopeConfig[]): void {
    this.validateGroups();
    for (const cfg of configs) {
      this.validateOne(cfg);
    }
    this.validateMainScopeMatrix(configs);
  }

  /**
   * scope 矩阵对称校验：每个 `<prefix>:main` scope 必须有对应 `<prefix>:summary` +
   * `<prefix>:consolidate` scope 文件（与 profile 侧 SessionTypeProfileValidator.validateMainMatrix
   * 对称——profile 侧查 profile 文件，本侧查 scope 文件）。
   *
   * 背景：main 类型 extends default（继承 threshold_should_compact 0.6 + post_compact
   * memory_skill_consolidation）。run 跑长触发 compact → 产 summary/consolidate 旁路 run →
   * scopeId 拼出 `<prefix>:summary|consolidate`。scope 文件缺失仅靠 resolveSourceScope 运行时
   * throw（首次 compact 才在 fire-and-forget .catch 里暴露）——启动期硬失败提前暴露漏配。
   */
  private validateMainScopeMatrix(configs: ScopeConfig[]): void {
    const ids = new Set(configs.map((c) => c.scopeId));
    for (const id of ids) {
      const prefix = mainScopePrefixOf(id);
      if (prefix === null) continue;
      if (!ids.has(`${prefix}:summary`)) {
        throw new Error(
          `ScopeConfigValidator: main scope "${id}" 缺对应 summary scope "${prefix}:summary"（矩阵对称：extends default 的 main 触发 compact 后必须有 summary 旁路 scope，否则 resolveSourceScope 运行时 throw）`,
        );
      }
      if (!ids.has(`${prefix}:consolidate`)) {
        throw new Error(
          `ScopeConfigValidator: main scope "${id}" 缺对应 consolidate scope "${prefix}:consolidate"（矩阵对称：post_compact memory_skill_consolidation 触发后必须有 consolidate 旁路 scope）`,
        );
      }
    }
  }

  /**
   * v0.0.71 D6 第 5 条：registry ↔ groups.json 双向一致校验。
   *
   * 校验内容（构建期 Map 已检内部唯一性，本方法聚焦覆盖率比对）：
   *   - registry 每个 EP（含 test fixtures）必须在某 group 出现（防漏登记）
   *   - groups.json 引用的 pointId 必须在 registry 已登记（防漂移：删除 EP 但忘删 group）
   *
   * @throws 任一不变量破坏时抛错（消息含 pointId 便于定位）
   */
  validateGroups(): void {
    // (a) registry 每个 EP 必须在某 group 出现且仅一次（构建期已检唯一，本处仅检覆盖率）
    for (const pointId of this.registry.listPoints()) {
      if (!this.pointToGroup.has(pointId)) {
        throw new Error(
          `ScopeConfigValidator.validateGroups: registry EP "${pointId}" 未在任何 group 登记（groups.json 漏登记，D6 第 5 条）`,
        );
      }
    }
    // (b) groups.json 引用的 pointId 必须在 registry 已登记
    for (const g of this.groups) {
      for (const p of g.extPoints) {
        if (this.registry.getPoint(p) === undefined) {
          throw new Error(
            `ScopeConfigValidator.validateGroups: group "${g.id}" 引用的 pointId "${p}" 未在 registry 登记（groups.json 漂移，D6 第 5 条）`,
          );
        }
      }
    }
  }

  /**
   * 校验单个 ScopeConfig vs registry 一致性。
   *
   * @throws 任一不变量破坏时抛错（消息含 scopeId + ep/impl 便于定位）
   */
  validateOne(cfg: ScopeConfig): void {
    // v0.0.204 T2-B3：extends 链校验——父存在 + 无环（链: cfg → parentScopeId → ... → default）
    // 仅在 allConfigs 注入时跑（缺省 = 旧调用方，向后兼容降级）
    if (cfg.scopeId !== 'default' && cfg.parentScopeId !== undefined && this.scopeById) {
      const seen = new Set<string>([cfg.scopeId]);
      let curId: string = cfg.parentScopeId ?? 'default';
      for (let i = 0; i < 16; i++) {
        if (curId === 'default') break; // default = root 终点，无需登记
        if (seen.has(curId)) {
          throw new Error(
            `ScopeConfigValidator: scope "${cfg.scopeId}" extends 链成环（${Array.from(seen).join(' → ')} → ${curId}）`,
          );
        }
        seen.add(curId);
        const parent: ScopeConfig | undefined = this.scopeById(curId);
        if (parent === undefined) {
          throw new Error(
            `ScopeConfigValidator: scope "${cfg.scopeId}" extends 链含未知父 "${curId}"（链: ${Array.from(seen).join(' → ')}）`,
          );
        }
        curId = parent.parentScopeId ?? 'default';
      }
    }
    // 校验 1：activatedPoints 中每个 pointId 在 registry 已登记
    for (const pointId of cfg.activatedPoints) {
      if (this.registry.getPoint(pointId) === undefined) {
        throw new Error(
          `ScopeConfigValidator: scope "${cfg.scopeId}" activatedPoints 含未知 pointId "${pointId}"（未在 registry 登记）`,
        );
      }
    }
    // 校验 2：impls.keys 必须在 registry；且 impl 实际归属的 point 必须在该 scope 的 activatedPoints 中
    //   （防跨 point 误列：implId 在 impls 字典但 manifest.point 不在 activatedPoints → 配置失效且语义错）
    for (const [implId, implCfg] of Object.entries(cfg.impls)) {
      const regImpl = this.registry.getImplById(implId);
      if (regImpl === undefined) {
        throw new Error(
          `ScopeConfigValidator: scope "${cfg.scopeId}" impls 含未知 implId "${implId}"（未在 manifest 注册）`,
        );
      }
      // impl 实际归属的 point 必须在该 scope 激活（否则配置失效且语义错）
      if (!cfg.activatedPoints.includes(regImpl.manifest.point)) {
        throw new Error(
          `ScopeConfigValidator: scope "${cfg.scopeId}" impls["${implId}"] 实际归属 point "${regImpl.manifest.point}" 未在该 scope activatedPoints（防跨 point 误列）`,
        );
      }
      void implCfg; // v0.0.179：ScopeImplConfig 仅 order/configValues（type 已约束，无需运行时校验）
    }
    // 校验 3：exclusive EP 在 activatedPoints 中 → impls 中恰好 1 active
    //   active = impls 字典 key 存在（membership）；validator 保证 exclusive EP 恰好 1 active
    //   0 active 或 >1 active → throw（消息含 scopeId + pointId + 实际 active count）
    for (const pointId of cfg.activatedPoints) {
      const ep = this.registry.getPoint(pointId);
      if (!ep || ep.cardinality !== 'exclusive') continue;
      const entries = this.registry.getByPoint(pointId);
      const activeCount = entries.filter(
        (e) => cfg.impls[e.manifest.implId] !== undefined,
      ).length;
      if (activeCount !== 1) {
        throw new Error(
          `ScopeConfigValidator: scope "${cfg.scopeId}" 激活了 exclusive EP "${pointId}"，需恰好 1 个 active impl，实际 ${activeCount} 个`,
        );
      }
    }
  }
}
