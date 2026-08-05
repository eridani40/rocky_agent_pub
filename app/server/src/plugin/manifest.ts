/**
 * PluginManifest / ExtImpl 类型定义（manifest 声明形状）
 * 参考: specs/tech/plugin_system/[P0]ext_impl_and_manifest_interface.md §2
 *       specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2.2
 *
 * 设计（ext_impl §3.1）：manifest 纯静态（不指向可执行入口、不含版本），
 * discovery/激活计划/配置后台只读 manifest 不跑插件代码。
 * impl 模块导出类（非 activate），get 时框架按当前 config 实例化（ext_impl §3.6）。
 *
 * 本文件只含「类型定义」，无运行时逻辑。运行时校验形状在 registry.ts。
 */

/** JSON Schema 的最小化类型摘要（persistence 不透明，plugin 不强校验 JSON Schema 内部） */
export type JsonSchema = Record<string, unknown>;

/**
 * manifest 内置 plugin.json 的最小化 schema 形状（运行时形状校验用）。
 *
 * v0.0.71 D8：删 plugin 级 configSchema?/config? 死字段——0 builtin 使用、0 代码读取
 * （research §3 of v0.0.71-bug-plugin-004-config-merge）。配置 schema 唯一源在 impl 级
 * `ExtImpl.configSchema`，plugin 级概念已废。
 */
export interface PluginManifest {
  /** 插件唯一 id，snake_case（必须等于 builtin 子目录名，见 builtin_plugins_directory §2.1） */
  id: string;
  /** ext impl 列表（扩展实现）；一个插件可向多个 point 贡献多个 ext impl */
  extImpls: ExtImpl[];
  /** 插件展示名（plugin tab UI 用；缺省时 inventory 以 pluginId 作 fallback） */
  label?: string;
  /** 插件描述（plugin tab UI 用；缺省时 inventory 返回空串） */
  description?: string;
}

/**
 * 一条 ext impl：把一个实现类挂到某个扩展点。
 *
 * v0.0.71 D7：删 `schemaConfig?` 字段——configSchema 是唯一 schema 源
 * （UI 控件由 configSchema.properties.<key>.{type,description,enum} 推导，不再需要 schemaConfig 简化形态）。
 * 删 SchemaConfigEntry type 同步进行。原 schemaConfig.description/options/enum 信息
 * 由各 builtin plugin.json 显式并入 configSchema.properties.<key>（JSON Schema 标准）。
 */
export interface ExtImpl {
  /** 本 ext impl 唯一标识（snake_case），作为 ext_impl_config 的逻辑 key */
  implId: string;
  /** 目标扩展点 id */
  point: string;
  /** 实现模块路径（相对 plugin 目录，如 "./provider.ts"）；该模块导出类 */
  impl: string;
  /**
   * impl 级描述（inventory 透传，UI 只读呈现）。
   * 代码硬编码（manifest 定义），不进 plugin_policy 配置（用户不能改）。
   * 参考: design §4.1 / specs/tech/config/[P0]plugin_config_service.md §2
   */
  description?: string;
  /**
   * 本 ext impl 的 per-impl 配置 JSON Schema（唯一 schema 源）。
   * - properties.<key>.default：实例化时与 scope configValues 合并的底座
   * - properties.<key>.description：UI 副文本（i18n 占位符 `__MSG_...__`）
   * - properties.<key>.enum：UI select 候选值
   */
  configSchema?: JsonSchema;
}

/**
 * registry 中一条 ext impl 的内部登记结构（manifest ExtImpl + 实例化所需的类引用）。
 * builtin-loader 解析 manifest 的 impl 模块路径后，把导出的类挂到这里（plugin_manager §3.4）。
 */
export interface RegisteredExtImpl {
  /** 该 ext impl 所属的 pluginId（manifest.id，登记时回填） */
  pluginId: string;
  /** manifest 形状（implId / point / impl / description / configSchema） */
  manifest: ExtImpl;
  /** impl 模块导出的实现类（get 时按当前 config 实例化） */
  implClass: unknown;
}
