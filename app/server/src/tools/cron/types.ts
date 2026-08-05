/**
 * cron 子系统共享 interface（UI HTTP + agent 工具共用）。
 * 参考: specs/api/overall/16-cron.md §2（UI 端点 body schema）
 *           §3（agent 工具 inputSchema / 出参）
 *           §4（CronJobSummary 共享形态）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §6（cron agent 工具表）
 *
 * 设计：
 *   - UI 端点 body 与 agent 工具 input 均收敛到 interface，避免弱类型散播
 *   - CronJobSummary 同时被 UI HTTP（list/create/update 响应体）和 cron 工具（action=list 出参）
 *     消费——同一形态保证 UI / agent 两入口对同一 job 的视图一致
 *   - nextFireAt 由 handler/tool 在响应时现算（不持久化，spec §4「现算」语义）
 */
//与前向声明的 Job/persistence 无 import 关系；纯 interface，避免循环。

/**
 * UI 端点 + agent 工具共用的 cron job 摘要形态（spec §4）。
 *
 * 字段来源：
 *   - id / sessionId / cron / tz / name / prompt / enabled / createdAt / lastFiredAt：
 *     来自 cron.json entry + 派生（id=`cron:${sessionId}:${entryId}`）
 *   - nextFireAt：handler/tool 在响应时现算（computeNextCronRunMs(cron, now, tz)），
 *     enabled=false 时=null（spec §4 + cron_subsystem §6 表注释）。
 */
export interface CronJobSummary {
  /** 全局唯一（含 session 前缀），UI 用作 key */
  id: string;
  /** 归属 session id */
  sessionId: string;
  /** 用户可读名（缺省=prompt.slice(0,30)） */
  name: string;
  /** 5 字段 cron expr（raw） */
  cron: string;
  /** IANA 时区（用于 UI 展示时区） */
  tz: string;
  /** 到点投递的提示词 */
  prompt: string;
  /** 启用开关 */
  enabled: boolean;
  /** 创建时刻 ISO */
  createdAt: string;
  /** 最近一次 fire ISO；null=从未触发 */
  lastFiredAt: string | null;
  /** 现算下次到点 ISO；enabled=false 时=null */
  nextFireAt: string | null;
}

/**
 * POST /session/:sessionId/cron 请求体（spec §2.2）。
 * cron 工具 action=create 入参子集同此（不含 sessionId / timezone）。
 */
export interface CreateCronBody {
  /** 5 字段 cron expr；校验 parseCronExpression(cron) !== null */
  cron: string;
  /** 必填，非空 */
  prompt: string;
  /** 可选，缺省 = prompt.slice(0,30) */
  name?: string;
  /** 可选，缺省 true */
  enabled?: boolean;
  /**
   * 可选 IANA 时区（如 Asia/Shanghai）。
   *
   * 取值来源与 fallback：
   *   - UI HTTP：前端建 cron 时取客户端本地 tz
   *     （`Intl.DateTimeFormat().resolvedOptions().timeZone`）传入——「全局用本地 timezone
   *     随时取用」，每次建 cron 现取当前 client tz，不存 session。
   *   - 缺省（含 agent cron 工具 action=create，agent 不知道 client tz）→ handler 走 resolveTz
   *     fallback：session.timezone → squad.timezone → server 进程本地。
   *
   * 注：cron 工具不暴露此字段（agent 无法感知用户时区，仍用 fallback）。
   */
  timezone?: string;
}

/**
 * PATCH /session/:sessionId/cron/:jobId 请求体（spec §2.3）。
 * cron 工具 action=update 入参子集同此。
 *
 * 注意：enabled 不在 PATCH（用 dedicated enable/disable 端点）；
 *       tz 不可改（绑 session.timezone，UI/agent 均不传）。
 */
export interface UpdateCronBody {
  /** 可选；校验合法性 */
  cron?: string;
  /** 可选 */
  prompt?: string;
  /** 可选 */
  name?: string;
}
