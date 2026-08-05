/**
 * squad/scheduler 投影类型 — scheduler 层数据接口。
 * 参考: specs/tech/squad/[P1]scheduler.md §1（SquadSnapshot）
 *       specs/tech/scheduling/[P1]heartbeat_handler.md §2（HeartbeatHandler.deps 入参）
 *       specs/tech/squad/[P1]data_model.md §1.1a（SquadHeartbeatConfig）
 *
 * [v0.0.116] per-member → squad 级心跳：
 *   - SquadSnapshot 新增 heartbeatConfig 字段（handler gate1/scope 读）
 *   - 新增 SquadHeartbeatConfig（squad 级心跳配置投影副本）
 *   - 新增 MemberSnapshot（handler listMembers 逐成员展开用）
 *   - RoleHeartbeat 删除（per-member 投影废弃，无 caller）
 *
 * 设计：纯 interface 文件，无 runtime 代码；多模块共享（squad-runtime / heartbeat-handler /
 *   heartbeat-adapter / 测试 mock）。
 */

/**
 * squad 级心跳配置（data_model §1.1a 字段一致）。
 * null = 未配置，走默认 interval=15/全天/all。
 */
export interface SquadHeartbeatConfig {
  /** 唤醒间隔（分钟）；枚举 5/15/30/60 */
  interval: number;
  /** 活跃时段列表（空=全天放行）；每段 HH:mm，start<end（不跨0点） */
  activeWindows: Array<{ start: string; end: string }>;
  /** 范围：all=全员（默认）；whitelist=仅 memberIds 列表 */
  scope: {
    mode: 'all' | 'whitelist';
    memberIds: string[];
  };
}

/**
 * squad record 投影（scheduler 关心的字段）。
 * HeartbeatHandler.deps.getSquad 返回此类型；squad-runtime.projectSquadSnapshot 投影产出。
 */
export interface SquadSnapshot {
  /** 心跳总开关（killswitch，每 tick 现取；false 短路 tryFire 返 skipped_killswitch） */
  enableHeartBeat: boolean;
  /** squad budget；null=未配=Gate 放行（gate2 short-circuit） */
  budget: { limit: number; window: 'daily'; scope: 'team' } | null;
  /** IANA 时区（activeWindows 判定用；缺省 UTC） */
  timezone?: string;
  /** [v0.0.116] squad 级心跳配置；null=默认（interval15/全天/all） */
  heartbeatConfig: SquadHeartbeatConfig | null;
}

/**
 * member 投影（handler listMembers 逐成员展开用，[v0.0.116] 新增）。
 * 含 scope filter 所需字段：id/sessionId/state/role。
 */
export interface MemberSnapshot {
  /** member id（scope whitelist 判定用） */
  id: string;
  /** member 对应 session id；无则跳过（SquadChat 无 member 天然排除） */
  sessionId?: string;
  /** 部署状态：deployed=可唤醒；benched=任何模式跳过 */
  state: 'deployed' | 'benched';
  /** 角色（leader/mate/squad-chat）*/
  role: string;
}
