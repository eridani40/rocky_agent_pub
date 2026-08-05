/**
 * GroupMetaProvider — v0.0.71 group 元数据运行时读视图：把 GroupMeta[]（Loader 加载）
 * 暴露为 inventory-builder JOIN 用的 read API。
 *
 * 参考: specs/tech/plugin_system/[P1]groups_meta_decl.md §3.3（包装层）
 *       specs/tech/plugin_system/[P1]scopes_config_decl.md §3.3（同型 Provider 范式）
 *       specs/tech/version_logs/v0.0.71/change_plan.md 模块 1
 *
 * 职责（[P1]groups_meta_decl.md §3.3）：
 *   - 把 Loader 加载的 GroupMeta[] 转成「按 pointId/groupId 查」的运行时读视图
 *   - 构建期维护 pointToGroup / idToGroup Map（O(1) 查询）
 *   - 构建期校验重复 pointId / 重复 groupId → throw（D6 第 5 条不变量前置）
 *
 * 不做（边界）：
 *   - 不读 fs（纯内存封装 Loader 数据，便于 UT 注入 mock）
 *   - 不校验 EP 在 registry 注册（Validator.validateGroups 的职责）
 */
import type { GroupMeta } from './group-meta-loader';

/**
 * 运行时读视图接口。生产由 LoadedGroupMetaProvider 实现（内存 GroupMeta[]）；
 * UT 可注入 mock 实现直接构造任意读视图，无需落盘。
 *
 * 参考 [P1]groups_meta_decl.md §3.3
 */
export interface GroupMetaProvider {
  /** 列所有 group（按 groups.json 声明序，[P1]groups_meta_decl.md §5.3） */
  listGroups(): GroupMeta[];
  /** pointId → 所属 group（构建期 Map 索引，O(1)；未登记返 undefined） */
  getGroupByPoint(pointId: string): GroupMeta | undefined;
  /** groupId → 元数据（构建期 Map 索引；未登记返 undefined） */
  getGroupById(groupId: string): GroupMeta | undefined;
}

/**
 * 基于 GroupMeta[] 的生产实现。bootstrap 启动期由 GroupMetaLoader.load().groups
 * 产出 GroupMeta[]，包装成本 provider 注入 PluginConfigService（inventory-builder JOIN 用）。
 *
 * 构建期校验（D6 第 5 条不变量前置）：
 *   - groupId 重复 → throw（group 元数据必须唯一）
 *   - pointId 重复（含同 group 内重复）→ throw（每个 EP 必须只归属一个 group）
 *
 * 注意：本 provider 不校验 EP 是否在 registry 注册（那是 ScopeConfigValidator.validateGroups
 * 的职责，需要 registry 上下文）。本 provider 仅做 GroupMeta[] 内部一致性检查。
 */
export class LoadedGroupMetaProvider implements GroupMetaProvider {
  private readonly groups: readonly GroupMeta[];
  private readonly pointToGroup: Map<string, GroupMeta>;
  private readonly idToGroup: Map<string, GroupMeta>;

  constructor(metas: GroupMeta[]) {
    this.groups = metas.slice();
    this.pointToGroup = new Map();
    this.idToGroup = new Map();
    for (const g of metas) {
      const prev = this.idToGroup.get(g.id);
      if (prev) {
        throw new Error(
          `LoadedGroupMetaProvider: 重复 group id "${g.id}"（group 元数据必须唯一，D6）`,
        );
      }
      this.idToGroup.set(g.id, g);
      for (const p of g.extPoints) {
        if (this.pointToGroup.has(p)) {
          throw new Error(
            `LoadedGroupMetaProvider: 重复 pointId "${p}"（每个 EP 必须只归属一个 group，D6）`,
          );
        }
        this.pointToGroup.set(p, g);
      }
    }
  }

  listGroups(): GroupMeta[] {
    return this.groups.slice();
  }

  getGroupByPoint(pointId: string): GroupMeta | undefined {
    return this.pointToGroup.get(pointId);
  }

  getGroupById(groupId: string): GroupMeta | undefined {
    return this.idToGroup.get(groupId);
  }
}
