/**
 * scheduling 子系统公共类型契约（纯调度接口）。
 * 参考: specs/tech/scheduling/[P0]job_registry.md §1-§4
 *       specs/tech/scheduling/index.md §④ 核心原则 1（引擎不感知业务）
 *
 * 设计：
 *   - 本文件是纯调度契约，不含业务层语义字段（scheduler 纯度硬性 grep 约束）
 *   - Job.payload = unknown — 业务 payload schema 在 payloads.ts 定义
 *   - engine.ts/registry.ts 仅依赖本文件 + active-window.ts + cron-expr.ts
 */

/** 活跃时段（HH:mm 24h padded；start>end 表示跨午夜窗口，如 22:00-06:00） */
export interface ActiveWindow {
  /** 起始 "HH:mm"（含） */
  start: string;
  /** 结束 "HH:mm"（不含） */
  end: string;
}

/**
 * interval 调度（heartbeat / cron interval 用；ms 间隔 + 可选活跃窗口）。
 * [v0.0.116] heartbeat activeWindows 多段业务 gate **全下沉 HeartbeatHandler.tryFire gate1**，
 * engine 不引 activeWindows[]（开放点1：引擎纯度守护，index.md §④原则1）。
 * activeWindow? 单段字段保留作 engine 层可选配置（heartbeat 不再使用）。
 */
export interface IntervalSchedule {
  kind: 'interval';
  /** 间隔毫秒数 */
  ms: number;
  /** 可选活跃窗口（engine 层单段；heartbeat 多段 activeWindows 下沉 handler，不进此字段） */
  activeWindow?: ActiveWindow;
  /** 窗口判定时区（IANA），缺省 UTC */
  tz?: string;
}

/** cron 调度（cron 用；5 字段 expr + 必填 IANA 时区） */
export interface CronSchedule {
  kind: 'cron';
  /** 5 字段 cron expr（minute hour dom month dow） */
  expr: string;
  /** IANA 时区（必填，cron 在该时区本地字段下解析） */
  tz: string;
}

export type Schedule = IntervalSchedule | CronSchedule;

/** handler 路由键（开放枚举：'heartbeat' | 'cron' | ...，按需扩） */
export type JobType = string;

/**
 * Job 注册项 — engine 透明数据载体。
 * payload 业务 schema 在 payloads.ts 定义；engine 不解释 payload 内容。
 */
export interface Job {
  /** 全局唯一 id（约定 type-prefix:owner:sub-id，engine 不校验） */
  id: string;
  /** handler 路由键（registry 按 type 路由 handler） */
  type: JobType;
  /** 调度配置（discriminated union，决定 isDue 双分支） */
  schedule: Schedule;
  /** 业务 payload（handler 自定义 schema，engine 不解释） */
  payload: unknown;
  /** 最近一次 fire 的 ISO 时刻；null=从未触发（首次排法锚 createdAt） */
  lastFiredAt: string | null;
  /** enabled 开关；false → engine tick 跳过（cron action=disable / pause 用） */
  enabled: boolean;
  /** 创建时刻 ISO（cron 首次 isDue 锚点；interval 首次排法不用） */
  createdAt: string;
  /** 持久化分片键（按 owner 分片落盘；engine 不感知 owner 语义） */
  owner: string;
}

/**
 * JobHandler 接口（fire-and-forget 友好）。
 * engine.tick 内 `void handler.fire(job, now).catch(()=>{})`，不 await。
 *
 * 实现约束（MANDATORY）：
 *   - 内部含完整 gate chain + deliverTo
 *   - gate 通过 + deliverTo 成功 → 调 engine.updateJobLastFiredAt(job.id, now)
 *   - gate 失败 → 不调 updateJobLastFiredAt（保旧 lastFiredAt，下 tick 重试）
 *   - 异常 try/catch 自吞（engine 已 .catch 但 handler 内部仍应 try/catch 防 reject）
 *
 * @param job  当前 job（engine 保证 job.enabled=true 且 isDue=true 才调）
 * @param now  engine 单一时间源（每 tick 一次，传给所有 due job）
 */
export interface JobHandler {
  fire(job: Job, now: Date): Promise<void>;
}

/**
 * PersistenceAdapter 接口（按 owner 分片落盘）。
 * 双实现：HeartbeatPersistenceAdapter（scheduler.json）/ CronPersistenceAdapter（cron.json）。
 * engine 不直接依赖 PersistenceAdapter；boot loader + handler / API 调用。
 */
export interface PersistenceAdapter {
  /** 读 owner 全量 jobs（boot loader 调） */
  loadJobs(owner: string): Promise<Job[]>;
  /** 写/替单 job（fire 后 lastFiredAt 更新 + create/update 调） */
  upsertJob(owner: string, job: Job): Promise<void>;
  /** 删单 job（delete / disable 永久删时调） */
  removeJob(owner: string, jobId: string): Promise<void>;
  /** 删 owner 全部 jobs（销毁时调） */
  removeAllJobs(owner: string): Promise<void>;
}
