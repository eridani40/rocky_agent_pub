/**
 * ws-filter-tree —— 裁剪式结果树构建器（v0.0.324 D2）
 * 参考: specs/tech/version_logs/v0.0.324/change_plan.md D2
 *       specs/prd/version_logs/v0.0.324-file-tree-search-filter-tree.md §3
 *
 * 纯函数模块：从扁平搜索结果 {path,type}[] 构建裁剪式结果树。
 * 路径拆解 → 祖先补全 → 同路径合并 → 展开列表 → 输出可直接喂 ComponentWsFileTree。
 */
import type { WsTreeNode } from './workspace-types';
import { parentOfPath } from './workspace-types';

/** 裁剪树构建结果 */
export interface FilterTreeResult {
  /** 裁剪树顶层节点 */
  tree: WsTreeNode[];
  /** 每个祖先目录的直接子项（裁剪后；key=parentPath） */
  childrenCache: Record<string, WsTreeNode[]>;
  /** 需展开的祖先目录 path（预填 expanded） */
  expandedPaths: string[];
  /** 命中项总数（不含祖先容器） */
  hitCount: number;
}

/** 搜索命中项（扁平 {path, type}） */
export interface SearchHit {
  path: string;
  type: 'file' | 'dir';
}

/** 取路径最后一段作为 basename */
export function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * 从扁平命中列表构建裁剪式结果树。
 *
 * 步骤：
 * 1. 路径拆解：对每个 hit path 拆出所有祖先段（如 src/auth/login.ts → src, src/auth, src/auth/login.ts）
 * 2. 构建节点映射：Map<path, WsTreeNode>（祖先=dir+hasChildren=true；命中节点=原始 type）
 * 3. 构建 children 映射：按 parentOfPath 分组到 Record<parentPath, WsTreeNode[]>
 * 4. 目录命中补全：命中目录 path 在 existingChildrenCache 有子项 → 用真实子项替换裁剪子项
 * 5. 顶层提取：parentPath==='' 的节点 → tree[]
 * 6. 展开列表：所有祖先路径（命中目录本身不加入）
 */
export function buildFilterTree(
  hits: SearchHit[],
  opts: { limit: number; existingChildrenCache?: Record<string, WsTreeNode[]> },
): FilterTreeResult {
  const { limit, existingChildrenCache } = opts;

  // 限量截断
  const truncated = hits.slice(0, limit);
  const hitCount = hits.length;

  // 节点映射（path → WsTreeNode）
  const nodeMap = new Map<string, WsTreeNode>();
  // children 映射（parentPath → 子节点数组）
  const childrenMap = new Map<string, WsTreeNode[]>();
  // 需展开的路径集合
  const expandedSet = new Set<string>();

  // 创建或获取节点
  function getOrCreateNode(path: string, type: 'file' | 'dir'): WsTreeNode {
    let node = nodeMap.get(path);
    if (!node) {
      node = { name: basename(path), path, type, hasChildren: type === 'dir' };
      nodeMap.set(path, node);
    }
    return node;
  }

  // 添加 child 到 parent 的 children 列表
  function addChild(parentPath: string, child: WsTreeNode): void {
    let arr = childrenMap.get(parentPath);
    if (!arr) {
      arr = [];
      childrenMap.set(parentPath, arr);
    }
    // 去重（同 path 不重复添加）
    if (!arr.some((n) => n.path === child.path)) {
      arr.push(child);
    }
  }

  for (const hit of truncated) {
    // 1. 拆解路径段：src/auth/login.ts → ['src', 'src/auth', 'src/auth/login.ts']
    const segments = hit.path.split('/');
    let currentPath = '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      const isLast = i === segments.length - 1;
      const parentPath = parentOfPath(currentPath);

      if (isLast) {
        // 命中节点本身
        const node = getOrCreateNode(currentPath, hit.type);
        if (parentPath !== undefined) addChild(parentPath, node);
      } else {
        // 祖先目录
        const node = getOrCreateNode(currentPath, 'dir');
        node.hasChildren = true;
        if (parentPath !== undefined) addChild(parentPath, node);
        expandedSet.add(currentPath);
      }
    }
  }

  // 4. 目录命中补全：命中目录在 existingChildrenCache 有子项 → 用真实子项替换裁剪子项
  const resultChildrenCache: Record<string, WsTreeNode[]> = {};
  for (const [parentPath, children] of childrenMap) {
    // 检查是否有命中目录等于 parentPath 且有缓存子项
    const hitDir = truncated.find((h) => h.path === parentPath && h.type === 'dir');
    if (hitDir && existingChildrenCache?.[parentPath]) {
      // 目录命中且有缓存 → 用真实子项（全部展示，而非仅裁剪路径上的）
      resultChildrenCache[parentPath] = existingChildrenCache[parentPath]!;
    } else {
      resultChildrenCache[parentPath] = children;
    }
  }
  // 命中目录自身不在 childrenMap 中时（其子项不在裁剪路径上），从 existingChildrenCache 补入
  for (const hit of truncated) {
    if (hit.type === 'dir' && existingChildrenCache?.[hit.path] && !resultChildrenCache[hit.path]) {
      resultChildrenCache[hit.path] = existingChildrenCache[hit.path]!;
    }
  }

  // 5. 顶层提取：parentPath === '' 的节点
  const tree = childrenMap.get('') ?? [];

  // 6. 展开列表：祖先路径已在 L106 路径拆解时加入 expandedSet（路径可见性必需）。
  //    [v0.0.327] 命中文件夹本身不自动展开——只显示命中（出现在裁剪树），不暴露子内容；
  //    用户想看内容手动展开。

  return {
    tree,
    childrenCache: resultChildrenCache,
    expandedPaths: [...expandedSet],
    hitCount,
  };
}
