/**
 * Registry — 全量代码树，按 (point, implId) 索引持有 impl 类引用
 * 参考: specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4（静态注册）
 *       specs/tech/plugin_system/[P0]overview.md §2.5（管理架构：Registry 角色）
 *
 * 设计（overview §2.5 核心不变量）：
 *   - discovered = registered：registry 持有类的引用就是「已注册」，无激活中间态
 *   - 存在性归代码：manifest + EP 定义决定「有哪些」，不读 config 表
 *   - list 同 implId 后者覆盖 + warning（plugin_manager §3.3）
 *
 * register(manifest, ...implClasses)：implClasses 按 manifest.extImpls 顺序位置对应。
 * builtin-loader 负责解析 manifest.impl 路径取类后调 register。
 */
import type { ExtensionPoint } from './extension-point';
import type { PluginManifest, ExtImpl, RegisteredExtImpl } from './manifest';

/**
 * 带类型的注册表（PluginManager 的底层存储 + PluginConfigService inventory 的代码树源）。
 *
 * 索引：implsByPoint（pointId → implId → 条目）支持 getByPoint / 同 implId 覆盖；
 *      implById（implId → 条目）支持单条查询。
 */
export class Registry {
  /** 扩展点登记：按 pointId → implId → 条目（同 point 同 implId 后者覆盖） */
  private readonly implsByPoint = new Map<string, Map<string, RegisteredExtImpl>>();
  /** 单条索引：implId → 条目（跨 point 唯一，implId 全局唯一） */
  private readonly implsById = new Map<string, RegisteredExtImpl>();
  /** 已登记的 EP id 集合（listPoints 用） */
  private readonly pointIds = new Set<string>();
  /** 已登记的 pluginId 集合（listPlugins 用） */
  private readonly pluginIds = new Set<string>();
  /** 已登记的 EP 完整对象（getPoint 用，供 cardinality 解析） */
  private readonly pointsById = new Map<string, ExtensionPoint>();
  /** [v0.0.5] plugin 级 manifest（id/label/description/configSchema/config 等），供 inventory buildPluginList 用 */
  private readonly pluginManifests = new Map<string, PluginManifest>();

  /**
   * 登记一份 manifest：按 extImpls 顺序把 implClasses 对应位置挂入 registry。
   * manifest 经形状校验（id / extImpls[] / extImpls[].implId+point 必填）。
   * 同 (point, implId) 后登记者覆盖前者，并打 warning（plugin_manager §3.3）。
   *
   * @param manifest 插件清单（id + extImpls）
   * @param implClasses 各 extImpl.impl 模块导出的实现类，按 extImpls 顺序位置对应
   * @throws manifest 形状不合法时抛错（带字段名）
   */
  register(manifest: PluginManifest, ...implClasses: unknown[]): void {
    validateManifestShape(manifest);
    if (implClasses.length !== manifest.extImpls.length) {
      throw new Error(
        `Registry.register: implClasses 数量(${implClasses.length})与 extImpls 长度(${manifest.extImpls.length})不一致`,
      );
    }
    this.pluginIds.add(manifest.id);
    this.pluginManifests.set(manifest.id, manifest);
    manifest.extImpls.forEach((ext, idx) => {
      const entry: RegisteredExtImpl = {
        pluginId: manifest.id,
        manifest: ext,
        implClass: implClasses[idx],
      };
      this.registerOne(ext, entry);
    });
  }

  /**
   * 登记一条扩展点定义（builtin 启动时挂入，供 cardinality 解析与 inventory JOIN）。
   *
   * v0.0.71（D1）：删除 EP.group 校验——group 归属迁到 app/plugins/groups.json
   * 元数据源（外部），EP 不再携带 group 字段。group 与 registry EP 的双向一致性
   * 由 ScopeConfigValidator.validateGroups 在启动期校验（D6 第 5 条不变量）。
   * @throws point 缺 id/cardinality 或类型不对时抛错（消息含字段名）
   */
  registerExtensionPoint(point: ExtensionPoint): void {
    validateExtensionPointShape(point);
    this.pointsById.set(point.id, point);
    this.pointIds.add(point.id);
  }

  /** 取某扩展点的所有已登记 ext impl（同 implId 已 last-write 覆盖） */
  getByPoint(pointId: string): RegisteredExtImpl[] {
    const m = this.implsByPoint.get(pointId);
    return m ? [...m.values()] : [];
  }

  /** 按 implId 取单条登记（跨 point 唯一） */
  getImplById(implId: string): RegisteredExtImpl | undefined {
    return this.implsById.get(implId);
  }

  /** 按 pointId 取扩展点定义（cardinality 解析用） */
  getPoint(pointId: string): ExtensionPoint | undefined {
    return this.pointsById.get(pointId);
  }

  /** 所有已登记 pluginId（去重） */
  listPlugins(): string[] {
    return [...this.pluginIds];
  }

  /**
   * [v0.0.5] 取某 plugin 的顶层 manifest（含 label/description 等插件级元数据）。
   * 供 PluginConfigService.buildPluginList JOIN 用；未登记返回 undefined。
   */
  getPluginManifest(pluginId: string): PluginManifest | undefined {
    return this.pluginManifests.get(pluginId);
  }

  /** 所有被贡献到的 point id 集合 */
  listPoints(): string[] {
    return [...this.pointIds];
  }

  /** 内部：单条 ext impl 登记逻辑（含 last-write 覆盖 + warning） */
  private registerOne(ext: ExtImpl, entry: RegisteredExtImpl): void {
    const pointMap =
      this.implsByPoint.get(ext.point) ??
      this.implsByPoint.set(ext.point, new Map()).get(ext.point)!;
    const prev = pointMap.get(ext.implId);
    if (prev) {
      // 同 point 同 implId 后者覆盖（plugin_manager §3.3），打 warning 不抛错
      console.warn(
        `Registry: implId "${ext.implId}" 在 point "${ext.point}" 已登记（plugin ${prev.pluginId}），` +
          `被 plugin ${entry.pluginId} 覆盖`,
      );
    }
    pointMap.set(ext.implId, entry);
    this.implsById.set(ext.implId, entry);
    this.pointIds.add(ext.point);
  }
}

/**
 * EP 形状校验。
 * v0.0.71（D1）：删除 group 必填校验（group 迁到外部 groups.json 元数据源）。
 * 只校验「形状」（必填字段存在 + 类型对）。
 * @throws 形状不合法时抛错（消息含字段名便于定位）
 */
export function validateExtensionPointShape(point: ExtensionPoint): void {
  if (point == null || typeof point !== 'object') {
    throw new Error('Registry.registerExtensionPoint: point 必须是对象');
  }
  if (typeof point.id !== 'string' || point.id.length === 0) {
    throw new Error('Registry.registerExtensionPoint: point.id 缺失或非非空字符串');
  }
  if (
    point.cardinality !== 'exclusive' &&
    point.cardinality !== 'list' &&
    point.cardinality !== 'ordered'
  ) {
    throw new Error(
      `Registry.registerExtensionPoint: point.cardinality 必须是 exclusive/list/ordered（point=${point.id}）`,
    );
  }
}

/**
 * manifest schema 形状校验（plugin_manager §3.4 静态注册前免代码校验）。
 * 只校验「形状」（必填字段存在 + 类型对），不强校验 JSON Schema 内部。
 * @throws 形状不合法时抛错（消息含字段名便于定位）
 */
export function validateManifestShape(manifest: PluginManifest): void {
  if (manifest == null || typeof manifest !== 'object') {
    throw new Error('Registry.register: manifest 必须是对象');
  }
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new Error('Registry.register: manifest.id 缺失或非非空字符串');
  }
  if (!Array.isArray(manifest.extImpls)) {
    throw new Error('Registry.register: manifest.extImpls 必须是数组');
  }
  for (const ext of manifest.extImpls) {
    if (ext == null || typeof ext !== 'object') {
      throw new Error(
        `Registry.register: manifest.extImpls[] 项必须对象（plugin=${manifest.id}）`,
      );
    }
    if (typeof ext.implId !== 'string' || ext.implId.length === 0) {
      throw new Error(
        `Registry.register: extImpls[].implId 缺失（plugin=${manifest.id}）`,
      );
    }
    if (typeof ext.point !== 'string' || ext.point.length === 0) {
      throw new Error(
        `Registry.register: extImpls[].point 缺失（plugin=${manifest.id}, implId=${ext.implId}）`,
      );
    }
    if (typeof ext.impl !== 'string' || ext.impl.length === 0) {
      throw new Error(
        `Registry.register: extImpls[].impl 缺失（plugin=${manifest.id}, implId=${ext.implId}）`,
      );
    }
  }
}
