/**
 * session-children-index —— parent→[childSid] 正向索引（v0.0.30）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §7（list_children）
 *       specs/tech/agent/session/[P0]session_store.md（children 索引）
 *
 * 背景：subagent 无限膨胀，session-store.listChildren 之前取 listSessions 全量 + 内存筛
 * parentSessionId === id（O(N)，N=所有 session）。每个 main agent 的 GET /children + children
 * tree 刷新轮询都走它，session 数量大时全量扫描越来越慢。
 *
 * 方案：内存正向索引 Map<parentSid, Set<childSid>>。lazy 建（首次 listChildren 扫一次全量），
 * 之后 createSession/deleteSession 增量维护。listChildren 查索引 → O(children)。
 *
 * 一致性：parentSessionId 创建后不可变（session record 无改 parent 的路径），故只需在
 * create/delete 维护；启动后首次访问 build 一次（覆盖历史 + 任何绕过路径）。
 *
 * 不级联删 children：deleteSession(parent) 只清 parent 自己的 set，children record 仍存
 * （parentSessionId 悬空成孤儿，listChildren 查已删 parent 返空）——与既有行为一致，不在本索引职责内。
 */
export interface ChildRef {
  id: string;
  parentSessionId?: string;
}

export class ChildrenIndex {
  private idx: Map<string, Set<string>> | null = null;

  /** 索引是否已建（首次 listChildren 后 true） */
  get isReady(): boolean {
    return this.idx !== null;
  }

  /**
   * 从全量 records 首次建索引（lazy）。已建则忽略（幂等）。
   * 调用方：session-store.listChildren 首次访问时 crud.query 全量传入。
   */
  build(records: Iterable<ChildRef>): void {
    if (this.idx) return;
    const m = new Map<string, Set<string>>();
    for (const r of records) {
      if (r.parentSessionId) addTo(m, r.parentSessionId, r.id);
    }
    this.idx = m;
  }

  /** 取 parent 的 children id 集合（未建索引或无 children 返 undefined）。 */
  get(parent: string): Set<string> | undefined {
    return this.idx?.get(parent);
  }

  /** createSession 后调：child 挂到 parent 的 set（索引已建才维护，未建则首次 build 覆盖）。 */
  onCreated(parentSessionId: string | undefined, childId: string): void {
    if (!this.idx || !parentSessionId) return;
    addTo(this.idx, parentSessionId, childId);
  }

  /**
   * deleteSession 后调：删的是 child → 从 parent 的 set 移除；删的是 parent → 清自己的 set
   * （children 变孤儿，不级联删，同既有行为）。
   */
  onDeleted(sessionId: string, parentSessionId: string | undefined): void {
    if (!this.idx) return;
    if (parentSessionId) this.idx.get(parentSessionId)?.delete(sessionId);
    this.idx.delete(sessionId);
  }

  /** 测试/重置用（清空，下次 build 重建） */
  resetForTest(): void {
    this.idx = null;
  }

  /**
   * BFS 收集 parent 的全部子孙 id（任意深度，不含 parent 自身）。
   *
   * 级联删用：删 parent 前一次性快照全部子孙（caller 随后逐个 deleteSession）。
   * 纯索引操作（不读 crud / 不做 I/O）；visited Set 去环防重（理论 parentSessionId 无环，防御）。
   *
   * 必须在任何 deleteSession 之前调用（onDeleted 会清 parent 自己的 child set，
   * 删后再查会漏子孙——时序约束，级联删 caller 负责遵守）。
   *
   * @returns 子孙 id 数组；索引未建（idx==null）或无 children 返 []
   */
  collectDescendants(parent: string): string[] {
    if (!this.idx) return [];
    const out: string[] = [];
    const visited = new Set<string>([parent]);
    const queue: string[] = [parent];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      const children = this.idx.get(cur);
      if (!children) continue;
      for (const cid of children) {
        if (visited.has(cid)) continue;
        visited.add(cid);
        out.push(cid);
        queue.push(cid);
      }
    }
    return out;
  }
}

function addTo(m: Map<string, Set<string>>, parent: string, child: string): void {
  let set = m.get(parent);
  if (!set) {
    set = new Set();
    m.set(parent, set);
  }
  set.add(child);
}
