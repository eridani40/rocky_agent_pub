/**
 * CronPersistenceAdapter — cron.json 持久化（session 级分片）。
 * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §3（权威契约 + CronFile schema）
 *       specs/tech/scheduling/[P0]job_registry.md §1（PersistenceAdapter 接口）
 *
 * 设计：
 *   - 路径 {fsRoot}/sessions/{sessionId}/cron.json（与 session-store 删 sessions/{sid}/ 同约定）
 *   - schema {version:1, sessionId, jobs:CronFileEntry[]}（v0.0.58 定义，原子写）
 *   - loadJobs 转 Job[]（id=`cron:${sessionId}:${entry.id}`，squadId 派生自 sessionStore）
 *   - 原子写复用 persistence/fs-io.ts:atomicWriteSync（与 scheduler.json 同机制，零新代码）
 *   - read-modify-write 全量；单 session 预期 jobs < 10，性能足够
 *
 * squadId 派生：通过注入的 resolveSquadId 回调（T6 装配时 wire 到 sessionStore.getSession
 *   → s?.squadId ?? null），避免 scheduling → agent → scheduling 循环依赖。
 */
import { join } from 'node:path';
import type { Job, PersistenceAdapter } from '../types';
import type { CronPayload } from '../payloads';
import {
  atomicWriteSync,
  readJsonFileSync,
  removeFileSync,
  ensureDirSync,
} from '../../persistence/fs-io';

/** cron.json 文件 schema（v0.0.58 定义，spec §3 权威） */
export interface CronFile {
  /** schema 版本（v0.0.58 = 1） */
  version: 1;
  /** 所属 session（与路径段一致，self-describing） */
  sessionId: string;
  /** 该 session 的全部 cron entries */
  jobs: CronFileEntry[];
}

/** cron.json 单条 entry schema（spec §3） */
export interface CronFileEntry {
  /** cronJobId（不含 sessionId 前缀；session 内唯一；Job.id = `cron:${sessionId}:${id}`） */
  id: string;
  /** 5 字段 cron expr（minute hour dom month dow） */
  cron: string;
  /** IANA 时区 */
  tz: string;
  /** 用户可读名 */
  name: string;
  /** 到点投递的提示词 */
  prompt: string;
  /** 启用开关 */
  enabled: boolean;
  /** 创建时刻 ISO */
  createdAt: string;
  /** 最近 fire ISO；null=从未触发（首次排法锚 createdAt） */
  lastFiredAt: string | null;
}

/** CronPersistenceAdapter 依赖（构造注入；T6 bootstrap 装配，UT 用 mock） */
export interface CronPersistenceAdapterDeps {
  /** fs root（与 session-store.fsRoot 同源；cron.json 落 {root}/sessions/{sid}/cron.json） */
  fsRoot: string;
  /**
   * 按 sessionId 派生 squadId（scheduling 不直接依赖 SessionStore，避免循环依赖）。
   * T6 装配 wire 到 sessionStore.getSession(sid)?.squadId ?? null。
   * 返 null = playground（无 squad budget gate）。
   */
  resolveSquadId(sessionId: string): Promise<string | null>;
}

/**
 * CronPersistenceAdapter — cron job 的持久化适配器。
 * 实现 PersistenceAdapter 接口（owner=sessionId），cron.json 单文件 per session。
 */
export class CronPersistenceAdapter implements PersistenceAdapter {
  constructor(private readonly deps: CronPersistenceAdapterDeps) {}

  /** cron.json 绝对路径（{fsRoot}/sessions/{sessionId}/cron.json） */
  private filePath(sessionId: string): string {
    return join(this.deps.fsRoot, 'sessions', sessionId, 'cron.json');
  }

  /**
   * 读 session 全量 cron jobs（boot loader / cron action=list 调）。
   * 无文件 → 空；squadId 通过 resolveSquadId 回调派生（playground=null）。
   */
  async loadJobs(sessionId: string): Promise<Job[]> {
    const file = readJsonFileSync<CronFile>(this.filePath(sessionId));
    if (!file || !Array.isArray(file.jobs)) return [];
    const squadId = await this.deps.resolveSquadId(sessionId);
    return file.jobs.map((e) => entryToJob(e, sessionId, squadId));
  }

  /**
   * 写/替单 job（fire 后 lastFiredAt 更新 / cron action=create / action=update 调）。
   * read-modify-write 全量 + 原子写（atomicWriteSync：tmp+fsync+rename）。
   */
  async upsertJob(sessionId: string, job: Job): Promise<void> {
    const filePath = this.filePath(sessionId);
    const existing = readJsonFileSync<CronFile>(filePath);
    const jobs: CronFileEntry[] = existing?.jobs ?? [];
    const entry = jobToEntry(job);
    const idx = jobs.findIndex((j) => j.id === entry.id);
    if (idx >= 0) jobs[idx] = entry;
    else jobs.push(entry);
    atomicWriteSync(filePath, JSON.stringify(serializeFile(sessionId, jobs), null, 2));
  }

  /**
   * 删单 job（cron action=delete / member disable 永久删时调）。
   * read-modify-write filter out + 原子写；文件不存在静默 no-op。
   */
  async removeJob(sessionId: string, jobId: string): Promise<void> {
    const filePath = this.filePath(sessionId);
    const existing = readJsonFileSync<CronFile>(filePath);
    if (!existing || !Array.isArray(existing.jobs)) return;
    // jobId 是完整 Job.id（`cron:${sessionId}:${entryId}`），entry.id 仅是后缀
    const entryId = stripCronPrefix(jobId, sessionId);
    const next = existing.jobs.filter((j) => j.id !== entryId);
    if (next.length === existing.jobs.length) return; // 无变化不刷盘
    if (next.length === 0) {
      // 空 → 直接删文件（与 removeAllJobs 一致，避免留空 schema 文件）
      removeFileSync(filePath);
      return;
    }
    atomicWriteSync(filePath, JSON.stringify(serializeFile(sessionId, next), null, 2));
  }

  /**
   * 删 session 全部 cron jobs（session 销毁 hook 调）。
   * 直接删整个 cron.json 文件；不存在静默 no-op。
   */
  async removeAllJobs(sessionId: string): Promise<void> {
    removeFileSync(this.filePath(sessionId));
  }

  // ── helper：本类对外导出 ensureDirSync 用于 T6 boot 预创建 sessions/ 目录（可选） ──
  /** 触发 sessions/{sid}/ 目录创建（幂等；upsertJob 内 atomicWriteSync 已自动 mkdir） */
  static ensureSessionDir(fsRoot: string, sessionId: string): void {
    ensureDirSync(join(fsRoot, 'sessions', sessionId));
  }
}

// ── 纯函数 helper（UT 直接 import 测） ──────────────────────────────────

/** 序列化 CronFile（统一字段顺序，便于 diff 稳定） */
function serializeFile(sessionId: string, jobs: CronFileEntry[]): CronFile {
  return { version: 1, sessionId, jobs };
}

/** Job.id（`cron:${sessionId}:${entryId}`）→ entry.id（仅后缀） */
function stripCronPrefix(jobId: string, sessionId: string): string {
  const prefix = `cron:${sessionId}:`;
  return jobId.startsWith(prefix) ? jobId.slice(prefix.length) : jobId;
}

/** CronFileEntry → Job（squadId 由 caller 派生注入） */
export function entryToJob(entry: CronFileEntry, sessionId: string, squadId: string | null): Job {
  const payload: CronPayload = {
    sessionId,
    name: entry.name,
    prompt: entry.prompt,
    squadId,
  };
  return {
    id: `cron:${sessionId}:${entry.id}`,
    type: 'cron',
    schedule: { kind: 'cron', expr: entry.cron, tz: entry.tz },
    payload,
    lastFiredAt: entry.lastFiredAt,
    enabled: entry.enabled,
    createdAt: entry.createdAt,
    owner: sessionId,
  };
}

/** Job → CronFileEntry（剥离 sessionId/squadId；schema 不存 squadId — 派生字段） */
export function jobToEntry(job: Job): CronFileEntry {
  const p = job.payload as CronPayload;
  // schedule.kind === 'cron' 由 caller 保证（cron-handler 不接 interval job）
  const schedule = job.schedule as { kind: 'cron'; expr: string; tz: string };
  // entry.id = Job.id 去掉 `cron:${sessionId}:` 前缀
  const entryId = stripCronPrefix(job.id, p.sessionId);
  return {
    id: entryId,
    cron: schedule.expr,
    tz: schedule.tz,
    name: p.name,
    prompt: p.prompt,
    enabled: job.enabled,
    createdAt: job.createdAt,
    lastFiredAt: job.lastFiredAt,
  };
}
