/**
 * SessionStore — session 持久化统一存储 + 检索层（facade）
 * 参考: specs/tech/agent/session/[P0]session_store.md §4
 *
 * v0.0.156 结构性拆分：class 留作 facade（constructor + 字段 + method 签名），方法实现
 *   move 到 session-store-{messages,usage,children,core}-impl.ts standalone 函数
 *   （core 组为 Round 2 追加拆分，修 code-review 打回 facade 超阈值）。
 *   class 内方法体改为单行委托（INV-S-3：公开 API 100% 等价）。
 *
 * 委托 CrudStore（CompositeStore 注入 4 schema）。异步签名保留 Promise（兼容 future 异步 engine）。
 * - getMessages 分页：MessageRange={limit?:50, beforeId?, fromId?, upToId?}（ULID 字典序=时间序）
 * - deleteSession 级联：删 session 自身 + rm -rf {root}/sessions/{sid}/（message/summary/runs）
 * - usage：accumulateUsage 三分区累加 + ratio 学习 + 递归 sub 上报；
 *   getRatio 滑动 3 中位数；getUsageView 真聚合（详见各 impl 文件 + session-usage-helper.ts）
 *
 * 类型见 session-store-types.ts；转换/错误见 session-store-converters.ts。
 *
 * packaged 护栏（INV-PKG-1/2）：本文件不读 process.env；不拼接相对路径；dataDir 由 caller 展开。
 */
import type { BizType, Role, SessionContext } from '@app/shared';
import type { SessionKind as SessionKindType } from '@app/shared';
import { CompositeStore } from '../persistence/composite';
import { SessionSchema } from './schema_defs';
import type { Message, MessageInput, Usage, ContextWindowUsage } from '../message/types';
// [v0.0.101] PendingToolCall（peekPendingToolCall/setPendingToolCalls/resolvePendingToolCall 用）
import type { PendingToolCall } from '../tools/types';
import type {
  Session, Run, SummaryInfo, MessageRange, MessagePage,
  CreateSessionInput, CreateRunInput, SessionStoreOptions, SessionUsageView, UsagePartition,
  UpdateUsageOpts,
  ChildrenView, ListChildrenFilter, StoreCallOpts,
} from './session-store-types';
import { normalizeKeyArray } from './session-store-converters';
import { SessionStateMachine } from './session-state-machine';
import type { ReplayableEventBus } from './event-bus';
import type { SessionTypeProfileLoader } from './session-type-profile-loader';
// clearSession 实现（spec session_clear.md §2 §3 §5）
import { clearSessionStoreOp } from './session-clear-op';
// workspace 字段操作（spec session_workspace.md §2.2 §3 §5）
import { setWorkspaceDirOp, ensureWorkspaceDirOp } from './session-workspace-store';
// unread CAS 操作（spec session_state.md §3.1 §6.3 + session_store.md §4）
import { markUnreadTrue, markReadAndEmit } from './session-unread-ops';
// [v0.0.101] HITL 悬挂 tool call 队列操作（pendingToolCalls 落盘 INV-3）
import { peekPendingToolCall, setPendingToolCalls, resolvePendingToolCall } from './session-pending-ops';
// parent→children 正向索引（listChildren O(N)→O(children)，subagent 无限膨胀优化）
import { ChildrenIndex } from './session-children-index';
// v0.0.156 拆分：impl 模块委托
import {
  sessionStoreCreateRun, sessionStoreGetRun, sessionStoreUpdateRun, sessionStoreGetRuns,
  sessionStoreAppendMessages, sessionStoreGetMessages, sessionStoreGetMessagesByRun,
} from './session-store-messages-impl';
import {
  sessionStoreGetSummary, sessionStoreSetSummary, sessionStoreAccumulateUsage,
  sessionStoreUpdateContextWindowUsage, sessionStoreNotifyUsageChanged, sessionStoreUpdateUsage,
  sessionStoreGetRatio, sessionStoreGetUsageView, sessionStorePersistUsage,
} from './session-store-usage-impl';
import { sessionStoreListChildren, sessionStoreCollectDescendants, sessionStoreListSessionsBySquad } from './session-store-children-impl';
// v0.0.156 Round 2 拆分（修 code-review 打回超阈值）：core 组（session 生命周期）委托
import {
  sessionStoreCreateSession, sessionStoreGetSession, sessionStoreGetSessionKind,
  sessionStoreGetSessionContext,
  sessionStoreUpdateSession, sessionStoreListSessions, sessionStoreDeleteSession,
  sessionStoreStripEnvelope,
} from './session-store-core-impl';

/**
 * SessionStore 实现（facade）。委托 CrudStore 落盘 4 schema，提供 session/run/message/summary
 * 的统一读写接口 + 分页 + 级联删 + 简化 usage 方法。
 *
 * session 运行态 CAS API（markRunning/markInterrupting/markInterrupted/markIdle/
 * markError + reconcileOnStartup）委托 SessionStateMachine（见 session-state-machine.ts）。
 *
 * 注：crud/fsRoot/statusBus/childrenIndex 改为 public readonly（v0.0.156 拆分时 impl 文件需访问）。
 *   与已有 stateMachine 字段同款（public readonly 单例装配后不变）。readonly 保留防止运行时改写。
 */
export class SessionStore {
  // 写操作走 CompositeStore.putAsync/deleteAsync（串行化，spec §6.1）
  readonly crud: CompositeStore;
  readonly fsRoot?: string;
  /** 运行态 CAS + reconcile 委托器 */
  readonly stateMachine: SessionStateMachine;
  /** session_panel topic 的 bus（推送 session_usage_update） */
  readonly statusBus?: ReplayableEventBus;
  /** parent→[childSid] 正向索引（lazy 建 + create/delete 增量维护；listChildren 用） */
  readonly childrenIndex = new ChildrenIndex();

  /**
   * session 销毁回调（注入式，避免 session-store → scheduling → session-store 循环依赖）。
   *
   * 触发：deleteSession 末尾（crud 删 + fs cascade 删 之后）调 await this.onSessionDestroyed?.(sid)。
   * 用途：bootstrap wire 到 cronAdapter.removeAllJobs + engine.unregister 该 session 的 cron jobs。
   * 设计：注入 callback 而非 session-store 直接 import cronAdapter（spec [P1]cron_subsystem.md §8），
   *   对齐 agent_manager/session-workspace-manager 已有 hook 模式。
   */
  onSessionDestroyed?: (sessionId: string) => Promise<void>;

  /**
   * [v0.0.204 T2-B5] SessionTypeProfileLoader 引用——createSession enabled 门用（STP §8）。
   * 缺省 → enabled 门跳过（UT fixture / dev misconfig 容忍）；生产路径 bootstrap 必注。
   * 仅 main-run 类型（derivation='parent'）走门：profile 必须存在且 enabled!==false。
   */
  sessionTypeProfileLoader?: SessionTypeProfileLoader;

  constructor(opts: SessionStoreOptions) {
    this.crud = opts.crud;
    this.fsRoot = opts.fsRoot;
    this.statusBus = opts.statusBus;
    this.sessionTypeProfileLoader = opts.sessionTypeProfileLoader;
    this.stateMachine = new SessionStateMachine({
      crud: this.crud,
      statusBus: opts.statusBus,
      logWriter: opts.logWriter,
      // [v0.0.361 T4] 透传 fsRoot：markX 状态变化写 member_state reminder + squad fanout
      reminderFsRoot: opts.fsRoot,
    });
  }

  /** 创建 session — 委托 session-store-core-impl */
  async createSession(input: CreateSessionInput): Promise<Session> {
    return sessionStoreCreateSession(this, input);
  }

  /** 读单个 session；不存在返 null — 委托 session-store-core-impl */
  async getSession(sessionId: string): Promise<Session | null> {
    return sessionStoreGetSession(this, sessionId);
  }

  /** 读 session → 构造 slim SessionKind（spec session_kind.md §4）— 委托 session-store-core-impl，@throws SessionNotFoundError */
  async getSessionKind(sessionId: string): Promise<SessionKindType> {
    return sessionStoreGetSessionKind(this, sessionId);
  }

  /** 读 session → 构造 SessionContext（6 实例 ID 投影，v0.0.204 新增）— 委托 session-store-core-impl，@throws SessionNotFoundError */
  async getSessionContext(sessionId: string): Promise<SessionContext> {
    return sessionStoreGetSessionContext(this, sessionId);
  }

  /** 部分更新 session（title/status/contextWindowUsage/providerId/modelId/titled/effort/approvalMode/alwaysApprovedKeys/pinned）— 委托 session-store-core-impl，详见其注释 */
  async updateSession(
    sessionId: string,
    patch: Partial<
      Pick<
        Session,
        | 'title'
        | 'status'
        | 'contextWindowUsage'
        | 'providerId'
        | 'modelId'
        | 'titled'
        | 'effort'
        | 'approvalMode'
        | 'alwaysApprovedKeys'
        | 'pinned'
      >
    >,
  ): Promise<void> {
    return sessionStoreUpdateSession(this, sessionId, patch);
  }

  /** 列出全部 session，按 updatedAt desc；biz/role 过滤见 spec session_biztype.md §3 — 委托 session-store-core-impl */
  async listSessions(opts?: { biz?: BizType; role?: Role }): Promise<Session[]> {
    return sessionStoreListSessions(this, opts);
  }

  /** 列出 children（subagent），按 running/terminated 分组 + limit 截断（api 10-multi-agent §3）— 委托 session-store-children-impl，详见其注释 */
  async listChildren(id: string, filter?: ListChildrenFilter): Promise<ChildrenView> {
    return sessionStoreListChildren(this, id, filter);
  }

  /** 收集 parent session 的全部子孙 id（任意深度 BFS，级联删用）— 委托 session-store-children-impl */
  async collectDescendants(parentId: string): Promise<string[]> {
    return sessionStoreCollectDescendants(this, parentId);
  }

  /** 按 squadId 平铺查全量 session id（解散时 catch 全部含 spawn child）— 委托 session-store-children-impl */
  async listSessionsBySquad(squadId: string): Promise<string[]> {
    return sessionStoreListSessionsBySquad(this, squadId);
  }

  /** 删除 session + 级联删 message/summary/run + onSessionDestroyed 回调（cron 注销）— 委托 session-store-core-impl */
  async deleteSession(sessionId: string): Promise<void> {
    return sessionStoreDeleteSession(this, sessionId);
  }

  /** 创建 run（status 默认 running）— 委托 session-store-messages-impl */
  async createRun(input: CreateRunInput): Promise<Run> {
    return sessionStoreCreateRun(this, input);
  }

  /** 读单个 run；不存在返 null — 委托 session-store-messages-impl */
  async getRun(sessionId: string, runId: string): Promise<Run | null> {
    return sessionStoreGetRun(this, sessionId, runId);
  }

  /** 更新 run（status/stopReason/error/contextWindowUsage/endedAt）— 委托 session-store-messages-impl */
  async updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<Pick<Run, 'status' | 'stopReason' | 'error' | 'contextWindowUsage' | 'endedAt'>>,
  ): Promise<void> {
    return sessionStoreUpdateRun(this, sessionId, runId, patch);
  }

  /** 列出某 session 全部 run（按 createdAt desc）— 委托 session-store-messages-impl */
  async getRuns(sessionId: string): Promise<Run[]> {
    return sessionStoreGetRuns(this, sessionId);
  }
  // transcript（message）

  /** 追加 messages 到 transcript（append-only；同 id upsert）— 委托 session-store-messages-impl，详见其注释 */
  async appendMessages(sessionId: string, messages: MessageInput[], _opts?: StoreCallOpts): Promise<void> {
    return sessionStoreAppendMessages(this, sessionId, messages, _opts);
  }

  /** 按 range 读 transcript 分页（ULID 字典序=时间序）— 委托 session-store-messages-impl，分页语义详见其注释 */
  async getMessages(sessionId: string, range?: MessageRange, _opts?: StoreCallOpts): Promise<MessagePage> {
    return sessionStoreGetMessages(this, sessionId, range, _opts);
  }

  /** 取某 run 关联的全部 messages（按 id 升序）— 委托 session-store-messages-impl */
  async getMessagesByRun(sessionId: string, runId: string): Promise<Message[]> {
    return sessionStoreGetMessagesByRun(this, sessionId, runId);
  }

  /** 读 summary；不存在返 null — 委托 session-store-usage-impl */
  async getSummary(sessionId: string): Promise<SummaryInfo | null> {
    return sessionStoreGetSummary(this, sessionId);
  }

  /** 写/覆盖 summary（upsert 语义；id 固定为 sessionId；[v0.0.186] block=compact 烘焙文本，可选）— 委托 session-store-usage-impl */
  async setSummary(
    sessionId: string,
    summary: { content: string; summaryUpTo: string | null; block?: string },
  ): Promise<void> {
    return sessionStoreSetSummary(this, sessionId, summary);
  }

  /** 累加 usage 到某分区（三分区 Σ + ratio 学习 + 递归 sub 上报，spec session_usage.md §6/§7）— 委托 session-store-usage-impl，详见其注释 */
  async accumulateUsage(
    sessionId: string,
    type: UsagePartition,
    usage: Usage,
  ): Promise<string[]> {
    return sessionStoreAccumulateUsage(this, sessionId, type, usage);
  }

  /** 更新 session 级 contextWindowUsage（纯 write 不 emit）— 委托 session-store-usage-impl */
  async updateContextWindowUsage(
    sessionId: string,
    cw: ContextWindowUsage,
  ): Promise<void> {
    return sessionStoreUpdateContextWindowUsage(this, sessionId, cw);
  }

  /** 通知 usage 变更（读 getUsageView 全量 emit session_usage_update，spec session_usage.md §3/§6/§10）— 委托 session-store-usage-impl */
  async notifyUsageChanged(sessionId: string): Promise<void> {
    return sessionStoreNotifyUsageChanged(this, sessionId);
  }

  /**
   * 统一更新 usage 并推送（写 + 推一体，caller 只 set 不推）— 委托 session-store-usage-impl。
   * 只写传入字段（cw / usagePartition+usage）；写完对涉及 sid 链逐个 emit session_usage_update
   * （读 getUsageView 全量——改 A 时 B 必为最新值）。只写不推场景（compact 纯生产者）不走本方法。
   */
  async updateUsage(sessionId: string, opts: UpdateUsageOpts): Promise<void> {
    return sessionStoreUpdateUsage(this, sessionId, opts);
  }

  /** 读当前 char/token ratio（滑动 3 中位数，spec session_usage.md §7）— 委托 session-store-usage-impl */
  async getRatio(sessionId: string): Promise<number> {
    return sessionStoreGetRatio(this, sessionId);
  }

  /** 聚合 usage view（三分区+ratio+contextWindowUsage 派生，spec session_usage.md §8）— 委托 session-store-usage-impl */
  async getUsageView(sessionId: string): Promise<SessionUsageView> {
    return sessionStoreGetUsageView(this, sessionId);
  }

  /** run 结束落 run 级 contextWindowUsage + 累计 token usage（spec session_usage.md §10）— 委托 session-store-usage-impl */
  async persistUsage(
    sessionId: string,
    runId: string,
    cw: ContextWindowUsage,
    runUsage?: Usage,
  ): Promise<void> {
    return sessionStorePersistUsage(this, sessionId, runId, cw, runUsage);
  }

  /** CrudStore.put 禁 record 自带信封字段（createdAt/updatedAt/version）—— 委托 session-store-core-impl */
  stripEnvelope<T extends Record<string, unknown>>(rec: T): T {
    return sessionStoreStripEnvelope(rec);
  }

  /** 清空 session 内容（保留实体），委托 session-clear-op */
  async clearSession(sessionId: string): Promise<Session> {
    return clearSessionStoreOp(this.crud, this.statusBus, sessionId);
  }

  /** 切换 session 工作目录（spec session_workspace.md §2.2），委托 session-workspace-store */
  async setWorkspaceDir(sessionId: string, newDir: string): Promise<void> {
    return setWorkspaceDirOp(this.crud, this.statusBus, sessionId, newDir);
  }

  /** 历史 session 兼容 lazy 修复（spec session_workspace.md §5），委托 session-workspace-store */
  async ensureWorkspaceDir(sessionId: string): Promise<string | null> {
    if (!this.fsRoot) return null;
    return ensureWorkspaceDirOp(this.crud, this.fsRoot, sessionId);
  }

  // ── unread CAS（spec session_state.md §3.1/§4.4/§6.3），委托 session-unread-ops ──

  /** 产生未读 CAS（unread: false→true，幂等），委托 session-unread-ops */
  async markUnreadTrue(sessionId: string): Promise<boolean> {
    return markUnreadTrue(this.crud, sessionId);
  }

  /** 消除未读 CAS（unread: true→false + emit），委托 session-unread-ops */
  async markRead(sessionId: string): Promise<boolean> {
    return markReadAndEmit(this.crud, this.statusBus, sessionId);
  }

  // ── HITL 悬挂 tool call 队列（pendingToolCalls 落盘 INV-3），委托 session-pending-ops ──
  // ── [v0.0.148] ApprovalStorePort（ApprovalManager cache-through 持久化层）──

  /** 读 session 的 always-approved keys（缺省 []，与 toSession lazy 默认一致） */
  async getAlwaysApprovedKeys(sessionId: string): Promise<string[]> {
    const rec = this.crud.get(SessionSchema, sessionId);
    if (!rec) return [];
    return normalizeKeyArray((rec as { alwaysApprovedKeys?: unknown }).alwaysApprovedKeys);
  }

  /** 追加一个 always-approved key（复用 updateSession read-modify-write 去重 merge） */
  async addAlwaysApprovedKey(sessionId: string, key: string): Promise<void> {
    await this.updateSession(sessionId, { alwaysApprovedKeys: [key] });
  }

  /** peek 队首悬挂 tool call（只读快照），委托 session-pending-ops */
  async peekPendingToolCall(sessionId: string): Promise<PendingToolCall | null> {
    return peekPendingToolCall(this.crud, sessionId);
  }

  /** 落盘整个 pendingToolCalls 数组（覆盖写），委托 session-pending-ops */
  async setPendingToolCalls(sessionId: string, items: PendingToolCall[]): Promise<void> {
    await setPendingToolCalls(this.crud, sessionId, items);
  }

  /** 按 toolCallId 标 resolved + 删一条，委托 session-pending-ops */
  async resolvePendingToolCall(sessionId: string, toolCallId: string): Promise<boolean> {
    return resolvePendingToolCall(this.crud, sessionId, toolCallId);
  }
}
