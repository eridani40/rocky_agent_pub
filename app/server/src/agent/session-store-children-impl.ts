/**
 * session-store-children-impl — SessionStore 的 listChildren 方法实现
 *
 * 纯 move 自 session-store.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，
 * 签名 + 内部逻辑不变。class 内方法改为单行委托到本文件 standalone 函数。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.4-4.5 + INV-S-2
 *
 * INV-S-2：listChildren 分组语义（running/terminated 按 updatedAt desc）+ childrenIndex
 *   增量维护（O(N)→O(children) 性能）等价保留
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；store 作入参。
 */
import { SessionSchema } from './schema_defs';
import type { SessionRecord } from './schema_defs';
import type { SessionStore } from './session-store';
import { toSession } from './session-store-converters';
import type {
  Session, ChildSummary, ChildrenView, ListChildrenFilter,
} from './session-store-types';

/**
 * childrenIndex lazy warm — 未建则 crud.query 全量 build（listChildren / collectDescendants 共用）。
 * build 后 isReady=true，后续 createSession/deleteSession 增量维护。
 */
function warmChildrenIndex(store: SessionStore): void {
  if (store.childrenIndex.isReady) return;
  store.childrenIndex.build(
    store.crud.query(SessionSchema, {}).map((r) => {
      const rec = r as SessionRecord & { parentSessionId?: string };
      return { id: rec.id, parentSessionId: rec.parentSessionId };
    }),
  );
}

/**
 * 列出 sessionId 派生的 children（subagent），按 state 分 running/terminated 两组，
 * 组内按 updatedAt desc + limit 截断（api 10-multi-agent §3 / derivation §7）。
 *
 * 实现：childrenIndex 正向索引查 children（O(children)）。
 * running 组含 state='running'/'interrupting'；terminated 组含 idle/error/interrupted。
 * status filter 指定时未请求组返 []；limit 截断（缺省 20）。
 *
 * @param store   SessionStore 实例
 * @param id      parent sessionId
 * @param filter  筛选/限量（status/templateType/limit）；缺省两组都返、limit 20
 * @returns ChildrenView（running/terminated 分组）；parent 不存在仍返空（caller 决定 404）
 */
export async function sessionStoreListChildren(
  store: SessionStore,
  id: string,
  filter?: ListChildrenFilter,
): Promise<ChildrenView> {
  const status = filter?.status;
  const templateType = filter?.templateType;
  const limit = typeof filter?.limit === 'number' && filter.limit > 0 ? filter.limit : 20;

  warmChildrenIndex(store);
  const childIds = store.childrenIndex.get(id);
  if (!childIds || childIds.size === 0) {
    return { parentSessionId: id, running: [], terminated: [] };
  }
  let children = [...childIds]
    .flatMap((cid) => {
      const r = store.crud.get(SessionSchema, cid);
      return r ? [r] : [];
    })
    .map(toSession);
  if (templateType !== undefined) {
    children = children.filter(
      (s) => (s.subAgentTemplateType ?? null) === templateType,
    );
  }

  // 转 ChildSummary
  const summaries: ChildSummary[] = children.map((s) => ({
    sessionId: s.id,
    name: s.subAgentTemplateType ?? 'subagent',
    state: s.state,
    subAgentTemplateType: s.subAgentTemplateType ?? null,
    updatedAt: s.updatedAt,
  }));

  // 分组：running={running,interrupting}；terminated={idle,error,interrupted}
  const groupOf = (st: Session['state']): 'running' | 'terminated' =>
    st === 'running' || st === 'interrupting' ? 'running' : 'terminated';
  const sortByUpdatedDesc = (a: ChildSummary, b: ChildSummary) =>
    b.updatedAt.localeCompare(a.updatedAt);

  const running = status === 'terminated' ? [] : summaries
    .filter((c) => groupOf(c.state) === 'running')
    .sort(sortByUpdatedDesc)
    .slice(0, limit);
  const terminated = status === 'running' ? [] : summaries
    .filter((c) => groupOf(c.state) === 'terminated')
    .sort(sortByUpdatedDesc)
    .slice(0, limit);

  return { parentSessionId: id, running, terminated };
}

/**
 * 收集 parent session 的全部子孙 id（任意深度，BFS 基于 childrenIndex）。
 *
 * 级联删用（DELETE /session/:id + dissolveSquad）：删 parent 前先快照子孙，
 * 逐个 deleteSession（每个触发 onSessionDestroyed → 清内存 cron，堵潜伏调度）。
 *
 * @returns 子孙 id 数组（不含 parent 自身）；空数组合法（无 children）
 */
export async function sessionStoreCollectDescendants(
  store: SessionStore,
  parentId: string,
): Promise<string[]> {
  warmChildrenIndex(store);
  return store.childrenIndex.collectDescendants(parentId);
}

/**
 * 按 squadId 平铺查全量 session（解散时一次性 catch 全部 squad session，含 spawn children）。
 *
 * 直接扫 SessionRecord.squadId 字段（v0.0.33.2 起随 spawn 一致写入，agent-tool.ts:318）。
 * O(N) 扫描可接受（解散一次性低频操作）。
 *
 * MUST 在删任何 session 前调用（删后 listSessions 不返，孤儿也兜住）。
 *
 * @returns sessionId 列表（squadId 命中者）
 */
export async function sessionStoreListSessionsBySquad(
  store: SessionStore,
  squadId: string,
): Promise<string[]> {
  const all = store.crud.query(SessionSchema, {});
  return all
    .filter((r) => (r as SessionRecord).squadId === squadId)
    .map((r) => r.id as string);
}
