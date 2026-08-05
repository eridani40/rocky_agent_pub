/**
 * ScopeConfigProvider — 运行时读视图：把 ScopeConfig[]（代码声明）暴露为
 * PluginManager / PluginConfigService.inventory 直接消费的 read API。
 *
 * 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §2.1（配置代码化）
 *                              §3 D2（落盘 policy 弃用：运行时不读 plugin_policy/）
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md §3（运行时投影）
 *       specs/tech/config/[P0]ext_impl_scope.md §5/§7（per-EP 回退 + inventory 视图）
 *
 * v0.0.179 模型简化（废 selected/enabled/exclusivePicks/delta）：
 *   - getImplConfig 返 undefined = 该 impl 不在 sourceScope active 列表（不再 default true）
 *   - 返 ScopeImplConfig = active（membership 判定）
 *   - per-EP 继承保留：scope EP 节点不出现 → 'default'；出现 → scopeId（取该 scope 自己的 impls 全量列表）
 *
 * 职责（不变）：
 *   - 把 Loader 加载的 ScopeConfig[] 转成「按 scopeId/pointId/implId 查」的运行时读视图
 *   - 实现 per-EP 回退：非 default scope 的未激活 EP → 沿 extends 链回退，终点 default
 *   - 与 PluginPolicyStore 落盘解耦：本接口只读代码声明，不读 plugin_policy/（D2）
 *
 * v0.0.206（plugin scope D6 已删）：default scope 无特权——
 *   - 激活判定 = point 节点在该 scope yaml 声明（activatedPoints 含 pointId），default 同路径
 *   - impl active = membership（impls 字典 key 存在）
 *   - default.yaml 不配某 EP = 该 EP 对 default 关（不配 = 关）
 *
 * 不变式（由 ScopeConfigValidator 保证）：
 *   - 所有 ScopeConfig.activatedPoints 引用的 pointId 在 registry 已登记
 *   - 所有 ScopeConfig.impls 引用的 implId 在 registry 已登记
 *   - exclusive EP 在 activatedPoints 中 → impls 列表恰好 1 active
 *
 * 注意：本 provider 不做 secret 注入（D1：zhipu apiKey 等 secret 由 dev config / env 注入，
 * 不放 scopes/*.yaml）。getExtensionImpls 实例化 impl 时 configValues 仅来自代码声明。
 */
import type { ScopeConfig, ScopeImplConfig } from './scope-config-loader';

/** scope 元信息（前端 inventory.scope 字段消费；不含 createdAt 等落盘信封字段） */
export interface ScopeMeta {
  scopeId: string;
  name: string;
  description: string;
  /** v0.0.204 T2-B3 extends 链父 scope id（缺省 = 'default'） */
  parentScopeId?: string;
}

/** 运行时读视角下的单条 impl 配置（与 ScopeImplConfig 形状一致；语义上 immutable） */
export type ImplConfigRead = ScopeImplConfig;

/** default scope 常量 id（extends 链 root 终点；保持与 plugin-scope-store 同名常量语义一致） */
const DEFAULT_SCOPE_ID = 'default';

/**
 * 运行时读视图接口。生产由 LoadedScopeConfigProvider 实现（内存 ScopeConfig[]）；
 * UT 可注入 mock 实现直接构造任意读视图，无需落盘。
 */
export interface ScopeConfigProvider {
  /** 列所有已加载 scope（default 必在首位，其余按加载顺序） */
  listScopes(): ScopeMeta[];
  /** 取某 scope 元信息（缺返 undefined） */
  getScope(scopeId: string): ScopeMeta | undefined;
  /**
   * (scopeId, pointId) 是否激活（v0.0.206：default 无特权——激活 = 该 scope yaml 声明此 point，
   * plugin scope D6 已删）。
   * 用于 inventory.activated 字段 + getExtensionImpls 的 per-EP 回退判定。
   */
  isPointActivated(scopeId: string, pointId: string): boolean;
  /**
   * 列某 scope 已激活 EP（= 该 scope yaml 声明的 activatedPoints；default 同路径，
   * 返 default.yaml 声明集）。
   */
  listActivatedPoints(scopeId: string): string[];
  /**
   * 解析 (scopeId, pointId) 的取源 scopeId（per-EP 回退，spec §5）：
   *   - scopeId='default' → 'default'（extends 链 root 终点，loop guard 自然落）
   *   - scopeId 非 default 且 activatedPoints 含 pointId → scopeId
   *     （取该 scope 自己的 impls 全量列表，零 delta merge）
   *   - 否则 → 沿 extends 链逐级回退，最终 'default'（继承 default 全量列表）
   */
  resolveSourceScope(scopeId: string, pointId: string): string;
  /**
   * 取 (sourceScope, implId) 的 impl 配置（order/configValues）。
   * v0.0.179：返回 undefined = 该 impl 不在 sourceScope active 列表（不再 default true）；
   * 返回 ScopeImplConfig = active（membership 判定）。
   *
   * 注意：sourceScope 已由调用方经 resolveSourceScope 解析；本方法不做回退。
   */
  getImplConfig(sourceScope: string, implId: string): ImplConfigRead | undefined;
}

/**
 * 基于 ScopeConfig[] 的生产实现。bootstrap 启动期由 ScopeConfigLoader.loadAll() 产出
 * ScopeConfig[]，包装成本 provider 注入 PluginManager / PluginConfigService。
 */
export class LoadedScopeConfigProvider implements ScopeConfigProvider {
  private readonly byId: Map<string, ScopeConfig>;
  private readonly order: string[];

  constructor(configs: ScopeConfig[]) {
    this.byId = new Map(configs.map((c) => [c.scopeId, c]));
    this.order = configs.map((c) => c.scopeId);
  }

  listScopes(): ScopeMeta[] {
    // default 首位，其余按加载顺序
    const out: ScopeMeta[] = [];
    const defaultCfg = this.byId.get(DEFAULT_SCOPE_ID);
    if (defaultCfg) {
      out.push(toMeta(defaultCfg));
    }
    for (const id of this.order) {
      if (id === DEFAULT_SCOPE_ID) continue;
      const cfg = this.byId.get(id);
      if (cfg) out.push(toMeta(cfg));
    }
    return out;
  }

  getScope(scopeId: string): ScopeMeta | undefined {
    const cfg = this.byId.get(scopeId);
    return cfg ? toMeta(cfg) : undefined;
  }

  isPointActivated(scopeId: string, pointId: string): boolean {
    // v0.0.206：default 无特权，与非 default 同路径（激活 = yaml 声明此 point）
    const cfg = this.byId.get(scopeId);
    if (!cfg) return false;
    return cfg.activatedPoints.includes(pointId);
  }

  listActivatedPoints(scopeId: string): string[] {
    const cfg = this.byId.get(scopeId);
    return cfg ? cfg.activatedPoints.slice() : [];
  }

  resolveSourceScope(scopeId: string, pointId: string): string {
    // v0.0.204 bug fix：入口 scopeId 未注册 → throw（不再静默兜底 default）。
    // 缺 scope 文件时（如 summary/consolidate run scopeId 未注册）静默落 default，
    // 对 summary/consolidate run = default 的真 compact → 递归爆炸。
    // scopeIds 来自 scopeIdOf(kind)，profile validator 已保证 main→summary+consolidate 注册，
    // 合法路径不会撞此 throw；这是 runtime defense（fail fast 显式失败 > 静默递归）。
    if (!this.byId.has(scopeId)) {
      throw new Error(
        `ScopeConfigProvider.resolveSourceScope: unregistered scopeId "${scopeId}"（入口 scope 必须注册；pointId=${pointId}）`,
      );
    }
    // v0.0.204 T2-B3：沿 extends 链逐级回退（取代「未激活→default」二级跳）。
    // 链: scope → parentScopeId → grandparent... → default（root 终点）
    // 合法 per-EP 继承：scope 存在但该 pointId 未激活 → 沿链找父，最终 default（不变）。
    // 防御深度：链上 16 跳仍找不到激活者 → fallback default（保守安全；不应到达——validator 防环）
    let cur: string | undefined = scopeId;
    for (let i = 0; i < 16 && cur !== undefined && cur !== DEFAULT_SCOPE_ID; i++) {
      const cfg = this.byId.get(cur);
      if (!cfg) break;
      if (cfg.activatedPoints.includes(pointId)) return cur;
      cur = cfg.parentScopeId ?? DEFAULT_SCOPE_ID;
    }
    return DEFAULT_SCOPE_ID;
  }

  getImplConfig(sourceScope: string, implId: string): ImplConfigRead | undefined {
    const cfg = this.byId.get(sourceScope);
    if (!cfg) return undefined;
    return cfg.impls[implId];
  }
}

/** ScopeConfig → ScopeMeta（剔除 activatedPoints/impls 等运行时数据） */
function toMeta(cfg: ScopeConfig): ScopeMeta {
  return {
    scopeId: cfg.scopeId,
    name: cfg.name,
    description: cfg.description ?? '',
    ...(cfg.parentScopeId !== undefined ? { parentScopeId: cfg.parentScopeId } : {}),
  };
}
