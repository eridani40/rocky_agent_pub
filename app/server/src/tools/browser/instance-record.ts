/**
 * instance-record —— 浏览器实例资源台账辅助工具（v0.0.334 B10 重构）
 * 参考: specs/tech/version_logs/v0.0.334/change_plan.md B10（browser-instances.json → sqlite 台账）
 *       specs/tech/agent/tools/[P1]browser_instance_manager.md §4.7（记录文件→台账）
 *
 * v0.0.334 起持久化记录迁移到 sqlite 表 browser_instances（instance-ledger.ts），
 * 本文件删除 browser-instances.json 读写（readPersistedInstances/persistInstance/
 * unpersistInstance/INSTANCE_RECORD_FILE/instanceRecordPath），保留纯函数工具：
 *   - isPidAlive：pid 存活检查（孤儿清理判定）
 *   - killProcessGroupByPid：按 pid 杀进程组（孤儿回收）
 *   - errMsg：错误信息提取
 *   - toRecord：WorkerHandle → 台账记录形态（mode 扩展 attach 允许）
 */
import type { PersistedInstanceRecord } from './types';
import type { WorkerHandle } from './worker-mode-impl';

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

/** WorkerHandle → 台账记录形态（worker-based 字段子集；attach 走 attach-mode-impl 自建记录） */
export function toRecord(i: WorkerHandle): PersistedInstanceRecord {
  return {
    key: i.key,
    mode: i.mode,
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
