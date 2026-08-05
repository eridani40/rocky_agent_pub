/**
 * bash 执行层（BashEngine 抽象 + SecureBashEngine seatbelt 沙箱）
 * 参考: specs/tech/agent/tools/[P0]bash_tools.md §4
 *       specs/tech/version_logs/v0.0.122/change_plan.md 模块 E
 *
 * 设计原则：bash tool 只引用 BashEngine.exec()，安全策略挂在 engine。
 * 改/加安全策略 = 改 SecureBashEngine 的 policy 挂载，bash tool 代码零改动。
 *
 * 平台分支：
 *   - darwin：SecureBashEngine（seatbelt profile 内联 -p，不写文件，packaged 护栏）
 *   - 非 darwin：passthrough runShell（无沙箱，仅参数层 checkPermission 生效）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessRegistry } from './child-process-registry';

// ============================================================
// 1. 接口 / 类型定义
// ============================================================

/** shell 执行结果 */
export interface ShellResult {
  /** stdout + stderr 合并输出 */
  stdout: string;
  /** 退出码（timedOut 时值为 1） */
  exitCode: number;
  /** 是否因超时/abort 被终止 */
  timedOut: boolean;
  /**
   * spawn 失败时的 errno（如 'EBADF'/'EMFILE'/'ENOENT'/'EACCES'）。
   * 仅 child 'error' 事件透出（spawn 系统调用失败）；close 正常路径恒 undefined。
   * type 用 string 不 union：errno 是开放集（防闭合性陷阱）。
   */
  spawnErrno?: string;
}

/** exec 调用选项 */
export interface ExecOpts {
  /** 工作目录（绝对路径） */
  cwd: string;
  /** 超时 ms */
  timeoutMs: number;
  /** 外部取消信号（联动杀子进程） */
  signal?: AbortSignal;
  /**
   * [v0.0.130.hang] run 级子进程注册表（bash tool 经 ctx.childRegistry 透传）。
   * wireChildLifecycle spawn 后 register，close/error 终局 unregister——
   * 供 run 终止级 sweep（abort-finalize.killAll）兜底清理未及时退出的子进程组。
   */
  childRegistry?: ChildProcessRegistry;
}

/**
 * bash 执行引擎抽象（职责分离：bash tool 只引用此接口）。
 * 安全策略（seatbelt profile）在 SecureBashEngine 实现内部挂载。
 */
export interface BashEngine {
  exec(command: string, opts: ExecOpts): Promise<ShellResult>;
}

/**
 * 声明式安全策略（黑名单制，每条可加一条，命中即失败）。
 * 路径含前导 ~ 时 engine 负责展开为绝对路径（复用 expandTilde，禁字面 ~）。
 */
export interface BashSecurityPolicy {
  id: string;
  description: string;
  /** 禁止读取的路径列表（前导 ~ 会被展开） */
  denyRead?: string[];
  /** 禁止写入的路径列表（本版保留字段，不挂策略） */
  denyWrite?: string[];
}

// ============================================================
// 2. 子进程生命周期管理 + runShell（从 bash.ts 移入，逻辑不变）
// ============================================================

/**
 * [v0.0.130.hang] 组杀 helper：用负 pid 杀整个进程组（detached spawn 建组时 pgid = child.pid，
 * 组内含 shell 派生的全部孙进程，如 `cmd | cat` 的 cat）。
 * 根因：spawn 不带 detached 时子进程与本进程同组，仅 `child.kill()` 只杀直接子进程（如 shell），
 * 孙进程（继承 stdout/stderr pipe 的读端）存活会让 pipe 永不关闭 → `close` 事件永不触发 → 悬挂。
 * 组杀失败（ESRCH 进程组已不存在 / 权限问题）时 fallback 杀直接子进程；全程 catch 不抛
 * （超时/abort 场景是 fire-and-forget 清理，不应打断主流程）。
 * 照搬 chrome-launcher.ts:179 killProcessGroup 组杀模式（本地实现，避免 tools→browser 跨模块耦合）。
 * 导出（非 BashEngine 公开接口的一部分）供 UT 直接覆盖 ESRCH fallback 分支。
 */
export function killProcessGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (!child.pid || child.killed) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // 组杀失败（ESRCH / 权限）→ fallback 杀直接子进程
      try {
        child.kill(sig);
      } catch {
        /* ignore — 进程已退出 */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 接管一个已 spawn 的子进程：收集 stdout+stderr 合并输出 + timeout/abort kill。
 * 超时语义：SIGTERM → 500ms 等待 → SIGKILL；abort 联动同样 SIGTERM。均走 killProcessGroup
 * 组杀（覆盖孙进程），而非仅 `child.kill()` 杀直接子进程（v0.0.130.hang 根因修复）。
 * runShell（普通 spawn）与 SecureBashEngine（sandbox-exec spawn）共用此生命周期
 * ——输出合并/timedOut 语义与原 bash.ts runShell 完全一致（§2 不破）。
 *
 * @param child 已 spawn 的子进程（stdio 须为 ['ignore','pipe','pipe']，且须 detached:true 建组）
 * @param timeoutMs 超时 ms
 * @param signal 外部取消信号
 * @param childRegistry run 级子进程注册表（spawn 后 register，close/error 终局 unregister）
 */
function wireChildLifecycle(
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
  childRegistry?: ChildProcessRegistry,
): Promise<ShellResult> {
  childRegistry?.register(child);

  return new Promise((resolve) => {
    let buf = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number, spawnErrno?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      childRegistry?.unregister(child.pid);
      resolve({ stdout: buf, exitCode, timedOut, spawnErrno });
    };

    const killTerm = () => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
    };

    /**
     * 显式销毁 child stdout/stderr pipe 读端 fd（fd 回收与孙子生死解耦）。
     * 仅 SIGKILL 兜底后调用：escaped-grandchild（setsid/double-fork 脱离进程组）继承
     * pipe 写端时，组杀打不到它 → child 'close' 永不触发 → pipe 读端 fd 永久钉死（+2/run）。
     * destroy() 同时让 child 'close' 在 stdio 关闭后正常触发（双收益：fd 回收 + promise 不 hang）。
     * try/catch + ?.：幂等（已 destroy 的流再 destroy / stdio 非 pipe 配置时不抛）。
     */
    const reclaimStreams = () => {
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* ignore — 已 destroy 或 fd 已失效 */
      }
    };

    const timer = setTimeout(() => {
      killTerm();
      // SIGTERM 后给 500ms 优雅退出，否则组杀 SIGKILL 兜底
      setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
        reclaimStreams();
        // 兜底防 event loop 被 close 永不触发的 child 句柄拖住 hang
        child.unref();
      }, 500);
    }, timeoutMs);

    // 外部取消信号联动（同样走组杀）
    if (signal) {
      if (signal.aborted) killTerm();
      else signal.addEventListener('abort', killTerm, { once: true });
    }

    child.stdout?.on('data', (d) => {
      buf += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      buf += d.toString('utf8');
    });
    // 透出 spawn errno（EBADF/EMFILE/ENOENT/EACCES）——原 finish(1) 吞 errno 致诊断盲区
    child.on('error', (err) => finish(1, (err as NodeJS.ErrnoException)?.code));
    child.on('close', (code) => finish(code ?? 1, undefined));
  });
}

/**
 * 执行 shell 命令（普通 spawn，stdout+stderr 合并，带 timeout kill）。
 * 输出合并/timedOut 语义与原 bash.ts runShell 完全一致（§2 不破）。
 * [v0.0.130.hang] spawn 加 detached:true 建独立进程组（pgid=child.pid）——
 * 否则组杀（killProcessGroup）打不到孙进程（如 `cmd | cat` 的 cat），非 darwin 平台走本函数
 * 同样获得组杀能力。
 */
export function runShell(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
  childRegistry?: ChildProcessRegistry,
): Promise<ShellResult> {
  const child = spawn(command, {
    shell: process.env.SHELL ?? '/bin/sh',
    cwd,
    // stdout + stderr 合并到 stdout（对齐 bash_tools §2 输出语义）
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  return wireChildLifecycle(child, timeout, signal, childRegistry);
}

// ============================================================
// 3. compileSeatbeltProfile — seatbelt profile 字符串编译
// ============================================================

/**
 * 展开 path 中的前导 `~` 为 home 目录（复用 config.ts expandTilde 同等逻辑）。
 * 独立实现原因：config.ts 的 expandTilde 未导出（内部 function）；
 * 逻辑与 config.ts 完全一致，禁止字面 ~ 拼接（packaged 护栏 BUG-004）。
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 将 BashSecurityPolicy[] 编译为 seatbelt profile 字符串（macOS sandbox-exec -p 格式）。
 * 黑名单制：allow default + 逐条 deny。
 * 路径前导 ~ 展开为绝对路径（禁字面 ~，BUG-004 packaged 护栏）。
 *
 * 格式示例：
 *   (version 1)
 *   (allow default)
 *   (deny file-read* (subpath "/Users/xxx/.ssh"))
 *
 * @param policies 策略列表
 * @returns seatbelt profile 字符串
 */
export function compileSeatbeltProfile(policies: BashSecurityPolicy[]): string {
  const lines: string[] = ['(version 1)', '(allow default)'];

  /**
   * 路径须为不含 `"` 或 `\` 的可信常量（源自内置策略 BUILTIN_POLICIES 或调用方）。
   * 含这两个字符时会破坏 profile 字符串结构，提前失败比静默生成错误 profile 更安全。
   */
  const assertSafePath = (abs: string) => {
    if (abs.includes('"') || abs.includes('\\')) {
      throw new Error(
        `compileSeatbeltProfile: 路径含不安全字符（" 或 \\），拒绝生成 profile: ${abs}`,
      );
    }
  };

  for (const policy of policies) {
    for (const p of policy.denyRead ?? []) {
      const abs = expandTilde(p);
      assertSafePath(abs);
      lines.push(`(deny file-read* (subpath "${abs}"))`);
    }
    for (const p of policy.denyWrite ?? []) {
      const abs = expandTilde(p);
      assertSafePath(abs);
      lines.push(`(deny file-write* (subpath "${abs}"))`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// 4. SecureBashEngine — macOS seatbelt 沙箱执行引擎
// ============================================================

/**
 * macOS seatbelt 沙箱执行引擎。
 *
 * darwin：sandbox-exec -p <profile> $SHELL -c <command>
 *   - profile 内联（-p），不写文件（packaged 护栏，兼容 asar / cwd=/ 场景）
 *   - 命中 = 非零退出码 → bash tool 按现有 exitCode !== 0 逻辑返 isError（无特判）
 *
 * 非 darwin：passthrough 走普通 runShell（无沙箱，仅参数层 checkPermission 生效）
 */
export class SecureBashEngine implements BashEngine {
  /** 安全策略列表（编译为 seatbelt profile） */
  private readonly policies: BashSecurityPolicy[];

  constructor(policies: BashSecurityPolicy[]) {
    this.policies = policies;
  }

  async exec(command: string, opts: ExecOpts): Promise<ShellResult> {
    if (process.platform !== 'darwin') {
      // 非 darwin：passthrough，无沙箱（req 只考虑 mac）
      return runShell(command, opts.cwd, opts.timeoutMs, opts.signal, opts.childRegistry);
    }

    // darwin：编译 seatbelt profile，以 sandbox-exec -p 内联传入
    const profile = compileSeatbeltProfile(this.policies);
    const shell = process.env.SHELL ?? '/bin/sh';

    // [v0.0.130.hang] detached:true 建独立进程组——sandbox-exec 派生的 shell/孙进程默认继承同组，
    // 组杀（killProcessGroup）负 pid 才能一并清理，避免 seatbelt 场景下孙进程残留悬挂 pipe。
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, shell, '-c', command], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    return wireChildLifecycle(child, opts.timeoutMs, opts.signal, opts.childRegistry);
  }
}

// ============================================================
// 5. getBashEngine — 进程级单例工厂
// ============================================================

/** 内置策略：禁止读取 ~/.ssh 敏感目录 */
const BUILTIN_POLICIES: BashSecurityPolicy[] = [
  {
    id: 'ssh-read-block',
    description: '禁止读取 ~/.ssh（私钥/known_hosts 等敏感文件）',
    denyRead: ['~/.ssh'],
  },
];

/** 进程级单例（惰性初始化） */
let _engine: BashEngine | null = null;

/**
 * 获取进程级 BashEngine 单例。
 * 按 process.platform 决定：
 *   - darwin → SecureBashEngine（seatbelt + 内置 ssh-read-block 策略）
 *   - 其他 → passthrough（SecureBashEngine 的非 darwin 分支）
 *
 * 内置策略列表固定（本版一条 ssh-read-block）。
 */
export function getBashEngine(): BashEngine {
  if (!_engine) {
    // SecureBashEngine 内部按 platform 决策 seatbelt/passthrough
    _engine = new SecureBashEngine(BUILTIN_POLICIES);
  }
  return _engine;
}
