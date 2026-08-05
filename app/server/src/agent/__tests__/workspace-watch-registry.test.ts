/**
 * WorkspaceWatchRegistry 单元测试 —— 纯内存记账（无 chokidar/IO）
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md §5/§6
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1/模块5 registry 行
 *
 * 覆盖：addTabDir 幂等 / removeTabDir no-op / takeTabDirs·takeSessionTabs 取出并清除 /
 *   refInc 首引用判定 / refDec 归零判定 / 多 tab 引用计数合并 / release-all 清空。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceWatchRegistry } from '../workspace-watch-registry';

let registry: WorkspaceWatchRegistry;

beforeEach(() => {
  registry = new WorkspaceWatchRegistry();
});

describe('WorkspaceWatchRegistry — tabDirs 幂等（addTabDir/removeTabDir/hasTabDir）', () => {
  it('addTabDir 首次登记返回 true，重复登记同目录返回 false（Set 去重不叠加）', () => {
    expect(registry.addTabDir('s1', 'c1', '/ws/src')).toBe(true);
    expect(registry.addTabDir('s1', 'c1', '/ws/src')).toBe(false);
    expect(registry.hasTabDir('s1', 'c1', '/ws/src')).toBe(true);
  });

  it('addTabDir 不同目录各自独立登记', () => {
    expect(registry.addTabDir('s1', 'c1', '/ws/a')).toBe(true);
    expect(registry.addTabDir('s1', 'c1', '/ws/b')).toBe(true);
    expect(registry.hasTabDir('s1', 'c1', '/ws/a')).toBe(true);
    expect(registry.hasTabDir('s1', 'c1', '/ws/b')).toBe(true);
  });

  it('removeTabDir 未持有的目录 → 静默 no-op 返回 false（不抛错）', () => {
    expect(registry.removeTabDir('s1', 'c1', '/ws/notyet')).toBe(false);
  });

  it('removeTabDir 已持有目录 → 返回 true 并移除；重复 remove 幂等返回 false', () => {
    registry.addTabDir('s1', 'c1', '/ws/src');
    expect(registry.removeTabDir('s1', 'c1', '/ws/src')).toBe(true);
    expect(registry.hasTabDir('s1', 'c1', '/ws/src')).toBe(false);
    expect(registry.removeTabDir('s1', 'c1', '/ws/src')).toBe(false);
  });

  it('不同 (sid,clientId) 记账相互隔离（tabKey 不串）', () => {
    registry.addTabDir('s1', 'c1', '/ws/a');
    expect(registry.hasTabDir('s1', 'c2', '/ws/a')).toBe(false);
    expect(registry.hasTabDir('s2', 'c1', '/ws/a')).toBe(false);
  });
});

describe('WorkspaceWatchRegistry — takeTabDirs / takeSessionTabs 取出并清除', () => {
  it('takeTabDirs 返回该 tab 全部目录并清空登记；无记录返回空数组（幂等）', () => {
    registry.addTabDir('s1', 'c1', '/ws/a');
    registry.addTabDir('s1', 'c1', '/ws/b');
    const dirs = registry.takeTabDirs('s1', 'c1').sort();
    expect(dirs).toEqual(['/ws/a', '/ws/b']);
    expect(registry.hasTabDir('s1', 'c1', '/ws/a')).toBe(false);
    expect(registry.takeTabDirs('s1', 'c1')).toEqual([]);
  });

  it('takeSessionTabs 取出该 session 名下全部 tab（多 clientId）并清空；无记录返回空数组', () => {
    registry.addTabDir('s1', 'c1', '/ws/a');
    registry.addTabDir('s1', 'c2', '/ws/b');
    registry.addTabDir('s2', 'c3', '/ws/c'); // 另一 session，不应被带出

    const entries = registry.takeSessionTabs('s1').sort((x, y) => x.clientId.localeCompare(y.clientId));
    expect(entries).toEqual([
      { clientId: 'c1', dirs: ['/ws/a'] },
      { clientId: 'c2', dirs: ['/ws/b'] },
    ]);
    // 已清空 s1 名下所有 tab
    expect(registry.hasTabDir('s1', 'c1', '/ws/a')).toBe(false);
    expect(registry.hasTabDir('s1', 'c2', '/ws/b')).toBe(false);
    expect(registry.takeSessionTabs('s1')).toEqual([]);
    // s2 的记账不受影响
    expect(registry.hasTabDir('s2', 'c3', '/ws/c')).toBe(true);
  });
});

describe('WorkspaceWatchRegistry — refInc/refDec 引用计数（红线④⑤）', () => {
  it('refInc 首次调用（0→1）返回 true；再次调用（1→2）返回 false', () => {
    expect(registry.refInc('s1', '/ws/a')).toBe(true);
    expect(registry.refInc('s1', '/ws/a')).toBe(false);
    expect(registry.refInc('s1', '/ws/a')).toBe(false);
    expect(registry.listSessionDirs('s1')).toEqual([{ absDir: '/ws/a', refcount: 3 }]);
  });

  it('refDec 归零（1→0）返回 true；未归零（N→N-1，N>1）返回 false', () => {
    registry.refInc('s1', '/ws/a');
    registry.refInc('s1', '/ws/a'); // refcount=2
    expect(registry.refDec('s1', '/ws/a')).toBe(false); // 2→1
    expect(registry.refDec('s1', '/ws/a')).toBe(true); // 1→0
    expect(registry.listSessionDirs('s1')).toEqual([]);
  });

  it('refDec 对不存在的 (sid,absDir) → 静默 no-op 返回 false（防误减负数）', () => {
    expect(registry.refDec('nope', '/ws/x')).toBe(false);
    registry.refInc('s1', '/ws/a');
    registry.refDec('s1', '/ws/a'); // 归零
    expect(registry.refDec('s1', '/ws/a')).toBe(false); // 再减一次仍安全
  });

  it('多 tab 同目录引用计数合并（2 tab 展开同目录 → refcount=2，关一个不归零，全关才归零）', () => {
    // 模拟 manager 编排：tab c1、c2 各自 watch 同一 absDir
    expect(registry.addTabDir('s1', 'c1', '/ws/src')).toBe(true);
    expect(registry.refInc('s1', '/ws/src')).toBe(true); // 首引用建 watcher
    expect(registry.addTabDir('s1', 'c2', '/ws/src')).toBe(true);
    expect(registry.refInc('s1', '/ws/src')).toBe(false); // 已有 watcher，仅计数

    // c1 收起：removeTabDir true → refDec
    expect(registry.removeTabDir('s1', 'c1', '/ws/src')).toBe(true);
    expect(registry.refDec('s1', '/ws/src')).toBe(false); // 未归零（c2 仍持有）

    // c2 收起：refDec 归零 → 该关物理 watcher 了
    expect(registry.removeTabDir('s1', 'c2', '/ws/src')).toBe(true);
    expect(registry.refDec('s1', '/ws/src')).toBe(true);
    expect(registry.listSessionDirs('s1')).toEqual([]);
  });

  it('sessionId 隔离：不同 session 的同名 absDir 引用计数互不影响', () => {
    registry.refInc('s1', '/ws/shared');
    registry.refInc('s2', '/ws/shared');
    expect(registry.listSessionDirs('s1')).toEqual([{ absDir: '/ws/shared', refcount: 1 }]);
    expect(registry.listSessionDirs('s2')).toEqual([{ absDir: '/ws/shared', refcount: 1 }]);
    registry.refDec('s1', '/ws/shared');
    expect(registry.listSessionDirs('s1')).toEqual([]);
    expect(registry.listSessionDirs('s2')).toEqual([{ absDir: '/ws/shared', refcount: 1 }]);
  });
});

describe('WorkspaceWatchRegistry — listSessions / clear（release-all / stopAll 支撑）', () => {
  it('listSessions 返回当前持有 refcount 记录的全部 sessionId', () => {
    registry.refInc('s1', '/ws/a');
    registry.refInc('s2', '/ws/b');
    expect(registry.listSessions().sort()).toEqual(['s1', 's2']);
  });

  it('clear 清空全部 tabDirs + dirRefcount 记账（release-all 场景）', () => {
    registry.addTabDir('s1', 'c1', '/ws/a');
    registry.refInc('s1', '/ws/a');
    registry.addTabDir('s2', 'c2', '/ws/b');
    registry.refInc('s2', '/ws/b');

    registry.clear();

    expect(registry.hasTabDir('s1', 'c1', '/ws/a')).toBe(false);
    expect(registry.listSessions()).toEqual([]);
    expect(registry.listSessionDirs('s1')).toEqual([]);
    expect(registry.takeSessionTabs('s1')).toEqual([]);
  });
});
