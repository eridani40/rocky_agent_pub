/**
 * PluginManager — 注册表运行时活动投影 + 双重载 getExtensionImpls
 * 参考: specs/tech/plugin_system/[P0]plugin_manager_interface.md §2/§3
 *       specs/tech/config/[P0]ext_impl_scope.md §5（F4 per-EP 回退）
 *
 * v0.0.179 模型简化（废 selected/enabled/delta，统一 getExtensionImpls）：
 *   - membership-based active：impl 在 ScopeConfig.impls 字典中 = active（key 存在即启用）
 *     不再 `cfg?.enabled ?? true`（delta merge 源头已废）
 *   - 统一 filter+sort+instantiate 路径（无 cardinality 分支）：
 *     active 过滤 + 按 cfg.order 升序（list 不关心顺序但 unified 跑，无害）
 *   - cardinality 仅 validator（exclusive 恰好 1）+ UI 消费；运行时不分支
 *
 * 保留行为（向后兼容）：
 *   - 单参重载 ≡ getExtensionImpls(point, 'default')
 *   - 双参 per-EP 回退：激活→scope 配置；未激活→沿 extends 链回退，终点 default
 *
 * v0.0.206（plugin scope D6 已删）：default scope 无特权——激活=point 节点在 yaml 声明，
 * 不配 = 关；channel 等 EP 经 getExtensionImpls 直供无状态 impl（ChannelManager 组合器消费）。
 */
import type { ExtensionPoint } from './extension-point';
import type { Registry } from './registry';
import type { RegisteredExtImpl } from './manifest';
import type { ScopeConfigProvider } from './scope-config-provider';
// v0.0.71 BUG-PLUGIN-004：deepMerge 替换 spread 浅 merge（嵌套 object 不再丢字段）。
// 复用 llm 模块的 generic deepMerge（research §5），不新建 util。
import { deepMerge } from '../llm';
// v0.0.71 DRY：extractConfigDefaults 抽到 config-defaults.ts（bug-A inventory JOIN 也复用）。
import { extractConfigDefaults } from './config-defaults';

/** PluginManager 构造参数 */
export interface PluginManagerOptions {
  registry: Registry;
  /**
   * 代码声明读视图。由 bootstrap 注入 LoadedScopeConfigProvider
   * （包装 ScopeConfigLoader.loadAll() 产出）。
   */
  scopeConfigs: ScopeConfigProvider;
}

/** default scope 常量 id（spec §2；extends 链 root 终点） */
const DEFAULT_SCOPE = 'default';

/**
 * 带类型的注册表运行时投影器。注入 Registry + ScopeConfigProvider。
 *
 * 用法：
 *   const mgr = new PluginManager({ registry, scopeConfigs });
 *   const providers = mgr.getExtensionImpls(LlmProviderPoint);          // ≡ default
 *   const providers = mgr.getExtensionImpls(LlmProviderPoint, 'forked'); // per-EP 回退
 */
export class PluginManager {
  private readonly registry: Registry;
  private readonly scopeConfigs: ScopeConfigProvider;

  constructor(opts: PluginManagerOptions) {
    this.registry = opts.registry;
    this.scopeConfigs = opts.scopeConfigs;
  }

  /**
   * 取某扩展点的 active impl 实例列表（已按当前 config 实例化）。
   *
   * 单参重载：≡ getExtensionImpls(point, 'default')，向后兼容（现有调用方零改动）。
   *
   * v0.0.179 统一投影（无 cardinality 分支）：
   *   1. 解析 sourceScope（per-EP 回退）
   *   2. active = entries.filter(membership active)（key 在 impls 字典 = active）
   *   3. 按 cfg.order 升序排序（稳定；list 不关心顺序但 unified 跑，无害）
   *   4. 按 cfg 实例化（manifest default ⊕ configValues deepMerge）
   *
   * @param point 扩展点（v0.0.179：cardinality 仅 validator + UI 消费，运行时不分支）
   * @returns active impl 实例列表（exclusive ≤1 由 validator 保证；list 多；ordered 按 order）
   */
  getExtensionImpls<T = unknown>(point: ExtensionPoint<T>): T[];
  /**
   * 带 scopeId 重载：per-EP 回退（激活→scope 配置，未激活→沿 extends 链回退，终点 default）。
   * scopeId='default' 与单参重载行为完全一致（v0.0.206：default 无特权，channel 等 EP
   * 经本方法直供无状态 impl）。
   */
  getExtensionImpls<T = unknown>(point: ExtensionPoint<T>, scopeId: string): T[];
  getExtensionImpls<T = unknown>(point: ExtensionPoint<T>, scopeId: string = DEFAULT_SCOPE): T[] {
    const entries = this.registry.getByPoint(point.id);
    // 同一 point 所有 impl 共享激活态（per-EP），source scope 在本 call 内只解一次。
    const sourceScope = this.resolveScopeSource(scopeId, point.id);
    // v0.0.179 membership active：getImplConfig !== undefined = 在 impls 字典中 = active
    const active = entries.filter((e) => this.isActive(e, sourceScope));
    // 统一按 YAML 数组序（cfg.order）升序；同 order 按 registry 登记序（filter 保留登记序）
    const sorted = [...active].sort(
      (a, b) =>
        (this.scopeConfigs.getImplConfig(sourceScope, a.manifest.implId)?.order ?? Infinity) -
        (this.scopeConfigs.getImplConfig(sourceScope, b.manifest.implId)?.order ?? Infinity),
    );
    // 实例化：每次 get 按 merged config new 一个（configValues 源按 sourceScope）
    return sorted.map((e) => this.instantiate<T>(e, sourceScope));
  }

  /**
   * 解析该 (scope, point) 实际应取的源 scopeId（per-EP 回退）。
   * 委托给 ScopeConfigProvider（基于 activatedPoints），便于 UT mock。
   *
   * 抽此 helper 保留旧调用点兼容 + 集中表达「per-EP 回退取源」语义。
   */
  resolveScopeSource(scopeId: string, pointId: string): string {
    return this.scopeConfigs.resolveSourceScope(scopeId, pointId);
  }

  /**
   * v0.0.179 membership-based active：impl 在 ScopeConfig.impls 字典中 = active。
   * 废除 `cfg?.enabled ?? true`（delta merge 源头已删；key 存在即启用）。
   */
  private isActive(entry: RegisteredExtImpl, sourceScope: string): boolean {
    return this.scopeConfigs.getImplConfig(sourceScope, entry.manifest.implId) !== undefined;
  }

  /**
   * 实例化 impl 类：合并 config（manifest default 底座 + 代码声明 impl 级 configValues 覆盖）
   * 注入构造器。
   *
   * v0.0.179：configValues 源 = ScopeConfig.impls[implId].configValues（不含 secret，D1）；
   *           进此函数的 impl 必为 active（getImplConfig !== undefined 已过滤）。
   *
   * BUG-003（v0.0.14）：manifest 的 default 在 `configSchema.properties.{key}.default`，
   * 不在顶层 `configSchema.default`（见 spec extension point and implementations.md §4）。
   *
   * BUG-PLUGIN-004（v0.0.71）：spread 浅 merge → deepMerge（嵌套 object 递归合并，避免
   * `credentials` / `pricing` 等嵌套字段被 configValues 整体替换而丢默认子字段）。
   */
  private instantiate<T>(entry: RegisteredExtImpl, sourceScope: string): T {
    const ImplClass = entry.implClass as new (...args: unknown[]) => T;
    const cfg = this.scopeConfigs.getImplConfig(sourceScope, entry.manifest.implId);
    // impl 级 configSchema.default 底座 ⊕ scope configValues 覆盖（deepMerge 嵌套递归）
    const merged = deepMerge(
      extractConfigDefaults(entry.manifest.configSchema),
      cfg?.configValues ?? {},
    );
    // 构造器签名约定：(implId, cfg)；implId 便于实例自识别身份
    return new ImplClass(entry.manifest.implId, merged);
  }
}
