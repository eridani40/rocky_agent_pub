/**
 * workspace-types —— WorkspacePanel 共享类型（lazy 加载）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §3（数据契约）+ §8（state）
 *       specs/api/overall/04-agent-session.md §2.6.1（WsTreeNode 字段）
 *
 * lazy 加载策略：GET tree 仅返一层；前端展开文件夹时按需 GET ?parent=<path> 子目录。
 * state 含 childrenCache / loadingChildren / stalePaths（spec §8）。
 */

/** 单条文件树节点（对齐 api §2.6.1 WsTreeNode） */
export interface WsTreeNode {
  /** 显示名（basename） */
  name: string;
  /** 相对 workspaceDir 的路径（唯一 key + POST open 入参；如 "src/auth/login.ts"） */
  path: string;
  /** 节点类型（真实类型，statSync 跟随 symlink 后判定） */
  type: 'file' | 'dir';
  /** dir 才有意义：是否有子项（控制 twisty 是否显示）；lazy 模式不递归 children */
  hasChildren: boolean;
  /** [v0.0.263] 是否为 symlink 节点（lstatSync 判定；缺省 undefined = 非 symlink，旧响应零差异） */
  isSymlink?: boolean;
  /** [v0.0.263] symlink 目标绝对路径（realpath 解析；仅 isSymlink=true 时有意义） */
  linkTarget?: string;
}

/** GET /session/:id/workspace/tree 响应（§3.1） */
export interface WorkspaceTreeResponse {
  /** 当前 workspaceDir（绝对路径；前端据此刷新 path-bar） */
  workspaceDir: string;
  /** 该层子项（顶层时 = 根级；带 parent 时 = parent 下的子项） */
  tree: WsTreeNode[];
}

/**
 * WorkspacePanel 内部 state（spec §8）。
 * 用 Record / Set 表达，reducer 纯函数维护。
 */
export interface WorkspaceState {
  /** 当前 workspaceDir（GET tree 返回 + SSE dir_changed 更新） */
  workspaceDir: string;
  /** 顶层文件树（GET tree 无 parent；只一层） */
  tree: WsTreeNode[];
  /** 已加载的子目录缓存（key = 父 path，value = 子节点；lazy 展开时填） */
  childrenCache: Record<string, WsTreeNode[]>;
  /** 展开态 per path（前端 state，不持久化——刷新后折叠态重置） */
  expanded: Record<string, boolean>;
  /** lazy GET 子目录 loading 态 per path（显示 ws-tree-loading spinner） */
  loadingChildren: Record<string, boolean>;
  /** 被 watch event 标记 stale 的子目录 path（下次展开时清缓存重拉） */
  stalePaths: Set<string>;
  /** [v0.0.275] 结构性变化（addDir/unlinkDir）的父目录 path 集合——结构刷新 effect 消费（未展开目录 twisty 刷新）；与 stalePaths 并存不互斥 */
  structuralStalePaths: Set<string>;
  /** GET 顶层 tree loading（禁用刷新按钮） */
  loading: boolean;
}

/** session_workspace_file_changed event payload（§3.2，spec session_event.md §2） */
export interface WorkspaceFileChangedEvent {
  type: 'session_workspace_file_changed';
  sessionId: string;
  createdAt: string;
  data: {
    /** 相对 workspaceDir 的相对路径（变化文件/目录） */
    path: string;
    /** 变化类型（add / change / unlink / addDir / unlinkDir） */
    kind: string;
    /** 是否目录 */
    isDir: boolean;
  };
}

/** session_workspace_dir_changed event payload（§3.2） */
export interface WorkspaceDirChangedEvent {
  type: 'session_workspace_dir_changed';
  sessionId: string;
  createdAt: string;
  data: {
    /** 新 workspaceDir（绝对路径） */
    workspaceDir: string;
    /** 旧 workspaceDir（绝对路径） */
    prevDir: string;
  };
}

/** WorkspacePanel 订阅的 SSE 事件（session_panel topic） */
export type WorkspaceEvent = WorkspaceFileChangedEvent | WorkspaceDirChangedEvent;

/**
 * 把相对路径中的 `/` 替换为 `-`，生成 testid 安全的 path 段（§5）。
 * 例：`src/auth/login.ts` → `src-auth-login.ts`
 */
export function encodePathForTestid(path: string): string {
  return path.replace(/\//g, '-');
}

/** 取相对路径的父目录（顶层变化时父 = 顶层，返空串）；'src/a.ts' → 'src'，'a.ts' → '' */
export function parentOfPath(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx < 0 ? '' : relPath.slice(0, idx);
}
