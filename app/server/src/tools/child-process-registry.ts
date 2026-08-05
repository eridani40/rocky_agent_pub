/**
 * run 级子进程注册表：给一次 agent run 期间产生的所有子进程（bash 等 spawn 型工具）
 * 提供统一的登记 + 兜底组杀能力。
 *
 * 背景（v0.0.130.hang）：agent hang 根因之一是子进程（尤其 bash 起的孙进程，如 `cmd | cat`）
 * 在 run 被 abort 或工具超时后仍存活，pipe 不释放导致 tool.run 永不 resolve。
 * ChildProcessRegistry 是 run 生命周期终止时的"扫尾"手段——挂在 AbortControllerHandle 上，
 * run abort（abort-finalize）或全 run 收尾时调用 killAll() 兜底杀掉所有登记在案的子进程组。
 *
 * 与单工具超时的关系：单个 tool 超时由 engine 的 ctx.signal → 工具自身清理逻辑负责
 * （bash 走 wireChildLifecycle 的组杀），不经过本类；本类只在 run 终止级 sweep 时触发，
 * 属于"最后一道防线"。
 *
 * 设计约束（见 change_plan.md 模块 B-2）：
 * - register/unregister 幂等、无副作用泄漏
 * - killAll 全 catch：单个子进程杀失败不阻断其余；ESRCH（进程已退出）容错
 * - killAll 幂等：二次调用无害（注册表已清空）
 * - 内存态，不落盘；不跨进程重启存活（reconcile 不接 killAll，见 change_plan 设计决策#4）
 *
 * 参考实现：tools/browser/chrome-launcher.ts 的 killProcessGroup（同款负 pgid 组杀模式）。
 */
import type { ChildProcess } from 'node:child_process';

/** SIGTERM 后等待优雅退出的宽限期，超时未退出则 SIGKILL（与 bash-engine wireChildLifecycle 一致） */
const GRACEFUL_KILL_GRACE_MS = 500;

/** 注册表内部登记项：只记必要的 pid/pgid，不持有整个 ChildProcess 引用之外的状态 */
interface RegisteredChild {
  pid: number;
  /** detached spawn 下 pgid === pid（新建进程组，子进程作为组长） */
  pgid: number;
}

/**
 * run 级子进程注册表。
 * 每次 agent run 启动时应新建一个实例（挂在 AbortControllerHandle.childRegistry），
 * run 结束/abort 后调用 killAll() 做终止级清理。
 */
export class ChildProcessRegistry {
  private readonly children = new Map<number, RegisteredChild>();

  /**
   * 登记一个子进程。spawn 失败（无 pid）时容错跳过，不抛错。
   * detached spawn 下进程组 id（pgid）等于子进程自身 pid（组长）。
   */
  register(child: ChildProcess): void {
    const pid = child.pid;
    if (pid == null) return; // spawn 失败或已退出，无 pid 可注册
    this.children.set(pid, { pid, pgid: pid });
  }

  /** 注销一个子进程（幂等：不存在的 pid 也不报错） */
  unregister(pid: number | undefined | null): void {
    if (pid == null) return;
    this.children.delete(pid);
  }

  /** 当前登记的子进程数 */
  get size(): number {
    return this.children.size;
  }

  /**
   * 遍历所有登记项，对每个进程组先 SIGTERM 优雅通知，等待宽限期后 SIGKILL 兜底。
   * - 用负 pgid 杀整个进程组（覆盖 bash 孙进程等继承同组的子进程树）
   * - 单个进程杀失败（如已提前退出，ESRCH）不阻断其余进程的清理
   * - 全程 catch，不向调用方抛错（run 终止级 sweep，调用方通常 fire-and-forget）
   * - 幂等：清空后再调用是空操作
   */
  async killAll(): Promise<void> {
    const targets = Array.from(this.children.values());
    this.children.clear(); // 先清空，保证幂等（并发/重复调用不会重复处理同一批）

    await Promise.all(
      targets.map(async (target) => {
        killGroupSignal(target.pgid, 'SIGTERM');
        await sleep(GRACEFUL_KILL_GRACE_MS);
        killGroupSignal(target.pgid, 'SIGKILL');
      }),
    );
  }
}

/**
 * 对进程组发一个信号，兼容进程已退出（ESRCH）等异常，全 catch 不抛。
 * 负 pgid = 杀整个进程组（detached spawn 建组时 pgid = 子进程 pid）。
 */
function killGroupSignal(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // 进程组已不存在（ESRCH）或权限问题——目标已死或不可达，视为清理成功
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
