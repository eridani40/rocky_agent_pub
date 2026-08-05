/**
 * chrome SingletonLock 处理（mode ② 持久 profile 占用检测/僵尸锁清理）
 * 参考: specs/research/v0.0.23-browser-use.md §3.5（openclaw chrome.ts readSingletonLockTarget / clearStaleChromeSingletonLocks）
 *       specs/tech/agent/tools/[P1]browser_tool.md §3
 *
 * chrome 对 user-data-dir 加 SingletonLock/SingletonSocket/SingletonCookie 文件锁。
 * 同一持久 profile 不能被两 chrome 进程同时打开（用户手动开同 profile 会失败）。
 *
 * 占用冲突策略：报错 + 提示用户，不抢锁不排队。
 * 但「持锁进程已死」属僵尸锁，可清。
 *
 * SingletonLock 在 macOS/linux 是 symlink，target 形如 `<host>-<pid>`。
 * Windows 是普通文件（暂不处理，mode ② 主用 mac/linux）。
 */
import { readlinkSync, unlinkSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserError } from './types';

/** SingletonLock 文件名（位于 user-data-dir 根） */
export const SINGLETON_LOCK = 'SingletonLock';
export const SINGLETON_SOCKET = 'SingletonSocket';
export const SINGLETON_COOKIE = 'SingletonCookie';

/** 持锁目标解析结果 */
export interface SingletonLockTarget {
  /** 持锁主机名 */
  host: string;
  /** 持锁进程 pid */
  pid: number;
}

/** readlink 注入点（测试 mock 用） */
export type ReadlinkFn = (path: string) => string;

/** 进程是否存活探测（测试可 mock：默认 kill(pid,0)） */
export type PidAliveFn = (pid: number) => boolean;

/**
 * 解析 SingletonLock target。
 * target 形如 `<host>-<pid>`，正则 ^(?<host>.+)-(?<pid>\d+)$ 提取。
 * @param lockPath 锁文件绝对路径
 * @param readlink 注入 readlink（测试用）
 * @returns 解析结果；非 symlink/格式不符返回 undefined
 */
export function readSingletonLockTarget(
  lockPath: string,
  readlink: ReadlinkFn = readlinkSync,
): SingletonLockTarget | undefined {
  let target: string;
  try {
    target = readlink(lockPath);
  } catch {
    return undefined;
  }
  const m = target.match(/^(?<host>.+)-(?<pid>\d+)$/);
  if (!m || !m.groups) return undefined;
  const pid = Number.parseInt(m.groups.pid!, 10);
  if (!Number.isFinite(pid)) return undefined;
  return { host: m.groups.host!, pid };
}

/**
 * 清理僵尸锁：持锁进程已死 → 删 SingletonLock/Socket/Cookie。
 * 不抢活锁（占用冲突策略：报错，由调用方处理）。
 * @param userDataDir chrome user-data-dir
 * @param deps 注入 readlink/pidAlive/unlink/exists（测试用）
 * @returns true=清过僵尸锁；false=无锁或锁仍活跃（活锁不在此清理）
 */
export function clearStaleSingletonLocks(
  userDataDir: string,
  deps: {
    readlink?: ReadlinkFn;
    pidAlive?: PidAliveFn;
    unlink?: (p: string) => void;
    exists?: (p: string) => boolean;
  } = {},
): boolean {
  const readlink = deps.readlink ?? readlinkSync;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const unlink = deps.unlink ?? ((p: string) => unlinkSync(p));
  const exists = deps.exists ?? existsSync;

  const lockPath = join(userDataDir, SINGLETON_LOCK);
  if (!exists(lockPath)) return false;

  const target = readSingletonLockTarget(lockPath, readlink);
  if (!target) return false; // 非标准锁格式，不动

  // 持锁进程仍活 → 活锁，不抢
  if (pidAlive(target.pid)) return false;

  // 僵尸锁：进程已死，删 SingletonLock/Socket/Cookie
  for (const name of [SINGLETON_LOCK, SINGLETON_SOCKET, SINGLETON_COOKIE]) {
    const p = join(userDataDir, name);
    try {
      if (exists(p)) unlink(p);
    } catch {
      /* ignore */
    }
  }
  return true;
}

/**
 * 默认进程存活探测：kill(pid, 0) === true 表示进程存在（ESRCH=不存在）。
 */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验 profile 是否可独占使用：清理僵尸锁后，若锁仍指向活进程 → 抛 profile_in_use。
 * 在 chrome launch 前调用。
 *
 * 判定逻辑（不依赖 exists 重检——mock unlink 不会改 exists 状态，且真实场景 unlink 后即不存在）：
 *   - readSingletonLockTarget 读锁；非标准格式/无锁 → 视为空闲
 *   - 持锁 pid 仍活 → profile_in_use
 *   - 持锁 pid 死 → 清僵尸锁后视为空闲
 * @param userDataDir 持久 profile 的 user-data-dir
 * @param deps 注入依赖（测试用）
 * @throws BrowserError(profile_in_use) 活锁存在（profile 被另一 chrome 进程占用）
 */
export function ensureProfileFree(
  userDataDir: string,
  deps: Parameters<typeof clearStaleSingletonLocks>[1] = {},
): void {
  const readlink = deps.readlink ?? readlinkSync;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const exists = deps.exists ?? existsSync;
  const unlink = deps.unlink ?? ((p: string) => unlinkSync(p));

  const lockPath = join(userDataDir, SINGLETON_LOCK);
  if (!exists(lockPath)) return;

  const target = readSingletonLockTarget(lockPath, readlink);
  if (!target) return; // 非标准锁格式，放行（chrome 自己处理）

  if (pidAlive(target.pid)) {
    throw new BrowserError(
      'profile_in_use',
      `browser profile 正被另一 chrome 进程占用 (pid=${target.pid})：请关闭该 chrome 或换 profile`,
    );
  }

  // 僵尸锁：清 SingletonLock/Socket/Cookie
  for (const name of [SINGLETON_LOCK, SINGLETON_SOCKET, SINGLETON_COOKIE]) {
    const p = join(userDataDir, name);
    try {
      if (exists(p)) unlink(p);
    } catch {
      /* ignore */
    }
  }
}

/** lstat 是否 symlink（debug 用） */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
