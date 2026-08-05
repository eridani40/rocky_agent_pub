/**
 * WorkspaceWatchRegistry —— 懒监听 tab 目录集 + 目录引用计数的纯内存记账层（v0.0.139 新建）
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md §3/§5/§6/§12（拆分注）
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1 registry 行
 *
 * 职责：只记账，**零 chokidar / IO 依赖**（可直接 UT，不涉及真实文件系统）。
 *   - tabDirs：`${sessionId}:${clientId}` → 该 tab 展开/持有的目录集合（Set，天然幂等去重）。
 *   - dirRefcount：sessionId → (absDir → 持有该目录的 tab 数)。多 tab 展开同一目录只需
 *     1 个物理 watcher，refcount 归零时物理 watcher 才该被 close（由调用方 manager 决策）。
 *
 * 记账与物理 watcher 解耦（MANDATORY，红线④⑤）：本类不建/不关任何 chokidar watcher，
 * 只回答「是否需要建（首引用）/ 是否需要关（归零）」，实际建关由 workspace-dir-watcher.ts
 * 的工厂函数执行，编排顺序由 session-workspace-manager.ts（Task2）决定。
 */

/** 目录引用计数快照（诊断/getStatus 组装用） */
export interface SessionDirRef {
  absDir: string;
  refcount: number;
}

/** 一个 tab 的目录集快照（recycleSession 编排用） */
export interface TabDirsEntry {
  clientId: string;
  dirs: string[];
}

export class WorkspaceWatchRegistry {
  /** tabKey(`${sid}:${clientId}`) → 该 tab 持有的目录集（Set 天然幂等） */
  private readonly tabDirs = new Map<string, Set<string>>();
  /** sessionId → (absDir → refcount) */
  private readonly dirRefcount = new Map<string, Map<string, number>>();

  private tabKey(sessionId: string, clientId: string): string {
    return `${sessionId}:${clientId}`;
  }

  /** 该 tab 是否已持有 absDir（供 watch() 编排层判断是否需要 refInc）。 */
  hasTabDir(sessionId: string, clientId: string, absDir: string): boolean {
    return this.tabDirs.get(this.tabKey(sessionId, clientId))?.has(absDir) ?? false;
  }

  /**
   * 登记 tab 持有 absDir（Set.add 天然幂等，重复调用不叠加）。
   * @returns 是否为新增持有（此前未持有）——true 时 caller 才需要 refInc。
   */
  addTabDir(sessionId: string, clientId: string, absDir: string): boolean {
    const key = this.tabKey(sessionId, clientId);
    let set = this.tabDirs.get(key);
    if (!set) {
      set = new Set();
      this.tabDirs.set(key, set);
    }
    if (set.has(absDir)) return false;
    set.add(absDir);
    return true;
  }

  /**
   * 注销 tab 对 absDir 的持有；未持有时静默 no-op（幂等）。
   * @returns 是否实际移除——true 时 caller 才需要 refDec。
   */
  removeTabDir(sessionId: string, clientId: string, absDir: string): boolean {
    const key = this.tabKey(sessionId, clientId);
    const set = this.tabDirs.get(key);
    if (!set || !set.has(absDir)) return false;
    set.delete(absDir);
    if (set.size === 0) this.tabDirs.delete(key);
    return true;
  }

  /**
   * 取出并清除该 tab 名下全部目录（releaseTab 编排用）。无记录 → 返回空数组（幂等 no-op）。
   */
  takeTabDirs(sessionId: string, clientId: string): string[] {
    const key = this.tabKey(sessionId, clientId);
    const set = this.tabDirs.get(key);
    if (!set) return [];
    this.tabDirs.delete(key);
    return Array.from(set);
  }

  /**
   * 取出并清除该 session 名下全部 tab（clientId → 目录集），recycleSession 编排用。
   * 幂等：无任何 tab → 返回空数组。
   */
  takeSessionTabs(sessionId: string): TabDirsEntry[] {
    const prefix = `${sessionId}:`;
    const result: TabDirsEntry[] = [];
    for (const key of Array.from(this.tabDirs.keys())) {
      if (!key.startsWith(prefix)) continue;
      const clientId = key.slice(prefix.length);
      const set = this.tabDirs.get(key);
      if (!set) continue;
      result.push({ clientId, dirs: Array.from(set) });
      this.tabDirs.delete(key);
    }
    return result;
  }

  /**
   * 目录引用计数 +1（该 sid 下 absDir 的持有 tab 数）。
   * @returns 是否为首引用（0→1）——true 时 caller 需 openDirWatcher 建物理 watcher。
   */
  refInc(sessionId: string, absDir: string): boolean {
    let m = this.dirRefcount.get(sessionId);
    if (!m) {
      m = new Map();
      this.dirRefcount.set(sessionId, m);
    }
    const cur = m.get(absDir) ?? 0;
    m.set(absDir, cur + 1);
    return cur === 0;
  }

  /**
   * 目录引用计数 -1。已是 0 / 不存在 → 静默 no-op 返回 false（幂等，防止误减为负数）。
   * @returns 是否归零（→0）——true 时 caller 需 closeDirWatcher 关物理 watcher。
   */
  refDec(sessionId: string, absDir: string): boolean {
    const m = this.dirRefcount.get(sessionId);
    if (!m) return false;
    const cur = m.get(absDir) ?? 0;
    if (cur <= 0) return false;
    const next = cur - 1;
    if (next === 0) {
      m.delete(absDir);
      if (m.size === 0) this.dirRefcount.delete(sessionId);
      return true;
    }
    m.set(absDir, next);
    return false;
  }

  /** 该 session 当前所有 refcount>0 的目录快照（getStatus 组装用）。 */
  listSessionDirs(sessionId: string): SessionDirRef[] {
    const m = this.dirRefcount.get(sessionId);
    if (!m) return [];
    return Array.from(m.entries()).map(([absDir, refcount]) => ({ absDir, refcount }));
  }

  /** 当前所有持有 refcount 记录的 sessionId（stopAll/getStatus 全量遍历用）。 */
  listSessions(): string[] {
    return Array.from(this.dirRefcount.keys());
  }

  /** 清空全部记账（stopAll 用；物理 watcher 关闭由调用方另行处理）。 */
  clear(): void {
    this.tabDirs.clear();
    this.dirRefcount.clear();
  }
}
