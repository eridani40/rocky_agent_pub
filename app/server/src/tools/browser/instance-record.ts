/**
 * instance-record —— browser-instances.json 持久化读写（开机自检/残留清理锚点）
 * 参考: specs/tech/agent/tools/[P1]browser_instance_manager.md §4.7
 *
 * 记录内容：`[{ key, mode, profileName?, userDataDir, cdpPort, workerPid, createdAt }]`。
 * 服务崩溃/强杀后 chrome 变孤儿 → 下次启动读记录 → 清理（kill 残留进程 + 删 headless 临时目录）。
 * 同步 writeFileSync（单进程无并发问题）；写失败 catch 吞错（best-effort，不阻塞主流程，记 warn）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersistedInstanceRecord } from './types';
import type { WorkerHandle } from './worker-mode-impl';

/** 实例记录文件名（dataDir 下） */
export const INSTANCE_RECORD_FILE = 'browser-instances.json';

/** 记录文件路径 */
export function instanceRecordPath(dataDir: string): string {
  return join(dataDir, INSTANCE_RECORD_FILE);
}

/**
 * 读持久化实例记录。文件不存在 / JSON 损坏 → []（catch 吞错，启动不炸）。
 * 同步读（构造期执行——服务启动即扫描残留）。
 */
export function readPersistedInstances(dataDir: string): PersistedInstanceRecord[] {
  const file = instanceRecordPath(dataDir);
  try {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is PersistedInstanceRecord =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as PersistedInstanceRecord).key === 'string' &&
        typeof (x as PersistedInstanceRecord).workerPid === 'number',
    );
  } catch {
    return []; // 损坏/不可读 → 空（不阻塞启动；残留由端口探测/锁清理兜底）
  }
}

/**
 * 写实例记录（append + 重写整文件）。失败 catch 吞错（best-effort，不阻塞 launch）。
 */
export function persistInstance(dataDir: string, rec: PersistedInstanceRecord): void {
  try {
    const list = readPersistedInstances(dataDir).filter((r) => r.key !== rec.key);
    list.push(rec);
    writeFileSync(instanceRecordPath(dataDir), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    // 磁盘满/权限 → 记录缺失 → 下次崩溃残留无法被发现；记 warn 可观测，不阻塞主流程
    console.warn(`[browser-instance-manager] persistInstance 写记录失败（best-effort）: ${rec.key}`);
  }
}

/**
 * 删实例记录（filter + 重写整文件）。key 不存在 → no-op（幂等）。
 * 失败 catch 吞错（best-effort，不阻塞 close 主流程）。
 */
export function unpersistInstance(dataDir: string, key: string): void {
  try {
    const list = readPersistedInstances(dataDir).filter((r) => r.key !== key);
    writeFileSync(instanceRecordPath(dataDir), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    console.warn(`[browser-instance-manager] unpersistInstance 写记录失败（best-effort）: ${key}`);
  }
}

/**
 * pid 存活检查（process.kill(pid,0)）。ESRCH → 死亡；EACCES → 存在（无权限信号）。
 * 纯函数无副作用（不真 kill）。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM'; // EPERM = 进程存在但无权发信号
  }
}

/** 按 pid 杀进程组（孤儿清理用；负 pid = 进程组） */
export function killProcessGroupByPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return; // 防误杀当前进程组
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

/** WorkerHandle → PersistedInstanceRecord（持久化字段子集）。attach 恒不持久化（调用方保证 worker-based） */
export function toRecord(i: WorkerHandle): PersistedInstanceRecord {
  return {
    key: i.key,
    mode: i.mode as 'headless' | 'managed-profile',
    ...(i.profileName ? { profileName: i.profileName } : {}),
    userDataDir: i.userDataDir!,
    cdpPort: i.cdpPort!,
    workerPid: i.workerPid!,
    ...(i.chromePid ? { chromePid: i.chromePid } : {}), // v0.0.272 起持久化（旧 worker 无 → 不写字段）
    createdAt: i.createdAt,
  };
}

/** 错误信息提取 helper */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
