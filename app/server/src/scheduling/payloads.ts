/**
 * scheduling 子系统业务 payload schema（handler 内消费）。
 * 参考: specs/tech/scheduling/[P0]job_registry.md §1（Payload schema）
 *
 * 设计：
 *   - 与 types.ts 分离：types.ts 是纯调度契约（不含 squad/budget/session 字样，
 *     满足 engine.ts/registry.ts/types.ts grep 纯度约束）；本文件含业务字段。
 *   - engine 不消费 payload；handler 内部 downcast job.payload as HeartbeatPayload/CronPayload。
 */

/**
 * heartbeat 业务载荷（[v0.0.116] squad 级统一心跳，去 memberId/sessionId）。
 * HeartbeatHandler.fire 内部 downcast 读取。
 * 成员在 tryFire 时按 squad.heartbeatConfig.scope 展开，不进 payload。
 */
export interface HeartbeatPayload {
  /** 所属 squad id（落盘寻址键；squad 级 job 唯一标识） */
  squadId: string;
}

/**
 * cron 业务载荷（cron.json entry 同字段 + sessionId 派生）。
 * CronHandler.fire 内部 downcast 读取。
 */
export interface CronPayload {
  /** owner session（playground / leader / mate） */
  sessionId: string;
  /** 用户可读名（UI 列表展示） */
  name: string;
  /** 到点投递的提示词（cron message content） */
  prompt: string;
  /** session 所属 squad id；null=playground 无 budget gate */
  squadId: string | null;
}

/**
 * consolidation 业务载荷（app 级单例 job 用）。
 * 刻意保持空——三段整理工作的所有输入（modelId/容量上限等）都从 app_config.consolidation
 * 现读，不进 payload 快照（避免 payload 与配置出现两份真相，见 [P1]consolidation_job.md §2）。
 */
export interface ConsolidationPayload {}
