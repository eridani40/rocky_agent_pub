/**
 * bootstrap-bus-phase — Phase 6 装配：EventHub + ReplayableEventBus × 3 + SseChannel
 *
 * 纯 move 自 bootstrap.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.1 Phase 6 + §4.2 第二行
 *
 * 装配顺序（INV-C-1 严格保留）：
 *   1. EventHub.singleton() 进程级单例
 *   2. agent_loop topic：ReplayableEventBus（replayable=true + lifecyclePredicate 识别 run_start/run_end）
 *      + wrapBusWithLog（dev-logs event hook）+ registerTopic
 *   3. session_panel topic：ReplayableEventBus（replayable=false）+ wrap + register
 *   4. session_meta topic：ReplayableEventBus（replayable=false）+ wrap + register
 *   5. SseChannel（依赖 hub）
 *
 * 3 topic 注册顺序不可换（agent_loop → session_panel → session_meta）。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；logWriter 作入参。
 */
import { EventHub, ReplayableEventBus } from './agent/event-hub';
import { SseChannel } from './sse/sse-channel';
import { wrapBusWithLog } from './dev-logs/wrap-bus-with-log';
import type { LogWriter } from './dev-logs/log-writer';
import { SESSION_META_TOPIC, APP_TASK_TOPIC } from './agent/session-event-types';
// [v0.0.305] squad_meta topic 名（squad 层事件类型文件导出；白名单测试 import 真值）
import { SQUAD_META_TOPIC } from './squad/squad-event-types';
// [v0.0.363] provider_quota topic 名（额度快照 SSE 广播；白名单测试 import 真值）
import { PROVIDER_QUOTA_TOPIC } from './llm/quota-events';
// [v0.0.189] panorama topic 名（hub.registerTopic 用；SSE 前端订阅白名单项）
const PANORAMA_TOPIC = 'panorama';
export { PANORAMA_TOPIC };
import type { ReplayableEventBus as ReplayableEventBusType } from './agent/event-hub';

/** agent_loop topic 名 */
const AGENT_LOOP_TOPIC = 'agent_loop';
/** session_panel topic 名（session 运行态变更通知） */
const SESSION_PANEL_TOPIC = 'session_panel';

export { AGENT_LOOP_TOPIC, SESSION_PANEL_TOPIC };

/**
 * Phase 6 装配：EventHub + 3 topic 的 ReplayableEventBus + SseChannel。
 *
 * @param logWriter dev-logs 写入器（wrapBusWithLog 闭包持引用）
 * @returns hub + bus（agent_loop）+ sessionStatusBus（session_panel）+ sessionMetaBus + sseChannel
 */
export async function bootstrapBusPhase(logWriter: LogWriter): Promise<{
  hub: EventHub;
  bus: ReplayableEventBusType;
  sessionStatusBus: ReplayableEventBusType;
  sessionMetaBus: ReplayableEventBusType;
  appTaskBus: ReplayableEventBusType;
  panoramaBus: ReplayableEventBusType;
  squadMetaBus: ReplayableEventBusType;
  /** [v0.0.363] provider_quota topic 的 bus（QuotaSyncService emit 用） */
  providerQuotaBus: ReplayableEventBusType;
  sseChannel: SseChannel;
}> {
  // EventHub 全局单例 + agent_loop topic 的 replayable bus + session_panel topic 的 bus
  // （SessionStore 推送 session_status_update）。
  // event hook（spec dev-logs §3.4）：创建每个 bus 后、registerTopic 前包一层
  //   wrapBusWithLog proxy（emit 拦截写 logs/event.log；subscribe/wake 透传不破坏现有行为）。
  //   statusBus 之后再被 wrapStatusBusForUnread 包一层（store 持有），realEmit 经 log proxy
  //   → log 写入 + inner.emit，链路完整。
  const hub = EventHub.singleton();
  // agent_loop bus 注入 lifecyclePredicate（spec event_bus.md §4.3）：
  //   识别 run_start / run_end → 额外写入 sticky slot，不被 clearReplay 清除。
  //   切走切回重订阅时 sticky 先回放，保证前端 runActive 翻转可恢复（spinner 不丢）。
  //   session_panel / session_meta 的 bus 不传 predicate（undefined）。
  //   predicate 是通用函数，bus 内部不感知业务 type 名；wrapBusWithLog 是 Proxy 透传所有方法，
  //   inner bus 构造时注入 predicate 后 proxy 完全透明，无需改 wrap 行为。
  const bus = wrapBusWithLog(
    new ReplayableEventBus({
      replayable: true,
      lifecyclePredicate: (e) => {
        const t = (e.data as { type?: string } | null | undefined)?.type;
        return t === 'run_start' || t === 'run_end';
      },
    }),
    logWriter,
    AGENT_LOOP_TOPIC,
  );
  hub.registerTopic(AGENT_LOOP_TOPIC, bus);
  // session_panel non-replayable（与 session_meta 同）：
  //   session_status_update / session_usage_update 是累计快照（最新态），不是流式增量——replay
  //   历史 buffer 只刷一堆过时快照。初始态靠 GET /session + GET /session/:id/usage 拉，replay 无意义。
  //   仅 agent_loop 需 replay（流式增量补「上次持久化后的半截」，见 agent_event.md §10）。
  // 同时包 wrapBusWithLog（spec dev-logs §3.4 event hook）：proxy 只拦截 emit
  //   写日志，subscribe/wakePendingSubscribers 透传 inner——non-replayable 语义由 inner 决定，
  //   proxy 不依赖 replayable:true（见 wrap-bus-with-log.ts），故可安全叠加。
  const sessionStatusBus = wrapBusWithLog(
    new ReplayableEventBus({ replayable: false }),
    logWriter,
    SESSION_PANEL_TOPIC,
  );
  hub.registerTopic(SESSION_PANEL_TOPIC, sessionStatusBus);
  // session_meta topic（spec sse_channel.md §10）：复用 EventHub 只加 topic，
  // non-replayable（列表初始态靠 GET /session 拉全量，只需订阅后的增量，避免回放陈旧 meta）
  // + 共享广播 group `_all`（传输层 group 分区约束，无 wildcard）
  const sessionMetaBus = wrapBusWithLog(
    new ReplayableEventBus({ replayable: false }),
    logWriter,
    SESSION_META_TOPIC,
  );
  hub.registerTopic(SESSION_META_TOPIC, sessionMetaBus);

  // [v0.0.164] app_task topic —— app 级后台任务状态广播（tier2_consolidation）。
  //   non-replayable：新连接订阅只关心当前状态；初始态走 GET /consolidation/status，SSE 只推实时更新
  //   （对齐 session_meta 决策：广播态 replay 无意义）。共享广播 group `_all`。
  //   registerTopic 必须在 AppTaskLock.setAppTaskBus 之前（bus 就绪保证），装配序：
  //     bus-phase.registerTopic → store-phase.new AppTaskLock → agent-phase.setAppTaskBus。
  const appTaskBus = wrapBusWithLog(
    new ReplayableEventBus({ replayable: false }),
    logWriter,
    APP_TASK_TOPIC,
  );
  hub.registerTopic(APP_TASK_TOPIC, appTaskBus);

  // [v0.0.189] panorama topic —— 业务全景看板事件广播（entity create/update/transition + schema update）。
  //   non-replayable + per-squad group（panorama:squad:{id}:entity，前端进 panorama 页订阅）。
  //   emit 在 panorama tool/http 写路径，bus 由本 phase 返回后经 bootstrap 注入 agent-phase rtc + squad-routes。
  const panoramaBus = wrapBusWithLog(
    new ReplayableEventBus({ replayable: false }),
    logWriter,
    PANORAMA_TOPIC,
  );
  hub.registerTopic(PANORAMA_TOPIC, panoramaBus);

  // [v0.0.305] squad_meta topic —— squad 聚合状态广播（在线/工作中/最后活跃）。
  //   non-replayable（快照态：初始态走 GET /squad 拉全量，订阅后只收增量——对齐 session_meta §10.3）。
  //   共享广播 group `_all`。SseChannel 构造前注册（bus 就绪保证）。
  const squadMetaBus = wrapBusWithLog(
    new ReplayableEventBus({ replayable: false }),
    logWriter,
    SQUAD_META_TOPIC,
  );
  hub.registerTopic(SQUAD_META_TOPIC, squadMetaBus);

  // [v0.0.363] provider_quota topic —— 全局额度快照广播（QuotaSyncService.syncOnce 写 store 后 emit）。
  //   non-replayable（快照态：初始态走 GET /provider/quota 拉 store，订阅后只收增量——对齐 session_meta §10.3）。
  //   共享广播 group `_all`（同 app_task）。registerTopic 先于 store-phase 的 QuotaSyncService.start（bus 就绪保证）。
  const providerQuotaBus = wrapBusWithLog(
    new ReplayableEventBus({ replayable: false }),
    logWriter,
    PROVIDER_QUOTA_TOPIC,
  );
  hub.registerTopic(PROVIDER_QUOTA_TOPIC, providerQuotaBus);

  // SseChannel 创建前置（仅依赖 hub）——供 SessionUnreadRuntime 注入前台判定探针。
  // [REPLAY-DEBUG] 传 logWriter：SseChannel 在 SSE 实际发送点（enqueue）记录每条帧全文到 event.log。
  const sseChannel = new SseChannel(hub, logWriter);

  return { hub, bus, sessionStatusBus, sessionMetaBus, appTaskBus, panoramaBus, squadMetaBus, providerQuotaBus, sseChannel };
}
