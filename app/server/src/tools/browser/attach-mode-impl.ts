/**
 * attach-mode-impl —— attach 模式专属 AttachModeImpl
 * 参考: specs/tech/version_logs/v0.0.266/change_plan.md Delta（registry 重构，老板 delta #2）
 *       specs/tech/agent/tools/[P1]browser_tool.md §4（ChromeMcpDriver connect/close 语义）
 *       specs/tech/version_logs/v0.0.330/change_plan.md §11-§16（Delta 3，D3-B）
 *
 * attach 语义（相对 worker-based）：
 *   - launch：switch 门禁 → attachDriver 缺省 fail-closed → connectAttachSession（不 spawn worker）
 *   - execute：主进程 dispatchAction（session 方法）+ 失活检测（CDP 断/chrome 被关 →
 *     isAttachConnectionLost → handle.state='dead' + 引导重新 launch；manager 收尾 close）
 *   - close：断 MCP 连接（disconnectAttachSession，不杀 chrome/不删目录/不释放端口/不持久化；幂等）
 *     + 检测 Chrome 调试态残留（detectChromeDebugResidual，只读）→ 残留返回引导提示文本
 *     （能力边界：用户 Chrome 调试态无编程关闭 API，只能检测+提示+引导，change_plan §12）
 * 失活自愈下沉 impl（tool.ts 不再检查 isAttachConnectionLost）。
 */
import type { BrowserActionParams, BrowserExecuteResult, BrowserLaunchOptions, BrowserSession, PersistedInstanceRecord } from './types';
import type { BrowserHandle, CloseResult, ExecuteCtx, LaunchResult, ModeImpl, ModeImplEnv } from './mode-impl';
import { connectAttachSession, disconnectAttachSession, isAttachConnectionLost } from './attach-instance';
import { detectChromeDebugResidual, type DetectDeps } from './attach-debug-state';
import { dispatchAction, type BrowserInputLike } from './tool-dispatch';
import { isPidAlive, killProcessGroupByPid, errMsg } from './instance-record';
import { execSync } from 'node:child_process';

/** AttachHandle —— attach 实例私有扩展（manager 不读这些字段） */
export interface AttachHandle extends BrowserHandle {
  /** 主进程持有的 ChromeMcpSession（dispatchAction 用） */
  session: BrowserSession;
  /** MCP 子进程 pid（v0.0.334 B9：attach 台账锚点；孤儿 MCP 代理回收用） */
  mcpPid?: number;
}

/** AttachModeImpl 可注入进程回收依赖（v0.0.336 G4/G5：UT mock 不真杀进程；生产缺省真实实现） */
export interface AttachKillDeps {
  /** pid 存活检查（缺省 instance-record.isPidAlive） */
  isPidAlive?: (pid: number) => boolean;
  /** 杀进程组（缺省 instance-record.killProcessGroupByPid） */
  killProcessGroup?: (pid: number) => void;
  /** pkill 命令执行（缺省 child_process.execSync；UT 注入 spy 断言 --parent-pid 锚定） */
  execPkill?: (cmd: string) => void;
}

/** AttachModeImpl（registry 注册 'attach' 键；依赖经 ModeImplEnv 注入，构造无参） */
export class AttachModeImpl implements ModeImpl {
  /** 检测依赖注入（UT mock TCP/文件；缺省生产实现） */
  private readonly detectDeps: DetectDeps;
  /** 进程回收依赖注入（v0.0.336 G4/G5：UT mock kill/pkill；缺省真实实现） */
  private readonly killDeps: Required<AttachKillDeps>;
  /**
   * v0.0.334 fix（Bug2 计数虚高）：launch 时缓存 env，供 execute 失活分支即时清账用。
   * 接口契约 ModeImpl.execute 无 env 参数（worker impl 同），但 attach 失活需访问
   * env.ledger + env.discardInstance——AttachModeImpl 是 attach 专属单例（registry 注册单键），
   * 缓存 launch env 安全（同一 manager 装配，env 生命周期 ≥ impl 生命周期）。
   */
  private env: ModeImplEnv | undefined;

  constructor(detectDeps: DetectDeps = {}, killDeps: AttachKillDeps = {}) {
    this.detectDeps = detectDeps;
    this.killDeps = {
      isPidAlive: killDeps.isPidAlive ?? isPidAlive,
      killProcessGroup: killDeps.killProcessGroup ?? killProcessGroupByPid,
      execPkill: killDeps.execPkill ?? ((cmd: string) => { execSync(cmd, { stdio: 'ignore' }); }),
    };
  }
  async launch(
    key: string,
    opts: BrowserLaunchOptions,
    env: ModeImplEnv,
    signal?: AbortSignal, // v0.0.337 H6：attach 超时 abort 感知（透传 connectAttachSession → driver.connect）
  ): Promise<LaunchResult> {
    this.env = env; // v0.0.334 fix：缓存 env 供 execute 失活即时清账（ledger.delete + discardInstance）
    if (env.isAttachEnabled && !env.isAttachEnabled()) {
      return {
        ok: false,
        error: { kind: 'not_enabled', message: 'browser attach 未启用：请在「连接器 → 浏览器」中开启开关' },
      };
    }
    if (!env.attachDriver) {
      return { ok: false, error: { kind: 'attach_failed', message: 'attach 驱动未注册（未装配 attachDriver）' } };
    }
    const r = await connectAttachSession(env.attachDriver, {}, signal);
    if (!r.ok) {
      // v0.0.337 H9：失败入台账（不 delete）——driver 清理失败/极端残留时进程还在，
      // 留记录给启动自检 cleanupOrphan 回收（kill 已死 pid no-op + delete，无害）。
      // 下次成功 launch INSERT OR REPLACE 覆盖同 key。best-effort：insert 失败 warn 不阻断。
      if (r.spawnPid !== undefined) {
        try {
          env.ledger.insert({
            key,
            mode: 'attach',
            workerPid: r.spawnPid,
            createdAt: env.now(),
          });
        } catch (e) {
          console.warn(`[attach-mode-impl] launch 失败入台账 ledger.insert 失败（best-effort）: ${errMsg(e)}`);
        }
      }
      return { ok: false, error: r.error };
    }
    const handle: AttachHandle = {
      key,
      mode: 'attach',
      session: r.session,
      ...(r.mcpPid !== undefined ? { mcpPid: r.mcpPid } : {}),
      state: 'ready',
      createdAt: env.now(),
      lastUsedAt: env.now(),
    };
    // B9：attach 入台账（仅 launch 成功且拿到 mcpPid 时）——MCP 子进程是 server spawn 的资源，
    // 崩溃/强杀后成孤儿，入台账让启动自检可回收（cleanupOrphan 杀进程组 + delete）。
    if (r.mcpPid !== undefined) {
      try {
        env.ledger.insert({
          key,
          mode: 'attach',
          workerPid: r.mcpPid,
          createdAt: env.now(),
        });
      } catch (e) {
        console.warn(`[attach-mode-impl] ledger.insert 失败（best-effort）: ${errMsg(e)}`);
      }
    }
    return { ok: true, handle, text: `launched ${opts.mode}` };
  }

  async execute(
    handle: BrowserHandle,
    action: string,
    params: BrowserActionParams,
    ctx: ExecuteCtx,
  ): Promise<BrowserExecuteResult> {
    const ah = handle as AttachHandle;
    const typed: BrowserInputLike = { url: params.url, ref: params.ref, text: params.text };
    const r = await dispatchAction(ah.session, action, typed, ctx);
    if (r.ok) return r;
    // 失活自愈下沉：CDP 断/chrome 被关 → 置 dead + 引导重新 launch（manager 见 dead → closeInstance）
    if (isAttachConnectionLost(r.error?.message ?? '')) {
      handle.state = 'dead';
      // v0.0.334 fix（Bug2 计数虚高）：失活当下即时清账——台账 + 内存 instance 同步删。
      // 语义：attach 失活 = Chrome 已被关、MCP 连接已断，资源实际已死，无需等 close 惰性兜底
      // （现有 manager.execute 兜底只在「同 key 再次 execute」才触发，失活后用户不再操作 → 残留虚高）。
      // env 来源：launch 缓存（ModeImpl.execute 接口无 env 参数，AttachModeImpl 单例缓存安全）。
      // best-effort：delete 失败 warn 不阻断 return attach_lost；均幂等（后续 closeInstance 再删 no-op）。
      const env = this.env;
      if (env) {
        try {
          env.ledger.delete(handle.key);
        } catch (e) {
          console.warn(`[attach-mode-impl] 失活即时清账 ledger.delete 失败（best-effort）: ${errMsg(e)}`);
        }
        env.discardInstance?.(handle.key);
      }
      return {
        ok: false,
        error: { kind: 'attach_lost', message: 'attach 浏览器连接已断开（Chrome 可能被关闭），请重新 launch' },
      };
    }
    return r; // 非失活错误原样透传
  }

  async close(handle: BrowserHandle, env: ModeImplEnv): Promise<CloseResult> {
    const ah = handle as AttachHandle;
    // v0.0.336 三层一致原则（老板定调）：close = 风雨无阻、无条件清干净——
    //   真实资源层（mcp 主进程组 + watchdog）+ 记录层（driver cache + sqlite 台账）+ 感知层（不谎报）。
    // 任何一步抛错都不中断整体清理（try/catch best-effort 全清），但失败要收集最终诚实上报（ok=false）。
    const failures: string[] = [];

    // 步骤 1：断 MCP 连接（graceful client.close + transport.close kill MCP 主进程；清 driver cache）
    try {
      await disconnectAttachSession(env.attachDriver);
    } catch (e) {
      failures.push(`disconnect 失败: ${errMsg(e)}`);
    }

    // 步骤 2：显式回收 mcp 主进程组（G4）——SDK StdioClientTransport.close 只杀 this._process，
    // 且 graceful 需 4s（stdin.end→SIGTERM→SIGKILL），这里直接 SIGKILL 进程组当场死（不等优雅窗）。
    if (ah.mcpPid !== undefined && this.killDeps.isPidAlive(ah.mcpPid)) {
      try {
        this.killDeps.killProcessGroup(ah.mcpPid);
      } catch (e) {
        failures.push(`kill mcp 主进程组失败 pid=${ah.mcpPid}: ${errMsg(e)}`);
      }
    }

    // 步骤 3：兜底杀 detached watchdog（G5）——watchdog 独立进程组，killProcessGroupByPid 杀不到，
    // 按 --parent-pid=<mcpPid> 精确 pkill -9（不误杀其他会话/模式的 mcp）。
    if (ah.mcpPid !== undefined) {
      try {
        this.killOrphanMcpWatchdog(ah.mcpPid);
      } catch (e) {
        failures.push(`kill watchdog 失败 parent-pid=${ah.mcpPid}: ${errMsg(e)}`);
      }
    }

    // 步骤 4：硬删台账（B9/v0.0.334；幂等，key 不存在 no-op）
    try {
      env.ledger.delete(handle.key);
    } catch (e) {
      failures.push(`ledger.delete 失败: ${errMsg(e)}`);
    }

    // 步骤 5：残留检测（只读）：断 MCP 后 Chrome 调试态可能仍在（9222 监听/提示条）——能力边界下
    // 无编程关闭 API，检测到则返回引导提示（manager closeInstance 透传到 text）；
    // autoConnect-only 恒检测（无显式端点跳过分支）；检测失败降级无提示不阻断 close。
    let tip: string | undefined;
    try {
      const residual = await detectChromeDebugResidual(env, ah, this.detectDeps);
      if (residual.residual) {
        tip =
          `attach 已断开；检测到 Chrome 调试态残留（${residual.detail}），` +
          '请到 chrome://inspect/#remote-debugging 取消 Allow remote debugging（Chrome 将重启恢复非调试模式），或重启 Chrome';
      }
    } catch {
      // 检测异常不阻断 close（降级为无提示，manager 输出 'closed'）
    }
    handle.state = 'dead';

    // 三层一致裁决：任何清理步骤失败 → ok=false 诚实上报（manager 不删 instances，调用方知状态未归零）；
    // 全清成功 → ok=true（tip 透传残留引导文本，无则 undefined manager 输出 'closed'）。
    if (failures.length > 0) {
      return {
        ok: false,
        error: { kind: 'close_incomplete', message: `attach close 清理不完整: ${failures.join('; ')}` },
      };
    }
    return tip !== undefined ? { ok: true, text: tip } : { ok: true };
  }

  /**
   * 孤儿 MCP 代理回收（v0.0.334 B9：attach 纳入台账后开机自检按 rec.mode 分发到本方法）。
   * attach 不 launch chrome（MCP 进程无子 chrome），单进程 kill 安全；
   * v0.0.336 G6：补 watchdog 兜底（rec.workerPid 即 mcpPid，对齐 close 同一回收逻辑）。
   * 幂等：pid 已死 no-op（killProcessGroupByPid 已含 ESRCH 吞错）。
   */
  cleanupOrphan(rec: PersistedInstanceRecord, env: ModeImplEnv): void {
    if (rec.workerPid && this.killDeps.isPidAlive(rec.workerPid)) {
      this.killDeps.killProcessGroup(rec.workerPid);
    }
    // G6：watchdog 兜底（detached 独立进程组，killProcessGroupByPid 杀不到；按 --parent-pid 精确锚定）
    if (rec.workerPid) {
      this.killOrphanMcpWatchdog(rec.workerPid);
    }
    env.ledger.delete(rec.key);
  }

  /**
   * 兜底杀 detached watchdog（v0.0.336 G5，实例方法用 this.killDeps.execPkill 可注入）。
   * watchdog 是 chrome-devtools-mcp telemetry/WatchdogClient.js:32-36 spawn 的 detached 独立进程组
   * （自己当 pgid），killProcessGroupByPid(mcpPid) 杀不到它——需按 mcpPid 精确定位：
   * watchdog 启动参数含 `--parent-pid=<mcpPid>`（WatchdogClient.js:15），pkill -9 -f 精确锚定。
   * 约束：MUST 以 mcpPid 精确定位（禁无差别 pkill chrome-devtools-mcp 误杀其他会话/模式的 mcp）；
   *       best-effort（失败 try/catch 不抛）；仅 POSIX（darwin/linux），win32 跳过（attach 暂不支持 win）。
   * @param mcpPid MCP 主进程 pid（watchdog 的 --parent-pid 锚点）
   */
  private killOrphanMcpWatchdog(mcpPid: number): void {
    if (process.platform === 'win32') return; // win32 跳过（attach 暂不支持 win 调试态路径）
    try {
      this.killDeps.execPkill(`pkill -9 -f "chrome-devtools-mcp.*--parent-pid=${mcpPid}"`);
    } catch {
      /* best-effort：pkill 无匹配/失败不阻断 close/cleanupOrphan 主流程 */
    }
  }
}
