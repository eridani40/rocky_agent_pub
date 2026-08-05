/**
 * useSkillsCatalog —— 当前会话可见 skills 目录 hook（PRD 定案 1）
 * 参考: specs/ui/components/chat-page/component-skills-modal.md（3 tab 数据源映射）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.1（Collection 形）
 *       specs/api/overall/06-skill.md §3.1（GET /skill?sessionId= 四层合并 catalog）
 *
 * GET-once 无 SSE 无 poll：onInit 拉 `/skill?sessionId=<sid>`（resolver 四层合并 + 按 name 去重
 * 后的全量 entries），按 scope 分三组给 skills 弹层 3 tab：
 *   - session = scope 'workspace'（当前 session ws `.rocky/skills/`），不过滤 enabled
 *   - group   = scope 'group'（squad 团队 ws `.rocky/skills/`），不过滤 enabled；
 *               playground 无 group 层 → 恒空（弹层空态）
 *   - global  = scope 'builtin'|'app' 且 **enabled=true**（只留当前会话实际生效的全局继承集，
 *               不展示被开关覆盖掉的下游版本——PRD 定案 1）
 *
 * 恒挂载于 component-chat-float-menu（不随弹层开关 mount/unmount）；弹层每次打开自行
 * refetch()（PRD UC-S7 重开刷新），与 memory/cron 同范式。
 */
import { useMemo } from 'react';
import { listSkillsBySession, type SkillEntry } from '../../lib/api-client';
import { useLifecycle } from '../../lib/use-lifecycle';
import { type Collection } from '../../lib/lifecycle-shapes';

/** skills 弹层 3 tab 分组结果 */
export interface SkillsCatalogGroups {
  /** session tab：resolver workspace 层 */
  session: SkillEntry[];
  /** group tab：resolver group 层（playground 恒空） */
  group: SkillEntry[];
  /** global tab：resolver builtin+app 层，只留 enabled=true */
  global: SkillEntry[];
}

export interface SkillsCatalog {
  groups: SkillsCatalogGroups;
  loading: boolean;
  error: string | null;
  /** 命令式重拉（弹层每次打开调用） */
  refetch: () => Promise<void>;
}

const EMPTY_GROUPS: SkillsCatalogGroups = { session: [], group: [], global: [] };

/**
 * 按 scope 分三组的纯函数（导出供 UT 直接断言分组规则）。
 * 合并 catalog 按 name 去重（resolver 高层胜出），故每条 entry 只落一个组。
 */
export function groupSkillsByScope(items: SkillEntry[]): SkillsCatalogGroups {
  const groups: SkillsCatalogGroups = { session: [], group: [], global: [] };
  for (const e of items) {
    if (e.scope === 'workspace') groups.session.push(e);
    else if (e.scope === 'group') groups.group.push(e);
    // builtin|app → global；只留 enabled（当前会话实际生效，PRD 定案 1 global 弹层语义）
    else if (e.enabled) groups.global.push(e);
  }
  return groups;
}

/**
 * @param sessionId 当前 session id（skills catalog 为 session 级：workspace/group 层由 session record 派生）
 */
export function useSkillsCatalog(sessionId: string): SkillsCatalog {
  // ctx=Collection<SkillEntry>（keyOf 按 name 索引——resolver 合并后 name 唯一）；对外暴露分好组的 groups
  const { ctx: coll, loading, error, reload } = useLifecycle<Collection<SkillEntry>>({
    onInit: async ({ signal }) => {
      const items = await listSkillsBySession(sessionId);
      // 不变量②：fetch 后必须校验 signal.aborted 才能「生效」（杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { items, keyOf: (s: SkillEntry) => s.name };
    },
    deps: [sessionId],
  });

  // 分组是纯派生：items 变才重算（useMemo 保引用稳定，弹层 tab 切换不触发重分组）
  const groups = useMemo(() => (coll ? groupSkillsByScope(coll.items) : EMPTY_GROUPS), [coll]);

  return {
    groups,
    loading,
    error: error?.message ?? null,
    refetch: reload,
  };
}
