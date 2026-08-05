/**
 * use-plugin-scope — page-plugin-config 的 scope 维度状态 + handlers（v0.0.26）
 * 参考: specs/ui/components/plugin-config-page/page-plugin-config.md [v0.0.26]
 *       specs/prd/version_logs/v0.0.26/change_log.md §3 UC-F6
 *
 * 从 page-plugin-config.tsx 拆出（避免主文件超 300 行）。封装：
 *   - currentScopeId state（默认 'default'）
 *   - refreshInventory(scopeId)：通用刷新（GET ?scopeId）
 *   - handleSelectScope：切换 scope（唯一保留下来的写 handler）
 *   - activatedPoints（Set<pointId>，从 inventory 嵌套 points[].activated 聚合，传给 section）
 *   - scopeItems（ScopeItem[]，inventory.scopes 兜底，传给切换器）
 *
 * 设计：以 hook 形式暴露，page 传入 inv/setInv/setError 控制库存与错误显示。
 *
 * v0.0.67 重构（D4 配置只读化）：原 4 个写 handler（handleActivateEp/handleDeactivateEp/
 *   handleCreateScope/handleDeleteScope）整体删除——它们仅返回 noop，没有任何消费者
 *   （PagePluginConfig 未解构使用）。保留会构成死代码（用户诉求「无死代码遗留」）。
 */
import { useMemo, useState } from 'react';
import {
  getPluginInventory,
  type PluginInventory,
  type PluginScope,
} from '../../lib/api-client';
import type { ScopeItem } from './component-scope-switcher';

export interface UsePluginScopeArgs {
  /** 当前 inventory（page 持有，本 hook 读取 scopes/groups 算 activatedPoints/scopeItems） */
  inv: PluginInventory;
  /** page 的 setInv（refreshInventory 写回新 tree） */
  setInv: (tree: PluginInventory) => void;
  /** page 的 setError（异步失败时回写错误显示） */
  setError: (msg: string | null) => void;
}

export interface UsePluginScopeReturn {
  currentScopeId: string;
  setCurrentScopeId: (id: string) => void;
  refreshInventory: (scopeId: string) => Promise<void>;
  handleSelectScope: (scopeId: string) => void;
  /** 该 scope 已激活的 pointId 集合（default 时 section 内部短路全激活，本 Set 仅其他 scope 用） */
  activatedPoints: Set<string>;
  /** scope 切换器数据源（inventory.scopes 兜底 [{id:'default', name:'Default'}]） */
  scopeItems: ScopeItem[];
}

/**
 * scope 维度状态 hook。page 调用 const {...} = usePluginScope({inv, setInv, setError})。
 * currentScopeId 由本 hook 内部 useState 管理（默认 'default'），page 通过返回值读取/切换。
 */
export function usePluginScope({ inv, setInv, setError }: UsePluginScopeArgs): UsePluginScopeReturn {
  const [currentScopeId, setCurrentScopeId] = useState<string>('default');

  // 通用刷新：按 scopeId 重新拉 inventory（含 points[].activated）。复用于切换 scope（v0.0.67 起唯一保留 handler）。
  const refreshInventory = (scopeId: string) =>
    getPluginInventory(scopeId)
      .then((tree) => setInv(tree))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  /** 切换 scope：setCurrentScopeId + GET ?scopeId 刷新 inventory。 */
  const handleSelectScope = (scopeId: string) => {
    setCurrentScopeId(scopeId);
    refreshInventory(scopeId);
  };

  // activatedPoints：从 inventory 嵌套结构 groups[].points[].activated 聚合（v0.0.71 D3）。
  // default section 内部短路全激活，本 Set 仅其他 scope 用。
  const activatedPoints = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    for (const g of inv.groups) {
      for (const p of g.points ?? []) {
        if (p.activated) {
          set.add(p.pointId);
        }
      }
    }
    return set;
  }, [inv]);

  // scopeItems：inventory.scopes 兜底 [default]。
  // 注意 PluginScope 业务 id 字段是 `scopeId`（非 `id`，见 types/plugin-scope.ts 注释）。
  const scopeItems = useMemo<ScopeItem[]>(() => {
    const list: PluginScope[] = inv.scopes ?? [{ scopeId: 'default', name: 'Default', createdAt: '' }];
    return list.map((s) => ({ id: s.scopeId, name: s.name, description: s.description }));
  }, [inv.scopes]);

  return {
    currentScopeId,
    setCurrentScopeId,
    refreshInventory,
    handleSelectScope,
    activatedPoints,
    scopeItems,
  };
}
