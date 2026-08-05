/**
 * panorama SSE 事件推送 —— 复用现有 EventHub/ReplayableEventBus（panorama_http.md §4）.
 *
 * topic 类别 = "panorama"（hub.registerTopic 注册，前端 subscribe 白名单）.
 * group = per-squad 路由键 "panorama:squad:{squadId}:entity"（传输层 bus 按此分区，
 *   避免 squad 间事件泄漏；对齐 session_panel 用 group=session_id:<sid> 的 per-session 路由模式）.
 *
 * 事件 shape（panorama_http.md §4.2）：
 *   - panorama_entity_update：create/update/transition 后
 *   - panorama_schema_update：define 后
 *
 * 复用现有 SSE 基建（GET /sse + POST /sse/subscribe）——emit 走 ReplayableEventBus，
 * SseChannel 订阅时建 dispatcher fan-out（与 session_meta/session_panel 同一套机制，不另起通道）.
 *
 * 发射器（broadcaster）拿 bus（非 sseChannel）：与 session-meta-broadcaster /
 * workspace-change-emitter 同款——emit 是 bus 侧能力，channel 只管订阅 fan-out.
 */
import type { ReplayableEventBus } from '../../../agent/event-hub';
// 单一来源：bootstrap-bus-phase 定义 + 导出（注册点）；此处 re-export 保持模块对外符号不变
import { PANORAMA_TOPIC } from '../../../bootstrap-bus-phase';

export { PANORAMA_TOPIC };

/** panorama SSE 事件类型 */
export type PanoramaSseEventType = 'panorama_entity_update' | 'panorama_schema_update';

/** panorama per-squad group（bus 路由键；前端 subscribe 传此 group） */
export function panoramaGroup(squadId: string): string {
  return `panorama:squad:${squadId}:entity`;
}

/** panorama_entity_update 事件 payload（panorama_http.md §4.2） */
export interface PanoramaEntityUpdateEvent {
  type: 'panorama_entity_update';
  squadId: string;
  entity: string;
  action: 'created' | 'updated' | 'transitioned' | 'deleted';
  id: string;
  record: Record<string, unknown>;
  /** transition 时带 from/to */
  transition?: { from: string; to: string };
  source: 'agent' | 'drag' | 'api';
  seq: number;
}

/** panorama_schema_update 事件 payload（panorama_http.md §4.3） */
export interface PanoramaSchemaUpdateEvent {
  type: 'panorama_schema_update';
  squadId: string;
  seq: number;
}

/**
 * 推送一条 panorama 事件到 SSE（经 panorama bus emit 到 per-squad group）.
 *
 * @param bus      panorama topic 的 ReplayableEventBus（bootstrap-bus-phase 注册）
 * @param squadId  目标 squad
 * @param event    事件 payload（panorama_entity_update / panorama_schema_update）
 */
export function emitPanoramaEvent(
  bus: ReplayableEventBus | undefined | null,
  squadId: string,
  event: PanoramaEntityUpdateEvent | PanoramaSchemaUpdateEvent,
): void {
  if (!bus) return; // bus 未注入（standalone / 测试）→ 静默跳过，不阻塞写操作
  bus.emit(panoramaGroup(squadId), {
    data: event,
    timestamp: new Date().toISOString(),
  });
}
