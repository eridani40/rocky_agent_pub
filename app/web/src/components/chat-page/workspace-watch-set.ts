/**
 * workspace-watch-set —— fs watch 关注集合纯函数（v0.0.271）
 * 参考: specs/tech/version_logs/v0.0.271/change_plan.md（裁决 R1：前端算完整集合推送，后端权威 diff 兜底）
 *       specs/tech/agent/session/[P0]session_workspace_manager.md（懒监听权威模型）
 *
 * 目标模型（老板拍板）：关注集合 = 所有打开节点自身 + 各自一级子文件夹（含空文件夹）。
 * 计算 = 全量重算 + diff（每次变化重算完整集合，与上次 diff 增删；不在新集合一律 close = 防泄漏对账）。
 *
 * 纯函数零副作用：输入 state 三件套（tree/expanded/childrenCache）→ 关注集合 string[]。
 * 打开节点来源 = expandedPathsByDepth（已有纯函数）；子文件夹判定用 node.type === 'dir'
 * （PRD 说 folder，实际类型是 dir）。路径去重 + 排序（可预测性 + diff 稳定性）。
 */
import type { WsTreeNode } from './workspace-types';
import { expandedPathsByDepth } from '../../store/workspace-slice-reducer';
import { parentOfPath } from './workspace-types';

export interface WatchSetInput {
  /** 顶层文件树（GET tree 无 parent；根一级子文件夹来源） */
  tree: WsTreeNode[];
  /** 展开态 per path（state.expanded；打开节点来源） */
  expanded: Record<string, boolean>;
  /** 已加载的子目录缓存（key = 父 path → 子节点；展开节点一级子文件夹来源） */
  childrenCache: Record<string, WsTreeNode[]>;
}

/**
 * 计算关注集合：根 '' 恒含 + 根一级子文件夹（tree 筛 dir）+ 每个打开节点自身 +
 * 各自一级子文件夹（childrenCache[path] 筛 dir）。路径去重 + 字典序排序。
 *
 * 时序幂等：初始 rootTree 未到 → {根}；到后 → {根, 根一级}（两次 applyWatchSet 幂等）。
 * 展开后 childrenCache 未到 → 先发自身；GET 成功后 → 补子一级（幂等）。
 */
export function computeWatchSet({ tree, expanded, childrenCache }: WatchSetInput): string[] {
  const paths = new Set<string>(['']);
  // 根一级子文件夹（顶层 dir 节点）
  for (const node of tree) {
    if (node.type === 'dir') paths.add(node.path);
  }
  // 打开节点自身 + 各自一级子文件夹（childrenCache 缺失时只 watch 自身——保守，不误伤）
  for (const path of expandedPathsByDepth(expanded)) {
    paths.add(path);
    const children = childrenCache[path];
    if (children) {
      for (const node of children) {
        if (node.type === 'dir') paths.add(node.path);
      }
    }
  }
  return [...paths].sort();
}

/**
 * [v0.0.275] 结构刷新 refetch 目标纯函数。
 *
 * 输入 structuralStalePaths（结构性事件 addDir/unlinkDir 的**父目录** P 集合）→ 输出 string[]：
 * 每个 P 的 parentOfPath(P)（P 所在层——P 的 hasChildren 在 parentOf(P) 的 children 数组里，
 * refetch parentOf(P) 才能刷新 P 的 twisty；refetch P 自己无用，P 未展开不渲染）。
 * 去重（同层多个 P → 一次 refetch）+ 排序（可预测性）；'' 保留代表 refetch root tree。
 */
export function structuralRefetchTargets(structuralStalePaths: Set<string>): string[] {
  const targets = new Set<string>();
  for (const p of structuralStalePaths) {
    targets.add(parentOfPath(p));
  }
  return [...targets].sort();
}
