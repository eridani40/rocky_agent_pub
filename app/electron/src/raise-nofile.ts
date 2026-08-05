/**
 * raise-nofile — packaged Electron 主进程抬高 nofile 软上限
 * 参考: specs/tech/version_logs/v0.0.236/change_plan.md（B 段）
 *       states/v0.0.236/research.md §4 B / research-2.md §排查 4（基线 fd 余量）
 *
 * 为什么需要它：
 *   bash 工具 spawn 子进程跑在 Electron 主进程（packaged require @app/server → node:http
 *   在主进程内）。dev 终端 ulimit -n=1048576（余量充足）；packaged .app 由 LaunchServices
 *   启动，继承的 nofile soft 通常=256（macOS 默认），app 启动期基线 fd 已逼近上限 →
 *   "重启后第一次 bash 就坏"。本函数把 soft 抬到 4096 给基线余量救急。
 *
 * 为什么用 native binding：
 *   Node 标准无 setrlimit API（process.setrlimit 实测不可用，见 architect finding）；
 *   ulimit/launchctl 在 .app 双击（LaunchServices 启动不经 shell）下都无法影响主进程；
 *   唯一可行 = 通过 posix npm 包调 POSIX setrlimit(2)。
 *
 * 容错红线（不阻塞启动）：
 *   - posix native 模块缺失（dev 未装 / packaged rebuild 失败）→ 静默返回 raised:false
 *   - getrlimit/setrlimit 抛错（权限/边界）→ console.warn 不抛
 *   - hard 绝不动（防超 kern.maxfilesperproc=92160 触发系统级问题）
 */

/** posix binding 的可注入子集（仅取 raise-nofile 用到的两个方法，便于单测注入 mock） */
export interface PosixBinding {
  getrlimit(resource: string): { soft: number | null; hard: number | null };
  setrlimit(
    resource: string,
    limits: { soft?: number | null; hard?: number | null },
  ): void;
}

/** raise 结果：raised=true 表示实际抬升过 soft；newSoft 为抬升后的 soft 值（-1 表示未知） */
export interface RaiseNofileResult {
  raised: boolean;
  newSoft: number;
}

/** 当前进程的 nofile 软上限未知时的占位（posix 缺失或调用失败都返回此值） */
export const NOFILE_UNKNOWN = -1;

const NOFILE_RESOURCE = 'nofile';

/**
 * 动态加载 posix native binding。
 * 动态 require（非顶层 import）：让 dev 单测/未装 posix 的环境也能加载本模块
 * （require 失败返 undefined，调用方静默降级）。参照 backend-bootstrap 默认参数
 * 的动态 require 先例（避免 dev 单测强依赖 native dist）。
 */
function loadPosixBinding(): PosixBinding | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('posix') as PosixBinding;
  } catch {
    return undefined;
  }
}

/**
 * 抬高当前进程的 nofile 软上限到至少 targetSoft（仅抬 soft，hard 不动）。
 *
 * @param targetSoft 期望的 soft 下限（如 4096）；当前 soft 更高时保持不变
 * @param binding 可选的 posix binding 注入（单测用）；缺省动态 require('posix')
 * @returns { raised, newSoft }
 *   - raised=true：实际调过 setrlimit 抬升 soft
 *   - raised=false：posix 缺失 / soft 已>=目标 / getrlimit·setrlimit 抛错 / soft=RLIM_INFINITY
 *   - newSoft：抬升后的 soft（成功时=newSoft；已>=目标时=当前 soft；Infinity 时=RLIM_INFINITY；失败时=-1）
 *
 * 不抛错：posix 缺失静默；getrlimit/setrlimit 抛错仅 console.warn。hard 永远保持当前值不动。
 */
export function raiseNofileLimit(
  targetSoft: number,
  binding?: PosixBinding,
): RaiseNofileResult {
  const posix = binding ?? loadPosixBinding();
  if (!posix) {
    // posix native 模块缺失（dev 未装 / packaged rebuild 失败）→ 静默不阻塞启动
    return { raised: false, newSoft: NOFILE_UNKNOWN };
  }

  try {
    const current = posix.getrlimit(NOFILE_RESOURCE);
    const currentSoft = current.soft;
    if (currentSoft === null) {
      // soft=RLIM_INFINITY（无限制），无需 raise
      return { raised: false, newSoft: Infinity };
    }
    // 取 max：当前 soft 已 >= 目标时不降级（setrlimit 可降但本函数语义只升不降）
    const newSoft = Math.max(currentSoft, targetSoft);
    if (newSoft === currentSoft) {
      return { raised: false, newSoft: currentSoft };
    }
    // hard 不动（防超 kern.maxfilesperproc=92160）：显式传 current.hard 锁住，
    // 即使 setrlimit 实现对省略 hard 有默认行为也不被影响
    posix.setrlimit(NOFILE_RESOURCE, { soft: newSoft, hard: current.hard });
    return { raised: true, newSoft };
  } catch (e) {
    // getrlimit/setrlimit 抛错（权限不足 / 边界值）→ warn 不阻塞启动
    // eslint-disable-next-line no-console
    console.warn('[electron] raiseNofileLimit failed:', e);
    return { raised: false, newSoft: NOFILE_UNKNOWN };
  }
}
