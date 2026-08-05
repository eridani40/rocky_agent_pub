/**
 * cron 工具共享层 — CronToolDeps + run* 实现 + helper（cron-tool.ts 6 Tool 定义调）。
 * 参考: specs/api/overall/16-cron.md §3 / specs/tech/scheduling/[P1]cron_subsystem.md §6
 *
 * 本文件含 helper + 6 run* 实现（cron-tool.ts 是 6 Tool 定义 + dispatch）；UI HTTP handler 也复用 helper。
 */
import type { ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult, textResult } from '../types';
import { ulid } from '../../config/ulid';
import { parseCronExpression } from '../../scheduling/cron-expr';
import { computeNextCronRunMs } from '../../scheduling/cron-next';
import type { CronPersistenceAdapter } from '../../scheduling/persistence/cron-adapter';
import type { SchedulerEngine } from '../../scheduling/engine';
import type { SessionStore } from '../../agent/session-store';
import type { SquadStore } from '../../stores/squad-store';
import type { Job } from '../../scheduling/types';
import type { CronPayload } from '../../scheduling/payloads';
import type { CronJobSummary } from './types';

// === 1. CronToolDeps（ctx.config.cronToolDeps 注入） ===

/**
 * cron 工具运行时依赖（鸭子类型；ctx.config.cronToolDeps as this）。
 * cronStore/engine 与 UI HTTP 共享同一实例，经 session-config 注入。
 */
export interface CronToolDeps {
  cronStore: CronPersistenceAdapter;
  engine: SchedulerEngine;
  sessionStore: SessionStore;
  squadStore: SquadStore;
}

/** 从 ctx.config.cronToolDeps 收敛 CronToolDeps（缺省 → null，工具报 RUNTIME_ERROR）。 */
export function resolveDeps(ctx: ToolCtx): CronToolDeps | null {
  const d = (ctx.config as { cronToolDeps?: unknown }).cronToolDeps;
  if (
    d &&
    typeof d === 'object' &&
    typeof (d as { cronStore?: unknown }).cronStore === 'object' &&
    typeof (d as { engine?: unknown }).engine === 'object' &&
    typeof (d as { sessionStore?: unknown }).sessionStore === 'object' &&
    typeof (d as { squadStore?: unknown }).squadStore === 'object'
  ) {
    return d as CronToolDeps;
  }
  return null;
}

/** 当前 session id（ctx.config.sessionId；缺省 → null，工具返 INVALID_INPUT）。 */
export function resolveSessionId(ctx: ToolCtx): string | null {
  const sid = (ctx.config as { sessionId?: unknown }).sessionId;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

// === 2. 共享 helper（tz 解析 + Job 构建 + CronJobSummary 派生） ===

/** 进程本地时区兜底（与 budget-aggregator DEFAULT_TIMEZONE 一致） */
export const LOCAL_TZ =
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

/** CronToolDeps / CronRouteDeps 共有的 tz 解析依赖形状（鸭子类型，两者均满足） */
interface TzResolveDeps {
  sessionStore: { getSession(id: string): Promise<{ timezone?: string; squadId?: string } | null> };
  squadStore: { getSquad(id: string): Promise<unknown> };
}

/** 解析 session.timezone → squad.timezone → 进程本地（cron_subsystem §5）；session 不存在返 null。UI HTTP + agent 工具共享。 */
export async function resolveTz(
  deps: TzResolveDeps,
  sessionId: string,
): Promise<{ tz: string; squadId: string | null } | null> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return null;
  if (session.timezone && session.timezone.trim()) {
    return { tz: session.timezone, squadId: session.squadId ?? null };
  }
  if (session.squadId) {
    const squad = await deps.squadStore.getSquad(session.squadId);
    const squadTz = (squad as { timezone?: string } | undefined)?.timezone;
    if (squadTz && squadTz.trim()) {
      return { tz: squadTz, squadId: session.squadId };
    }
  }
  return { tz: LOCAL_TZ, squadId: session.squadId ?? null };
}

/**
 * 构造 cron Job 实例（UI HTTP handleCreate + agent 工具 runCreate 共享，spec §3.3 两路径同 schema）。
 * id=`cron:${sessionId}:${ulid()}`；schedule.tz=tz；owner=sessionId；lastFiredAt=null（新建必为 null）。
 */
export function buildCronJob(args: {
  sessionId: string;
  cron: string;
  prompt: string;
  name: string;
  enabled: boolean;
  tz: string;
  squadId: string | null;
}): Job {
  const { sessionId, cron, prompt, name, enabled, tz, squadId } = args;
  const entryId = ulid();
  const jobId = `cron:${sessionId}:${entryId}`;
  const now = new Date().toISOString();
  const payload: CronPayload = { sessionId, name, prompt, squadId };
  return {
    id: jobId,
    type: 'cron',
    schedule: { kind: 'cron', expr: cron, tz },
    payload,
    lastFiredAt: null,
    enabled,
    createdAt: now,
    owner: sessionId,
  };
}

/** 现算 nextFireAt ISO（enabled=false → null；computeNextCronRunMs 返 null → null） */
function computeNextFireAt(job: Job): string | null {
  if (!job.enabled) return null;
  const schedule = job.schedule as { kind: 'cron'; expr: string; tz: string };
  const anchorMs = job.lastFiredAt ? Date.parse(job.lastFiredAt) : Date.parse(job.createdAt);
  if (Number.isNaN(anchorMs)) return null;
  const next = computeNextCronRunMs(schedule.expr, new Date(anchorMs), schedule.tz);
  return next === null ? null : new Date(next).toISOString();
}

/** Job → CronJobSummary（spec §4 形态；现算 nextFireAt）。UI HTTP 也用此函数（共享形态）。 */
export function toSummary(job: Job): CronJobSummary {
  const p = job.payload as CronPayload;
  const schedule = job.schedule as { kind: 'cron'; expr: string; tz: string };
  return {
    id: job.id,
    sessionId: p.sessionId,
    name: p.name,
    cron: schedule.expr,
    tz: schedule.tz,
    prompt: p.prompt,
    enabled: job.enabled,
    createdAt: job.createdAt,
    lastFiredAt: job.lastFiredAt,
    nextFireAt: computeNextFireAt(job),
  };
}

/** 校验 cron expr 合法（parseCronExpression 返 null=非法） */
export function isValidCronExpr(expr: string): boolean {
  return parseCronExpression(expr) !== null;
}

/**
 * 判定 job 是否匹配 jobId 入参（健壮化匹配，UI HTTP + agent 工具共用）。
 *
 * BUG-001 背景：UI 把 `cron:sid:eid` 整体当 URL path segment，`encodeURIComponent` 把 `:`
 * 编码成 `%3A`，router `new URL().pathname` 不解码 → findJob 收到 `cron%3Asid%3Aeid`，与
 * j.id（decoded）不等 → "job not found"。修在匹配层（一处修双双过）。
 *
 * 兼容三态：① full decoded `cron:sid:eid` ② full encoded `cron%3Asid%3Aeid` ③ suffix `eid`。
 * decodeURIComponent 遇非法 % 序列会 throw，try/catch 兜底（不阻断判定）。
 */
export function jobMatches(job: Job, jobIdInput: string): boolean {
  if (job.id === jobIdInput) return true;
  try {
    const decoded = decodeURIComponent(jobIdInput);
    if (decoded !== jobIdInput && job.id === decoded) return true;
  } catch {
    // 非法 % 序列，忽略
  }
  // suffix entryId（不含 `:` 视为简写，避免误匹配其他 session 同 entryId）
  if (!jobIdInput.includes(':') && job.id.endsWith(':' + jobIdInput)) return true;
  return false;
}

/** 在 jobs 列表中找首个匹配 jobId 入参的 Job；不在 → null。 */
export function findJobById(jobs: Job[], jobIdInput: string): Job | null {
  return jobs.find((j) => jobMatches(j, jobIdInput)) ?? null;
}

/** 从弱类型 ToolInput 取 string（trim；空 → undefined） */
export function optString(input: ToolInput, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// === 3. 6 个 run* 实现（cron-tool.ts Tool 定义包装调） ===

/** cron action=create — 入参 {cron, prompt, name?, enabled?}；出参 {jobId, cron, name, nextFireAt}（spec §3）。 */
export async function runCreate(
  input: ToolInput,
  deps: CronToolDeps,
  sessionId: string,
): Promise<ToolRunResult> {
  const cron = optString(input, 'cron');
  if (!cron) return errorResult('[cron:create] cron required');
  if (!isValidCronExpr(cron)) return errorResult(`[cron:create] cron expr invalid: ${cron}`);
  const prompt = optString(input, 'prompt');
  if (!prompt) return errorResult('[cron:create] prompt required');
  const name = optString(input, 'name') ?? prompt.slice(0, 30);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;

  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return errorResult(`[cron:create] session not found: ${sessionId}`);
  const tzInfo = await resolveTz(deps, sessionId);
  // session 上一步已验存在；tzInfo 理论不为 null（防御）
  if (!tzInfo) return errorResult(`[cron:create] session not found: ${sessionId}`);
  const { tz, squadId } = tzInfo;

  const job = buildCronJob({ sessionId, cron, prompt, name, enabled, tz, squadId });
  const jobId = job.id;
  try {
    deps.engine.register(job);
    await deps.cronStore.upsertJob(sessionId, job);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errorResult(`[cron:create] internal error: ${reason}`);
  }
  const summary = toSummary(job);
  return textResult(JSON.stringify({ jobId, cron, name, nextFireAt: summary.nextFireAt }));
}

/** cron action=list — 出参 {jobs: CronJobSummary[]}（spec §3）。 */
export async function runList(
  deps: CronToolDeps,
  sessionId: string,
): Promise<ToolRunResult> {
  const jobs = await deps.cronStore.loadJobs(sessionId);
  const summaries = jobs.map(toSummary);
  return textResult(JSON.stringify({ jobs: summaries }));
}

/** cron action=update — 入参 {jobId, cron?, prompt?, name?}；enabled 不在此（用 enable/disable action）。read-modify-write + engine.register 替换。 */
export async function runUpdate(
  input: ToolInput,
  deps: CronToolDeps,
  sessionId: string,
): Promise<ToolRunResult> {
  const jobId = optString(input, 'jobId');
  if (!jobId) return errorResult('[cron:update] jobId required');
  const existing = await deps.cronStore.loadJobs(sessionId);
  const job = findJobById(existing, jobId); // BUG-001：jobMatches 兼容 encoded/suffix
  if (!job) return errorResult(`[cron:update] job not found: ${jobId}`);

  const schedule = job.schedule as { kind: 'cron'; expr: string; tz: string };
  const newCron = optString(input, 'cron');
  if (newCron !== undefined) {
    if (!isValidCronExpr(newCron)) {
      return errorResult(`[cron:update] cron expr invalid: ${newCron}`);
    }
    schedule.expr = newCron;
  }
  const p = job.payload as CronPayload;
  const newPrompt = optString(input, 'prompt');
  if (newPrompt !== undefined) p.prompt = newPrompt;
  const newName = optString(input, 'name');
  if (newName !== undefined) p.name = newName;

  const updated: Job = { ...job, schedule: { ...schedule }, payload: { ...p } };
  try {
    deps.engine.register(updated);
    await deps.cronStore.upsertJob(sessionId, updated);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errorResult(`[cron:update] internal error: ${reason}`);
  }
  const summary = toSummary(updated);
  return textResult(
    JSON.stringify({ jobId, cron: summary.cron, name: summary.name, prompt: summary.prompt }),
  );
}

/** cron action=disable / action=enable 共用 toggle — 入参 {jobId}；出参 {jobId, enabled}。不重置 lastFiredAt（保续接）。 */
export async function runToggle(
  input: ToolInput,
  deps: CronToolDeps,
  sessionId: string,
  enabled: boolean,
  action: 'enable' | 'disable',
): Promise<ToolRunResult> {
  const jobId = optString(input, 'jobId');
  if (!jobId) return errorResult(`[cron:${action}] jobId required`);
  const existing = await deps.cronStore.loadJobs(sessionId);
  const job = findJobById(existing, jobId); // BUG-001：jobMatches 兼容 encoded/suffix
  if (!job) return errorResult(`[cron:${action}] job not found: ${jobId}`);
  const updated: Job = { ...job, enabled };
  try {
    deps.engine.register(updated);
    await deps.cronStore.upsertJob(sessionId, updated);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errorResult(`[cron:${action}] internal error: ${reason}`);
  }
  return textResult(JSON.stringify({ jobId, enabled }));
}

/** cron action=delete — 入参 {jobId}；出参 {jobId, deleted:true}。engine.unregister + cronStore.removeJob；不存在 → isError。 */
export async function runDelete(
  input: ToolInput,
  deps: CronToolDeps,
  sessionId: string,
): Promise<ToolRunResult> {
  const jobId = optString(input, 'jobId');
  if (!jobId) return errorResult('[cron:delete] jobId required');
  const existing = await deps.cronStore.loadJobs(sessionId);
  const job = findJobById(existing, jobId); // BUG-001：jobMatches 兼容 encoded/suffix
  if (!job) return errorResult(`[cron:delete] job not found: ${jobId}`);
  try {
    // engine/cronStore 用 job.id（canonical decoded）；入参 jobId 可能 encoded/suffix
    deps.engine.unregister(job.id);
    await deps.cronStore.removeJob(sessionId, job.id);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errorResult(`[cron:delete] internal error: ${reason}`);
  }
  return textResult(JSON.stringify({ jobId: job.id, deleted: true }));
}
