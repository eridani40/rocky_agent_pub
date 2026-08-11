/**
 * SquadMetaBroadcaster — squad 层聚合 meta 广播器（v0.0.305 新增）
 * 参考: specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/architecture.md D3/D4
 *       specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta topic 同构）
 *
 * 设计（仿 SessionMetaBroadcaster 自治订阅 statusBus）：
 *   - **状态机 + agent-loop 不感知 squad_meta / 不调 broadcaster**——本 broadcaster 是 squad 层
 *     组件，经 wrapStatusBusForUnread fan-out 捕获 statusBus 事件自治广播。
 *   - 事件→squad 路由：收到 session 事件（只有 sessionId，无 squadId）→ sessionStore.getSession
 *     → s.squadId；null（playground）跳过；非 null → broadcast(squadId)。
 *   - broadcast(squadId)：读最新 squad + members + sessions → computeSquadAggregate →
 *     squad 不存在（并发删除）返 null → no-op；否则 emit squad_meta_update 到 (squad_meta, _all)。
 *   - 每次读最新态（非缓存）；异常 try/catch 吞掉不影响调用方写路径。
 *
 * 循环依赖打破（change_plan「store 构造后注入」）：sessionStore 依赖 wrap（statusBusForStore），
 * wrap 依赖本 broadcaster → 构造时 sessionStore 延迟注入（setSessionStore，store 构造后调）。
 * 未注入前 handleSessionEvent no-op（store 构造前 statusBus 无事件可达）。
 *
 * 触发纪律（PRD §4.4.2）：写路径（hire/deploy/bench/create）由 handler 层显式调 broadcast，
 * 且 MUST await 落盘后再调（v0.0.163 race 教训）。
 *
 * 单文件 ≤300 行（spec 任务约束）。
 */
import { ulid } from '../config/ulid';
import type { ReplayableEventBus } from '../agent/event-bus';
import type { SessionStore } from '../agent/session-store';
import type { SquadStore, MemberStore } from '../stores/squad-store';
import type { SessionEvent } from '../agent/session-event-types';
import { computeSquadAggregate } from './squad-aggregate-service';
import {
  SQUAD_META_BROADCAST_GROUP,
  type SquadMetaUpdateEvent,
} from './squad-event-types';

/** SquadMetaBroadcaster 注入接口（最小依赖：store + bus，不依赖 handler） */
export interface SquadMetaBroadcasterDeps {
  /** squad store（getSquad 读最新 squad entity） */
  squadStore: SquadStore;
  /** member store（listMembers 读 member 直连 session） */
  memberStore: MemberStore;
  /** squad_meta topic 的 bus（emit 到 _all 共享广播 group） */
  squadMetaBus: ReplayableEventBus;
}

/**
 * 触发类型集合（对齐 SessionMetaBroadcaster META_TRIGGERING_TYPES 模式）：
 *   - session_status_update（状态 CAS，覆盖 run_start/run_end/busy 变化）
 *   - summary_task_update（压缩任务，updatedAt 推进）
 *   - session_usage_update（usage 变化）
 *   - session_read_update / messages_cleared（meta 变化，lastActiveAt 可能不变但无害）
 * 高频 session_workspace_file_changed **不触发**（同 SessionMetaBroadcaster 决策）。
 */
// 用 Set<string> 而非 Set<SessionEvent['type']>，允许 UT 查任意字符串（如预留类型）。
export const SQUAD_META_TRIGGERING_TYPES = new Set<string>([
  'session_status_update',
  'summary_task_update',
  'session_usage_update',
  'session_read_update',
  'messages_cleared',
]);

/**
 * SquadMetaBroadcaster — squad 层聚合 meta 广播器。
 *
 * 职责：收到 statusBus 上的 session 事件 OR handler 写路径显式调 broadcast(squadId) 时，
 * 读最新 squad/members/sessions → 算 SquadAggregate → emit squad_meta_update 到 (squad_meta, _all)。
 */
export class SquadMetaBroadcaster {
  private readonly squadStore: SquadStore;
  private readonly memberStore: MemberStore;
  private readonly squadMetaBus: ReplayableEventBus;
  /** sessionStore 延迟注入（store 构造后调 setSessionStore；打破 store↔wrap↔broadcaster 循环） */
  private sessionStore?: SessionStore;

  constructor(deps: SquadMetaBroadcasterDeps) {
    this.squadStore = deps.squadStore;
    this.memberStore = deps.memberStore;
    this.squadMetaBus = deps.squadMetaBus;
  }

  /** store 构造后注入 sessionStore（bootstrap-store-phase 调；未注入前 handleSessionEvent no-op） */
  setSessionStore(store: SessionStore): void {
    this.sessionStore = store;
  }

  /**
   * 处理 statusBus 上收到的 SessionEvent：仅触发类型集合内 → 查 session 得 squadId →
   * null（playground）跳过 → broadcast(squadId)。
   *
   * 由 wrapStatusBusForUnread fan-out 调用（wrap 内异常吞掉不影响 emit 主路径）。
   * getSession 为异步 → 内部 fire-and-forget（void route），路由异常自吞。
   */
  handleSessionEvent(event: SessionEvent): void {
    if (!SQUAD_META_TRIGGERING_TYPES.has(event.type)) return;
    if (!this.sessionStore) return; // 未注入（store 构造前）→ no-op
    void this.route(event.sessionId);
  }

  /** 异步路由：session → squadId（null=playground 跳过）→ broadcast */
  private async route(sessionId: string): Promise<void> {
    try {
      const session = await this.sessionStore!.getSession(sessionId);
      if (!session) return; // session 不存在（并发删除）→ no-op
      const squadId = session.squadId;
      if (!squadId) return; // playground session 无 squadId → 跳过
      await this.computeAndEmit(squadId);
    } catch {
      // 路由异常不影响 emit 主路径（wrap 已 try/catch 兜底）
    }
  }

  /**
   * 广播 squad 最新聚合到 (squad_meta, _all)。
   *
   * 由 handler 写路径（hire/deploy/bench/create 落盘后）显式调用 + handleSessionEvent 内部调用。
   * squad 不存在（并发删除）→ no-op；异常吞掉不影响调用方写路径（PRD §4.4.2）。
   */
  broadcast(squadId: string): void {
    try {
      void this.computeAndEmit(squadId);
    } catch {
      // broadcast 异常不影响主路径（写已落盘，前端可 GET /squad 兜底）
    }
  }

  /** 异步计算 + emit（broadcast 内 fire-and-forget，异常自吞） */
  private async computeAndEmit(squadId: string): Promise<void> {
    try {
      if (!this.sessionStore) return; // 未注入 → no-op（理论不达：broadcast 均由 store 装配后调）
      const aggregate = await computeSquadAggregate(
        { sessionStore: this.sessionStore, squadStore: this.squadStore, memberStore: this.memberStore },
        squadId,
      );
      if (!aggregate) return; // squad 已删（并发删除）→ no-op
      const event: SquadMetaUpdateEvent = {
        id: ulid(),
        type: 'squad_meta_update',
        squadId,
        createdAt: new Date().toISOString(),
        data: aggregate,
      };
      // emit 到共享广播 group `_all`（传输层 group 分区约束，无 wildcard）
      this.squadMetaBus.emit(SQUAD_META_BROADCAST_GROUP, {
        data: event,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // 异步路径异常同样吞掉（不影响调用方）
    }
  }
}
