/**
 * ConsolidationPersistenceAdapter —— {dataDir}/consolidation/state.json 持久化（app 级单例分片）。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §2.1（两处分离存储设计）
 *       specs/tech/scheduling/[P0]job_registry.md §1（PersistenceAdapter 接口）
 *
 * 设计：
 *   - 落盘路径固定 {fsRoot}/consolidation/state.json（app 级单例，无 per-owner 分片——owner 恒为 'app'）
 *   - jobs[] 直接存整个序列化 Job（含 schedule/payload/lastFiredAt/enabled/createdAt），
 *     boot 重启后靠 lastFiredAt 续接 at-most-once 语义（同 cron/heartbeat 落盘范式）
 *   - lastResult 独立字段：{lastRunAt, summary}，与 app_config.consolidation（用户配置）完全分离
 *     ——防 UI 保存 dailyTime 时的 read-modify-write 覆盖系统执行状态（spec §2.1 理由）
 *   - readLastResult 同步方法（供 handleConsolidationStatus 的同步 Response 签名用）；
 *     PersistenceAdapter 契约方法（loadJobs/upsertJob/removeJob/removeAllJobs）沿用 async 签名
 */
import { join } from 'node:path';
import type { Job, PersistenceAdapter } from '../types';
import { atomicWriteSync, readJsonFileSync } from '../../persistence/fs-io';

/** 上次整理结果（GET /consolidation/status + test-only 端点共用的只读投影） */
export interface ConsolidationLastResult {
  lastRunAt: string;
  summary: string;
}

/** consolidation/state.json 文件 schema */
export interface ConsolidationStateFile {
  version: 1;
  /** app 级单例 job（预期 0 或 1 条；owner 恒 'app'） */
  jobs: Job[];
  /** 上次整理的轻量可见性摘要；无历史为 null */
  lastResult: ConsolidationLastResult | null;
}

/** ConsolidationPersistenceAdapter 依赖（构造注入） */
export interface ConsolidationPersistenceAdapterDeps {
  /** fs root（与 dataDir 同源；state.json 落 {root}/consolidation/state.json） */
  fsRoot: string;
}

/**
 * ConsolidationPersistenceAdapter —— consolidation job 的持久化适配器（app 级单例）。
 * 实现 PersistenceAdapter 接口；owner 恒 'app'，无 per-owner 分片（与 cron/heartbeat 的
 * per-session/per-squad 分片不同，consolidation 全进程只有一份 state.json）。
 */
export class ConsolidationPersistenceAdapter implements PersistenceAdapter {
  constructor(private readonly deps: ConsolidationPersistenceAdapterDeps) {}

  /** state.json 绝对路径（{fsRoot}/consolidation/state.json） */
  private filePath(): string {
    return join(this.deps.fsRoot, 'consolidation', 'state.json');
  }

  private readFile(): ConsolidationStateFile | undefined {
    return readJsonFileSync<ConsolidationStateFile>(this.filePath());
  }

  /** 读全量 jobs（boot loader 调）。无文件 → 空数组；按 owner 字段过滤（接口完整性）。 */
  async loadJobs(owner: string): Promise<Job[]> {
    const file = this.readFile();
    if (!file || !Array.isArray(file.jobs)) return [];
    return file.jobs.filter((j) => j.owner === owner);
  }

  /**
   * 写/替单 job（fire 后 lastFiredAt 更新时调）。
   * read-modify-write 全量 + 原子写；lastResult 字段原样保留（与 job 状态分离更新）。
   */
  async upsertJob(_owner: string, job: Job): Promise<void> {
    const existing = this.readFile();
    const jobs = existing?.jobs ?? [];
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) jobs[idx] = job;
    else jobs.push(job);
    this.writeFile(jobs, existing?.lastResult ?? null);
  }

  /** 删单 job（接口完整性保留；consolidation 单例场景理论不触发）。 */
  async removeJob(_owner: string, jobId: string): Promise<void> {
    const existing = this.readFile();
    if (!existing || !Array.isArray(existing.jobs)) return;
    const next = existing.jobs.filter((j) => j.id !== jobId);
    if (next.length === existing.jobs.length) return;
    this.writeFile(next, existing.lastResult ?? null);
  }

  /** 删 owner 全部 jobs（接口完整性保留；consolidation 无 teardown 场景）。 */
  async removeAllJobs(owner: string): Promise<void> {
    const existing = this.readFile();
    if (!existing || !Array.isArray(existing.jobs)) return;
    const next = existing.jobs.filter((j) => j.owner !== owner);
    this.writeFile(next, existing.lastResult ?? null);
  }

  /**
   * 读上次整理结果（GET /consolidation/status + test-only 端点共用）。
   * 同步方法——供 handleConsolidationStatus 的同步 Response 签名用；无历史 → {lastRunAt:null, summary:null}。
   */
  readLastResult(): { lastRunAt: string | null; summary: string | null } {
    const file = this.readFile();
    if (!file?.lastResult) return { lastRunAt: null, summary: null };
    return { lastRunAt: file.lastResult.lastRunAt, summary: file.lastResult.summary };
  }

  /**
   * 写上次整理结果（ConsolidationJobHandler.fire + handleTestConsolidationRun 共用）。
   * 同步写（原子写文件），jobs 字段原样保留（与用户配置/job 锚点分离更新）。
   */
  writeLastResult(result: ConsolidationLastResult): void {
    const existing = this.readFile();
    this.writeFile(existing?.jobs ?? [], result);
  }

  private writeFile(jobs: Job[], lastResult: ConsolidationLastResult | null): void {
    atomicWriteSync(
      this.filePath(),
      JSON.stringify({ version: 1, jobs, lastResult }, null, 2),
    );
  }
}
