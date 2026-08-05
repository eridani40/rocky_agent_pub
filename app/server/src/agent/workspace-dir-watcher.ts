/**
 * workspace-dir-watcher —— 单目录一层非递归 chokidar watcher 工厂（v0.0.139 新建）
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md §2/§3.1/§4/§7（懒监听权威源）
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1 dir-watcher 行
 *       hotfix 1ef2d61c（chokidar v4 ignored 无 glob，须函数匹配目录段）
 *
 * 职责：把「监听单元 = 单目录一层（depth:0，非递归）」封装成 open/close 工厂，供
 *   session-workspace-manager.ts（Task2 编排器）按 (sessionId, absDir) 建/关物理 watcher。
 *   WATCH_OPTIONS/IGNORED_DIR_NAMES/waitForChokidarReady/mapKind 从旧递归模型的
 *   session-workspace-manager.ts 迁入（逻辑不变，仅 WATCH_OPTIONS 新增 depth:0）——旧文件
 *   本身在本 task 不动（Task2 才整体重写替换掉旧递归实现）。
 *
 * **MUST NOT 注册 addDir → watcher.add**（红线①核心变更）：旧递归模型对运行时新建子目录
 * 强制 watcher.add() 纳入递归监听；懒监听下绝不自动 add 子目录，否则退化回递归、
 * re-introduce 扫描风暴。新子目录仍会 emit 'addDir'（前端文件树显示新文件夹），
 * 但只有用户显式展开（调 watch()）才会对它建新的一层 watcher。
 */
import { watch, type FSWatcher } from 'chokidar';

/**
 * 等待 chokidar watcher 就绪（'ready' 事件）。
 * 不 await → caller 拿到「未就绪」watcher → 写文件事件落在初始扫描窗口被 ignoreInitial 吞。
 * 超时兜底：超时也 resolve（不 reject/不抛），让 watcher 自愈，避免阻塞编排主路径。
 * 导出供单测直测（避免 vi.mock chokidar v4 模块污染）。
 */
export function waitForChokidarReady(
  watcher: { once(event: string, cb: () => void): unknown },
  timeoutMs = 5000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    watcher.once('ready', finish);
    setTimeout(finish, timeoutMs);
  });
}

/** watch 排除目录名（chokidar v4 ignored 字符串=全路径精确相等、无 glob——须函数匹配目录段） */
export const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', '.venv', '__pycache__']);

/**
 * chokidar 单目录 watcher 配置（spec §4）。
 * depth:0 = 只监听该目录直接子项（一层，非递归）——含大子目录（如 .venv）的目录只 stat 该
 * 子目录条目本身，绝不扫描其内部文件，扫描风暴结构性消失，ignored 降级为噪声过滤（非性能关键路径）。
 * export 供单测断言（避免 vi.mock chokidar 模块污染）。
 */
export const WATCH_OPTIONS = {
  depth: 0,
  ignored: (p: string) => p.split('/').some((seg) => IGNORED_DIR_NAMES.has(seg)),
  ignoreInitial: true, // 初始/展开树走 GET tree API，watcher 只负责增量
  persistent: true,
};

/** chokidar eventName → SessionEvent kind（spec §8 表，5 类文件变化，其余忽略） */
export type FsChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export function mapKind(eventName: string): FsChangeKind | null {
  switch (eventName) {
    case 'add':
    case 'change':
    case 'unlink':
    case 'addDir':
    case 'unlinkDir':
      return eventName;
    default:
      // chokidar v4 'all' 事件可能含 'ready'/'raw' 等非文件变化类，忽略
      return null;
  }
}

/** 一个被监听目录的物理 watcher 句柄（每 absDir 一个，供 close 幂等判定 + 诊断）。 */
export interface DirWatcher {
  sessionId: string;
  absDir: string;
  watcher: FSWatcher;
  ready: boolean;
  closed: boolean;
}

export interface OpenDirWatcherOpts {
  sessionId: string;
  absDir: string;
  /** chokidar 'all' 原始事件转发（未做 kind 过滤/debounce——那是 workspace-change-emitter 的职责） */
  onEvent: (sessionId: string, absDir: string, eventName: string, absPath: string) => void;
  /** chokidar 'error' 转发（如目录被删/inotify 满）；caller 决定回收策略 */
  onError?: (sessionId: string, absDir: string, err: unknown) => void;
  readyTimeoutMs?: number;
}

/**
 * 建立一个单目录一层非递归 watcher 并等待 ready。
 * - depth:0 + ignoreInitial:true（spec §2/§4）
 * - 不校验 absDir 是否存在/是目录——caller（manager.watch()）负责该校验（spec §3）
 * - 不挂 addDir→watcher.add（红线①：禁自动递归）
 */
export async function openDirWatcher(opts: OpenDirWatcherOpts): Promise<DirWatcher> {
  const { sessionId, absDir, onEvent, onError, readyTimeoutMs = 5000 } = opts;
  const watcher = watch(absDir, WATCH_OPTIONS);
  const handle: DirWatcher = { sessionId, absDir, watcher, ready: false, closed: false };
  watcher.on('all', (eventName, absPath) => {
    onEvent(sessionId, absDir, eventName, absPath);
  });
  watcher.on('ready', () => {
    handle.ready = true;
  });
  // 始终挂 'error' 监听：EventEmitter 在无 'error' listener 时 emit('error') 会抛未捕获异常
  // → 进程崩溃（chokidar 会在目录被删 / inotify 满 / EMFILE 等场景 emit 'error'）。基座监听
  // 兜底防崩，有 onError 则转发给 caller 决定回收策略，无则安全吞掉。
  watcher.on('error', (err) => {
    onError?.(sessionId, absDir, err);
  });
  await waitForChokidarReady(watcher, readyTimeoutMs);
  return handle;
}

/**
 * 关闭一个 DirWatcher 句柄——幂等（重复 close 不抛，Bun FSEvents close 段错误面兜底 spec §7）。
 * `closed` 标记在首次调用的同步阶段即置 true（早于 await），保证并发/连点 close 也只真正
 * close 一次物理 watcher（JS 单线程：并发调用间同步段互不交错）。
 */
export async function closeDirWatcher(handle: DirWatcher): Promise<void> {
  if (handle.closed) return;
  handle.closed = true;
  try {
    await handle.watcher.close();
  } catch {
    // close 失败忽略——句柄已标记 closed，caller 侧记账已不再持有
  }
}
