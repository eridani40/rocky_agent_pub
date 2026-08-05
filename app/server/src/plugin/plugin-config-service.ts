/**
 * PluginConfigService — plugin 配置管理面（v0.0.67 起只读化）
 * 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D2/D4
 *       specs/tech/config/[P0]plugin_config_service.md §2/§3
 *       specs/tech/config/[P0]ext_impl_scope.md §6/§7
 *
 * v0.0.67 重构（D2 + 用户指示「直接删写端点 + 写方法，无死代码」）：
 *   - 读路径（inventory / listScopes / listActivatedPoints / getScope）从 ScopeConfigProvider 取
 *   - 写路径全删：setEnabled/setImplEnabled/setExclusive/setImplConfig/setPointOrders/setOrder/setConfig/
 *     createScope/deleteScope/activateEp/deactivateEp/persist（HTTP 层 task 3 路由同步删写端点）
 *   - ScopedWriter + scope-snapshot 整模块删（仅服务写路径）
 *   - PluginPolicyStore + PluginScopeStore 保留实例化：lazy migrate 旧盘兼容（spec §3 D2），
 *     但运行时读路径不再读它们；ScopeActivationStore 不再实例化（写路径删后无用）
 */
import type { Registry } from './registry';
import { PluginPolicyStore } from './plugin-policy-store';
import {
  PluginScopeStore,
  DEFAULT_SCOPE_ID,
  type PluginScope,
  pluginScopeFromMeta,
} from './plugin-scope-store';
import type { ScopeConfigProvider } from './scope-config-provider';
import type { GroupMetaProvider } from './group-meta-provider';
import {
  buildGroups,
  type InventoryBuilderDeps,
  type PluginInventoryTree,
} from './inventory-builder';

/**
 * inventory 返回的全量树类型定义在 inventory-builder.ts（与算法同源，避免主文件超 300 行）。
 * 重新导出便于现有 `import { PluginInventoryTree } from './plugin-config-service'` 零改动。
 */
export type { PluginInventoryTree } from './inventory-builder';

/** PluginConfigService 构造参数 */
export interface PluginConfigServiceOptions {
  /** 数据根目录（FsCrudStore root；lazy migrate 落盘兼容用） */
  root: string;
  /** v0.0.67 代码声明读视图（替代 PluginPolicyStore 读路径）。bootstrap 注入 LoadedScopeConfigProvider。 */
  scopeConfigs: ScopeConfigProvider;
  /**
   * v0.0.71 D1：group 元数据 read 视图（替代 EP.group 字段，T2 已删）。
   * bootstrap 注入 LoadedGroupMetaProvider（基于 GroupMetaLoader.load()）。
   * inventory-builder JOIN groups.json 声明序 + 嵌套结构用。
   */
  groupMeta: GroupMetaProvider;
}

/**
 * plugin 配置管理面服务（v0.0.67 起只读）。注入 Registry（代码树）+ root（lazy migrate 兼容落盘）
 * + scopeConfigs（读路径代码声明）+ groupMeta（v0.0.71 group 元数据 read 视图）。
 * 内部实例化 PluginPolicyStore + PluginScopeStore 仅服务 lazy migrate
 * 兼容旧盘（运行时读路径不读它们）。
 */
export class PluginConfigService {
  private readonly registry: Registry;
  private readonly store: PluginPolicyStore;
  private readonly scopeStore: PluginScopeStore;
  private readonly scopeConfigs: ScopeConfigProvider;
  private readonly groupMeta: GroupMetaProvider;

  constructor(registry: Registry, opts: PluginConfigServiceOptions) {
    this.registry = registry;
    this.scopeConfigs = opts.scopeConfigs;
    this.groupMeta = opts.groupMeta;
    this.store = new PluginPolicyStore({ root: opts.root });
    this.scopeStore = new PluginScopeStore({ root: opts.root });
    this.scopeStore.bootstrap(); // 确保 default scope 存在
  }

  // ── inventory（v0.0.67 读源 = ScopeConfigProvider；结构对前端不变）──

  /**
   * 全量树（按 scope 视图，spec §7）。scopeId 缺省='default'。
   * v0.0.67：scope 元信息 + scopes 列表 + activatedPoints 全部从 ScopeConfigProvider 取（不读落盘）。
   */
  inventory(scopeId: string = DEFAULT_SCOPE_ID): PluginInventoryTree {
    const scopes = this.scopeConfigs.listScopes();
    const current = scopes.find((s) => s.scopeId === scopeId)
      ?? scopes.find((s) => s.scopeId === DEFAULT_SCOPE_ID)!
      ?? { scopeId: DEFAULT_SCOPE_ID, name: 'Default', description: '' };
    return {
      scope: { id: current.scopeId, name: current.name, description: current.description },
      scopes,
      plugins: this.buildPluginList(),
      groups: buildGroups(this.makeDeps(), scopeId),
    };
  }

  /** 构造 builder helper 共享依赖（v0.0.71：registry + scopeConfigs + groupMeta，纯函数便于 UT） */
  private makeDeps(): InventoryBuilderDeps {
    return { registry: this.registry, scopeConfigs: this.scopeConfigs, groupMeta: this.groupMeta };
  }

  /** [v0.0.5] 构建 plugin-centric 平面列表（顶层 plugins[]）。plugin 级不分 scope。 */
  private buildPluginList(): PluginInventoryTree['plugins'] {
    // v0.0.67：plugin 级 native 受信恒 true（落盘 policy 已弃用读，PRD OUT）
    return this.registry
      .listPlugins()
      .map((pluginId) => {
        const manifest = this.registry.getPluginManifest(pluginId);
        return {
          pluginId,
          label: manifest?.label ?? pluginId,
          description: manifest?.description ?? '',
          enabled: true,
        };
      })
      .sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
  }

  // ── scope 读路径（v0.0.67：从代码声明取，spec §6.2）──

  /** 列所有 scope（default 首位）。v0.0.67：从代码声明取（ScopeConfigProvider.listScopes）。 */
  listScopes(): PluginScope[] {
    return this.scopeConfigs.listScopes().map(pluginScopeFromMeta);
  }

  /** 取某 scope 元信息（代码声明优先，落盘 fallback 兼容历史动态 scope）。 */
  getScope(scopeId: string): PluginScope | undefined {
    const meta = this.scopeConfigs.getScope(scopeId);
    if (meta) return pluginScopeFromMeta(meta);
    return this.scopeStore.get(scopeId);
  }

  /**
   * 查某 scope 的激活 EP 列表（spec §6.2）。
   * v0.0.67：从代码声明取（ScopeConfigProvider.listActivatedPoints）。
   * v0.0.206：default 返 default.yaml 声明集（plugin scope D6 已删，default 无特权）。
   */
  listActivatedPoints(scopeId: string): string[] {
    return this.scopeConfigs.listActivatedPoints(scopeId);
  }
}
