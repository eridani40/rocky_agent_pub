/**
 * bootstrap-store-phase — Phase 7 装配：SessionStore + SessionUnreadRuntime + SessionTaskLock
 *
 * 纯 move 自 bootstrap.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.1 Phase 7 + §4.2 第三行
 *       specs/tech/version_logs/v0.0.194/change_plan.md 模块 B/C（SQLite mount + subscriber/aggregator 装配）
 *
 * 装配顺序（INV-C-1 严格保留）：
 *   1. FsCrudStore + CompositeStore mount 4 schema（session/transcript/summary/runs）
 *   2. SessionMetaBroadcaster（注入 crud + sessionMetaBus）
 *   3. SessionUnreadRuntime（enabled=false 构造，reconcile 期间豁免；注入 presenceProbe=sseChannel）
 *   4. wrapStatusBusForUnread 包装 statusBus（realEmit 经 log proxy → wrap → store）
 *   5. SessionStore 构造（注入 crud + statusBusForStore）
 *   6. setSessionStoreEpDelegate（persistent_session_store EP delegate 注入）
 *   7. stateMachine.reconcileOnStartup（**必须在 unreadRuntime.start 前**——INV-C-1）
 *   8. SessionTaskLock 构造 + reconcileOnStartup（接口保留与五态 reconcile 同范式）
 *   9. unreadRuntime.start（reconcile 完成后启用未读运行时）
 *  10. [v0.0.194] SQLite crud.sqlite 装配 + token_usage_stat store/aggregator/subscriber
 *
 * 关键时序：reconcile 在 unreadRuntime.start 之前——reconcile 期间 enabled=false 挡住 emit
 * 不产未读（spec 不变量 4）。顺序错会导致启动期 session_status_update 误产未读。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；dataDir 作入参。
 */
import * as path from 'node:path';
import type { SseChannel } from './sse/sse-channel';
import type { ReplayableEventBus } from './agent/event-hub';
import type { LogWriter } from './dev-logs/log-writer';
import { CompositeStore } from './persistence/composite';
import { FsCrudStore } from './persistence/fs-store';
import { SessionStore } from './agent/session-store';
// SessionTaskLock —— 统一 per-session × per-task 内存锁（subsumes summaryTask CAS）
import { SessionTaskLock } from './agent/session-task-lock';
// [v0.0.164] AppTaskLock —— app 级 × per-task 内存锁（tier2_consolidation 撞车保护）
import { AppTaskLock } from './agent/app-task-lock';
// session 层未读自治运行时（spec unread-model-decision.md §6 归属层=session 层）
import { SessionUnreadRuntime, wrapStatusBusForUnread } from './agent/session-unread-runtime';
// session 层 meta 广播器（spec sse_channel.md §10 + session_event.md §3a）
import { SessionMetaBroadcaster } from './agent/session-meta-broadcaster';
// persistent_session_store EP impl 的 delegate 注入（打破 plugin_manager 实例化签名限制）
import { setSessionStoreEpDelegate } from './agent/session-store-ep-delegate';
// [v0.0.194] SQLite crud engine + token 统计 store/aggregator/subscriber
import { createCrudSqlDriver } from './persistence/crud-sqlite-driver-factory';
import { TokenUsageStatStore } from './persistence/token-usage-stat-store';
import { TokenUsageAggregator } from './squad/token-usage/token-usage-aggregator';
import { setTokenUsageSubscriberDeps } from './squad/token-usage/token-usage-subscriber';
import { SquadStore } from './stores/squad-store';
// [v0.0.210] AcademyStore —— academy 域 7 entity CrudStore facade（classroom/student/version/task/turn/dataset/grader）
import { AcademyStore } from './academy/academy-store';

/**
 * Phase 7 装配：SessionStore + SessionUnreadRuntime + SessionTaskLock + AcademyStore。
 *
 * @param dataDir 数据根目录绝对路径
 * @param sessionStatusBus session_panel topic 的 bus（来自 bus-phase）
 * @param sessionMetaBus session_meta topic 的 bus（来自 bus-phase）
 * @param sseChannel SseChannel（来自 bus-phase，作为 unreadRuntime.presenceProbe）
 * @param logWriter dev-logs 写入器
 * @returns store + unreadRuntime + sessionMetaBroadcaster + taskLock + academyStore
 */
export async function bootstrapStorePhase(dataDir: string, sessionStatusBus: ReplayableEventBus, sessionMetaBus: ReplayableEventBus, sseChannel: SseChannel, logWriter: LogWriter): Promise<{
  store: SessionStore;
  unreadRuntime: SessionUnreadRuntime;
  sessionMetaBroadcaster: SessionMetaBroadcaster;
  taskLock: SessionTaskLock;
  appTaskLock: AppTaskLock;
  /** [v0.0.194] token 用量聚合查询（sqlite 装配失败时 undefined → handler 返 503） */
  tokenUsageAggregator?: TokenUsageAggregator;
  /** [v0.0.210] academy 域统一 store（bootstrap.ts 装配 TrainingEngine 用） */
  academyStore: AcademyStore;
}> {
  // SessionStore：CompositeStore mount 4 schema（session/transcript/summary/runs）到 fs engine
  const fs = new FsCrudStore({ root: dataDir });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);

  // SessionUnreadRuntime —— session 层未读自治运行时（spec session_state.md §4.4/§6.2
  // + unread-model-decision.md §6）。enabled=false 构造（reconcile 期间豁免），wrap statusBus
  // 后注入 store/stateMachine——agent-loop 用纯 markIdle/markError，
  // completion 信号（session_status_update）由本运行时自治消费。
  // 同时构造 SessionMetaBroadcaster 注入 wrap（spec sse_channel.md §10.4）：
  // statusBus 任意 session 事件 → broadcaster.broadcast(sid)；markUnreadTrue CAS 成功后 runtime 直调。
  const sessionMetaBroadcaster = new SessionMetaBroadcaster({
    crud,
    sessionMetaBus,
  });
  const unreadRuntime = new SessionUnreadRuntime({
    crud,
    presenceProbe: sseChannel,
    metaBroadcaster: sessionMetaBroadcaster,
  });
  const statusBusForStore = wrapStatusBusForUnread(sessionStatusBus, unreadRuntime, {
    metaBroadcaster: sessionMetaBroadcaster,
  });
  const store = new SessionStore({ crud, fsRoot: dataDir, statusBus: statusBusForStore, logWriter });

  // 注入持久 SessionStore 到 persistent_session_store EP impl 的 server 侧 delegate holder。
  //   default scope 的 assemble/ingest 经 ContextEngine.resolveStore('default') 拿本 EP impl，
  //   impl 委托 holder 的 delegate 完成持久化读写。必须在 ContextEngine 使用 session_store EP 前调。
  setSessionStoreEpDelegate(store);

  // 启动扫描修复 orphan run（崩溃前 running/interrupting 的 session → idle + Run=interrupted）
  // session_state.md §5。监听 API 前调一次。
  // reconcile 在 unreadRuntime.start() 之前——emit 的 session_status_update 经
  // wrapStatusBusForUnread fan-out 到运行时，但 enabled=false 挡住 → 不产生未读（spec 不变量 4）。
  await store.stateMachine.reconcileOnStartup();

  // SessionTaskLock 单例构造 + reconcile。
  //   lock 不落盘（内存 only），reconcileOnStartup 实际为 no-op（内存已空 = 全部释放）。
  //   接口保留与五态 reconcile 同范式（spec session_task_lock.md §3.4）。
  const taskLock = new SessionTaskLock();
  taskLock.reconcileOnStartup();

  // [v0.0.164] AppTaskLock 单例构造 + reconcile（no-op 占位）。
  //   与 SessionTaskLock 同款：不落盘、内存 only、reconcile 是 no-op。
  //   bus 注入在 agent-phase.setAppTaskBus（bus-phase 已 registerTopic APP_TASK_TOPIC，
  //   顺序保证 bus 就绪）。spec app_task_lock.md §3.4。
  const appTaskLock = new AppTaskLock();
  appTaskLock.reconcileOnStartup();

  // reconcile 完成后启用未读运行时——此后 agent-loop 正常完成的 session_status_update
  // completion 信号（idle/error）会触发 markUnreadTrue（非前台时）。
  unreadRuntime.start();

  // [v0.0.194] SQLite crud.sqlite 装配 + token_usage_stat store/aggregator/subscriber。
  // 路径：join(dataDir, 'crud.sqlite')（绝对路径，PACKAGED-GUARD-2）。
  // 异常容忍（对齐 bootstrap-search-phase 范式）：sqlite 装配失败 → log warn + 跳过 token 统计，
  // 不阻塞 server 启动（handler 返 503）。createCrudSqlDriver 双产物 {store, driver}：
  //   - store（SqliteCrudStore）→ TokenUsageStatStore（写入，读写分离 §2.6）
  //   - driver（SqlDriver）→ TokenUsageAggregator（raw SQL GROUP BY 聚合查询）
  let tokenUsageAggregator: TokenUsageAggregator | undefined;
  try {
    const sqlitePath = path.join(dataDir, 'crud.sqlite');
    const { store: sqliteCrud, driver: sqliteDriver } = await createCrudSqlDriver(sqlitePath);
    const statStore = new TokenUsageStatStore(sqliteCrud);
    tokenUsageAggregator = new TokenUsageAggregator(sqliteDriver);
    // subscriber 依赖注入（sessionStore.crud 读 session record；SquadStore 读 squad record）
    const squadReader = new SquadStore({ root: dataDir });
    setTokenUsageSubscriberDeps({ statStore, sessionStore: store, squadReader });
  } catch (e) {
    // sqlite 装配失败：log warn + 跳过 token 统计（不阻塞主流程）
    console.error('[bootstrap] crud.sqlite assembly failed; token_stats disabled:', e);
  }

  return { store, unreadRuntime, sessionMetaBroadcaster, taskLock, appTaskLock, ...(tokenUsageAggregator ? { tokenUsageAggregator } : {}),
    // [v0.0.210] AcademyStore 装配（AcademyStore 构造内部已 mount 7 entity；root=dataDir 绝对路径，PACKAGED-GUARD-2）
    academyStore: new AcademyStore({ root: dataDir }),
  };
}
