// @vitest-environment jsdom
/**
 * workspace-slice-reducer 单测 —— lazy 加载 + watch event 局部刷新 + dir change 清 cache
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §3（数据契约）+ §8（state）
 *       specs/tech/agent/session/[P0]session_event.md §2（workspace event payload）
 */
import { describe, it, expect } from 'vitest';
import {
  applyWorkspaceDirChanged,
  applyWorkspaceFileChanged,
  clearStructuralStalePaths,
  expandedPathsByDepth,
  initialWorkspaceState,
  resetForRefresh,
  setChildrenLoaded,
  setLoadingChildren,
  setTreeLoaded,
  toggleExpanded,
} from '../workspace-slice-reducer';
import type {
  WorkspaceDirChangedEvent,
  WorkspaceFileChangedEvent,
  WsTreeNode,
} from '../../components/chat-page/workspace-types';

const fileNode = (path: string, name?: string): WsTreeNode => ({
  name: name ?? path.split('/').pop() ?? path,
  path,
  type: 'file',
  hasChildren: false,
});

const dirNode = (path: string, name: string, hasChildren = true): WsTreeNode => ({
  name,
  path,
  type: 'dir',
  hasChildren,
});

const fileChanged = (path: string, kind = 'change'): WorkspaceFileChangedEvent => ({
  type: 'session_workspace_file_changed',
  sessionId: 'S1',
  createdAt: '2026-06-23T00:00:00.000Z',
  data: { path, kind, isDir: false },
});

const dirChanged = (newDir: string, prevDir = '/old'): WorkspaceDirChangedEvent => ({
  type: 'session_workspace_dir_changed',
  sessionId: 'S1',
  createdAt: '2026-06-23T00:00:00.000Z',
  data: { workspaceDir: newDir, prevDir },
});

describe('initialWorkspaceState', () => {
  it('空 state + 空 stalePaths/structuralStalePaths Set', () => {
    const s = initialWorkspaceState();
    expect(s.workspaceDir).toBe('');
    expect(s.tree).toEqual([]);
    expect(s.childrenCache).toEqual({});
    expect(s.expanded).toEqual({});
    expect(s.loadingChildren).toEqual({});
    expect(s.stalePaths).toBeInstanceOf(Set);
    expect(s.stalePaths.size).toBe(0);
    expect(s.structuralStalePaths).toBeInstanceOf(Set);
    expect(s.structuralStalePaths.size).toBe(0);
    expect(s.loading).toBe(false);
  });
});

describe('setTreeLoaded', () => {
  it('填顶层 tree + workspaceDir + 清 loading + 清顶层 stale', () => {
    const s0 = { ...initialWorkspaceState(), loading: true, stalePaths: new Set<string>(['']) };
    const tree = [dirNode('src', 'src'), fileNode('README.md')];
    const s = setTreeLoaded(s0, '/work/s1', tree);
    expect(s.workspaceDir).toBe('/work/s1');
    // ingest 时复制后排序（§4.X）：内容相等但引用已非 caller 入参（不再 .toBe(tree)）
    expect(s.tree).toEqual(tree);
    expect(s.loading).toBe(false);
    expect(s.stalePaths.has('')).toBe(false);
  });
});

describe('setChildrenLoaded / setLoadingChildren', () => {
  it('展开文件夹拉子目录：填 childrenCache[path] + 清 loading', () => {
    let s = setLoadingChildren(initialWorkspaceState(), 'src', true);
    expect(s.loadingChildren['src']).toBe(true);
    s = setChildrenLoaded(s, 'src', [fileNode('src/a.ts')]);
    expect(s.childrenCache['src']).toEqual([fileNode('src/a.ts')]);
    expect(s.loadingChildren['src']).toBe(false);
    expect(s.stalePaths.has('src')).toBe(false);
  });

  it('setLoadingChildren(false) 删 key（不是置 false）', () => {
    let s = setLoadingChildren(initialWorkspaceState(), 'src', true);
    s = setLoadingChildren(s, 'src', false);
    expect(s.loadingChildren['src']).toBeUndefined();
  });
});

describe('setTreeLoaded / setChildrenLoaded — ingest 排序（§4.X 文件排序）', () => {
  it('setTreeLoaded：乱序 tree 入参 → state.tree 按文件夹置顶 + 自然序有序', () => {
    const s0 = { ...initialWorkspaceState(), loading: true };
    // 乱序：file 100.txt 夹在中间、9.txt/100.txt 字典序倒置
    const messy = [
      fileNode('100.txt'),
      dirNode('docs', 'docs'),
      fileNode('9.txt'),
      dirNode('a9', 'a9'),
    ];
    const s = setTreeLoaded(s0, '/work', messy);
    expect(s.tree.map((n) => n.name)).toEqual(['a9', 'docs', '9.txt', '100.txt']);
  });

  it('setTreeLoaded：不突变 caller 入参（原数组引用顺序不变）', () => {
    const s0 = { ...initialWorkspaceState(), loading: true };
    const messy = [fileNode('100.txt'), fileNode('9.txt'), dirNode('a9', 'a9')];
    const messySnapshot = messy.map((n) => n.name);
    setTreeLoaded(s0, '/work', messy);
    // caller 入参顺序保持原样（未 in-place sort）
    expect(messy.map((n) => n.name)).toEqual(messySnapshot);
    expect(messy).not.toBe(setTreeLoaded(s0, '/work', messy).tree);
  });

  it('setChildrenLoaded：乱序 children 入参 → state.childrenCache[path] 有序', () => {
    const s0 = setLoadingChildren(initialWorkspaceState(), 'src', true);
    const messy = [fileNode('src/100.txt'), fileNode('src/9.txt'), dirNode('src/a9', 'a9')];
    const s = setChildrenLoaded(s0, 'src', messy);
    expect(s.childrenCache['src']!.map((n: WsTreeNode) => n.name)).toEqual([
      'a9',
      '9.txt',
      '100.txt',
    ]);
  });

  it('setChildrenLoaded：不突变 caller 入参', () => {
    const s0 = setLoadingChildren(initialWorkspaceState(), 'src', true);
    const messy = [fileNode('src/100.txt'), fileNode('src/9.txt')];
    const messySnapshot = messy.map((n) => n.name);
    setChildrenLoaded(s0, 'src', messy);
    expect(messy.map((n) => n.name)).toEqual(messySnapshot);
  });

  it('缓存命中也有序（条件②）：折叠再展开读 path 直接有序，无需重排', () => {
    // 第一次写入 childrenCache['src'] 已排序
    let s = setChildrenLoaded(initialWorkspaceState(), 'src', [
      fileNode('src/100.txt'),
      fileNode('src/9.txt'),
    ]);
    // 缓存命中：state 不变时直接读 path 即有序
    expect(s.childrenCache['src']!.map((n: WsTreeNode) => n.name)).toEqual(['9.txt', '100.txt']);
    // 重新覆盖写入也保持有序（条件③ stale 重取同 ingest）
    s = setChildrenLoaded(s, 'src', [fileNode('src/1000.txt'), fileNode('src/8.txt')]);
    expect(s.childrenCache['src']!.map((n: WsTreeNode) => n.name)).toEqual(['8.txt', '1000.txt']);
  });

  it('SSE stale 重取走同 ingest（条件③）：再次 setTreeLoaded/setChildrenLoaded 仍有序', () => {
    // 模拟 SSE file_changed → 父标 stale → 组件 effect 触发重 GET 顶层 tree → 又走 setTreeLoaded
    let s = setTreeLoaded(initialWorkspaceState(), '/work', [
      fileNode('100.txt'),
      fileNode('9.txt'),
    ]);
    expect(s.tree.map((n) => n.name)).toEqual(['9.txt', '100.txt']);
    // 标 stale（applyWorkspaceFileChanged）后重取
    s = { ...s, stalePaths: new Set<string>(['']) };
    s = setTreeLoaded(s, '/work', [fileNode('500.txt'), fileNode('8.txt'), fileNode('9.txt')]);
    // 重取后仍按同 ingest 排序
    expect(s.tree.map((n) => n.name)).toEqual(['8.txt', '9.txt', '500.txt']);
    expect(s.stalePaths.has('')).toBe(false);
  });

  it('签名零变更：setTreeLoaded(state, workspaceDir, tree) / setChildrenLoaded(state, parentPath, children) 三参', () => {
    // 显式调用形态不变（编译期保证 + 这里冒烟跑一次确认无 undefined 异常）
    const s1 = setTreeLoaded(initialWorkspaceState(), '/work', []);
    expect(s1.tree).toEqual([]);
    const s2 = setChildrenLoaded(initialWorkspaceState(), 'src', []);
    expect(s2.childrenCache['src']).toEqual([]);
  });
});

describe('toggleExpanded', () => {
  it('无 force 切换展开态', () => {
    const s0 = initialWorkspaceState();
    const s1 = toggleExpanded(s0, 'src');
    expect(s1.expanded['src']).toBe(true);
    const s2 = toggleExpanded(s1, 'src');
    expect(s2.expanded['src']).toBe(false);
  });

  it('force=true 展开 / force=false 收起', () => {
    const s0 = initialWorkspaceState();
    const s1 = toggleExpanded(s0, 'src', true);
    expect(s1.expanded['src']).toBe(true);
    const s2 = toggleExpanded(s1, 'src', false);
    expect(s2.expanded['src']).toBe(false);
  });
});

describe('resetForRefresh', () => {
  it('清 cache + stale + loadingChildren；保留 expanded（按层逐层补回）；标 loading=true', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      tree: [fileNode('a.ts')],
      childrenCache: { src: [fileNode('src/b.ts')] },
      expanded: { src: true }, // 刷新保留展开态（spec §3.3 按展开层逐层补回）
      loadingChildren: { src: true },
      stalePaths: new Set<string>(['src']),
    };
    const s = resetForRefresh(s0);
    expect(s.tree).toEqual([]);
    expect(s.childrenCache).toEqual({});
    // expanded 保留：手动刷新按展开层逐层补回（§3.3）
    expect(s.expanded).toEqual({ src: true });
    expect(s.loadingChildren).toEqual({});
    expect(s.stalePaths.size).toBe(0);
    expect(s.loading).toBe(true);
    // workspaceDir 保留（不重置，等 tree-loaded 再覆盖）
    expect(s.workspaceDir).toBe(s0.workspaceDir);
  });

  it('多层 expanded（src/ + src/utils/）刷新后 childrenCache 全清 + expanded 保留（组件逐层补回）', () => {
    // BUG-017-001 回归：手动刷新后已展开 src/ 下子节点 DOM 全部消失
    // 原因：reducer 正确保留 expanded，但组件层没按 expanded 逐层 GET 补回 childrenCache
    // 此测覆盖 reducer 侧：reset 后 expanded 多层全保留 + cache 全清（组件层补回另测）
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      tree: [dirNode('src', 'src'), fileNode('README.md')],
      childrenCache: {
        src: [dirNode('src/utils', 'utils'), fileNode('src/index.ts')],
        'src/utils': [fileNode('src/utils/helper.ts')],
      },
      expanded: { src: true, 'src/utils': true },
      stalePaths: new Set<string>(['src']),
    };
    const s = resetForRefresh(s0);
    // cache 全清（组件将按 expandedPathsByDepth 补回）
    expect(s.childrenCache).toEqual({});
    expect(s.tree).toEqual([]);
    // expanded 多层全保留（组件据此决定要补回哪些层）
    expect(s.expanded).toEqual({ src: true, 'src/utils': true });
    expect(s.loading).toBe(true);
  });
});

describe('expandedPathsByDepth（§3.3 逐层补回辅助）', () => {
  it('按路径深度升序排序（父先于子）', () => {
    const expanded = { src: true, 'src/utils': true, docs: true };
    expect(expandedPathsByDepth(expanded)).toEqual(['src', 'docs', 'src/utils']);
  });

  it('过滤未展开（false）+ 过滤空串（顶层占位）', () => {
    const expanded = { '': true, src: true, docs: false, 'src/a': true };
    expect(expandedPathsByDepth(expanded)).toEqual(['src', 'src/a']);
  });

  it('空 expanded → 空数组', () => {
    expect(expandedPathsByDepth({})).toEqual([]);
  });

  it('多层混合：BUG-017-001 场景（src + src/utils + src/utils/deep）按深度补回', () => {
    const expanded = { src: true, 'src/utils': true, 'src/utils/deep': true };
    expect(expandedPathsByDepth(expanded)).toEqual([
      'src',
      'src/utils',
      'src/utils/deep',
    ]);
  });
});

describe('applyWorkspaceFileChanged（watch event 局部刷新分流）', () => {
  it('父目录已展开 → 标 parent stale（组件 effect 触发 re-fetch）', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      expanded: { src: true }, // src 已展开
      childrenCache: { src: [fileNode('src/a.ts')] },
    };
    // src/login.ts 变化 → parent = 'src' 已展开 → 标 'src' stale
    const s = applyWorkspaceFileChanged(s0, fileChanged('src/login.ts'));
    expect(s.stalePaths.has('src')).toBe(true);
  });

  it('父目录未展开 → 仍标 stale（下次展开时清缓存重拉）', () => {
    const s0 = initialWorkspaceState();
    // src 未展开，src/deep/x.ts 变化 → parent='src/deep' 未展开 → 标 stale
    const s = applyWorkspaceFileChanged(s0, fileChanged('src/deep/x.ts'));
    expect(s.stalePaths.has('src/deep')).toBe(true);
  });

  it('顶层文件变化 → parent="" stale', () => {
    const s0 = initialWorkspaceState();
    const s = applyWorkspaceFileChanged(s0, fileChanged('README.md'));
    expect(s.stalePaths.has('')).toBe(true);
  });

  it('幂等：同 parent 已 stale → 不重建 Set（无谓 render）', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      stalePaths: new Set<string>(['src']),
    };
    const s = applyWorkspaceFileChanged(s0, fileChanged('src/x.ts'));
    // 返回同一 Set 引用（未新建）
    expect(s.stalePaths).toBe(s0.stalePaths);
  });

  it('空 path → 不变', () => {
    const s0 = initialWorkspaceState();
    const s = applyWorkspaceFileChanged(s0, fileChanged(''));
    expect(s).toBe(s0);
  });

  it('[v0.0.275] addDir 事件 → 父目录同时标 stalePaths + structuralStalePaths', () => {
    const s0 = initialWorkspaceState();
    // t1 里建 t2 → addDir('t1/t2') → parent='t1' → 双标
    const s = applyWorkspaceFileChanged(s0, fileChanged('t1/t2', 'addDir'));
    expect(s.stalePaths.has('t1')).toBe(true);
    expect(s.structuralStalePaths.has('t1')).toBe(true);
  });

  it('[v0.0.275] unlinkDir 事件 → 父目录同时标 stalePaths + structuralStalePaths', () => {
    const s0 = initialWorkspaceState();
    const s = applyWorkspaceFileChanged(s0, fileChanged('t1/t2', 'unlinkDir'));
    expect(s.stalePaths.has('t1')).toBe(true);
    expect(s.structuralStalePaths.has('t1')).toBe(true);
  });

  it('[v0.0.275] 顶层 addDir → 父="" 双标（root tree refetch）', () => {
    const s0 = initialWorkspaceState();
    const s = applyWorkspaceFileChanged(s0, fileChanged('t1', 'addDir'));
    expect(s.stalePaths.has('')).toBe(true);
    expect(s.structuralStalePaths.has('')).toBe(true);
  });

  it('[v0.0.275] 文件事件（add/change/unlink）→ 只标 stalePaths 不标 structural', () => {
    const s0 = initialWorkspaceState();
    for (const kind of ['add', 'change', 'unlink']) {
      const s = applyWorkspaceFileChanged(s0, fileChanged(`dir/${kind}.ts`, kind));
      expect(s.stalePaths.has('dir')).toBe(true);
      expect(s.structuralStalePaths.size).toBe(0);
    }
  });

  it('[v0.0.275] 同 parent 结构性事件去重：已标 structural → 不重复标（同 Set 引用）', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      stalePaths: new Set<string>(['t1']),
      structuralStalePaths: new Set<string>(['t1']),
    };
    const s = applyWorkspaceFileChanged(s0, fileChanged('t1/t2', 'addDir'));
    // 双标都已存在 → 返回同一 state 引用（未重建）
    expect(s).toBe(s0);
  });

  it('[v0.0.275] 文件事件已标 stale → 结构事件补标 structural（各自独立去重）', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      stalePaths: new Set<string>(['t1']),
    };
    // stale 已有 t1；addDir 补 structural
    const s = applyWorkspaceFileChanged(s0, fileChanged('t1/t2', 'addDir'));
    expect(s.stalePaths).toBe(s0.stalePaths); // stale 未重建
    expect(s.structuralStalePaths.has('t1')).toBe(true); // structural 新增
  });

  it('[v0.0.275] applyWorkspaceDirChanged 清 structuralStalePaths', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      stalePaths: new Set<string>(['src']),
      structuralStalePaths: new Set<string>(['src']),
    };
    const s = applyWorkspaceDirChanged(s0, dirChanged('/new'));
    expect(s.structuralStalePaths.size).toBe(0);
    expect(s.stalePaths.size).toBe(0);
  });

  it('[v0.0.275] resetForRefresh 清 structuralStalePaths', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      stalePaths: new Set<string>(['src']),
      structuralStalePaths: new Set<string>(['src']),
    };
    const s = resetForRefresh(s0);
    expect(s.structuralStalePaths.size).toBe(0);
    expect(s.stalePaths.size).toBe(0);
  });

  it('[v0.0.275] clearStructuralStalePaths 清空（空集 → 同引用不重建）', () => {
    const s0 = initialWorkspaceState();
    expect(clearStructuralStalePaths(s0)).toBe(s0);
    const s1: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      structuralStalePaths: new Set<string>(['src']),
    };
    const s2 = clearStructuralStalePaths(s1);
    expect(s2.structuralStalePaths.size).toBe(0);
    expect(s2).not.toBe(s1);
  });
});

describe('applyWorkspaceDirChanged（切目录清 cache）', () => {
  it('更新 workspaceDir + 清 tree/cache/expanded/stale + loading=true', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      workspaceDir: '/old',
      tree: [fileNode('a.ts')],
      childrenCache: { src: [fileNode('src/b.ts')] },
      expanded: { src: true },
      stalePaths: new Set<string>(['src']),
    };
    const s = applyWorkspaceDirChanged(s0, dirChanged('/new'));
    expect(s.workspaceDir).toBe('/new');
    expect(s.tree).toEqual([]);
    expect(s.childrenCache).toEqual({});
    expect(s.expanded).toEqual({});
    expect(s.stalePaths.size).toBe(0);
    expect(s.loading).toBe(true);
  });

  it('缺 data.workspaceDir → 保留原值兜底', () => {
    const s0: ReturnType<typeof initialWorkspaceState> = {
      ...initialWorkspaceState(),
      workspaceDir: '/keep',
    };
    const evt = {
      type: 'session_workspace_dir_changed' as const,
      sessionId: 'S1',
      createdAt: '',
      data: { workspaceDir: '', prevDir: '' },
    };
    const s = applyWorkspaceDirChanged(s0, evt);
    // 空字符串落到 ?? 的兜底分支：data.workspaceDir 为 ''（falsy）→ 保留 state.workspaceDir
    expect(s.workspaceDir).toBe('/keep');
  });
});
