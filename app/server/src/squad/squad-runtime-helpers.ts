/**
 * squad-runtime helpers — 投影函数 + SchedulerFacade + Job 构造（从 squad-runtime.ts 拆出）。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §5（squad-runtime 改造点）
 *       specs/tech/squad/[P1]data_model.md §1.1a（SquadHeartbeatConfig）
 *
 * [v0.0.116] per-member → squad 级心跳：
 *   - 新增 buildSquadHeartbeatJob（squad 级 job 构造）
 *   - 新增 projectSquadHeartbeatConfig（squad 心跳配置投影 + 默认值填充）
 *   - heartbeatJobId 改单参（squadId）
 *   - projectSquadSnapshot 加 heartbeatConfig 字段
 *   - 删 buildHeartbeatJob/projectMemberHeartbeat（per-member 废弃）
 *   - SchedulerFacade 去 reloadRole（per-member 废弃）
 */
import type { SquadEntity } from '../stores/squad-store';
import type { Job } from '../scheduling/types';
import type { HistoryEntry } from './scheduler/scheduler-history';
import type { SquadSnapshot, SquadHeartbeatConfig } from './scheduler/types';

/**
 * Squad record → scheduler 投影（仅取 scheduler 关心字段）。
 * [v0.0.116] 新增 heartbeatConfig 字段。
 */
export function projectSquadSnapshot(squad: SquadEntity): SquadSnapshot {
  return {
    enableHeartBeat: squad.enableHeartBeat === true,
    budget: squad.budget as SquadSnapshot['budget'],
    timezone: (squad as SquadEntity & { timezone?: string }).timezone ?? 'UTC',
    // heartbeatConfig：cast 前向兼容旧 squad 无字段（null=默认，handler 走 ??）
    heartbeatConfig: ((squad as SquadEntity & { heartbeatConfig?: SquadHeartbeatConfig | null }).heartbeatConfig) ?? null,
  };
}

/**
 * 默认 SquadHeartbeatConfig（heartbeatConfig=null 时使用）。
 * interval=15min / 全天 / 全员 all。
 */
const DEFAULT_HEARTBEAT_CONFIG: SquadHeartbeatConfig = {
  interval: 15,
  activeWindows: [],
  scope: { mode: 'all', memberIds: [] },
};

/**
 * [v0.0.116] 读 squad.heartbeatConfig + timezone，供 adapter.getHeartbeatConfig 注入。
 * null = squad 不存在（不是 heartbeatConfig=null）→ adapter.loadJobs 返 []。
 * heartbeatConfig=null → 走默认 interval15/全天/all。
 *
 * @param squad squad 实体；null = squad 不存在
 */
export function projectSquadHeartbeatConfig(
  squad: SquadEntity | null | undefined,
): { config: SquadHeartbeatConfig; tz: string } | null {
  if (!squad) return null;
  const tz = (squad as SquadEntity & { timezone?: string }).timezone ?? 'UTC';
  const raw = (squad as SquadEntity & { heartbeatConfig?: SquadHeartbeatConfig | null }).heartbeatConfig;
  const config = raw ?? DEFAULT_HEARTBEAT_CONFIG;
  return { config, tz };
}

/**
 * [v0.0.116] heartbeat job id（squad 级，单参）。
 * 格式：`heartbeat:<squadId>`（全局唯一；多 squad 隔离）。
 */
export function heartbeatJobId(squadId: string): string {
  return `heartbeat:${squadId}`;
}

/**
 * [v0.0.116] 构造 squad 级 heartbeat Job。
 * 一个 squad 一个 job（id=`heartbeat:<squadId>`）。
 * schedule.activeWindow 不设（activeWindows 多段业务 gate 下沉 HeartbeatHandler.tryFire gate1）。
 *
 * @param squadId     归属 squad
 * @param config      SquadHeartbeatConfig（含 interval/activeWindows/scope）
 * @param tz          squad timezone（IANA）
 * @param lastFiredAt 续接语义；null=首次排法
 */
export function buildSquadHeartbeatJob(
  squadId: string,
  config: SquadHeartbeatConfig,
  tz: string,
  lastFiredAt: string | null,
): Job {
  return {
    id: heartbeatJobId(squadId),
    type: 'heartbeat',
    schedule: {
      kind: 'interval',
      ms: (config.interval ?? 15) * 60_000,
      // activeWindow 不设：activeWindows 多段 gate 下沉 HeartbeatHandler（开放点1，engine 纯度守护）
      tz,
    },
    payload: { squadId },
    lastFiredAt,
    enabled: true,
    createdAt: lastFiredAt ?? new Date().toISOString(),
    owner: squadId,
  };
}

/**
 * SchedulerFacade — SquadRuntime.getScheduler 返回的 thin facade（handler 兼容）。
 * [v0.0.116] 去 reloadRole（per-member 心跳废弃）；保留 getHistory。
 */
export interface SchedulerFacade {
  /** 读 squad history（透传到 SchedulerHistory.getHistory） */
  getHistory(limit?: number, roleId?: string): HistoryEntry[];
}

/** 构造 thin facade（squad-runtime 内部用；闭包绑定 squadId） */
export function makeSchedulerFacade(
  getHistory: (limit?: number, roleId?: string) => HistoryEntry[],
): SchedulerFacade {
  return { getHistory };
}
