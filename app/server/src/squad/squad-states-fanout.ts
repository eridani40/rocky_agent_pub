/**
 * squad-states-fanout — squad 状态变化 reminder queue 扇出（v0.0.361 T4）。
 * 参考: specs/tech/version_logs/v0.0.361/change_plan.md §1.5（调用点表 + fan-out helper 契约）
 *       specs/tech/version_logs/v0.0.361/change_plan.md §2（样例 B/C：value 渲染原文）
 *
 * 定位（§1.5）：`fanoutStates(squadId, key, value)` 读 squad 直连 session 集合
 * （members[].sessionId + squadChatSessionId，squad-aggregate-service 同款口径）→ 逐 session
 * queue write；task 变化走 audience 过滤（leader ∪ owner ∪ dependencies[].owner——写侧过滤，
 * mate 不收不相关 task 噪声，对齐 squad_task provider 的 viewer filter 语义）。
 *
 * 失败语义：逐 session 隔离（单 session 写失败不影响其余）+ 整体静默（reminder 是
 * best-effort 通知，绝不阻断业务写入方的主路径）。
 *
 * queue 实例：per-call new（ReminderQueueStore.write 临界区为纯同步 JS——
 * readJsonFileSync + atomicWriteSync 无 await，事件循环天然串行，多实例并发写不交错）。
 */
import { ReminderQueueStore } from '../agent/system-reminder-queue';
import { SquadStore, MemberStore } from '../stores/squad-store';
import { TASK_ENTITY_DEF } from './panorama/builtin/task-schema';
import { parseDeps } from './panorama/builtin/task-hooks';

/** fanout 依赖（fsRoot = DATA_DIR 绝对路径；queue/squad/member 落盘根） */
export interface FanoutOpts {
  fsRoot: string;
}

/** task 实例最小形状（panorama store / http 两入口透传；owner/dependencies 软解析） */
export interface TaskLike {
  id: string;
  title?: string;
  owner?: string;
  dependencies?: string;
}

/** task 依赖解析用 store 鸭子类型（PanoramaEntityStore / http store 均满足） */
interface TaskDepResolver {
  getInstance(entity: string, id: string): Record<string, unknown> | undefined | null;
}

/**
 * fanout reminder 行到 squad 全员 + squadChat（§1.5 helper 契约）。
 * 逐 session 失败隔离；squad 不存在 / 整体异常 → 静默 no-op。
 */
export async function fanoutStates(squadId: string, key: string, value: string, opts: FanoutOpts): Promise<void> {
  try {
    const sids = await resolveDirectSessionIds(squadId, opts.fsRoot);
    const queue = new ReminderQueueStore({ fsRoot: opts.fsRoot });
    await Promise.all(
      [...sids].map((sid) => queue.write(sid, key, value).catch(() => { /* 逐 session 隔离 */ })),
    );
  } catch { /* reminder fanout 失败静默（best-effort 通知） */ }
}

/**
 * member 运行态变化通知（state-machine markX 调）：解析 member name → 渲染
 * `[squad:agents] {member} → {state}`（§2 样例 C）→ fanout 全员。
 */
export async function notifyMemberState(deps: {
  fsRoot: string;
  squadId: string;
  sessionId: string;
  state: string;
}): Promise<void> {
  try {
    const memberStore = new MemberStore({ root: deps.fsRoot });
    const members = await memberStore.listMembers(deps.squadId);
    const name = members.find((m) => m.sessionId === deps.sessionId)?.name ?? deps.sessionId;
    const value = `[squad:agents] ${name} → ${deps.state}`;
    await fanoutStates(deps.squadId, `member_state:${deps.sessionId}`, value, { fsRoot: deps.fsRoot });
  } catch { /* 静默 */ }
}

/**
 * task transition 通知（panorama tool + http 两入口同调，§1.5「不重复实现」）：
 *   - value：`[task] {id}「{title}」→ {中文状态}（owner: {ownerName}）`（§2 样例 B）
 *   - audience：leader ∪ task.owner ∪ dependencies[].owner（写侧过滤，不含 squadChat）
 * inst 接 panorama 原始 record（tool/http 两入口直接透传，内部窄化 TaskLike）。
 */
export async function notifyTaskTransition(
  deps: { fsRoot: string; squadId: string; store: TaskDepResolver },
  instRaw: Record<string, unknown>,
  to: string,
): Promise<void> {
  try {
    const inst: TaskLike = {
      id: String(instRaw.id ?? ''),
      title: typeof instRaw.title === 'string' ? instRaw.title : undefined,
      owner: typeof instRaw.owner === 'string' ? instRaw.owner : undefined,
      dependencies: typeof instRaw.dependencies === 'string' ? instRaw.dependencies : undefined,
    };
    const squadStore = new SquadStore({ root: deps.fsRoot });
    const memberStore = new MemberStore({ root: deps.fsRoot });
    const squad = await squadStore.getSquad(deps.squadId);
    if (!squad) return;
    const members = await memberStore.listMembers(deps.squadId);
    const byId = new Map(members.map((m) => [String(m.id), m]));

    // audience 收集：leader + task.owner + 依赖 task 的 owner
    const audience = new Set<string>([squad.leaderId]);
    if (inst.owner) audience.add(inst.owner);
    for (const depId of parseDeps(inst.dependencies)) {
      const dep = deps.store.getInstance('task', depId);
      const depOwner = dep?.owner;
      if (typeof depOwner === 'string' && depOwner) audience.add(depOwner);
    }

    // value 渲染（label 配死中文，task-schema display.status_labels 权威）
    const label = TASK_ENTITY_DEF.display?.status_labels?.[to] ?? to;
    const ownerName = (inst.owner && byId.get(inst.owner)?.name) || inst.owner || '—';
    const value = `[task] ${inst.id}「${inst.title ?? ''}」→ ${label}（owner: ${ownerName}）`;
    const key = `task:${inst.id}`;

    const queue = new ReminderQueueStore({ fsRoot: deps.fsRoot });
    await Promise.all(
      [...audience].flatMap((mid) => {
        const sid = byId.get(mid)?.sessionId;
        return sid ? [queue.write(sid, key, value).catch(() => { /* 逐 session 隔离 */ })] : [];
      }),
    );
  } catch { /* 静默 */ }
}

/** 读 squad 直连 session 集合（squadChat + members[].sessionId；aggregate-service seats 口径） */
async function resolveDirectSessionIds(squadId: string, fsRoot: string): Promise<Set<string>> {
  const squadStore = new SquadStore({ root: fsRoot });
  const memberStore = new MemberStore({ root: fsRoot });
  const squad = await squadStore.getSquad(squadId);
  if (!squad) return new Set();
  const members = await memberStore.listMembers(squadId);
  const sids = new Set<string>([squad.squadChatSessionId]);
  for (const m of members) {
    if (m.sessionId) sids.add(m.sessionId);
  }
  return sids;
}
