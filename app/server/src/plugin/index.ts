/**
 * plugin 模块入口 — 静态内核（Registry / PluginManager / BuiltinLoader / PluginConfigService）
 * 参考: specs/tech/plugin_system/[P0]overview.md（模块概览）
 *       specs/tech/config/[P0]plugin_config_service.md（管理面）
 *       states/v0.0.3/task.json T2（plugin 静态内核）
 *
 * 使用方：`import { PluginManager, PluginConfigService, ... } from '@app/server/plugin'`
 *
 * 模块组成：
 *   - extension-point.ts：ExtensionPoint 类型 + 内置 EP 常量（llm_provider / llm_protocol）
 *   - manifest.ts：PluginManifest / ExtImpl / RegisteredExtImpl 类型
 *   - registry.ts：Registry（全量代码树，按 (point, implId) 索引）+ validateManifestShape
 *   - builtin-loader.ts：BuiltinLoader（扫描 app/plugins/builtins/，静态登记）
 *   - plugin-policy-store.ts：PluginPolicyStore（落盘 plugins.policy.json，两级稀疏 delta）
 *   - plugin-config-service.ts：PluginConfigService（管理面 inventory + setters + persist）
 *   - plugin-manager.ts：PluginManager（运行时 getExtensionImpls 投影 + 实例化）
 *   - schema_defs/plugin_policy.ts：plugin_policy entity SchemaDef
 */
// 扩展点
export {
  LlmProviderPoint,
  LlmProtocolPoint,
  WebSearchProviderPoint,
  BUILTIN_EXTENSION_POINTS,
  type ExtensionPoint,
} from './extension-point';

// manifest 类型
export type {
  PluginManifest,
  ExtImpl,
  RegisteredExtImpl,
  JsonSchema,
} from './manifest';

// Registry
export { Registry, validateManifestShape } from './registry';

// BuiltinLoader
export { BuiltinLoader, type BuiltinLoaderOptions } from './builtin-loader';

// PluginPolicyStore
export {
  PluginPolicyStore,
  type PluginPolicyData,
  type ExtImplPolicyData,
  type PluginPolicyStoreOptions,
  type PluginPolicyListEntry,
} from './plugin-policy-store';

// PluginConfigService
export {
  PluginConfigService,
  type PluginInventoryTree,
  type PluginConfigServiceOptions,
} from './plugin-config-service';

// [v0.0.26] scope 一等实体 + 激活记录 store + 默认 scope 常量。
// 注：PluginScopeStore.bootstrap()（ensure default scope）由 PluginConfigService constructor
// 隐式触发（plugin-config-service.ts bootstrap 段），bootstrapBuiltinPlugins new
// PluginConfigService(...) 即生效——此处仅导出符号，不在 index.ts 重复调用。
export {
  PluginScopeStore,
  type PluginScope,
  type PluginScopeStoreOptions,
  type ScopeCascadeDeps,
  DEFAULT_SCOPE_ID,
} from './plugin-scope-store';
export {
  ScopeActivationStore,
  type ScopeActivationStoreOptions,
} from './scope-activation-store';

// PluginManager
export { PluginManager, type PluginManagerOptions } from './plugin-manager';

// [v0.0.67] ScopeConfig 代码声明体系（Loader + Validator + Provider）
export {
  ScopeConfigLoader,
  type ScopeConfig,
  type ScopeImplConfig,
  type ScopeConfigLoaderOptions,
} from './scope-config-loader';
export {
  ScopeConfigValidator,
  type ScopeConfigValidatorOptions,
} from './scope-config-validator';
export {
  type ScopeConfigProvider,
  type ScopeMeta,
  LoadedScopeConfigProvider,
} from './scope-config-provider';

// [v0.0.71] GroupMeta 元数据体系（Loader + Provider；T1 产出，T2 接入 bootstrap）
export {
  GroupMetaLoader,
  type GroupMeta,
  type GroupMetaFile,
  type GroupMetaLoaderOptions,
} from './group-meta-loader';
export {
  type GroupMetaProvider,
  LoadedGroupMetaProvider,
} from './group-meta-provider';

// SchemaDef
export { PluginPolicySchema } from './schema_defs/plugin_policy';
export type { PluginPolicyRecord } from './schema_defs/plugin_policy';
