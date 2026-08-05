/**
 * cron-api —— cron UI HTTP 端点 CRUD 薄封装（v0.0.58 T5）
 * 参考: specs/api/overall/16-cron.md §2（6 UI HTTP 端点）+ §4（CronJobSummary）
 *
 * UI 与 agent 工具正交：UI 走 /session/:sid/cron/* HTTP；agent 工具走 cron_create/list/...，
 * 两者共享底层 CronStore + engine。
 *
 * 所有端点都在 path 显式带 sessionId（agent 工具是自动取 ctx.session.id；UI 必须显式传）。
 */
import { req } from './api-client';

/** cron job 摘要（对齐 specs/api/overall/16-cron.md §4 CronJobSummary） */
export interface CronJobSummary {
  id: string;
  sessionId: string;
  name: string;
  cron: string;
  tz: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  /** 现算：computeNextCronRunMs；enabled=false → null */
  nextFireAt: string | null;
}

/** POST 新建入参（对齐 CreateCronBody） */
export interface CreateCronInput {
  cron: string;
  prompt: string;
  name?: string;
  enabled?: boolean;
  /**
   * 客户端本地 IANA 时区（v0.0.58.cron-fix2）。
   * 调用方传 `Intl.DateTimeFormat().resolvedOptions().timeZone`（如 Asia/Shanghai）。
   * server schedule.tz 优先用此值；缺省 → server resolveTz fallback（session→squad→server）。
   */
  timezone?: string;
}

/** PATCH 更新入参（对齐 UpdateCronBody；不含 enabled/tz） */
export interface UpdateCronInput {
  cron?: string;
  prompt?: string;
  name?: string;
}

/**
 * GET /session/:sid/cron —— 列 cron jobs（含 nextFireAt 现算）。
 */
export async function listCronJobs(sessionId: string, base?: string): Promise<CronJobSummary[]> {
  const r = await req<{ items: CronJobSummary[] }>(
    `/session/${encodeURIComponent(sessionId)}/cron`,
    undefined,
    base,
  );
  return r.items ?? [];
}

/**
 * POST /session/:sid/cron —— 新建 cron job（201 / 400 expr 非法 / 404 session 不存在）。
 * body 透传 input（含 input.timezone 时 server 用 client local 作 schedule.tz）。
 */
export async function createCronJob(
  sessionId: string,
  input: CreateCronInput,
  base?: string,
): Promise<CronJobSummary> {
  return req<CronJobSummary>(
    `/session/${encodeURIComponent(sessionId)}/cron`,
    { method: 'POST', body: JSON.stringify(input) },
    base,
  );
}

/**
 * PATCH /session/:sid/cron/:jid —— 更新 cron/prompt/name（不含 enabled）。
 */
export async function updateCronJob(
  sessionId: string,
  jobId: string,
  patch: UpdateCronInput,
  base?: string,
): Promise<CronJobSummary> {
  return req<CronJobSummary>(
    `/session/${encodeURIComponent(sessionId)}/cron/${encodeURIComponent(jobId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    base,
  );
}

/**
 * POST /session/:sid/cron/:jid/disable —— enabled=false（disabled 期间 isDue 也跳过）。
 */
export async function disableCronJob(
  sessionId: string,
  jobId: string,
  base?: string,
): Promise<{ id: string; enabled: boolean }> {
  return req(
    `/session/${encodeURIComponent(sessionId)}/cron/${encodeURIComponent(jobId)}/disable`,
    { method: 'POST' },
    base,
  );
}

/**
 * POST /session/:sid/cron/:jid/enable —— enabled=true（不重置 lastFiredAt 保续接）。
 */
export async function enableCronJob(
  sessionId: string,
  jobId: string,
  base?: string,
): Promise<{ id: string; enabled: boolean }> {
  return req(
    `/session/${encodeURIComponent(sessionId)}/cron/${encodeURIComponent(jobId)}/enable`,
    { method: 'POST' },
    base,
  );
}

/**
 * DELETE /session/:sid/cron/:jid —— 永久删（engine.unregister + cronStore.removeJob）。
 */
export async function deleteCronJob(
  sessionId: string,
  jobId: string,
  base?: string,
): Promise<{ id: string; deleted: boolean }> {
  return req(
    `/session/${encodeURIComponent(sessionId)}/cron/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
    base,
  );
}
