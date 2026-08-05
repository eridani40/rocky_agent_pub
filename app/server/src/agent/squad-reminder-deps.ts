/**
 * squad reminder provider 依赖工厂（v0.0.33.3 从 context-engine.ts 拆出，≤300 行约束）
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md §1（ReminderCtx 扩展 + squadContext/transcriptReader）
 *       reqs/v0.0.33.3/req7 §4（去重 + 10 条兜底）+ req8 §3（动态归 reminder）
 *
 * 职责：
 *   - 定义 SquadReminderDeps（store 句柄集合，bootstrap 注入）
 *   - makeSquadContextService：把 SquadReminderDeps 包装成 SquadContextService（provider 读数据用）
 *   - makeTranscriptReader：把预 load 的 transcript 包装成 TranscriptReader（provider 去重用）
 *   - buildReminderExtras：构造 reminder provider 的 squadContext + transcriptReader（v0.0.33.3 T4 从 context-engine 移出）
 *
 * 拆出动机：context-engine.ts 超 300 行硬限；本文件为纯工具（无 ContextEngine 依赖）。
 */
import type { SessionStore } from './session-store';
import type { SessionConfig } from './context-types';
import { PanoramaEntityStore } from '../squad/panorama/store/panorama_store';
import { parseDeps } from '../squad/panorama/builtin/task-hooks';

/**
 * squad reminder provider 的 store 句柄集合（bootstrap 注入）。
 * 与 SquadStore/MemberStore 同名方法鸭子类型兼容（生产注入 store 实例）。
 */
export interface SquadReminderDeps {
  /** SquadStore 句柄（getSquad，留给未来扩展用） */
  squadStore: {
    getSquad(squadId: string): Promise<unknown> | unknown;
  };
  /** MemberStore 句柄（listMembers，roster + team-status provider 用） */
  memberStore: {
    listMembers(squadId: string): Promise<unknown[]> | unknown[];
  };
  /**
   * [v0.0.116] session running 状态查询（squad_team_status provider 用）。
   * 口径：session.state==='running'（与 isSessionBusy 同 SessionStore 句柄）。
   */
  isSessionRunning(sessionId: string): Promise<boolean>;
  /**
   * panorama data_dir 根（squad_task provider 读 PanoramaEntityStore 用）.
   * 路径展开由 boot.ts 注入时确定（=config.dataDir，已绝对路径）.
   */
  panoramaDataDir: string;
}

/**
 * task 实例子集（squad_task reminder provider 产出格式用）.
 * 由 PanoramaEntityStore.listInstances('task') 读出后筛选字段.
 * owner=null 显「未指派」；archived 永远 false（service 层已过滤）.
 */
export interface TaskLike {
  id: string;
  title: string;
  owner: string | null;
  dependencies: string[];
  status: string;
  archived: boolean;
}

/**
 * squadContext service 形态（与 rocky_context/types.ts SquadContextService 鸭子类型兼容）。
 * 提供给 squad reminder provider 读 store 动态数据。
 */
export interface SquadContextService {
  getSquad(squadId: string): Promise<unknown>;
  listMembers(squadId: string): Promise<unknown[]>;
  /**
   * [v0.0.116] session running 状态查询（squad_team_status provider 用）。
   * 口径：session.state==='running'（bootstrap 注入）。
   */
  isSessionRunning(sessionId: string): Promise<boolean>;
  /**
   * 列活跃 task（squad_task provider 用，panorama_builtin §5）.
   * leader（viewerMemberId=null）→ 全队活跃；mate → owner∪我 block 别人的.
   * 永远不返 archived=true 的 task（service 层已过滤）.
   */
  listActiveTasks(squadId: string, viewerMemberId: string | null): Promise<TaskLike[]>;
}

/**
 * TranscriptReader 形态（与 rocky_context/types.ts TranscriptReader 鸭子类型兼容）。
 * 提供给 squad reminder provider 做去重（扫 transcript 找 last reminder + 算距上次条数）。
 */
export interface TranscriptReader {
  findLastReminder(prefix: string): { messageId: string; atMessageCount: number } | null;
  messageCountSince(messageId: string): number;
}

/**
 * 把 SquadReminderDeps 包装成 SquadContextService。
 * store 方法本身已是正确签名 → 直接代理；getSquad/listMembers 保持 Promise（async 透传）.
 * listActiveTasks：经 PanoramaEntityStore 直读 task 实例 + 角色 filter（panorama_builtin §5）.
 */
export function makeSquadContextService(deps: SquadReminderDeps): SquadContextService {
  return {
    getSquad: (squadId: string) => Promise.resolve(deps.squadStore.getSquad(squadId)),
    listMembers: (squadId: string) => Promise.resolve(deps.memberStore.listMembers(squadId)),
    // [v0.0.116] 透传 isSessionRunning（squad_team_status provider 用）
    isSessionRunning: (sessionId: string) => Promise.resolve(deps.isSessionRunning(sessionId)),
    // squad_task provider 数据源（panorama_builtin §5）
    listActiveTasks: (squadId: string, viewerMemberId: string | null) =>
      Promise.resolve(listActiveTasksImpl(deps, squadId, viewerMemberId)),
  };
}

/**
 * listActiveTasks 实现（panorama_builtin §5）.
 *  - 经 PanoramaEntityStore 直读（task 是 builtin 永远在，不依赖 board define）
 *  - filter archived=false（永远不返归档）
 *  - leader（viewerMemberId=null）→ 全队活跃
 *  - mate → owner==self ∪ dependencies 含 owner==self 的 task（我负责的 + 我在 block 别人的）
 */
function listActiveTasksImpl(
  deps: SquadReminderDeps,
  squadId: string,
  viewerMemberId: string | null,
): TaskLike[] {
  const store = new PanoramaEntityStore({ root: deps.panoramaDataDir, squadId });
  const all = store.listInstances('task');
  const active = all.filter((t) => t.archived !== true);
  const tasks: TaskLike[] = active.map((t) => ({
    id: typeof t.id === 'string' ? t.id : '',
    title: typeof t.title === 'string' ? t.title : '',
    owner: typeof t.owner === 'string' && t.owner.length > 0 ? t.owner : null,
    dependencies: parseDeps(t.dependencies),
    status: typeof t.status === 'string' ? t.status : '',
    archived: false,
  }));
  if (viewerMemberId === null) return tasks; // leader 全队
  // mate：owner==self ∪ 我 block 别人（某 task 的 dependencies 含 owner==self 的 task）
  const myTaskIds = new Set(tasks.filter((t) => t.owner === viewerMemberId).map((t) => t.id));
  return tasks.filter((t) =>
    t.owner === viewerMemberId ||
    t.dependencies.some((d) => myTaskIds.has(d)),
  );
}

/**
 * 把预 load 的 transcript 包装成 TranscriptReader（扫 message 找 last reminder + 算距上次条数）。
 *
 * 实现说明：
 * - transcript 形态：{ items: Message[] }（升序，500 条上限）
 * - reminder 注入形态：text block 内容以 `[system_reminder]` 标头 + 多条 `- ...`（squad/member 等条目）
 * - findLastReminder：从后往前扫，找含 prefix 的 message → 返 {messageId, atMessageCount}
 * - messageCountSince：找 messageId 在 transcript 中的位置，返其后的 message 数（不含自己）
 *
 * @param transcript 预 load 的 transcript（null → 所有方法降级，findLastReminder 返 null）
 */
export function makeTranscriptReader(
  transcript: { items: Array<{ id: string; content: Array<{ type: string; text?: string }> }> } | null,
): TranscriptReader {
  const items = transcript?.items ?? [];
  return {
    findLastReminder(prefix: string): { messageId: string; atMessageCount: number } | null {
      for (let i = items.length - 1; i >= 0; i--) {
        const m = items[i]!;
        const hit = m.content.some(
          (b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes(prefix),
        );
        if (hit) return { messageId: m.id, atMessageCount: items.length - i };
      }
      return null;
    },
    messageCountSince(messageId: string): number {
      const idx = items.findIndex((m) => m.id === messageId);
      if (idx < 0) return Number.MAX_SAFE_INTEGER; // 找不到（被 compaction 滚出）→ 兜底刷新
      return items.length - idx - 1;
    },
  };
}

/**
 * [辅助] 从 SessionStore 预 load transcript（500 条），供 makeTranscriptReader 使用。
 * 读失败 → 返 null（reader 降级返 null → 首条产出，不阻断 reminder 注入）。
 */
export async function preloadTranscript(
  store: SessionStore,
  sessionId: string,
): Promise<{ items: Array<{ id: string; content: Array<{ type: string; text?: string }> }> } | null> {
  try {
    return await store.getMessages(sessionId, { limit: 500 });
  } catch {
    return null;
  }
}

/**
 * [v0.0.33.3 T4] 构造 reminder provider 的 squadContext + transcriptReader（squad sessionType 才返非空）。
 * 由 ContextEngine.ingest 调用，按 config.sessionType/squadId/sessionId 圈定。
 * 缺省（无注入 store 句柄 / 非 squad session）→ 返空对象（provider 降级不产出）。
 *
 * **async**：transcriptReader 需预 load transcript（provider.findLastReminder 是 sync 接口），
 * 故本方法 await getMessages 一次后再构造 reader。
 *
 * v0.0.33.3 T4 从 ContextEngine 私有方法移出为模块级函数（≤300 行约束），零行为变更：
 * store + deps 由 caller 作为参数传入（不再依赖 this）。
 *
 * @param store SessionStore 句柄（预 load transcript 用）
 * @param deps squad reminder store 句柄（null → 跳过 squad provider，向后兼容）
 * @param config session context（按 sessionType/sessionId 圈定）
 * @returns { squadContext?, transcriptReader? } —— isSquadScoped 时返两者；非 squad 返 { transcriptReader }；deps 为 null 返 {}
 */
export async function buildReminderExtras(
  store: SessionStore,
  deps: SquadReminderDeps | null,
  config: SessionConfig,
): Promise<{ squadContext?: unknown; transcriptReader?: unknown }> {
  // [v0.0.56] kind.role 替代旧 sessionType
  const sessionType = config.kind?.role;
  const isSquadScoped = sessionType === 'leader' || sessionType === 'mate' || sessionType === 'squad';
  // 仅 squad session + 注入了 deps 才构造（其余场景返空 → 跳过 squad provider）
  if (!deps) return {};
  // 预 load transcript（500 条）→ 喂给 transcriptReader（sync 扫描）
  const transcript = await preloadTranscript(store, config.sessionId);
  const transcriptReader = makeTranscriptReader(transcript);
  if (!isSquadScoped) return { transcriptReader };
  const squadContext = makeSquadContextService(deps);
  return { squadContext, transcriptReader };
}
