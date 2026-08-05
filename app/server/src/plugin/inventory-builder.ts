/**
 * inventory-builder — PluginConfigService.inventory(scopeId?) 算法辅助。
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §7（inventory 扩展）
 *       specs/tech/version_logs/v0.0.71/change_plan.md 模块 5（D3 嵌套化 + bug-A JOIN default + D7）
 *       specs/api/version_logs/v0.0.71.md（AFTER 嵌套形状 = AT 断言契约源）
 *
 * v0.0.179 模型简化（membership 派生 enabled/selected）：
 *   - **enabled 派生**：`getImplConfig(...) !== undefined`（key 在 impls 字典 = active）
 *     不再 `implCfg?.enabled ?? true`（delta merge 源头已废）
 *   - **selected 派生**：exclusive EP 中 active impl 的 order 最小者（与运行时同口径）；
 *     list/ordered 永远 false
 *   - type 字段保留（cardinality 透传给 UI 按 type 渲染 radio/checkbox/ordered）
 *
 * v0.0.71 关键变更（保留）：
 *   - **D3 嵌套化**：buildGroups 返回 groups[].points[].impls[]（破坏性 schema 变更）
 *     groups 顺序 = GroupMetaProvider.listGroups() 声明序（不读 EP.group——T2 已删）
 *   - **bug-A**：ExtImplNode.config = JOIN(manifest default ⊕ scope configValues)
 *   - **D7**：删 schemaConfig 透传 + 新增 configSchema 透传（单一 schema 源）
 *   - **API spec §3.2**：删 ExtImplNode.pointActivated（信息上提到 points[].activated）
 */
import type { Registry } from './registry';
import type { ScopeConfigProvider, ScopeMeta } from './scope-config-provider';
import type { RegisteredExtImpl, JsonSchema } from './manifest';
import type { GroupMetaProvider } from './group-meta-provider';
import { computeEffectiveOrders } from './order-utils';
import { extractConfigDefaults } from './config-defaults';

/**
 * inventory 返回的全量树（v0.0.71 嵌套化）。
 * pluginEnabled 恒 true（v0.0.67 native 受信）；scopes=ScopeMeta（代码声明视图）。
 */
export interface PluginInventoryTree {
  /** 顶层 scope 元信息（当前查询 scope） */
  scope: { id: string; name: string; description: string };
  /** 全部 scope 列表（供 UI 切换器；default 首位） */
  scopes: ScopeMeta[];
  /**
   * plugin-centric 平面列表（插件 tab UI 用）。
   * v0.0.67：plugin 级 enabled 恒 true（native 受信，无落盘开关）。
   */
  plugins: {
    pluginId: string;
    label: string;
    description: string;
    enabled: boolean;
  }[];
  /**
   * group-centric 嵌套结构（v0.0.71 D3：破坏性 schema 变更）。
   *   - groups 顺序 = groups.json 声明序（GroupMetaProvider.listGroups()）
   *   - 每 group 下 points[] = 该 group 的 EP（GroupMeta.extPoints）
   *   - 每 point 下 impls[] = 该 EP 的 impl（per-point sourceScope 解析后取 effective 配置）
   */
  groups: {
    groupId: string;
    /** 该 group 下每个 point 节点（含激活状态 + impls[]） */
    points: {
      pointId: string;
      /** 该 point 在当前 scope 的激活状态（同 point 所有 impl 共享，per-EP 回退时不激活=false） */
      activated: boolean;
      /** 该 point 的 impl 节点（per-point effective order 排序 + (pluginId, implId) 稳定尾序） */
      impls: ExtImplNode[];
    }[];
  }[];
}

/**
 * 单条 ext impl 节点（嵌套在 groups[].points[].impls[] 下）。
 *
 * v0.0.71 变更：
 *   - **删 schemaConfig?**（D7：单一 configSchema 源，schemaConfig 字段从全系统清除）
 *   - **加 configSchema?**（D7：透传 manifest configSchema，让前端 modal 可读 JSON Schema 形状）
 *   - **删 pointActivated**（API spec §3.2：信息上提到 points[].activated，同 point 共享避免冗余）
 *   - **config 行为变更**（bug-A：始终 = JOIN(manifest default ⊕ scope configValues)，修复之前裸
 *     configValues 在 default.json 未声明时为 undefined 的根因）
 */
export interface ExtImplNode {
  pluginId: string;
  implId: string;
  pointId: string;
  type: 'exclusive' | 'list' | 'ordered';
  /** v0.0.67：plugin 级 native 受信恒 true（保留字段供前端兼容） */
  pluginEnabled: boolean;
  /**
   * v0.0.179：impl 级 enabled 门 = membership（getImplConfig(...) !== undefined）。
   * 在 impls 字典中 = active；不在 = inactive。与运行时 plugin-manager.isActive 同口径。
   */
  enabled: boolean;
  /** 仅 ordered cardinality：per-point 连续 1..n（其他类型 undefined） */
  order?: number;
  /**
   * D7 新增：manifest configSchema 透传（让前端 modal 读 JSON Schema 形状）。
   * 单一 schema 源（schemaConfig 已删）。
   */
  configSchema?: JsonSchema;
  /**
   * bug-A 修复（v0.0.71）：始终 = JOIN(extractConfigDefaults(configSchema) ⊕ implCfg.configValues)。
   * manifest default 底座 ⊕ scope configValues overlay（per-domain 默认表对齐 spec）。
   */
  config: Record<string, unknown>;
  /** impl 级 description（i18n 占位符透传，UI 只读呈现） */
  description: string;
  /** EP 级 description（来自 ExtensionPoint.description） */
  pointDescription: string;
  /** plugin 级 description（来自 PluginManifest.description） */
  pluginDescription: string;
  /**
   * v0.0.179 selected 派生字段（不入库，inventory 算出来）：该 impl 是否是当前 point 的「选中项」。
   *   - exclusive point：active（impls 字典 key 存在）中 effective order 最小者
   *     （与运行时 plugin-manager 统一 getExtensionImpls 同口径，前端 radio 直接读不再自算）
   *   - list/ordered point：`selected = false`（无单选语义）
   */
  selected?: boolean;
}

/** inventory builder 依赖（v0.0.71：加 groupMeta JOIN groups.json 声明序） */
export interface InventoryBuilderDeps {
  registry: Registry;
  scopeConfigs: ScopeConfigProvider;
  /** v0.0.71 D1：group 元数据 read 视图（替代 EP.group 字段，T2 已删） */
  groupMeta: GroupMetaProvider;
}

/** 判定 (scopeId, pointId) 是否激活（委托 ScopeConfigProvider；v0.0.206 起 default 无特权）。 */
export function isPointActivated(
  deps: InventoryBuilderDeps,
  scopeId: string,
  pointId: string,
): boolean {
  return deps.scopeConfigs.isPointActivated(scopeId, pointId);
}

/**
 * 解析某 point 在某 scope 下的 impl 配置源 scopeId（spec §7 末段）。
 *   激活 → scopeId 自己（取 scope 自己的代码声明）
 *   未激活 → 'default'（回退取 default 的代码声明，inventory 视图与 default 一致）
 */
export function resolveSourceScope(
  deps: InventoryBuilderDeps,
  scopeId: string,
  pointId: string,
): string {
  return deps.scopeConfigs.resolveSourceScope(scopeId, pointId);
}

/**
 * 构建 inventory(scopeId) 的 groups[]（v0.0.71 D3 嵌套化：groups[].points[].impls[]）。
 *
 * 算法（spec §7 + change_plan 模块 5）：
 *   1. **groups 顺序 = GroupMetaProvider.listGroups() 声明序**（D5 7 组固定排序，不再按 registry 注册序）
 *   2. 每 group 下 points[] = GroupMeta.extPoints（registry.getPoint 反查 cardinality，
 *      缺 EP 视为 misconfig → throw，不静默 fallback——D6 不变量）
 *   3. 每 point 计算 activated（isPointActivated）+ sourceScope（resolveSourceScope，per-EP 回退）
 *   4. 每 point 用源 scope 跑 computeEffectiveOrders + 取 enabled/configValues
 *   5. 每 point 的 impls[] = 该 EP 的 impl 节点（per-point effective order + (pluginId, implId) 稳定尾序）
 *
 * @returns 嵌套 groups[]（group → point → impl 三层）
 */
export function buildGroups(
  deps: InventoryBuilderDeps,
  scopeId: string,
): PluginInventoryTree['groups'] {
  const { registry, scopeConfigs, groupMeta } = deps;
  const groupMetas = groupMeta.listGroups();

  return groupMetas.map((g): PluginInventoryTree['groups'][number] => {
    const points = g.extPoints.map((pointId): PluginInventoryTree['groups'][number]['points'][number] => {
      const point = registry.getPoint(pointId);
      // D6 不变量防御：groups.json 引用的 pointId 必须在 registry 注册（启动期 validateGroups 兜底）
      if (!point) {
        throw new Error(
          `buildGroups: groups.json 引用的 pointId "${pointId}" 不在 registry（D6 不变量违反）`,
        );
      }
      // 该 point 的激活状态 + 配置源 scope（spec §7）
      const activated = isPointActivated(deps, scopeId, pointId);
      const sourceScope = resolveSourceScope(deps, scopeId, pointId);

      // per-point effective order（按源 scope 取代码声明 order record）
      // v0.0.179：list EP 不关心顺序但 unified 跑（保 UI 1..n 连续序友好）
      const entriesOfPoint = registry.getByPoint(pointId);
      const orderMap = computeEffectiveOrders(entriesOfPoint, (implId) =>
        scopeConfigs.getImplConfig(sourceScope, implId),
      );
      // v0.0.179 exclusive selected 派生：active（membership）中 order 最小者；
      //   与运行时 plugin-manager 统一 getExtensionImpls 同口径。list/ordered 无单选语义 → undefined。
      const selectedImplId =
        point.cardinality === 'exclusive'
          ? computeExclusiveSelected(entriesOfPoint, orderMap, sourceScope, scopeConfigs)
          : undefined;
      const pointDescription = point.description ?? '';
      const impls = entriesOfPoint
        .map((entry) =>
          buildExtImplNode(
            deps,
            entry,
            point.cardinality,
            pointDescription,
            orderMap.get(entry.manifest.implId),
            sourceScope,
            entry.manifest.implId === selectedImplId,
          ),
        )
        .sort(compareExtImpl);
      return { pointId, activated, impls };
    });
    return { groupId: g.id, points };
  });
}

// ── 内部：JOIN 代码树 + 数据，构建单 ext impl 节点 ──

/**
 * 单 ext impl 节点：JOIN 代码声明（按 point 的 sourceScope 取）+ EP cardinality
 * + manifest description + configSchema + selected。
 *
 * v0.0.179 变更：
 *   - **enabled 派生**：`implCfg !== undefined`（membership；与 plugin-manager.isActive 同口径）
 *     不再 `implCfg?.enabled ?? true`（delta merge 源头已废）
 *
 * v0.0.71 变更（保留）：
 *   - **bug-A**：config = JOIN(manifest default ⊕ scope configValues)，per-domain 默认表对齐 spec
 *   - **D7**：删 schemaConfig 透传 / 加 configSchema 透传（单一 schema 源）
 *   - **API spec §3.2**：删 pointActivated（信息上提到 points[].activated）
 *   - **flagged ②**：absent（implCfg 未声明 → enabled=false，inactive）∪ active 都序列化，
 *     inventory 不静默 fallback（inactive 候选仍进 impls[]，前端 radio 渲染「未选中」状态）
 */
function buildExtImplNode(
  deps: InventoryBuilderDeps,
  entry: RegisteredExtImpl,
  cardinality: 'exclusive' | 'list' | 'ordered',
  pointDescription: string,
  order: number | undefined,
  sourceScope: string,
  selected: boolean,
): ExtImplNode {
  const implCfg = deps.scopeConfigs.getImplConfig(sourceScope, entry.manifest.implId);
  const pluginManifest = deps.registry.getPluginManifest(entry.pluginId);
  // bug-A：JOIN manifest default ⊕ scope configValues（浅 merge：scope 同 key 覆盖 default；
  //   嵌套 object 由 plugin-manager.instantiate 内 deepMerge 处理，inventory 仅展示用浅 merge 够用）
  //   flagged ②：absent（implCfg=undefined → 仅 manifest default，inactive）∪ active 都序列化
  const config: Record<string, unknown> = {
    ...extractConfigDefaults(entry.manifest.configSchema),
    ...(implCfg?.configValues ?? {}),
  };
  return {
    pluginId: entry.pluginId,
    implId: entry.manifest.implId,
    pointId: entry.manifest.point,
    type: cardinality,
    pluginEnabled: true, // v0.0.67：plugin 级 native 受信恒 true
    // v0.0.179：membership 派生（与 plugin-manager.isActive 同口径）
    enabled: implCfg !== undefined,
    order,
    configSchema: entry.manifest.configSchema, // D7 透传 manifest configSchema
    config, // bug-A：始终 = manifest default ⊕ scope configValues
    description: entry.manifest.description ?? '',
    pointDescription,
    pluginDescription: pluginManifest?.description ?? '',
    selected,
  };
}

/**
 * 计算 exclusive point 的 selected implId（spec §4.2）。
 * v0.0.179 与运行时 plugin-manager 统一 getExtensionImpls 同口径：
 *   1. active = `getImplConfig(...) !== undefined`（membership；不再 cfg?.enabled ?? true）
 *   2. 多个 active → 取 effective order 最小者（validator 保证 exclusive 恰好 1 active，
 *      但保持算法健壮应对 inventory 灰显场景）
 *   3. 0 active → 返 undefined（无 selected）
 */
function computeExclusiveSelected(
  entries: RegisteredExtImpl[],
  orderMap: Map<string, number>,
  sourceScope: string,
  scopeConfigs: ScopeConfigProvider,
): string | undefined {
  // v0.0.179 membership active 过滤（plugin 级恒 active，impl 级靠 key 存在）
  const active = entries.filter((e) =>
    scopeConfigs.getImplConfig(sourceScope, e.manifest.implId) !== undefined,
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0]!.manifest.implId;
  // 多个 active → effective order 最小者
  const sorted = [...active].sort(
    (a, b) =>
      (orderMap.get(a.manifest.implId) ?? Infinity) -
      (orderMap.get(b.manifest.implId) ?? Infinity),
  );
  return sorted[0]!.manifest.implId;
}

/**
 * 同 point 内 ext impl 稳定排序：effective order 升序 + (pluginId, implId) 字典序尾序。
 * change_plan 模块 5：point 内 impl 排序 = effective order + (pluginId, implId) 稳定尾序。
 */
function compareExtImpl(a: ExtImplNode, b: ExtImplNode): number {
  // effective order 优先（升序；undefined → 末尾，但 computeEffectiveOrders 已补位成 1..n）
  const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
  if (aOrder !== bOrder) return aOrder - bOrder;
  // (pluginId, implId) 字典序稳定尾序
  if (a.pluginId !== b.pluginId) return a.pluginId < b.pluginId ? -1 : 1;
  if (a.implId !== b.implId) return a.implId < b.implId ? -1 : 1;
  return 0;
}
